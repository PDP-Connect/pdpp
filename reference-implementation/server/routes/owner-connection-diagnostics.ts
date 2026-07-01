// HTTP adapter for the bearer-authed owner-agent connection-diagnostics read:
//
//   GET /v1/owner/connections/:connectionId/diagnostics
//   GET /v1/owner/connectors/:connectorId/diagnostics
//
// These are the owner-agent (bearer) connection-scoped diagnostics reads. They
// live in the `/v1/owner/*` route family and reuse the existing owner-bearer
// guards (`requireToken` + `requireOwner`) without teaching `requireOwnerSession`
// (cookie) a second identity source. `/mcp` owner-bearer rejection
// (`requireClientOrMcpPackage`) is untouched.
//
// Connection-scoped by construction (design.md "Connection-scoped vs owner-wide
// boundary"): the read derives entirely from the ONE configured connection whose
// `connector_instance_id` matches the addressed `connection_id`. The shared
// `getOwnerConnectionDiagnostics` operation reuses `listConnectorSummaries`,
// which already projects per-connection rows carrying no sibling-connection or
// device-exporter-subsystem state — so an agent asking "diagnose connection X"
// never receives owner-wide/device-subsystem health for unrelated siblings. This
// is the structural distinction from the device-rooted
// `GET /_ref/device-exporters/diagnostics`, which the design rejected for an
// owner-bearer adapter precisely because it is broader than one connection.
//
// The response carries the connection's last run status, last successful run,
// last successful ingest time, current schedule state, freshness, typed health
// classification, and the same rendered verdict / required-action projection
// that the console consumes (`healthy` / `degraded` / `blocked` /
// `cooling_off` / `idle` / `needs_attention` / `unknown` — the canonical
// connection-health taxonomy the connector-health-surface research captured).
//
// Instance scoping (design.md #5, tasks 6.1-6.3):
//   - the `:connectionId` route is addressed by a single `connection_id`
//     (== `connector_instance_id`); the resolver verifies owner ownership +
//     active status and reads exactly that connection. A foreign/unknown id
//     surfaces as connector_instance_not_found (404).
//   - the `:connectorId` route is addressed by connector type only; the resolver
//     auto-selects the connector's single active connection. When the owner has
//     more than one active connection for that connector the request is rejected
//     with a typed `ambiguous_connection` (409) carrying the available
//     `connection_id` values (+ owner-meaningful labels) and
//     `retry_with: connection_id`, instead of guessing which connection to read.
//
// Diagnostics is a read, not a mutation, but each request still emits non-secret
// `owner_agent.connection.inspect` spine evidence (actor kind, client id/name,
// target connection/connector, operation, outcome, request id) so an owner can
// audit which agent inspected which connection. Bearer tokens and secrets are
// never logged.
//
// Spec: openspec/changes/add-owner-agent-control-surface/specs/
//       reference-owner-agent-control-surface/spec.md
//       (#"Owner-agent control SHALL advertise and enforce per-connection
//         actions" → "Agent inspects available actions" (inspect diagnostics) +
//         "Agent targets connector type when instance is ambiguous")

import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

// Express-shaped surface, structurally typed to avoid pulling in the
// transport's `.js` ambient types. Matches the pattern established in
// `server/routes/owner-connection-run.ts`.

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
  get(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
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

export interface MountOwnerConnectionDiagnosticsContext {
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
  // Shared connection-scoped diagnostics read. Owner-scoped because the
  // namespace was already resolved owner-side; returns `null` when no
  // configured connection matches the resolved instance id.
  getOwnerConnectionDiagnostics(connectorInstanceId: string): Promise<unknown | null>;
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

function httpStatusForDiagnosticsError(err: unknown): number {
  const code = (err as { code?: unknown })?.code;
  if (code === "authentication_error") {
    return 401;
  }
  if (code === "permission_error") {
    return 403;
  }
  if (code === "connector_instance_not_found" || code === "not_found") {
    return 404;
  }
  if (code === "ambiguous_connection") {
    return 409;
  }
  return 500;
}

function buildAuditTrace(
  ctx: MountOwnerConnectionDiagnosticsContext,
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

// Emits one non-secret `owner_agent.connection.inspect` spine event. The
// `selector` records whether the read was addressed by `connection_id` or by
// `connector_id` (the latter is the path that can be ambiguous). The audit
// never carries the bearer token, diagnostics payload, or any provider secret.
async function emitDiagnosticsAudit(
  ctx: MountOwnerConnectionDiagnosticsContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectionId?: string | null;
    connectorKey?: string | null;
    error?: unknown;
    healthState?: string | null;
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
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    event_type: "owner_agent.connection.inspect",
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
      operation: "inspect_diagnostics",
      outcome: args.outcome,
      // Non-secret health verdict so an owner can see what state the agent
      // observed without re-reading the diagnostics body. `null` on failure.
      health_state: args.healthState ?? null,
      target_resource: "connection_diagnostics",
      ...(args.error
        ? {
            error: {
              code: typeof code === "string" ? code : "api_error",
              http_status: httpStatusForDiagnosticsError(args.error),
            },
          }
        : {}),
    },
  });
}

// Separate owner guard that emits a failed-authorization audit event before
// rejecting a non-owner bearer, mirroring the run route. Keeps the audit trail
// complete for client/mcp_package bearers that reach the route.
function buildDiagnosticsRequireOwner(
  ctx: MountOwnerConnectionDiagnosticsContext,
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
    const { connectionId, connectorKey } = readDiagnosticsTarget(ctx, req, selector);
    await emitDiagnosticsAudit(ctx, req, res, {
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
function readDiagnosticsTarget(
  ctx: MountOwnerConnectionDiagnosticsContext,
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
  ctx: MountOwnerConnectionDiagnosticsContext,
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

function readHealthState(diagnostics: unknown): string | null {
  const health = (diagnostics as { health?: { state?: unknown } } | null)?.health;
  return typeof health?.state === "string" ? health.state : null;
}

// Shared handler body for both routes. `selector` chooses connector-only vs
// connection-scoped addressing; the namespace-resolution and ambiguity path is
// identical to the run/schedule routes. On success the connection-scoped
// diagnostics document is returned as 200.
function buildDiagnosticsHandler(
  ctx: MountOwnerConnectionDiagnosticsContext,
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

      const diagnostics = await ctx.getOwnerConnectionDiagnostics(namespace.connectorInstanceId);
      if (!diagnostics) {
        // The namespace resolved (owner owns an active binding) but the
        // diagnostics read-model has no summary row for it yet (e.g. a
        // connector whose manifest is not a public reference connector). Map
        // to a typed 404 rather than fabricating an empty diagnostic.
        const notFound = new Error(`No diagnostics available for connection: ${connectionId}`) as Error & {
          code: string;
        };
        notFound.code = "connector_instance_not_found";
        await emitDiagnosticsAudit(ctx, req, res, {
          connectionId,
          connectorKey,
          error: notFound,
          outcome: "failed",
          ownerSubjectId,
          selector,
        });
        ctx.pdppError(res, 404, "not_found", notFound.message);
        return;
      }
      await emitDiagnosticsAudit(ctx, req, res, {
        connectionId,
        connectorKey,
        healthState: readHealthState(diagnostics),
        outcome: "succeeded",
        ownerSubjectId,
        selector,
      });
      res.status(200).json(diagnostics);
    } catch (err) {
      await emitDiagnosticsAudit(ctx, req, res, {
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

export function mountOwnerConnectionDiagnostics(app: AppLike, ctx: MountOwnerConnectionDiagnosticsContext): void {
  app.get(
    "/v1/owner/connections/:connectionId/diagnostics",
    { contract: "ownerInspectConnectionDiagnostics" },
    ctx.requireToken,
    buildDiagnosticsRequireOwner(ctx, "connection_id"),
    buildDiagnosticsHandler(ctx, "connection_id")
  );
  app.get(
    "/v1/owner/connectors/:connectorId/diagnostics",
    { contract: "ownerInspectConnectorDiagnostics" },
    ctx.requireToken,
    buildDiagnosticsRequireOwner(ctx, "connector_id"),
    buildDiagnosticsHandler(ctx, "connector_id")
  );
}
