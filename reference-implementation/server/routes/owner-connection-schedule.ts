// HTTP adapter for the bearer-authed owner-agent schedule pause/resume control
// routes:
//
//   POST /v1/owner/connections/:connectionId/schedule/pause
//   POST /v1/owner/connections/:connectionId/schedule/resume
//   POST /v1/owner/connectors/:connectorId/schedule/pause
//   POST /v1/owner/connectors/:connectorId/schedule/resume
//
// These are the owner-agent (bearer) siblings of the cookie-authed
// `/_ref/connections/:id/schedule/{pause,resume}` and
// `/_ref/connectors/:id/schedule/{pause,resume}` routes in
// `server/routes/ref-connectors.ts`. They live in the `/v1/owner/*` route
// family and reuse the existing owner-bearer guards (`requireToken` +
// `requireOwner`) without teaching `requireOwnerSession` (cookie) a second
// identity source. `/mcp` owner-bearer rejection (`requireClientOrMcpPackage`)
// is untouched.
//
// Both surfaces converge on ONE mutation path — the controller's
// `setScheduleEnabled` (owner-scoped via the connector-instance namespace
// resolver) — under separate auth adapters, so the schedule pause/resume
// semantics (schedule-not-found 404, automation-ineligibility 400, scheduler
// refresh on success) are shared, not cloned.
//
// Instance scoping (design.md #5, tasks 6.1-6.3):
//   - the `:connectionId` routes are addressed by a single `connection_id`
//     (== `connector_instance_id`); the resolver verifies owner ownership +
//     active status and pauses/resumes exactly that connection.
//   - the `:connectorId` routes are addressed by connector type only; the
//     resolver auto-selects the connector's single active connection. When the
//     owner has more than one active connection for that connector the request
//     is rejected with a typed `ambiguous_connection` (409) carrying the
//     available `connection_id` values (+ owner-meaningful labels) and
//     `retry_with: connection_id`, instead of guessing which connection to act
//     on.
//
// Every mutation (success and failure) emits non-secret
// `owner_agent.connection.schedule` spine evidence: actor kind, client
// id/name, target connection/connector, operation, outcome, request id. Bearer
// tokens and secrets are never logged.
//
// Spec: openspec/changes/add-owner-agent-control-surface/specs/
//       reference-owner-agent-control-surface/spec.md
//       (#"Owner-agent control SHALL advertise and enforce per-connection
//         actions" → "Agent targets connector type when instance is ambiguous";
//        #"Owner-agent control mutations SHALL be auditable and secret-safe"
//         → "Mutation fails")

import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";
import { codeToStatus } from "./ref-error-status.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/owner-connections.ts`.

interface RouteRequest {
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
  post(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

// Capability-shaped namespace bag — the host resolver returns at least these
// fields. Other resolver-only fields pass through opaquely.
interface ConnectorNamespace {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
}

interface ActiveBinding {
  readonly connectorId?: string | null;
  readonly connectorInstanceId: string;
  readonly displayName?: string | null;
}

interface WireConnection {
  connection_id: string;
  display_name?: string;
}

interface TraceContext {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly trace_id: string;
}

// Typed ambiguity error the host's `AmbiguousConnectionError` produces. The
// host writer (`handleError`) maps `code: "ambiguous_connection"` to HTTP 409
// and copies `available_connections` / `retry_with` onto the envelope.
interface AmbiguousConnectionErrorLike extends Error {
  available_connections: WireConnection[];
  code: string;
  retry_with: string;
}

export interface MountOwnerConnectionScheduleContext {
  // Constructs the typed `ambiguous_connection` error from the available
  // connection rows. Injected (rather than imported) so this adapter stays
  // decoupled from the host's error module, matching the wider route-family
  // pattern.
  AmbiguousConnectionError: new (
    message: string,
    availableConnections: WireConnection[]
  ) => AmbiguousConnectionErrorLike;
  canonicalConnectorKey(value: string | null | undefined): string | null;
  createTraceContext(input?: { scenarioId?: string }): TraceContext;
  emitSpineEvent(event: Record<string, unknown>): Promise<unknown>;
  ensureRequestId(res: RouteResponse): string;
  getOwnerTokenSubjectId(req: unknown): string;
  handleError(res: unknown, err: unknown): void;
  // Lists the owner's active connection bindings for a connector. Used to
  // populate `available_connections` on the typed ambiguity error.
  listActiveBindingsForGrant(input: {
    ownerSubjectId: string;
    connectorId: string;
  }): Promise<ActiveBinding[]> | ActiveBinding[];
  // Scheduler refresh hook fired after a successful pause/resume so the change
  // takes effect immediately. Same callback the cookie-authed `/_ref` schedule
  // routes use. Optional so a controller-less test harness can omit it.
  onScheduleMutation?(): Promise<unknown> | unknown;
  pdppError: PdppErrorFn;
  // Projects one active binding to the wire `{ connection_id, display_name? }`
  // shape used in `available_connections` (placeholder labels suppressed).
  projectBindingForWire(instance: ActiveBinding): WireConnection | null;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  // Owner-scoped connector-instance namespace resolution. Throws
  // `ConnectorInstanceResolutionError` with code `ambiguous_connector_instance`
  // when a connector-only address resolves to more than one active connection.
  resolveOwnerConnectorNamespace(
    req: unknown,
    connectorId: string | null,
    options?: {
      readonly allowDefaultAccount?: boolean;
      readonly connectorInstanceId?: string | null;
      readonly ownerSubjectId?: string;
    }
  ): Promise<ConnectorNamespace>;
  setReferenceTraceId(res: RouteResponse, traceId: string): void;
  // Controller schedule enable/disable. Owner-scoped because the namespace was
  // already resolved owner-side; the controller acts on the resolved instance.
  setScheduleEnabled(
    connectorId: string,
    enabled: boolean,
    options: { connectorInstanceId?: string | null }
  ): Promise<unknown>;
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

function httpStatusForScheduleError(err: unknown): number {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? (codeToStatus[code] ?? 500) : 500;
}

function buildAuditTrace(
  ctx: MountOwnerConnectionScheduleContext,
  req: RouteRequest,
  res: RouteResponse
): TraceContext {
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

// Emits one non-secret `owner_agent.connection.schedule` spine event. The
// `selector` records whether the action was addressed by `connection_id` or by
// `connector_id` (the latter is the path that can be ambiguous). The audit
// never carries the bearer token or any provider secret.
async function emitScheduleAudit(
  ctx: MountOwnerConnectionScheduleContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectionId?: string | null;
    connectorKey?: string | null;
    enabled: boolean;
    error?: unknown;
    outcome: "succeeded" | "failed";
    ownerSubjectId?: string | null;
    selector: "connection_id" | "connector_id";
  }
): Promise<void> {
  const trace = buildAuditTrace(ctx, req, res);
  const clientId = typeof req.tokenInfo?.client_id === "string" ? req.tokenInfo.client_id : null;
  const clientName = typeof req.tokenInfo?.client_name === "string" ? req.tokenInfo.client_name : null;
  const actorKind = auditActorKind(req);
  const ownerSubjectId =
    args.ownerSubjectId ?? (typeof req.tokenInfo?.subject_id === "string" ? req.tokenInfo.subject_id : null);
  const operation = args.enabled ? "resume_schedule" : "pause_schedule";
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    event_type: "owner_agent.connection.schedule",
    trace_id: trace.trace_id,
    scenario_id: trace.scenario_id,
    request_id: trace.request_id,
    actor_type: actorKind,
    actor_id: clientId ?? ownerSubjectId ?? actorKind,
    subject_type: "subject",
    subject_id: ownerSubjectId,
    client_id: clientId,
    object_type: "connection",
    object_id: args.connectionId || args.connectorKey || "unknown_connection",
    status: args.outcome,
    data: {
      auth_token_kind: req.tokenInfo?.pdpp_token_kind ?? null,
      actor_kind: actorKind,
      client_id: clientId,
      client_name: clientName,
      connection_id: args.connectionId ?? null,
      connector_key: args.connectorKey ?? null,
      selector: args.selector,
      operation,
      outcome: args.outcome,
      target_resource: "connection_schedule",
      ...(args.error
        ? {
            error: {
              code: typeof code === "string" ? code : "api_error",
              http_status: httpStatusForScheduleError(args.error),
            },
          }
        : {}),
    },
  });
}

// Separate owner guard that emits a failed-authorization audit event before
// rejecting a non-owner bearer, mirroring the rename route. Keeps the audit
// trail complete for client/mcp_package bearers that reach the route.
function buildScheduleRequireOwner(
  ctx: MountOwnerConnectionScheduleContext,
  selector: "connection_id" | "connector_id",
  enabled: boolean
): MiddlewareHandler {
  return async (...args: unknown[]) => {
    const [req, res, next] = args as [RouteRequest, RouteResponse, NextFn];
    if (req.tokenInfo?.pdpp_token_kind === "owner") {
      await next();
      return;
    }
    const err = new Error("Owner token required") as Error & { code: string };
    err.code = "permission_error";
    const { connectionId, connectorKey } = readScheduleTarget(ctx, req, selector);
    await emitScheduleAudit(ctx, req, res, {
      connectionId,
      connectorKey,
      enabled,
      error: err,
      outcome: "failed",
      ownerSubjectId: typeof req.tokenInfo?.subject_id === "string" ? req.tokenInfo.subject_id : null,
      selector,
    });
    ctx.pdppError(res, 403, "permission_error", "Owner token required");
  };
}

// Reads the addressed target from the request path for audit labelling. For a
// connection-scoped route this is the `connection_id`; for a connector-scoped
// route it is the canonical connector key.
function readScheduleTarget(
  ctx: MountOwnerConnectionScheduleContext,
  req: RouteRequest,
  selector: "connection_id" | "connector_id"
): { connectionId: string | null; connectorKey: string | null } {
  if (selector === "connection_id") {
    const connectionId = req.params.connectionId ? decodeURIComponent(req.params.connectionId) : null;
    return { connectionId, connectorKey: null };
  }
  const raw = req.params.connectorId ? decodeURIComponent(req.params.connectorId) : null;
  const connectorKey = raw ? (ctx.canonicalConnectorKey(raw) ?? raw) : null;
  return { connectionId: null, connectorKey };
}

// Maps the store's connector-only ambiguity (`ambiguous_connector_instance`)
// to the public, typed `ambiguous_connection` (409) error carrying the
// available `connection_id` values + owner-meaningful labels and
// `retry_with: connection_id`. Any other resolver error is rethrown unchanged.
async function rethrowAsAmbiguousConnection(
  ctx: MountOwnerConnectionScheduleContext,
  err: unknown,
  ownerSubjectId: string,
  connectorKey: string
): Promise<never> {
  if ((err as { code?: unknown })?.code !== "ambiguous_connector_instance") {
    throw err;
  }
  const active = await Promise.resolve(ctx.listActiveBindingsForGrant({ ownerSubjectId, connectorId: connectorKey }));
  const available = active
    .map((binding) => ctx.projectBindingForWire(binding))
    .filter((row): row is WireConnection => row !== null);
  throw new ctx.AmbiguousConnectionError(
    `Connector '${connectorKey}' has multiple active connections. Retry with a specific connection_id.`,
    available
  );
}

// Shared handler body for all four routes. `selector` chooses connector-only
// vs connection-scoped addressing; `enabled` chooses resume (true) vs pause
// (false).
function buildScheduleHandler(
  ctx: MountOwnerConnectionScheduleContext,
  selector: "connection_id" | "connector_id",
  enabled: boolean
): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
    let connectionId: string | null = null;
    let connectorKey: string | null = null;
    try {
      let namespace: ConnectorNamespace;
      if (selector === "connection_id") {
        const addressed = decodeURIComponent(req.params.connectionId as string);
        // Resolve by connection_id (== connector_instance_id). The resolver
        // verifies the connection belongs to this owner and is active; a
        // foreign or unknown id surfaces as connector_instance_not_found (404).
        namespace = await ctx.resolveOwnerConnectorNamespace(req, null, {
          ownerSubjectId,
          allowDefaultAccount: false,
          connectorInstanceId: addressed,
        });
      } else {
        const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
        connectorKey = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
        try {
          // connector-only addressing: auto-select the single active
          // connection, or throw ambiguity when more than one exists.
          namespace = await ctx.resolveOwnerConnectorNamespace(req, rawConnectorId, {
            ownerSubjectId,
            allowDefaultAccount: false,
          });
        } catch (resolveErr) {
          await rethrowAsAmbiguousConnection(ctx, resolveErr, ownerSubjectId, connectorKey);
          // rethrowAsAmbiguousConnection always throws; unreachable.
          return;
        }
      }
      connectionId = namespace.connectorInstanceId;
      connectorKey = ctx.canonicalConnectorKey(namespace.connectorId) ?? namespace.connectorId;

      const schedule = await ctx.setScheduleEnabled(namespace.connectorId, enabled, {
        connectorInstanceId: namespace.connectorInstanceId,
      });
      await ctx.onScheduleMutation?.();
      await emitScheduleAudit(ctx, req, res, {
        connectionId,
        connectorKey,
        enabled,
        outcome: "succeeded",
        ownerSubjectId,
        selector,
      });
      res.json(schedule);
    } catch (err) {
      await emitScheduleAudit(ctx, req, res, {
        connectionId,
        connectorKey,
        enabled,
        error: err,
        outcome: "failed",
        ownerSubjectId,
        selector,
      });
      ctx.handleError(res, err);
    }
  };
}

export function mountOwnerConnectionSchedule(app: AppLike, ctx: MountOwnerConnectionScheduleContext): void {
  app.post(
    "/v1/owner/connections/:connectionId/schedule/pause",
    { contract: "ownerPauseConnectionSchedule" },
    ctx.requireToken,
    buildScheduleRequireOwner(ctx, "connection_id", false),
    buildScheduleHandler(ctx, "connection_id", false)
  );
  app.post(
    "/v1/owner/connections/:connectionId/schedule/resume",
    { contract: "ownerResumeConnectionSchedule" },
    ctx.requireToken,
    buildScheduleRequireOwner(ctx, "connection_id", true),
    buildScheduleHandler(ctx, "connection_id", true)
  );
  app.post(
    "/v1/owner/connectors/:connectorId/schedule/pause",
    { contract: "ownerPauseConnectorSchedule" },
    ctx.requireToken,
    buildScheduleRequireOwner(ctx, "connector_id", false),
    buildScheduleHandler(ctx, "connector_id", false)
  );
  app.post(
    "/v1/owner/connectors/:connectorId/schedule/resume",
    { contract: "ownerResumeConnectorSchedule" },
    ctx.requireToken,
    buildScheduleRequireOwner(ctx, "connector_id", true),
    buildScheduleHandler(ctx, "connector_id", true)
  );
}
