// HTTP adapter for the bearer-authed owner-agent run-now control routes:
//
//   POST /v1/owner/connections/:connectionId/run
//   POST /v1/owner/connectors/:connectorId/run
//
// These are the owner-agent (bearer) siblings of the cookie-authed
// `/_ref/connections/:connectorInstanceId/run` and
// `/_ref/connectors/:connectorId/run` routes in
// `server/routes/ref-connectors.ts`. They live in the `/v1/owner/*` route
// family and reuse the existing owner-bearer guards (`requireToken` +
// `requireOwner`) without teaching `requireOwnerSession` (cookie) a second
// identity source. `/mcp` owner-bearer rejection (`requireClientOrMcpPackage`)
// is untouched.
//
// Both surfaces converge on ONE mutation path — the controller's `runNow`,
// owner-scoped via the connector-instance namespace resolver — under separate
// auth adapters, so the run semantics (async 202 with the run handle, typed
// `run_already_active` 409, preconditions validation) are shared, not cloned.
//
// Instance scoping (design.md #5, tasks 6.1-6.3):
//   - the `:connectionId` route is addressed by a single `connection_id`
//     (== `connector_instance_id`); the resolver verifies owner ownership +
//     active status and runs exactly that connection.
//   - the `:connectorId` route is addressed by connector type only; the
//     resolver auto-selects the connector's single active connection. When the
//     owner has more than one active connection for that connector the request
//     is rejected with a typed `ambiguous_connection` (409) carrying the
//     available `connection_id` values (+ owner-meaningful labels) and
//     `retry_with: connection_id`, instead of guessing which connection to run.
//
// Every run attempt (success and failure) emits non-secret
// `owner_agent.connection.run` spine evidence: actor kind, client id/name,
// target connection/connector, operation, outcome, request id. Bearer tokens
// and secrets are never logged.
//
// Spec: openspec/changes/add-owner-agent-control-surface/specs/
//       reference-owner-agent-control-surface/spec.md
//       (#"Owner-agent control SHALL advertise and enforce per-connection
//         actions" → "Agent inspects available actions" (run now) +
//         "Agent targets connector type when instance is ambiguous";
//        #"Owner-agent control mutations SHALL be auditable and secret-safe"
//         → "Mutation fails")

import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";
import { codeToStatus } from "./ref-error-status.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/owner-connection-schedule.ts`.

interface RouteRequest {
  readonly body?: Readonly<Record<string, unknown>> | null;
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
  end(): unknown;
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

export interface MountOwnerConnectionRunContext {
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
  // Controller run-now. Owner-scoped because the namespace was already resolved
  // owner-side; the controller starts a run for the resolved instance and
  // returns the run handle (`{ run_id, trace_id, ... }`) immediately.
  //
  // `force: true` bypasses the provider-pressure cooldown gate. Callers MUST
  // NOT pass force for the ordinary `Sync now` path; it is reserved for an
  // explicitly-named "force run despite pressure" action.
  runNow(connectorId: string, options: { connectorInstanceId?: string | null; force?: boolean }): Promise<unknown>;
  setReferenceTraceId(res: RouteResponse, traceId: string): void;
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

function httpStatusForRunError(err: unknown): number {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? (codeToStatus[code] ?? 500) : 500;
}

function buildAuditTrace(ctx: MountOwnerConnectionRunContext, req: RouteRequest, res: RouteResponse): TraceContext {
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

// Emits one non-secret `owner_agent.connection.run` spine event. The `selector`
// records whether the action was addressed by `connection_id` or by
// `connector_id` (the latter is the path that can be ambiguous). The audit
// never carries the bearer token or any provider secret.
async function emitRunAudit(
  ctx: MountOwnerConnectionRunContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectionId?: string | null;
    connectorKey?: string | null;
    error?: unknown;
    outcome: "succeeded" | "failed";
    ownerSubjectId?: string | null;
    runId?: string | null;
    selector: "connection_id" | "connector_id";
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
    event_type: "owner_agent.connection.run",
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
      operation: "run_now",
      outcome: args.outcome,
      run_id: args.runId ?? null,
      target_resource: "connection_run",
      ...(args.error
        ? {
            error: {
              code: typeof code === "string" ? code : "api_error",
              http_status: httpStatusForRunError(args.error),
            },
          }
        : {}),
    },
  });
}

// Separate owner guard that emits a failed-authorization audit event before
// rejecting a non-owner bearer, mirroring the schedule route. Keeps the audit
// trail complete for client/mcp_package bearers that reach the route.
function buildRunRequireOwner(
  ctx: MountOwnerConnectionRunContext,
  selector: "connection_id" | "connector_id"
): MiddlewareHandler {
  return async (...args: unknown[]) => {
    const [req, res, next] = args as [RouteRequest, RouteResponse, NextFn];
    if (req.tokenInfo?.pdpp_token_kind === "owner") {
      await next();
      return;
    }
    const err = new Error("Owner token required") as Error & { code: string };
    err.code = "permission_error";
    const { connectionId, connectorKey } = readRunTarget(ctx, req, selector);
    await emitRunAudit(ctx, req, res, {
      connectionId,
      connectorKey,
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
function readRunTarget(
  ctx: MountOwnerConnectionRunContext,
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
  ctx: MountOwnerConnectionRunContext,
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

function readRunId(started: unknown): string | null {
  const id = (started as { run_id?: unknown } | null)?.run_id;
  return typeof id === "string" ? id : null;
}

// Shared handler body for both routes. `selector` chooses connector-only vs
// connection-scoped addressing; the namespace-resolution and ambiguity path is
// identical to the schedule routes. On success the controller's run handle is
// returned as 202 (the run resolves asynchronously; callers poll the run
// projection).
function buildRunHandler(
  ctx: MountOwnerConnectionRunContext,
  selector: "connection_id" | "connector_id"
): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
    let connectionId: string | null = null;
    let connectorKey: string | null = null;
    try {
      let namespace: ConnectorNamespace;
      if (selector === "connection_id") {
        const addressed = decodeURIComponent(req.params.connectionId as string);
        connectionId = addressed;
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

      // `force` must be explicitly `true` in the request body; any other value
      // (absent, null, false, non-boolean) is treated as an ordinary safe run.
      const force = (req.body as Record<string, unknown> | null | undefined)?.force === true;
      const started = await ctx.runNow(namespace.connectorId, {
        connectorInstanceId: namespace.connectorInstanceId,
        force,
      });
      await emitRunAudit(ctx, req, res, {
        connectionId,
        connectorKey,
        outcome: "succeeded",
        ownerSubjectId,
        runId: readRunId(started),
        selector,
      });
      res.status(202).json(started);
    } catch (err) {
      await emitRunAudit(ctx, req, res, {
        connectionId,
        connectorKey,
        error: err,
        outcome: "failed",
        ownerSubjectId,
        selector,
      });
      ctx.handleError(res, err);
    }
  };
}

export function mountOwnerConnectionRun(app: AppLike, ctx: MountOwnerConnectionRunContext): void {
  app.post(
    "/v1/owner/connections/:connectionId/run",
    { contract: "ownerRunConnection" },
    ctx.requireToken,
    buildRunRequireOwner(ctx, "connection_id"),
    buildRunHandler(ctx, "connection_id")
  );
  app.post(
    "/v1/owner/connectors/:connectorId/run",
    { contract: "ownerRunConnector" },
    ctx.requireToken,
    buildRunRequireOwner(ctx, "connector_id"),
    buildRunHandler(ctx, "connector_id")
  );
}
