// HTTP adapter for the bearer-authed owner-agent control surface routes
// `GET /v1/owner/connections` and `PATCH /v1/owner/connections/:connectionId`
// (rename).
//
// This is the owner-agent (bearer) sibling of the cookie-authed
// `/_ref/connections` listing in `server/routes/ref-connectors.ts`. Per the
// owner-agent control-surface audit (Lane B) it lives in the `/v1/owner/*`
// route family so it reuses the existing owner-bearer guards
// (`requireToken` + `requireOwner`) without teaching `requireOwnerSession`
// (cookie) a second identity source. `/mcp` owner-bearer rejection
// (`requireClientOrMcpPackage`) is untouched.
//
// The route reuses the connector-instance store, the connector-key
// canonicalizer, and the public-read display-name projection so the
// owner-agent surface agrees with public read on `connection_id`,
// `display_name`, and the fallback/label-needed distinction.
//
// Spec: openspec/changes/add-owner-agent-control-surface/specs/
//       reference-owner-agent-control-surface/spec.md
//       (#"Owner-agent control SHALL distinguish connector templates from
//         connection instances")
//       openspec/changes/add-owner-agent-control-surface/specs/
//       reference-connector-instances/spec.md
//       (#"Owner control surfaces SHALL expose connection identity before
//         instance operations")

import type { OwnerAgentControlAction } from "../metadata.ts";
import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/ref-connectors.ts` and `server/routes/rs-mutation.ts`.

interface RouteRequest {
  readonly body?: unknown;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly tokenInfo?: {
    readonly client_id?: string | null;
    readonly client_name?: string | null;
    readonly pdpp_token_kind?: string | null;
    readonly scenario_id?: string | null;
    readonly subject_id?: string | null;
  } | null;
}

interface RouteResponse {
  getHeader(name: string): string | number | string[] | undefined;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): void;
  status(code: number): RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;
type NextFn = () => unknown | Promise<unknown>;

interface AppLike {
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
  patch(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

// Minimal connector-instance shape this adapter projects. The substrate
// store carries additional fields; these are the ones the projection reads.
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

interface ConnectorInstanceStore {
  get(connectorInstanceId: string): Promise<ConnectorInstanceRow | null> | ConnectorInstanceRow | null;
  listByOwner(ownerSubjectId: string): Promise<ConnectorInstanceRow[]> | ConnectorInstanceRow[];
  setDisplayName(
    connectorInstanceId: string,
    options: { ownerSubjectId: string; displayName: string; updatedAt: string }
  ): Promise<ConnectorInstanceRow>;
}

interface TraceContext {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly trace_id: string;
}

export interface MountOwnerConnectionsContext {
  // Projects the instance-scoped subset of the owner-agent control catalog for
  // one connection, from the same single source of truth `GET /v1/owner/control`
  // reads, so a row's `supported_actions` can never disagree with the control
  // document. Supported instance actions carry the connection's concrete URL.
  buildOwnerConnectionSupportedActions(input: { connectionId: string; resource: string }): OwnerAgentControlAction[];
  canonicalConnectorKey(value: string | null | undefined): string | null;
  createRequestConnectorInstanceStore(): ConnectorInstanceStore;
  createTraceContext(input?: { scenarioId?: string }): TraceContext;
  emitSpineEvent(event: Record<string, unknown>): Promise<unknown>;
  ensureRequestId(res: RouteResponse): string;
  getOwnerTokenSubjectId(req: unknown): string;
  handleError(res: unknown, err: unknown): void;
  invalidateConnectorSummariesCache?(): void;
  listSchedules(): Promise<ScheduleRow[]> | ScheduleRow[];
  // Wall-clock stamp for the `updated_at` recorded on rename. Injected so the
  // route stays deterministic under test and so this module does not import a
  // clock. Defaults to `new Date().toISOString()` at the call site.
  now?(): string;
  pdppError: PdppErrorFn;
  // Filters a stored `display_name` to an owner-meaningful label, or `null`
  // when the value is a storage-layer placeholder / connector-type fallback.
  // Reused from `server/connection-id-request.js` so this surface agrees
  // with public read on what counts as "label-needed".
  projectStorageDisplayName(
    displayName: string | null | undefined,
    options: { connectorId?: string | null; connectorInstanceId?: string | null }
  ): string | null;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  // Resolves the caller-visible trusted RS public base for this request (same
  // forwarded-origin handling as the control entrypoint), so a row's
  // `supported_actions` URLs name the advertised resource exactly.
  resolveResource(req: unknown): string;
  resolveSingleConnectorIdQueryValue(raw: unknown): string | null;
  setReferenceTraceId(res: RouteResponse, traceId: string): void;
}

// Owner-agent projection of a connector instance. Standardizes on
// `connection_id` as the stable selector and keeps `connector_instance_id`
// as a deprecated alias for compatibility with older clients. Emits both
// `connector_id` and `connector_key` (canonicalized) so an agent can match
// the connector type regardless of which identifier it persisted. Surfaces
// `label_status` so an agent can tell an owner-chosen label
// (`owner_set`) from a storage-layer fallback (`fallback`, i.e.
// label-needed) without re-deriving the placeholder rules.
function projectOwnerConnection(
  ctx: MountOwnerConnectionsContext,
  instance: ConnectorInstanceRow,
  schedulesByInstanceId: ReadonlyMap<string, unknown>,
  resource: string
): Record<string, unknown> {
  const connectorKey = ctx.canonicalConnectorKey(instance.connectorId) ?? instance.connectorId;
  const ownerMeaningfulName = ctx.projectStorageDisplayName(instance.displayName, {
    connectorId: connectorKey,
    connectorInstanceId: instance.connectorInstanceId,
  });
  const labelStatus = ownerMeaningfulName ? "owner_set" : "fallback";
  return {
    object: "owner_connection",
    connection_id: instance.connectorInstanceId,
    // Deprecated alias for the stable `connection_id` selector. Kept for
    // compatibility; agents SHOULD persist `connection_id`.
    connector_instance_id: instance.connectorInstanceId,
    connector_id: connectorKey,
    connector_key: connectorKey,
    // The raw stored display name (may be a fallback). `label_status`
    // tells the agent whether this is owner-meaningful or label-needed.
    display_name: instance.displayName,
    label_status: labelStatus,
    status: instance.status,
    source_kind: instance.sourceKind,
    source_binding: instance.sourceBinding,
    created_at: instance.createdAt,
    updated_at: instance.updatedAt,
    revoked_at: instance.revokedAt,
    schedule: schedulesByInstanceId.get(instance.connectorInstanceId) || null,
    // Capability-advertised, instance-scoped control actions for this exact
    // connection (design.md #5). Projected from the same control catalog
    // `GET /v1/owner/control` reads. Supported actions (`rename_connection`)
    // carry this connection's concrete URL; unavailable actions are marked
    // `owner_mediated`/`unsupported` with a typed reason rather than omitted, so
    // an agent never probes a 404 and the fallback/label-needed row always names
    // its supported rename action.
    supported_actions: ctx.buildOwnerConnectionSupportedActions({
      connectionId: instance.connectorInstanceId,
      resource,
    }),
  };
}

function connectorIdMatchesFilter(
  ctx: MountOwnerConnectionsContext,
  instance: ConnectorInstanceRow,
  connectorId: string | null
): boolean {
  if (!connectorId) {
    return true;
  }
  return (ctx.canonicalConnectorKey(instance.connectorId) ?? instance.connectorId) === connectorId;
}

function httpStatusForAuditError(err: unknown): number {
  const code = (err as { code?: unknown })?.code;
  if (code === "invalid_request") {
    return 400;
  }
  if (code === "authentication_error") {
    return 401;
  }
  if (code === "permission_error") {
    return 403;
  }
  if (code === "connector_instance_not_found") {
    return 404;
  }
  return 500;
}

function buildAuditTrace(ctx: MountOwnerConnectionsContext, req: RouteRequest, res: RouteResponse): TraceContext {
  const scenarioId = typeof req.tokenInfo?.scenario_id === "string" ? req.tokenInfo.scenario_id : undefined;
  const trace = scenarioId ? ctx.createTraceContext({ scenarioId }) : ctx.createTraceContext();
  const requestId = ctx.ensureRequestId(res);
  ctx.setReferenceTraceId(res, trace.trace_id);
  return {
    request_id: requestId,
    scenario_id: trace.scenario_id,
    trace_id: trace.trace_id,
  };
}

function auditActorKind(req: RouteRequest): "owner_agent" | "client" | "mcp_package" | "unknown" {
  const kind = req.tokenInfo?.pdpp_token_kind;
  if (kind === "owner") {
    return "owner_agent";
  }
  if (kind === "client" || kind === "mcp_package") {
    return kind;
  }
  return "unknown";
}

async function emitOwnerConnectionRenameAudit(
  ctx: MountOwnerConnectionsContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectionId: string;
    connectorKey?: string | null;
    displayNameSupplied?: boolean;
    error?: unknown;
    labelStatus?: string | null;
    ownerSubjectId?: string | null;
    outcome: "succeeded" | "failed";
  }
): Promise<void> {
  const trace = buildAuditTrace(ctx, req, res);
  const clientId = typeof req.tokenInfo?.client_id === "string" ? req.tokenInfo.client_id : null;
  const clientName = typeof req.tokenInfo?.client_name === "string" ? req.tokenInfo.client_name : null;
  const actorKind = auditActorKind(req);
  const ownerSubjectId =
    args.ownerSubjectId ?? (typeof req.tokenInfo?.subject_id === "string" ? req.tokenInfo.subject_id : null);
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    event_type: "owner_agent.connection.rename",
    trace_id: trace.trace_id,
    scenario_id: trace.scenario_id,
    request_id: trace.request_id,
    actor_type: actorKind,
    actor_id: clientId ?? ownerSubjectId ?? actorKind,
    subject_type: "subject",
    subject_id: ownerSubjectId,
    client_id: clientId,
    object_type: "connection",
    object_id: args.connectionId || "unknown_connection",
    status: args.outcome,
    data: {
      auth_token_kind: req.tokenInfo?.pdpp_token_kind ?? null,
      actor_kind: actorKind,
      client_id: clientId,
      client_name: clientName,
      connection_id: args.connectionId,
      connector_key: args.connectorKey ?? null,
      display_name_supplied: args.displayNameSupplied ?? true,
      label_status: args.labelStatus ?? null,
      operation: "rename_connection",
      outcome: args.outcome,
      target_resource: "connection",
      ...(args.error
        ? {
            error: {
              code: typeof code === "string" ? code : "api_error",
              http_status: httpStatusForAuditError(args.error),
            },
          }
        : {}),
    },
  });
}

function buildOwnerConnectionRenameRequireOwner(ctx: MountOwnerConnectionsContext): MiddlewareHandler {
  return async (...args: unknown[]) => {
    const [req, res, next] = args as [RouteRequest, RouteResponse, NextFn];
    if (req.tokenInfo?.pdpp_token_kind === "owner") {
      await next();
      return;
    }
    const connectionId = decodeURIComponent(req.params.connectionId as string);
    const err = new Error("Owner token required") as Error & { code: string };
    err.code = "permission_error";
    await emitOwnerConnectionRenameAudit(ctx, req, res, {
      connectionId,
      error: err,
      outcome: "failed",
      ownerSubjectId: typeof req.tokenInfo?.subject_id === "string" ? req.tokenInfo.subject_id : null,
    });
    ctx.pdppError(res, 403, "permission_error", "Owner token required");
  };
}

// GET /v1/owner/connections — bearer-authed owner-agent listing of every
// configured connection instance for the authenticated owner. Mirrors the
// cookie-authed `/_ref/connections` listing's filtering and projection
// semantics but emits the owner-agent contract (`connection_id`,
// `connector_key`, `label_status`).
export function mountOwnerConnectionsList(app: AppLike, ctx: MountOwnerConnectionsContext): void {
  app.get(
    "/v1/owner/connections",
    { contract: "ownerListConnections" },
    ctx.requireToken,
    ctx.requireOwner,
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
        const resource = ctx.resolveResource(req);
        const rawConnectorId = ctx.resolveSingleConnectorIdQueryValue(req.query.connector_id);
        // Canonicalize the owner-supplied connector_id filter so a URL-shaped
        // value (e.g. https://registry.pdpp.org/connectors/amazon) matches the
        // canonical key the instances are stored under. Same boundary handling
        // as `/_ref/connections`.
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
          .map((instance) => projectOwnerConnection(ctx, instance, schedulesByInstanceId, resource));
        res.json({ object: "list", data });
      } catch (err) {
        ctx.handleError(res, err);
      }
    }
  );
}

// PATCH /v1/owner/connections/:connectionId — bearer-authed owner-agent rename
// of a connection's owner-meaningful `display_name`. This is the owner-agent
// (bearer) sibling of the cookie-authed `PATCH /_ref/connections/:id` route. It
// shares the connector-instance store's rename semantics
// (`store.setDisplayName`, owner-scoped WHERE clause, ≤200-char validation) so
// the two auth surfaces converge on one mutation path, while keeping their auth
// adapters (`requireToken` + `requireOwner` vs `requireOwnerSession`) separate.
//
// The store's update is owner-scoped: a `connection_id` belonging to another
// owner matches zero rows and surfaces as `connector_instance_not_found` (404),
// so a stolen id cannot cross owners even though no separate preflight runs.
//
// On success the row is re-projected through `projectOwnerConnection`, so the
// response carries the owner-agent contract (`connection_id`, `connector_key`,
// `label_status`) and an owner-set rename reports `label_status: "owner_set"`.
//
// Auth: owner bearer (`pdpp_token_kind: "owner"`). Client and `mcp_package`
// bearers are rejected with 403 by `requireOwner`; a missing bearer is rejected
// with 401 by `requireToken`. `/mcp` owner-bearer rejection is untouched.
//
// Spec: openspec/changes/add-owner-agent-control-surface/specs/
//       reference-owner-agent-control-surface/spec.md
//       (#"Owner-agent control mutations SHALL be auditable and secret-safe"
//         → "Owner agent renames a connection")
export function mountOwnerConnectionRename(app: AppLike, ctx: MountOwnerConnectionsContext): void {
  app.patch(
    "/v1/owner/connections/:connectionId",
    { contract: "ownerSetConnectionDisplayName" },
    ctx.requireToken,
    buildOwnerConnectionRenameRequireOwner(ctx),
    async (req: RouteRequest, res: RouteResponse) => {
      try {
        const connectionId = decodeURIComponent(req.params.connectionId as string);
        const body = (req.body as Record<string, unknown> | null) || {};
        const displayName = body.display_name;
        // Validate at the boundary so a malformed request is a typed 400 before
        // the store is touched, matching the `/_ref` PATCH behaviour and the
        // contract's `display_name` body schema.
        if (typeof displayName !== "string" || !displayName.trim()) {
          const err = new Error("display_name must be a non-empty string") as Error & { code: string; param: string };
          err.code = "invalid_request";
          err.param = "display_name";
          await emitOwnerConnectionRenameAudit(ctx, req, res, {
            connectionId,
            displayNameSupplied: Object.hasOwn(body, "display_name"),
            error: err,
            outcome: "failed",
            ownerSubjectId: ctx.getOwnerTokenSubjectId(req),
          });
          ctx.pdppError(res, 400, "invalid_request", "display_name must be a non-empty string", "display_name");
          return;
        }
        const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
        const store = ctx.createRequestConnectorInstanceStore();
        const updated = await store.setDisplayName(connectionId, {
          ownerSubjectId,
          displayName: displayName.trim(),
          updatedAt: ctx.now ? ctx.now() : new Date().toISOString(),
        });
        ctx.invalidateConnectorSummariesCache?.();
        const schedules = await ctx.listSchedules();
        const schedulesByInstanceId = new Map<string, unknown>(
          schedules
            .filter((schedule) => schedule?.connector_instance_id)
            .map((schedule) => [schedule.connector_instance_id as string, schedule])
        );
        const resource = ctx.resolveResource(req);
        const projected = projectOwnerConnection(ctx, updated, schedulesByInstanceId, resource);
        await emitOwnerConnectionRenameAudit(ctx, req, res, {
          connectionId,
          connectorKey: typeof projected.connector_key === "string" ? projected.connector_key : null,
          labelStatus: typeof projected.label_status === "string" ? projected.label_status : null,
          outcome: "succeeded",
          ownerSubjectId,
        });
        res.json(projected);
      } catch (err) {
        const connectionId = decodeURIComponent(req.params.connectionId as string);
        await emitOwnerConnectionRenameAudit(ctx, req, res, {
          connectionId,
          error: err,
          outcome: "failed",
          ownerSubjectId: ctx.getOwnerTokenSubjectId(req),
        });
        ctx.handleError(res, err);
      }
    }
  );
}
