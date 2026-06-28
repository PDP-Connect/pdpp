// HTTP adapter for the reference-only `/_ref/connectors`,
// `/_ref/connections`, and `/_ref/connector-instances` route family —
// connector-summary list/detail, schedule read, connection list/detail, connection
// display-name PATCH, and the run-now / schedule put / pause / resume /
// delete action routes.
//
// Behaviour-preserving extraction from `server/index.js` per the OpenSpec
// change `split-reference-server-by-route-family` (§2.4). Each `mount...`
// function registers one route at the same point in registration order
// where `server/index.js` previously registered it inline. Owner-session
// posture, contract metadata, response envelopes, status codes, error
// mapping, owner-subject namespace resolution, and the
// `onScheduleMutation` callback are unchanged.
//
// `projectRefConnection`, `sendRefConnectionDetail`, `resolveRefConnectorNamespace`,
// and `resolveRefConnectionNamespace` move here from the `buildAsApp`
// closure in `server/index.js` because all call sites are within this
// route family. Namespace resolution still flows through the host-supplied
// `resolveOwnerConnectorNamespace` so the substrate lookup stays a single
// implementation.

import {
  executeRefConnectorScheduleGet,
  RefConnectorScheduleGetNotFoundError,
} from "../../operations/ref-connector-schedule-get/index.ts";
import {
  executeRefConnectorDetail,
  RefConnectorDetailNotFoundError,
} from "../../operations/ref-connectors-detail/index.ts";
import {
  executeRefConnectorsList,
  type RefConnectorsRuntimeStatus,
} from "../../operations/ref-connectors-list/index.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/ref-dataset.ts`.

interface RouteRequest {
  readonly body?: unknown;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
}

interface RouteResponse {
  end(): unknown;
  getHeader(name: string): string | number | string[] | undefined;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): void;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  delete(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
  patch(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
  put(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

// Minimal connector-instance shape this adapter projects. The substrate
// store carries additional fields; these are the ones the projection
// reads.
interface ConnectorInstanceRow {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly createdAt?: string | null;
  readonly displayName?: string | null;
  readonly revokedAt?: string | null;
  readonly sourceBinding?: unknown;
  readonly sourceKind?: string | null;
  readonly status?: string | null;
  readonly updatedAt?: string | null;
}

interface ScheduleRow {
  readonly connector_instance_id?: string | null;
}

// Capability-shaped namespace bag — the host resolver returns at least
// these fields. Other resolver-only fields pass through opaquely.
interface ConnectorNamespace {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
}

interface ConnectorInstanceStore {
  get(connectorInstanceId: string): Promise<ConnectorInstanceRow | null> | ConnectorInstanceRow | null;
  listByOwner(ownerSubjectId: string): Promise<ConnectorInstanceRow[]> | ConnectorInstanceRow[];
  setDisplayName(
    connectorInstanceId: string,
    options: { ownerSubjectId: string; displayName: string; updatedAt: string }
  ): Promise<ConnectorInstanceRow>;
}

interface ScheduleUpsertResult {
  readonly policy_warning?: unknown;
  readonly schedule: unknown;
}

interface TraceContext {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly trace_id: string;
}

// Connection-scoped soft-flip result returned by the shared store
// `updateStatus` primitive. Both the owner-session revoke and reactivate
// routes reuse the same primitive — no new destructive
// semantic is introduced here.
interface RevokedInstance {
  readonly connectorInstanceId?: string | null;
  readonly revokedAt?: string | null;
  readonly status?: string | null;
}

// Non-secret deletion summary returned by the shared store `deleteConnection`
// cascade (counts + stable ids only). Identical to the shape the owner-agent
// bearer delete route surfaces.
interface ConnectionDeleteSummary {
  readonly connection_id: string;
  readonly connector_id: string;
  readonly deleted_record_count: number;
  readonly deleted_stream_count: number;
  readonly device_refs_cleared: number;
  readonly schedule_deleted: boolean;
  readonly source_kind: string;
}

interface OwnerNamespaceOptions {
  readonly allowDefaultAccount?: boolean;
  readonly allowStatuses?: readonly string[];
  readonly connectorInstanceId?: string | null;
  readonly ownerSubjectId?: string;
}

export interface MountRefConnectorsContext {
  canonicalConnectorKey(value: string | null | undefined): string | null;
  createRequestConnectorInstanceStore(): ConnectorInstanceStore;
  createTraceContext(input?: { scenarioId?: string }): TraceContext;
  // Connection-scoped destructive delete primitive — the SAME cascade the
  // owner-agent bearer delete route delegates to. Resolves + verifies owner
  // ownership BEFORE any mutation, refuses active-run / default-account with the
  // existing typed errors, purges exactly one connection's source-of-truth
  // records + state, and returns the non-secret deletion summary. Wired with the
  // same injected `purge` phases the bearer route receives so the console path
  // cannot diverge from the agent path.
  deleteConnection(
    connectorInstanceId: string,
    options: { ownerSubjectId: string; now?: string | undefined }
  ): Promise<ConnectionDeleteSummary>;
  deleteSchedule(connectorId: string, options: { connectorInstanceId?: string | null }): Promise<boolean>;
  emitSpineEvent(event: Record<string, unknown>): Promise<unknown>;
  ensureRequestId(res: RouteResponse): string;
  getConnectorDetail(connectorId: string): Promise<Record<string, unknown> | null>;
  getConnectorSummaryForRoute(routeId: string): Promise<unknown | null> | unknown | null;
  getOwnerSubjectId(req: unknown): string;
  getRuntimeStatus(): RefConnectorsRuntimeStatus;
  getSchedule(connectorId: string, options: { connectorInstanceId?: string | null }): Promise<unknown> | unknown;
  handleError(res: unknown, err: unknown): void;
  invalidateConnectorSummariesCache?(): void;
  listConnectorSummaries(): Promise<readonly unknown[]> | readonly unknown[];
  listSchedules(): Promise<ScheduleRow[]> | ScheduleRow[];
  // Marks the maintained connector-summary read-model evidence for exactly one
  // connection dirty after a cookie-authed `/_ref` mutation (run / schedule /
  // rename / revoke / reactivate / delete). Injected (not imported) to match the
  // optional `invalidateConnectorSummariesCache` above; awaited at each call
  // site so ordering is explicit, best-effort, and a no-op until the read model
  // is warmed.
  markConnectorSummaryEvidenceDirty?(input: { connectorInstanceId: string; reason?: string }): Promise<void> | void;
  now?(): string;
  onScheduleMutation?(): Promise<unknown> | unknown;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
  resolveOwnerConnectorNamespace(
    req: unknown,
    connectorId: string | null,
    options?: OwnerNamespaceOptions
  ): Promise<ConnectorNamespace>;
  resolveRegisteredConnectorManifest(connectorId: string): Promise<unknown>;
  resolveSingleConnectorIdQueryValue(raw: unknown): string | null;
  runNow(
    connectorId: string,
    options: {
      connectorInstanceId?: string | null;
      force?: boolean;
      resources?: Readonly<Record<string, readonly string[]>>;
    }
  ): Promise<unknown>;
  setReferenceTraceId(res: RouteResponse, traceId: string): void;
  setScheduleEnabled(
    connectorId: string,
    enabled: boolean,
    options: { connectorInstanceId?: string | null }
  ): Promise<unknown>;
  // Connection-scoped soft-flip primitive — the SAME store `updateStatus`
  // method the owner-agent bearer revoke and reactivate routes use. Flips
  // exactly one connector instance to the target status, zero cascade; the
  // namespace is owner-verified before this is called. Reactivate passes
  // `{ status: 'active', revokedAt: null }` to clear the revoke stamp.
  updateConnectorInstanceStatus(
    connectorInstanceId: string,
    options:
      | { status: "revoked"; updatedAt: string; revokedAt: string }
      | { status: "active"; updatedAt: string; revokedAt: null }
  ): Promise<RevokedInstance> | RevokedInstance;
  upsertSchedule(
    connectorId: string,
    input: unknown,
    options: { connectorInstanceId?: string | null }
  ): Promise<ScheduleUpsertResult>;
}

// Moved from the `buildAsApp` closure in `server/index.js`. Owner subject
// resolution stays a host concern (the `ownerAuth` module owns the
// `req.ownerSession` shape); namespace resolution flows through
// `ctx.resolveOwnerConnectorNamespace` so the substrate lookup remains a
// single implementation.
function resolveRefConnectorNamespace(
  ctx: MountRefConnectorsContext,
  req: unknown,
  connectorId: string
): Promise<ConnectorNamespace> {
  return ctx.resolveOwnerConnectorNamespace(req, connectorId, {
    ownerSubjectId: ctx.getOwnerSubjectId(req),
  });
}

function resolveRefConnectionNamespace(
  ctx: MountRefConnectorsContext,
  req: unknown,
  connectorInstanceId: string,
  options: { allowStatuses?: readonly string[] } = {}
): Promise<ConnectorNamespace> {
  return ctx.resolveOwnerConnectorNamespace(req, null, {
    ownerSubjectId: ctx.getOwnerSubjectId(req),
    allowDefaultAccount: false,
    connectorInstanceId,
    ...(options.allowStatuses ? { allowStatuses: options.allowStatuses } : {}),
  });
}

// Moved from the `buildAsApp` closure in `server/index.js`. Owner-facing
// projection of a connector instance; the second argument lets list and
// PATCH callers attach the matching schedule from a pre-fetched map.
// The third argument canonicalizes connector_id at the response boundary
// so URL-shaped registry IDs never appear in owner-facing API responses
// even if the storage row pre-dates the canonical-key migration.
function projectRefConnection(
  instance: ConnectorInstanceRow,
  schedulesByInstanceId: ReadonlyMap<string, unknown> = new Map(),
  canonicalizeConnectorId: (id: string) => string | null = (id) => id
): Record<string, unknown> {
  return {
    object: "ref_connection",
    connector_instance_id: instance.connectorInstanceId,
    connector_id: canonicalizeConnectorId(instance.connectorId) ?? instance.connectorId,
    display_name: instance.displayName,
    status: instance.status,
    source_kind: instance.sourceKind,
    source_binding: instance.sourceBinding,
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
    revoked_at: instance.revokedAt,
    schedule: schedulesByInstanceId.get(instance.connectorInstanceId) || null,
  };
}

function connectorIdMatchesFilter(
  ctx: MountRefConnectorsContext,
  instance: ConnectorInstanceRow,
  connectorId: string | null
): boolean {
  if (!connectorId) {
    return true;
  }
  return (ctx.canonicalConnectorKey(instance.connectorId) ?? instance.connectorId) === connectorId;
}

// Moved from the `buildAsApp` closure in `server/index.js`. Both the
// canonical `/_ref/connections/:id` route and the legacy
// `/_ref/connector-instances/:id` alias delegate here; behaviour
// (namespace resolution, store read, schedule lookup, projection) is
// identical between them.
async function sendRefConnectionDetail(
  ctx: MountRefConnectorsContext,
  req: unknown,
  res: RouteResponse,
  connectorInstanceId: string
): Promise<void> {
  const namespace = await resolveRefConnectionNamespace(ctx, req, connectorInstanceId);
  const store = ctx.createRequestConnectorInstanceStore();
  const instance = await store.get(namespace.connectorInstanceId);
  const schedule = await ctx.getSchedule(namespace.connectorId, {
    connectorInstanceId: namespace.connectorInstanceId,
  });
  const schedulesByInstanceId = new Map<string, unknown>(schedule ? [[namespace.connectorInstanceId, schedule]] : []);
  // Fall back to the namespace bag (which carries `connectorInstanceId`
  // and `connectorId`) when the store has no row — the previous inline
  // implementation did the same, so the deprecated alias route keeps
  // returning a projection rather than 404'ing.
  const source = instance ?? (namespace as unknown as ConnectorInstanceRow);
  res.json(projectRefConnection(source, schedulesByInstanceId, (id) => ctx.canonicalConnectorKey(id)));
}

// ─── Connector summary list / detail ────────────────────────────────────

// Reference-only connector-summary list. Envelope assembly lives in the
// canonical `ref.connectors.list` operation; this route owns owner auth,
// response writing, and dependency wiring (the substrate read still lives
// in `server/ref-control.ts`). Despite the historical route name, list items
// are configured connection summaries, not addable catalog connectors.
export function mountRefConnectorsList(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.get(
    "/_ref/connectors",
    { contract: "refListConnectors" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        // Optional connection selector. When present, the route projects only
        // the resolved connection (records subpages resolve one connection and
        // must not hydrate every connector); when absent it lists every
        // configured connection exactly as before. The scoped read goes through
        // the same per-connection projection (`ref-control.ts`), so a
        // single-connection summary cannot diverge from its entry in the list.
        const connectionSelector = ctx.resolveSingleConnectorIdQueryValue(req.query.connection);
        const listConnectorSummaries = connectionSelector
          ? async () => {
              const summary = await ctx.getConnectorSummaryForRoute(connectionSelector);
              return summary == null ? [] : [summary];
            }
          : () => ctx.listConnectorSummaries();
        // The operation expects `RefConnectorsListItem[]`; the host read
        // returns the same shape via `ref-control.ts`. We forward
        // opaquely — the adapter does not redefine the item shape.
        const envelope = await executeRefConnectorsList({
          listConnectorSummaries: () =>
            listConnectorSummaries() as unknown as ReturnType<
              Parameters<typeof executeRefConnectorsList>[0]["listConnectorSummaries"]
            >,
          getRuntimeStatus: ctx.getRuntimeStatus,
        });
        res.json(envelope);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// Reference-only connector detail. The canonical `ref.connectors.detail`
// operation owns the `ref_connector_detail` envelope discriminator and
// the not-found mapping; the host adapter translates host-internal
// `RefControlError`s into the same `not_found` / `connector_invalid`
// shape the route exposed before mount.
export function mountRefConnectorDetail(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.get(
    "/_ref/connectors/:connectorId",
    { contract: "refGetConnector" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorId = decodeURIComponent(req.params.connectorId as string);
        const envelope = await executeRefConnectorDetail(
          { connectorId },
          {
            getConnectorDetail: async (id) => {
              try {
                const detail = await ctx.getConnectorDetail(id);
                if (!detail) {
                  return null;
                }
                const { object: _ignored, ...rest } = detail as Record<string, unknown>;
                return rest as unknown as Awaited<
                  ReturnType<Parameters<typeof executeRefConnectorDetail>[1]["getConnectorDetail"]>
                >;
              } catch (err) {
                if (err && (err as { code?: string }).code === "not_found") {
                  return null;
                }
                throw err;
              }
            },
          }
        );
        res.json(envelope);
      } catch (err) {
        if (err instanceof RefConnectorDetailNotFoundError) {
          const wrapped = new Error(err.message) as Error & { code?: string };
          wrapped.code = "not_found";
          ctx.handleError(res, wrapped);
          return;
        }
        ctx.handleError(res, err);
      }
    }
  );
}

// Reference-only per-connector schedule view. The canonical
// `ref.connector-schedule.get` operation owns the success projection and
// the typed not-found failure shape; the host adapter translates the
// typed error into the existing PDPP 404 `not_found` envelope.
export function mountRefConnectorScheduleGet(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.get(
    "/_ref/connectors/:connectorId/schedule",
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const connectorId = decodeURIComponent(req.params.connectorId as string);
      try {
        const namespace = await resolveRefConnectorNamespace(ctx, req, connectorId);
        const schedule = await executeRefConnectorScheduleGet(
          { connectorId: namespace.connectorInstanceId },
          {
            getConnectorSchedule: async () =>
              ctx.getSchedule(namespace.connectorId, {
                connectorInstanceId: namespace.connectorInstanceId,
              }),
          }
        );
        res.json(schedule);
      } catch (err) {
        if (err instanceof RefConnectorScheduleGetNotFoundError) {
          ctx.pdppError(res, 404, "not_found", err.message);
          return;
        }
        ctx.handleError(res, err);
      }
    }
  );
}

// ─── Connection list / detail / display-name PATCH ──────────────────────

export function mountRefConnectionsList(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.get(
    "/_ref/connections",
    { contract: "refListConnections" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const ownerSubjectId = ctx.getOwnerSubjectId(req);
        const rawConnectorId = ctx.resolveSingleConnectorIdQueryValue(req.query.connector_id);
        // Canonicalize the owner-supplied connector_id filter so a URL-shaped
        // value (e.g. https://registry.pdpp.org/connectors/spotify) matches the
        // canonical key the instances are stored under. Accept the legacy alias
        // at the boundary, then compare canonically. See canonicalize-connector-keys
        // Decision 1: connector instances bind to canonical keys only.
        const connectorId = rawConnectorId
          ? (ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId)
          : rawConnectorId;
        const status = ctx.resolveSingleConnectorIdQueryValue(req.query.status);
        const store = ctx.createRequestConnectorInstanceStore();
        const instances = await store.listByOwner(ownerSubjectId);
        const schedules = await ctx.listSchedules();
        const schedulesByInstanceId = new Map<string, unknown>(
          schedules
            .filter((schedule) => schedule?.connector_instance_id)
            .map((schedule) => [schedule.connector_instance_id as string, schedule])
        );
        const data = instances
          .filter((instance) => connectorIdMatchesFilter(ctx, instance, connectorId))
          .filter((instance) => !status || instance.status === status)
          .map((instance) =>
            projectRefConnection(instance, schedulesByInstanceId, (id) => ctx.canonicalConnectorKey(id))
          );
        res.json({ object: "list", data });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefConnectorInstancesList(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.get(
    "/_ref/connector-instances",
    { contract: "refListConnectorInstances" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const ownerSubjectId = ctx.getOwnerSubjectId(req);
        const rawConnectorId = ctx.resolveSingleConnectorIdQueryValue(req.query.connector_id);
        // Canonicalize the connector_id filter so URL-shaped or legacy-alias
        // values match the canonical key instances are stored under. See
        // canonicalize-connector-keys Decision 1.
        const connectorId = rawConnectorId
          ? (ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId)
          : rawConnectorId;
        const status = ctx.resolveSingleConnectorIdQueryValue(req.query.status);
        const store = ctx.createRequestConnectorInstanceStore();
        const instances = await store.listByOwner(ownerSubjectId);
        const data = instances
          .filter((instance) => connectorIdMatchesFilter(ctx, instance, connectorId))
          .filter((instance) => !status || instance.status === status)
          .map((instance) => projectRefConnection(instance, new Map(), (id) => ctx.canonicalConnectorKey(id)));
        res.json({ object: "list", data });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefConnectionDetail(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.get(
    "/_ref/connections/:connectorInstanceId",
    { contract: "refGetConnection" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
        await sendRefConnectionDetail(ctx, req, res, connectorInstanceId);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefConnectorInstanceDetail(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.get(
    "/_ref/connector-instances/:connectorInstanceId",
    { contract: "refGetConnectorInstance" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
        await sendRefConnectionDetail(ctx, req, res, connectorInstanceId);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// PATCH /_ref/connections/:connectorInstanceId — owner-authenticated
// mutation of the owner-meaningful `display_name` carried on the
// public read contract. Operator-only surface; grant-authorized tokens
// SHALL NOT reach this route (gated by `ctx.requireOwnerSession`).
//
// Spec: openspec/changes/expose-connection-identity-on-public-read/
//       specs/reference-implementation-architecture/spec.md
//       (#"Owner-meaningful display name SHALL be owner-editable")
export function mountRefConnectionSetDisplayName(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.patch(
    "/_ref/connections/:connectorInstanceId",
    { contract: "refSetConnectionDisplayName" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
        const body = (req.body as Record<string, unknown> | null) || {};
        const displayName = body.display_name;
        if (typeof displayName !== "string" || !displayName.trim()) {
          ctx.pdppError(res, 400, "invalid_request", "display_name must be a non-empty string", "display_name");
          return;
        }
        const ownerSubjectId = ctx.getOwnerSubjectId(req);
        // Confirm the instance belongs to this owner before mutating; the
        // store also enforces this in its WHERE clause so a stolen id
        // cannot cross owners even if this preflight is skipped.
        await resolveRefConnectionNamespace(ctx, req, connectorInstanceId);
        const store = ctx.createRequestConnectorInstanceStore();
        const updated = await store.setDisplayName(connectorInstanceId, {
          ownerSubjectId,
          displayName: displayName.trim(),
          updatedAt: new Date().toISOString(),
        });
        ctx.invalidateConnectorSummariesCache?.();
        // Scoped, awaited dirty marking: display_name is durable summary evidence.
        await ctx.markConnectorSummaryEvidenceDirty?.({
          connectorInstanceId: updated.connectorInstanceId,
          reason: "ref rename changed connection display_name evidence",
        });
        const schedule = await ctx.getSchedule(updated.connectorId, {
          connectorInstanceId: updated.connectorInstanceId,
        });
        res.json(
          projectRefConnection(
            updated,
            new Map<string, unknown>(schedule ? [[updated.connectorInstanceId, schedule]] : []),
            (id) => ctx.canonicalConnectorKey(id)
          )
        );
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// ─── Action routes (run / schedule put / pause / resume / delete) ───────

function readExplicitRunForce(req: RouteRequest): boolean {
  const body = req.body;
  return Boolean(
    body && typeof body === "object" && !Array.isArray(body) && (body as { force?: unknown }).force === true
  );
}

function isSafeResourceStreamName(stream: string): boolean {
  return stream.length > 0 && stream !== "__proto__" && stream !== "constructor" && stream !== "prototype";
}

function readRunResources(req: RouteRequest): Readonly<Record<string, readonly string[]>> | undefined {
  const body = req.body;
  if (!(body && typeof body === "object" && !Array.isArray(body))) {
    return;
  }
  const raw = (body as { resources?: unknown }).resources;
  if (raw == null) {
    return;
  }
  if (!(typeof raw === "object" && !Array.isArray(raw))) {
    const err = new Error("run resources must be an object keyed by stream") as Error & { code: string };
    err.code = "invalid_request";
    throw err;
  }
  const resources: Record<string, string[]> = {};
  for (const [stream, values] of Object.entries(raw)) {
    if (
      typeof stream !== "string" ||
      !isSafeResourceStreamName(stream) ||
      !Array.isArray(values) ||
      values.some((value) => typeof value !== "string")
    ) {
      const err = new Error("run resources must map stream names to string arrays") as Error & { code: string };
      err.code = "invalid_request";
      throw err;
    }
    const stringValues = values as string[];
    const cleaned = [...new Set(stringValues.filter((value) => value.length > 0))];
    if (cleaned.length === 0) {
      const err = new Error("run resources must include at least one resource id per stream") as Error & {
        code: string;
      };
      err.code = "invalid_request";
      throw err;
    }
    resources[stream] = cleaned;
  }
  if (Object.keys(resources).length === 0) {
    const err = new Error("run resources must include at least one stream") as Error & { code: string };
    err.code = "invalid_request";
    throw err;
  }
  return resources;
}

export function mountRefConnectorRun(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.post(
    "/_ref/connectors/:connectorId/run",
    { contract: "refRunConnector" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorId = decodeURIComponent(req.params.connectorId as string);
        const namespace = await resolveRefConnectorNamespace(ctx, req, connectorId);
        const resources = readRunResources(req);
        const started = await ctx.runNow(namespace.connectorId, {
          connectorInstanceId: namespace.connectorInstanceId,
          force: readExplicitRunForce(req),
          ...(resources ? { resources } : {}),
        });
        ctx.invalidateConnectorSummariesCache?.();
        // Scoped, awaited dirty marking: starting a run is a run-lifecycle event
        // that changes this connection's last-run evidence. Instance id known.
        await ctx.markConnectorSummaryEvidenceDirty?.({
          connectorInstanceId: namespace.connectorInstanceId,
          reason: "ref run-now started a run for this connection",
        });
        res.status(202).json(started);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefConnectionRun(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.post(
    "/_ref/connections/:connectorInstanceId/run",
    { contract: "refRunConnection" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
        const namespace = await resolveRefConnectionNamespace(ctx, req, connectorInstanceId, {
          allowStatuses: ["active", "draft"],
        });
        const resources = readRunResources(req);
        const started = await ctx.runNow(namespace.connectorId, {
          connectorInstanceId: namespace.connectorInstanceId,
          force: readExplicitRunForce(req),
          ...(resources ? { resources } : {}),
        });
        ctx.invalidateConnectorSummariesCache?.();
        // Scoped, awaited dirty marking: starting a run is a run-lifecycle event
        // that changes this connection's last-run evidence. Instance id known.
        await ctx.markConnectorSummaryEvidenceDirty?.({
          connectorInstanceId: namespace.connectorInstanceId,
          reason: "ref run-now started a run for this connection",
        });
        res.status(202).json(started);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefConnectorScheduleUpsert(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.put(
    "/_ref/connectors/:connectorId/schedule",
    { contract: "refPutConnectorSchedule" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorId = decodeURIComponent(req.params.connectorId as string);
        await ctx.resolveRegisteredConnectorManifest(connectorId);
        const namespace = await resolveRefConnectorNamespace(ctx, req, connectorId);
        const result = await ctx.upsertSchedule(namespace.connectorId, req.body || {}, {
          connectorInstanceId: namespace.connectorInstanceId,
        });
        await ctx.onScheduleMutation?.();
        ctx.invalidateConnectorSummariesCache?.();
        // Scoped, awaited dirty marking: a schedule upsert changes this
        // connection's schedule/refresh-policy evidence. Instance id known.
        await ctx.markConnectorSummaryEvidenceDirty?.({
          connectorInstanceId: namespace.connectorInstanceId,
          reason: "ref schedule upsert changed connection schedule evidence",
        });
        // Include policy_warning in the response so dashboard can surface
        // it without a second round-trip.
        const responseBody = result.policy_warning
          ? { ...(result.schedule as Record<string, unknown>), policy_warning: result.policy_warning }
          : result.schedule;
        res.json(responseBody);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefConnectionScheduleUpsert(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.put(
    "/_ref/connections/:connectorInstanceId/schedule",
    { contract: "refPutConnectionSchedule" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
        const namespace = await resolveRefConnectionNamespace(ctx, req, connectorInstanceId);
        await ctx.resolveRegisteredConnectorManifest(namespace.connectorId);
        const result = await ctx.upsertSchedule(namespace.connectorId, req.body || {}, {
          connectorInstanceId: namespace.connectorInstanceId,
        });
        await ctx.onScheduleMutation?.();
        ctx.invalidateConnectorSummariesCache?.();
        // Scoped, awaited dirty marking: a schedule upsert changes this
        // connection's schedule/refresh-policy evidence. Instance id known.
        await ctx.markConnectorSummaryEvidenceDirty?.({
          connectorInstanceId: namespace.connectorInstanceId,
          reason: "ref schedule upsert changed connection schedule evidence",
        });
        const responseBody = result.policy_warning
          ? { ...(result.schedule as Record<string, unknown>), policy_warning: result.policy_warning }
          : result.schedule;
        res.json(responseBody);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefConnectorSchedulePause(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.post(
    "/_ref/connectors/:connectorId/schedule/pause",
    { contract: "refPauseConnectorSchedule" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorId = decodeURIComponent(req.params.connectorId as string);
        const namespace = await resolveRefConnectorNamespace(ctx, req, connectorId);
        const schedule = await ctx.setScheduleEnabled(namespace.connectorId, false, {
          connectorInstanceId: namespace.connectorInstanceId,
        });
        await ctx.onScheduleMutation?.();
        ctx.invalidateConnectorSummariesCache?.();
        // Scoped, awaited dirty marking: pausing a schedule changes this
        // connection's schedule/refresh-policy evidence. Instance id known.
        await ctx.markConnectorSummaryEvidenceDirty?.({
          connectorInstanceId: namespace.connectorInstanceId,
          reason: "ref schedule pause changed connection schedule evidence",
        });
        res.json(schedule);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefConnectionSchedulePause(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.post(
    "/_ref/connections/:connectorInstanceId/schedule/pause",
    { contract: "refPauseConnectionSchedule" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
        const namespace = await resolveRefConnectionNamespace(ctx, req, connectorInstanceId);
        const schedule = await ctx.setScheduleEnabled(namespace.connectorId, false, {
          connectorInstanceId: namespace.connectorInstanceId,
        });
        await ctx.onScheduleMutation?.();
        ctx.invalidateConnectorSummariesCache?.();
        // Scoped, awaited dirty marking: pausing a schedule changes this
        // connection's schedule/refresh-policy evidence. Instance id known.
        await ctx.markConnectorSummaryEvidenceDirty?.({
          connectorInstanceId: namespace.connectorInstanceId,
          reason: "ref schedule pause changed connection schedule evidence",
        });
        res.json(schedule);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefConnectorScheduleResume(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.post(
    "/_ref/connectors/:connectorId/schedule/resume",
    { contract: "refResumeConnectorSchedule" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorId = decodeURIComponent(req.params.connectorId as string);
        const namespace = await resolveRefConnectorNamespace(ctx, req, connectorId);
        const schedule = await ctx.setScheduleEnabled(namespace.connectorId, true, {
          connectorInstanceId: namespace.connectorInstanceId,
        });
        await ctx.onScheduleMutation?.();
        ctx.invalidateConnectorSummariesCache?.();
        // Scoped, awaited dirty marking: resuming a schedule changes this
        // connection's schedule/refresh-policy evidence. Instance id known.
        await ctx.markConnectorSummaryEvidenceDirty?.({
          connectorInstanceId: namespace.connectorInstanceId,
          reason: "ref schedule resume changed connection schedule evidence",
        });
        res.json(schedule);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefConnectionScheduleResume(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.post(
    "/_ref/connections/:connectorInstanceId/schedule/resume",
    { contract: "refResumeConnectionSchedule" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
        const namespace = await resolveRefConnectionNamespace(ctx, req, connectorInstanceId);
        const schedule = await ctx.setScheduleEnabled(namespace.connectorId, true, {
          connectorInstanceId: namespace.connectorInstanceId,
        });
        await ctx.onScheduleMutation?.();
        ctx.invalidateConnectorSummariesCache?.();
        // Scoped, awaited dirty marking: resuming a schedule changes this
        // connection's schedule/refresh-policy evidence. Instance id known.
        await ctx.markConnectorSummaryEvidenceDirty?.({
          connectorInstanceId: namespace.connectorInstanceId,
          reason: "ref schedule resume changed connection schedule evidence",
        });
        res.json(schedule);
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefConnectorScheduleDelete(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.delete(
    "/_ref/connectors/:connectorId/schedule",
    { contract: "refDeleteConnectorSchedule" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorId = decodeURIComponent(req.params.connectorId as string);
        const namespace = await resolveRefConnectorNamespace(ctx, req, connectorId);
        const deleted = await ctx.deleteSchedule(namespace.connectorId, {
          connectorInstanceId: namespace.connectorInstanceId,
        });
        if (!deleted) {
          ctx.pdppError(res, 404, "not_found", `Schedule not found for connector: ${connectorId}`);
          return;
        }
        await ctx.onScheduleMutation?.();
        ctx.invalidateConnectorSummariesCache?.();
        // Scoped, awaited dirty marking: deleting a schedule changes this
        // connection's schedule/refresh-policy evidence. Instance id known.
        await ctx.markConnectorSummaryEvidenceDirty?.({
          connectorInstanceId: namespace.connectorInstanceId,
          reason: "ref schedule delete changed connection schedule evidence",
        });
        res.status(204).end();
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

export function mountRefConnectionScheduleDelete(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.delete(
    "/_ref/connections/:connectorInstanceId/schedule",
    { contract: "refDeleteConnectionSchedule" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
        const namespace = await resolveRefConnectionNamespace(ctx, req, connectorInstanceId);
        const deleted = await ctx.deleteSchedule(namespace.connectorId, {
          connectorInstanceId: namespace.connectorInstanceId,
        });
        if (!deleted) {
          ctx.pdppError(res, 404, "not_found", `Schedule not found for connection: ${connectorInstanceId}`);
          return;
        }
        await ctx.onScheduleMutation?.();
        ctx.invalidateConnectorSummariesCache?.();
        // Scoped, awaited dirty marking: deleting a schedule changes this
        // connection's schedule/refresh-policy evidence. Instance id known.
        await ctx.markConnectorSummaryEvidenceDirty?.({
          connectorInstanceId: namespace.connectorInstanceId,
          reason: "ref schedule delete changed connection schedule evidence",
        });
        res.status(204).end();
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// ─── Connection revoke / delete (owner-session siblings of the bearer routes) ──
//
// These two routes give the operator console a way to revoke and delete one
// configured connection over its existing owner-session auth, without an
// owner-agent bearer. They are deliberately thin: each delegates to the SAME
// connector-instance store primitive the owner-agent bearer route uses
// (`updateStatus` for revoke, `deleteConnection` for delete, wired with the same
// injected `purge` phases in `server/index.js`) and emits the SAME non-secret
// audit event type, differing only in the auth adapter (`requireOwnerSession`
// cookie vs `requireToken` + `requireOwner` bearer) and the owner-subject source
// (`getOwnerSubjectId` session vs token). No deletion/revoke cascade is
// re-implemented here; the console path cannot diverge from the agent path
// because both bottom out in one store method per action.
//
// Spec: openspec/changes/add-console-connection-revoke-delete-controls/specs/
//       reference-implementation-architecture/spec.md
//       (#"Owner-session connection revoke and delete SHALL reuse the
//         owner-agent cascade implementation")

function buildConnectionControlAuditTrace(ctx: MountRefConnectorsContext, res: RouteResponse): TraceContext {
  const trace = ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return {
    request_id: requestId,
    scenario_id: trace.scenario_id,
    trace_id: trace.trace_id,
  };
}

// Emits one non-secret audit event for an owner-session connection control
// action. The `event_type` matches the owner-agent bearer route's so the
// console path and the agent path appear under one audit stream per action;
// `actor_type` is `owner_session` to distinguish the surface. Never logs
// session credentials, provider secrets, or record contents.
async function emitConnectionControlAudit(
  ctx: MountRefConnectorsContext,
  res: RouteResponse,
  args: {
    connectionId?: string | null;
    connectorKey?: string | null;
    deletionSummary?: ConnectionDeleteSummary | null;
    error?: unknown;
    eventType: "owner_agent.connection.revoke" | "owner_agent.connection.delete" | "owner_agent.connection.reactivate";
    operation: "revoke" | "delete" | "reactivate";
    outcome: "succeeded" | "failed";
    ownerSubjectId?: string | null;
  }
): Promise<void> {
  const trace = buildConnectionControlAuditTrace(ctx, res);
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    event_type: args.eventType,
    trace_id: trace.trace_id,
    scenario_id: trace.scenario_id,
    request_id: trace.request_id,
    actor_type: "owner_session",
    actor_id: args.ownerSubjectId ?? "owner_session",
    subject_type: "subject",
    subject_id: args.ownerSubjectId ?? null,
    object_type: "connection",
    object_id: args.connectionId || args.connectorKey || "unknown_connection",
    status: args.outcome,
    data: {
      actor_kind: "owner_session",
      connection_id: args.connectionId ?? null,
      connector_key: args.connectorKey ?? null,
      selector: "connection_id",
      operation: args.operation,
      outcome: args.outcome,
      target_resource: "connection",
      ...(args.deletionSummary
        ? {
            deletion_summary: {
              deleted_record_count: args.deletionSummary.deleted_record_count,
              deleted_stream_count: args.deletionSummary.deleted_stream_count,
              schedule_deleted: args.deletionSummary.schedule_deleted,
              device_refs_cleared: args.deletionSummary.device_refs_cleared,
            },
          }
        : {}),
      ...(args.error ? { error: { code: typeof code === "string" ? code : "api_error" } } : {}),
    },
  });
}

// POST /_ref/connections/:connectorInstanceId/revoke — owner-session revoke of
// one configured connection. Resolves + owner-verifies the connection through
// the shared namespace resolver, flips exactly that instance to `revoked` via
// the shared store primitive, and emits a non-secret revoke audit. Zero cascade:
// already-collected records, grants, and audit are preserved; a repeat revoke
// surfaces the store's typed `connector_instance_inactive` through `handleError`.
export function mountRefConnectionRevoke(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.post(
    "/_ref/connections/:connectorInstanceId/revoke",
    { contract: "refRevokeConnection" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const ownerSubjectId = ctx.getOwnerSubjectId(req);
      let connectionId: string | null = null;
      let connectorKey: string | null = null;
      try {
        const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
        connectionId = connectorInstanceId;
        const namespace = await resolveRefConnectionNamespace(ctx, req, connectorInstanceId);
        connectionId = namespace.connectorInstanceId;
        connectorKey = ctx.canonicalConnectorKey(namespace.connectorId) ?? namespace.connectorId;
        const stamp = ctx.now ? ctx.now() : new Date().toISOString();
        const revoked = await Promise.resolve(
          ctx.updateConnectorInstanceStatus(namespace.connectorInstanceId, {
            status: "revoked",
            updatedAt: stamp,
            revokedAt: stamp,
          })
        );
        ctx.invalidateConnectorSummariesCache?.();
        // Scoped, awaited dirty marking: the soft revoke changed this
        // connection's lifecycle evidence (status/revoked_at). Instance id known.
        await ctx.markConnectorSummaryEvidenceDirty?.({
          connectorInstanceId: namespace.connectorInstanceId,
          reason: "ref revoke changed connection lifecycle evidence",
        });
        await emitConnectionControlAudit(ctx, res, {
          connectionId,
          connectorKey,
          eventType: "owner_agent.connection.revoke",
          operation: "revoke",
          outcome: "succeeded",
          ownerSubjectId,
        });
        res.status(200).json({
          object: "ref_connection_revoke",
          connection_id: connectionId,
          connector_id: connectorKey,
          connector_key: connectorKey,
          status: revoked.status ?? "revoked",
          revoked_at: revoked.revokedAt ?? stamp,
        });
      } catch (err) {
        await emitConnectionControlAudit(ctx, res, {
          connectionId,
          connectorKey,
          error: err,
          eventType: "owner_agent.connection.revoke",
          operation: "revoke",
          outcome: "failed",
          ownerSubjectId,
        });
        ctx.handleError(res, err);
      }
    }
  );
}

// DELETE /_ref/connections/:connectorInstanceId — owner-session delete of one
// configured connection. Delegates to the shared `deleteConnection` cascade
// (ownership + active-run + default-account guards live in the store), emits a
// non-secret delete audit with the deletion summary, and returns the summary so
// the console can confirm what was erased. The store's typed
// `connection_run_active` / `default_account_delete_unsupported` /
// `connector_instance_not_found` errors flow through `handleError` unchanged.
export function mountRefConnectionDelete(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.delete(
    "/_ref/connections/:connectorInstanceId",
    { contract: "refDeleteConnection" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const ownerSubjectId = ctx.getOwnerSubjectId(req);
      let connectionId: string | null = decodeURIComponent(req.params.connectorInstanceId as string);
      let connectorKey: string | null = null;
      try {
        const now = ctx.now ? ctx.now() : undefined;
        const summary = await ctx.deleteConnection(connectionId as string, { ownerSubjectId, now });
        connectionId = summary.connection_id;
        connectorKey = ctx.canonicalConnectorKey(summary.connector_id) ?? summary.connector_id;
        ctx.invalidateConnectorSummariesCache?.();
        // Scoped, awaited dirty marking: the delete cascade removed this
        // connection from canonical state, so its maintained summary row is now
        // stale; a later reconcile drops the dirty vanished row. Instance id known.
        await ctx.markConnectorSummaryEvidenceDirty?.({
          connectorInstanceId: connectionId,
          reason: "ref delete removed the connection from canonical state",
        });
        await emitConnectionControlAudit(ctx, res, {
          connectionId,
          connectorKey,
          deletionSummary: summary,
          eventType: "owner_agent.connection.delete",
          operation: "delete",
          outcome: "succeeded",
          ownerSubjectId,
        });
        res.status(200).json({
          object: "ref_connection_delete",
          connection_id: summary.connection_id,
          connector_id: connectorKey,
          connector_key: connectorKey,
          deleted: true,
          deleted_record_count: summary.deleted_record_count,
          deleted_stream_count: summary.deleted_stream_count,
          schedule_deleted: summary.schedule_deleted,
          device_refs_cleared: summary.device_refs_cleared,
        });
      } catch (err) {
        await emitConnectionControlAudit(ctx, res, {
          connectionId,
          connectorKey,
          error: err,
          eventType: "owner_agent.connection.delete",
          operation: "delete",
          outcome: "failed",
          ownerSubjectId,
        });
        ctx.handleError(res, err);
      }
    }
  );
}

// POST /_ref/connections/:connectorInstanceId/reactivate — owner-session
// reactivate of one revoked connection. Resolves through the shared namespace
// resolver with `allowStatuses: ['revoked']` so only a revoked instance is
// accepted (active → connector_instance_inactive → re-labeled
// connector_instance_not_revoked 409; foreign/unknown → not_found 404). Flips
// the instance from `revoked` to `active`, clears `revoked_at`, and emits a
// non-secret reactivate audit. Zero cascade: already-collected records, grants,
// schedule, and spine evidence are untouched. Credential freshness is delegated
// to the next collection run exactly as Plaid's update-mode pattern does.
export function mountRefConnectionReactivate(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.post(
    "/_ref/connections/:connectorInstanceId/reactivate",
    { contract: "refReactivateConnection" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      const ownerSubjectId = ctx.getOwnerSubjectId(req);
      let connectionId: string | null = null;
      let connectorKey: string | null = null;
      try {
        const connectorInstanceId = decodeURIComponent(req.params.connectorInstanceId as string);
        connectionId = connectorInstanceId;
        // Resolve with allowStatuses: ['revoked'] — ownership is verified,
        // active connections surface as connector_instance_inactive (400) which
        // we re-label as connector_instance_not_revoked (409).
        let namespace: ConnectorNamespace;
        try {
          namespace = await resolveRefConnectionNamespace(ctx, req, connectorInstanceId, {
            allowStatuses: ["revoked"],
          });
        } catch (resolveErr) {
          const code = (resolveErr as { code?: unknown })?.code;
          if (code === "connector_instance_inactive") {
            ctx.pdppError(
              res,
              409,
              "connector_instance_not_revoked",
              `Connection '${connectorInstanceId}' is not revoked; only revoked connections can be reactivated.`
            );
            return;
          }
          throw resolveErr;
        }
        connectionId = namespace.connectorInstanceId;
        connectorKey = ctx.canonicalConnectorKey(namespace.connectorId) ?? namespace.connectorId;
        const stamp = ctx.now ? ctx.now() : new Date().toISOString();
        const reactivated = await Promise.resolve(
          ctx.updateConnectorInstanceStatus(namespace.connectorInstanceId, {
            status: "active",
            updatedAt: stamp,
            revokedAt: null,
          })
        );
        ctx.invalidateConnectorSummariesCache?.();
        // Scoped, awaited dirty marking: reactivation flips status back to active
        // and clears revoked_at — both durable summary evidence. Instance id known.
        await ctx.markConnectorSummaryEvidenceDirty?.({
          connectorInstanceId: namespace.connectorInstanceId,
          reason: "ref reactivate changed connection lifecycle evidence",
        });
        await emitConnectionControlAudit(ctx, res, {
          connectionId,
          connectorKey,
          eventType: "owner_agent.connection.reactivate",
          operation: "reactivate",
          outcome: "succeeded",
          ownerSubjectId,
        });
        res.status(200).json({
          object: "ref_connection_reactivate",
          connection_id: connectionId,
          connector_id: connectorKey,
          connector_key: connectorKey,
          status: reactivated.status ?? "active",
          reactivated_at: stamp,
        });
      } catch (err) {
        await emitConnectionControlAudit(ctx, res, {
          connectionId,
          connectorKey,
          error: err,
          eventType: "owner_agent.connection.reactivate",
          operation: "reactivate",
          outcome: "failed",
          ownerSubjectId,
        });
        ctx.handleError(res, err);
      }
    }
  );
}
