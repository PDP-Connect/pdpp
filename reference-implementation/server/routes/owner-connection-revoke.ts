// HTTP adapter for the bearer-authed owner-agent connection-revoke control
// routes:
//
//   POST /v1/owner/connections/:connectionId/revoke
//   POST /v1/owner/connectors/:connectorId/revoke
//
// These are the owner-agent (bearer) connection-scoped revoke siblings of the
// run/schedule control routes. There is no cookie-authed `/_ref` revoke route
// to share with: revoke is a NEW owner-agent control surface built directly on
// the existing connector-instance store soft-flip primitive
// (`connectorInstanceStore.updateStatus(id, { status: 'revoked' })`). The route
// adds NO new destructive semantic — it shares that existing store primitive
// under the same owner-bearer auth adapter (`requireToken` + `requireOwner`)
// the run/schedule routes use, without teaching `requireOwnerSession` (cookie)
// a second identity source. `/mcp` owner-bearer rejection
// (`requireClientOrMcpPackage`) is untouched.
//
// What revoke is (and is NOT):
//   - Revoke stops a connection's FUTURE collection: it flips exactly one
//     `connector_instance_id` (== `connection_id`) to status `revoked`. Routine
//     ingest already refuses a non-active instance (the resolver's active-status
//     gate), so no new run/ingest lands for the connection.
//   - Already-collected records, dataset projections, spine evidence, device
//     rows, and SIBLING connections are untouched — revoke is zero-cascade.
//     Records stay readable; revoke is not delete.
//   - It is durable: implicit default-account materialization no longer
//     resurrects a revoked row (the durability guard in
//     `ensureDefaultAccountConnection` + the resolver's non-active fail-closed),
//     so the revoke survives every owner/dashboard read and grant/polyfill scope
//     resolution. A revoked connection is reversible only by an explicit owner
//     re-initiate, never silently.
//
// Ownership + scoping:
//   - the `:connectionId` route resolves the namespace by a single
//     `connection_id` via `resolveOwnerConnectorNamespace(..., allowDefaultAccount:
//     false)`. The resolver verifies `instance.ownerSubjectId === ownerSubjectId`
//     (foreign id → connector_instance_not_found 404) BEFORE any mutation, so a
//     foreign or unknown `connection_id` can never be revoked. The store
//     `updateStatus` itself takes no owner argument, so this resolver guard is
//     the ownership boundary.
//   - the `:connectorId` route is addressed by connector type only; the resolver
//     auto-selects the connector's single active connection, or rejects with a
//     typed `ambiguous_connection` (409) carrying the available `connection_id`
//     values (+ owner-meaningful labels) and `retry_with: connection_id`.
//   - a repeat revoke is repeat-safe-by-typed-error: the active-status gate
//     returns `connector_instance_inactive` (400) for an already-revoked
//     connection, so a second revoke is a clean typed 4xx, not a crash or a
//     silent no-op.
//
// Every revoke attempt (success and failure) emits non-secret
// `owner_agent.connection.revoke` spine evidence: actor kind, client id/name,
// target connection/connector, operation, outcome, request id. Bearer tokens
// and provider secrets are never logged.
//
// Spec: openspec/changes/add-owner-agent-control-surface/specs/
//       reference-owner-agent-control-surface/spec.md
//       (#"Owner-agent control SHALL advertise and enforce per-connection
//         actions";
//        #"Owner-agent control mutations SHALL be auditable and secret-safe")
//       design.md "Deferred: connection-revoke durability" → Unit 2.

import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";
import { codeToStatus } from "./ref-error-status.ts";

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

interface RevokedInstance {
  readonly connectorInstanceId?: string | null;
  readonly revokedAt?: string | null;
  readonly status?: string | null;
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

export interface MountOwnerConnectionRevokeContext {
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
  invalidateConnectorSummariesCache?(): void;
  // Lists the owner's active connection bindings for a connector. Used to
  // populate `available_connections` on the typed ambiguity error.
  listActiveBindingsForGrant(input: {
    ownerSubjectId: string;
    connectorId: string;
  }): Promise<ActiveBinding[]> | ActiveBinding[];
  // Marks the maintained connector-summary read-model evidence for exactly this
  // connection dirty after the revoke mutation commits. Injected (not imported)
  // to match the route-family decoupling pattern and the optional
  // `invalidateConnectorSummariesCache` above. Awaited at the call site so
  // ordering is explicit rather than hidden in a fire-and-forget promise;
  // best-effort and a no-op until the read model is warmed.
  markConnectorSummaryEvidenceDirty?(input: { connectorInstanceId: string; reason?: string }): Promise<void> | void;
  // Wall-clock stamp for the `updated_at` / `revoked_at` recorded on the soft
  // flip. Injected so the route stays deterministic under test and so this
  // module does not import a clock. Defaults to `new Date().toISOString()`.
  now?(): string;
  pdppError: PdppErrorFn;
  // Projects one active binding to the wire `{ connection_id, display_name? }`
  // shape used in `available_connections` (placeholder labels suppressed).
  projectBindingForWire(instance: ActiveBinding): WireConnection | null;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  // Owner-scoped connector-instance namespace resolution. Verifies owner
  // ownership + active status BEFORE the mutation; throws
  // `ConnectorInstanceResolutionError` with `connector_instance_not_found`
  // (foreign/unknown id → 404), `connector_instance_inactive` (already revoked
  // → 400), or `ambiguous_connector_instance` (connector-only, >1 active).
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
  // Connection-scoped soft-flip primitive. Owner-scoped because the namespace
  // was already resolved + ownership-verified owner-side; flips exactly one
  // connector_instance to status `revoked`, zero cascade. Returns the updated
  // row. The SAME store primitive the device-collected and default-account
  // classes share — no new destructive semantic is introduced here.
  updateConnectorInstanceStatus(
    connectorInstanceId: string,
    options: { status: "revoked"; updatedAt: string; revokedAt: string }
  ): Promise<RevokedInstance> | RevokedInstance;
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

function httpStatusForRevokeError(err: unknown): number {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? (codeToStatus[code] ?? 500) : 500;
}

function buildAuditTrace(ctx: MountOwnerConnectionRevokeContext, req: RouteRequest, res: RouteResponse): TraceContext {
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

// Emits one non-secret `owner_agent.connection.revoke` spine event. The
// `selector` records whether the action was addressed by `connection_id` or by
// `connector_id` (the latter is the path that can be ambiguous). The audit
// never carries the bearer token or any provider secret.
async function emitRevokeAudit(
  ctx: MountOwnerConnectionRevokeContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectionId?: string | null;
    connectorKey?: string | null;
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
  const code = (args.error as { code?: unknown } | null)?.code;
  await ctx.emitSpineEvent({
    event_type: "owner_agent.connection.revoke",
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
      operation: "revoke",
      outcome: args.outcome,
      target_resource: "connection",
      ...(args.error
        ? {
            error: {
              code: typeof code === "string" ? code : "api_error",
              http_status: httpStatusForRevokeError(args.error),
            },
          }
        : {}),
    },
  });
}

// Separate owner guard that emits a failed-authorization audit event before
// rejecting a non-owner bearer, mirroring the run/schedule routes. Keeps the
// audit trail complete for client/mcp_package bearers that reach the route.
function buildRevokeRequireOwner(
  ctx: MountOwnerConnectionRevokeContext,
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
    const { connectionId, connectorKey } = readRevokeTarget(ctx, req, selector);
    await emitRevokeAudit(ctx, req, res, {
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
function readRevokeTarget(
  ctx: MountOwnerConnectionRevokeContext,
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
  ctx: MountOwnerConnectionRevokeContext,
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

// Shared handler body for both routes. `selector` chooses connector-only vs
// connection-scoped addressing; the namespace-resolution and ambiguity path is
// identical to the run/schedule routes. On success the soft-flipped connection
// is returned as 200 `{ object: "owner_connection_revoke", connection_id,
// connector_key, status: "revoked", revoked_at }`.
function buildRevokeHandler(
  ctx: MountOwnerConnectionRevokeContext,
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
        // foreign or unknown id surfaces as connector_instance_not_found (404),
        // and an already-revoked connection surfaces as
        // connector_instance_inactive (400), making a repeat revoke a clean
        // typed 4xx. allowDefaultAccount:false so an unmaterialized default
        // account is never created just to revoke it.
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

      const stamp = ctx.now ? ctx.now() : new Date().toISOString();
      const revoked = await Promise.resolve(
        ctx.updateConnectorInstanceStatus(namespace.connectorInstanceId, {
          status: "revoked",
          updatedAt: stamp,
          revokedAt: stamp,
        })
      );
      ctx.invalidateConnectorSummariesCache?.();
      // Scoped, awaited dirty marking for the maintained read model: the soft
      // revoke changed this connection's lifecycle evidence (status/revoked_at),
      // so its summary evidence row is now stale. Instance id is known, so this
      // is a scoped marker rather than a full-table sweep.
      await ctx.markConnectorSummaryEvidenceDirty?.({
        connectorInstanceId: namespace.connectorInstanceId,
        reason: "owner revoke changed connection lifecycle evidence",
      });
      await emitRevokeAudit(ctx, req, res, {
        connectionId,
        connectorKey,
        outcome: "succeeded",
        ownerSubjectId,
        selector,
      });
      res.status(200).json({
        object: "owner_connection_revoke",
        connection_id: connectionId,
        connector_id: connectorKey,
        connector_key: connectorKey,
        status: revoked.status ?? "revoked",
        revoked_at: revoked.revokedAt ?? stamp,
      });
    } catch (err) {
      await emitRevokeAudit(ctx, req, res, {
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

export function mountOwnerConnectionRevoke(app: AppLike, ctx: MountOwnerConnectionRevokeContext): void {
  app.post(
    "/v1/owner/connections/:connectionId/revoke",
    { contract: "ownerRevokeConnection" },
    ctx.requireToken,
    buildRevokeRequireOwner(ctx, "connection_id"),
    buildRevokeHandler(ctx, "connection_id")
  );
  app.post(
    "/v1/owner/connectors/:connectorId/revoke",
    { contract: "ownerRevokeConnector" },
    ctx.requireToken,
    buildRevokeRequireOwner(ctx, "connector_id"),
    buildRevokeHandler(ctx, "connector_id")
  );
}
