// HTTP adapter for the reference-only `/_ref/connectors`,
// `/_ref/connections`, and `/_ref/connector-instances` route family —
// catalog list/detail, schedule read, connection list/detail, connection
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
import { executeRefConnectorsList } from "../../operations/ref-connectors-list/index.ts";

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
  json(body: unknown): unknown;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;
type MiddlewareHandler = (...args: unknown[]) => unknown;
// Config objects (e.g. `{ contract: 'opId' }`) may appear in the args
// list alongside middlewares and the final handler, matching transport.js's
// registration convention.
type RouteArg = Readonly<{ contract?: string }> | MiddlewareHandler | RouteHandler;

interface AppLike {
  delete(path: string, ...args: RouteArg[]): AppLike;
  get(path: string, ...args: RouteArg[]): AppLike;
  patch(path: string, ...args: RouteArg[]): AppLike;
  post(path: string, ...args: RouteArg[]): AppLike;
  put(path: string, ...args: RouteArg[]): AppLike;
}

type PdppErrorFn = (
  res: unknown,
  status: number,
  code: string,
  message: string | undefined,
  param?: string | null,
  extras?: Readonly<Record<string, unknown>> | null
) => unknown;

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

interface OwnerNamespaceOptions {
  readonly allowDefaultAccount?: boolean;
  readonly connectorInstanceId?: string | null;
  readonly ownerSubjectId?: string;
}

export interface MountRefConnectorsContext {
  createRequestConnectorInstanceStore(): ConnectorInstanceStore;
  deleteSchedule(connectorId: string, options: { connectorInstanceId?: string | null }): Promise<boolean>;
  getConnectorDetail(connectorId: string): Promise<Record<string, unknown> | null>;
  getOwnerSubjectId(req: unknown): string;
  getSchedule(connectorId: string, options: { connectorInstanceId?: string | null }): Promise<unknown> | unknown;
  handleError(res: unknown, err: unknown): void;
  listConnectorSummaries(): Promise<readonly unknown[]> | readonly unknown[];
  listSchedules(): Promise<ScheduleRow[]> | ScheduleRow[];
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
  runNow(connectorId: string, options: { connectorInstanceId?: string | null }): Promise<unknown>;
  setScheduleEnabled(
    connectorId: string,
    enabled: boolean,
    options: { connectorInstanceId?: string | null }
  ): Promise<unknown>;
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
  connectorInstanceId: string
): Promise<ConnectorNamespace> {
  return ctx.resolveOwnerConnectorNamespace(req, null, {
    ownerSubjectId: ctx.getOwnerSubjectId(req),
    allowDefaultAccount: false,
    connectorInstanceId,
  });
}

// Moved from the `buildAsApp` closure in `server/index.js`. Owner-facing
// projection of a connector instance; the second argument lets list and
// PATCH callers attach the matching schedule from a pre-fetched map.
function projectRefConnection(
  instance: ConnectorInstanceRow,
  schedulesByInstanceId: ReadonlyMap<string, unknown> = new Map()
): Record<string, unknown> {
  return {
    object: "ref_connection",
    connector_instance_id: instance.connectorInstanceId,
    connector_id: instance.connectorId,
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
  res.json(projectRefConnection(source, schedulesByInstanceId));
}

// ─── Catalog list / detail ──────────────────────────────────────────────

// Reference-only connector catalog list. Envelope assembly lives in the
// canonical `ref.connectors.list` operation; this route owns owner auth,
// response writing, and dependency wiring (the substrate read still lives
// in `server/ref-control.ts`).
export function mountRefConnectorsList(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.get(
    "/_ref/connectors",
    { contract: "refListConnectors" },
    ctx.requireOwnerSession,
    async (_req: RouteRequest, res: RouteResponse) => {
      try {
        // The operation expects `RefConnectorsListItem[]`; the host read
        // returns the same shape via `ref-control.ts`. We forward
        // opaquely — the adapter does not redefine the item shape.
        const envelope = await executeRefConnectorsList({
          listConnectorSummaries: () =>
            ctx.listConnectorSummaries() as unknown as ReturnType<
              Parameters<typeof executeRefConnectorsList>[0]["listConnectorSummaries"]
            >,
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
        const connectorId = ctx.resolveSingleConnectorIdQueryValue(req.query.connector_id);
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
          .filter((instance) => !connectorId || instance.connectorId === connectorId)
          .filter((instance) => !status || instance.status === status)
          .map((instance) => projectRefConnection(instance, schedulesByInstanceId));
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
        const connectorId = ctx.resolveSingleConnectorIdQueryValue(req.query.connector_id);
        const status = ctx.resolveSingleConnectorIdQueryValue(req.query.status);
        const store = ctx.createRequestConnectorInstanceStore();
        const instances = await store.listByOwner(ownerSubjectId);
        const data = instances
          .filter((instance) => !connectorId || instance.connectorId === connectorId)
          .filter((instance) => !status || instance.status === status)
          .map((instance) => projectRefConnection(instance));
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
        const schedule = await ctx.getSchedule(updated.connectorId, {
          connectorInstanceId: updated.connectorInstanceId,
        });
        res.json(
          projectRefConnection(
            updated,
            new Map<string, unknown>(schedule ? [[updated.connectorInstanceId, schedule]] : [])
          )
        );
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// ─── Action routes (run / schedule put / pause / resume / delete) ───────

export function mountRefConnectorRun(app: AppLike, ctx: MountRefConnectorsContext): void {
  app.post(
    "/_ref/connectors/:connectorId/run",
    { contract: "refRunConnector" },
    ctx.requireOwnerSession,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectorId = decodeURIComponent(req.params.connectorId as string);
        const namespace = await resolveRefConnectorNamespace(ctx, req, connectorId);
        const started = await ctx.runNow(namespace.connectorId, {
          connectorInstanceId: namespace.connectorInstanceId,
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
        const namespace = await resolveRefConnectionNamespace(ctx, req, connectorInstanceId);
        const started = await ctx.runNow(namespace.connectorId, {
          connectorInstanceId: namespace.connectorInstanceId,
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
        res.status(204).end();
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}
