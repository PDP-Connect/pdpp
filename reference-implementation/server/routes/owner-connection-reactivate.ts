// HTTP adapter for the bearer-authed owner-agent connection-reactivate control
// routes:
//
//   POST /v1/owner/connections/:connectionId/reactivate
//   POST /v1/owner/connectors/:connectorId/reactivate
//
// Reactivate is the clean inverse of revoke: it flips a single `revoked`
// connection back to `active`, clearing `revoked_at`. Already-collected
// records, grants, and audit are never touched — the transition is a pure
// status flip on the connector-instance row, zero cascade.
//
// This route is the ONLY deliberate path that can move a connection from
// `revoked` to `active`. The durability guard (`ensureDefaultAccountConnection`
// + the resolver's active-only default) prevents any silent resurrection by
// system processes, so reactivation remains an explicit owner act.
//
// Key design choices that mirror `owner-connection-revoke.ts`:
//   - Same auth adapter: `requireToken` + `requireOwner` (bearer owner-kind).
//   - Same resolver (`resolveOwnerConnectorNamespace`) but with
//     `allowStatuses: ['revoked']` so the active-status gate is replaced by a
//     revoked-status gate. This means a foreign/unknown id still surfaces as
//     `connector_instance_not_found` (404) and an already-active connection
//     surfaces as `connector_instance_inactive` (400) from the resolver — the
//     caller then re-labels it as `connector_instance_not_revoked` (409).
//   - Same ambiguity path on the connector-only route
//     (`ambiguous_connector_instance` → `ambiguous_connection` 409).
//   - Same audit event family (`owner_agent.connection.reactivate`) with the
//     same non-secret payload shape.
//   - `updateConnectorInstanceStatus` with `status: 'active', revokedAt: null`
//     clears the soft-flip produced by revoke.
//
// Credential freshness: a reactivated connection whose stored credential has
// since expired will surface a typed credential error on its NEXT collection
// run — the same health-projection machinery that handles any other auth
// failure. Reactivate does not validate or re-supply credentials; the run
// lifecycle owns that. This is the documented credential-freshness delegation
// pattern (see research doc §5.1 rationale 4).
//
// Spec: openspec/changes/add-mcp-cimd-client-identity/tasks.md
//       (reactivate as clean inverse of revoke)

import {
  auditActorKind,
  buildAuditTrace,
  httpStatusForOperationError,
  readConnectionTarget,
} from "./_owner-connection-helpers.ts";
import type {
  ActiveBinding,
  AmbiguousConnectionErrorLike,
  ConnectorNamespace,
  MiddlewareHandler,
  PdppErrorFn,
  RouteArg,
  TraceContext,
  WireConnection,
} from "./_route-contract.ts";

// Express-shaped surface, structurally typed (mirrors owner-connection-revoke.ts).
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

interface ReactivatedInstance {
  readonly connectorInstanceId?: string | null;
  readonly revokedAt?: string | null;
  readonly status?: string | null;
}

interface ReactivateTarget {
  connectionId: string | null;
  connectorKey: string | null;
}

export interface MountOwnerConnectionReactivateContext {
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
  listActiveBindingsForGrant(input: {
    ownerSubjectId: string;
    connectorId: string;
  }): Promise<ActiveBinding[]> | ActiveBinding[];
  // Returns all revoked connections owned by `ownerSubjectId` for the given
  // connector. Used by the connector-only route to find the single revoked
  // connection to reactivate (mirroring listActiveBindingsForGrant for revoke).
  listRevokedConnectionsForConnector(input: {
    ownerSubjectId: string;
    connectorId: string;
  }): Promise<ActiveBinding[]> | ActiveBinding[];
  // Marks the maintained connector-summary read-model evidence for exactly this
  // connection dirty after the reactivate mutation commits. Injected (not
  // imported) to match the optional `invalidateConnectorSummariesCache` above;
  // awaited at the call site so ordering is explicit, best-effort, and a no-op
  // until the read model is warmed.
  markConnectorSummaryEvidenceDirty?(input: { connectorInstanceId: string; reason?: string }): Promise<void> | void;
  now?(): string;
  pdppError: PdppErrorFn;
  projectBindingForWire(instance: ActiveBinding): WireConnection | null;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  // Resolves the connector-instance namespace for the given owner. Accepts
  // `allowStatuses: ['revoked']` so the active-status gate is replaced with a
  // revoked-status gate (foreign/unknown id → connector_instance_not_found 404;
  // non-revoked id → connector_instance_inactive 400, which the handler
  // re-labels as connector_instance_not_revoked 409).
  resolveOwnerConnectorNamespace(
    req: unknown,
    connectorId: string | null,
    options?: {
      readonly allowDefaultAccount?: boolean;
      readonly allowStatuses?: readonly string[];
      readonly connectorInstanceId?: string | null;
      readonly ownerSubjectId?: string;
    }
  ): Promise<ConnectorNamespace>;
  setReferenceTraceId(res: RouteResponse, traceId: string): void;
  // Shared store primitive. Flips the instance status, clears revokedAt.
  updateConnectorInstanceStatus(
    connectorInstanceId: string,
    options: { status: "active"; updatedAt: string; revokedAt: null }
  ): Promise<ReactivatedInstance> | ReactivatedInstance;
}

// Emits one non-secret `owner_agent.connection.reactivate` spine event.
// The selector records whether the action was addressed by `connection_id` or
// by `connector_id`. No bearer token or provider secret is ever logged.
async function emitReactivateAudit(
  ctx: MountOwnerConnectionReactivateContext,
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
  const clientId = readTokenString(req.tokenInfo?.client_id);
  const clientName = readTokenString(req.tokenInfo?.client_name);
  const actorKind = auditActorKind(req);
  const ownerSubjectId = resolveAuditOwnerSubjectId(req, args.ownerSubjectId);
  await ctx.emitSpineEvent({
    event_type: "owner_agent.connection.reactivate",
    trace_id: trace.trace_id,
    scenario_id: trace.scenario_id,
    request_id: trace.request_id,
    actor_type: actorKind,
    actor_id: clientId ?? ownerSubjectId ?? actorKind,
    subject_type: "subject",
    subject_id: ownerSubjectId,
    client_id: clientId,
    object_type: "connection",
    object_id: reactivateObjectId(args),
    status: args.outcome,
    data: {
      auth_token_kind: req.tokenInfo?.pdpp_token_kind ?? null,
      actor_kind: actorKind,
      client_id: clientId,
      client_name: clientName,
      connection_id: args.connectionId ?? null,
      connector_key: args.connectorKey ?? null,
      selector: args.selector,
      operation: "reactivate",
      outcome: args.outcome,
      target_resource: "connection",
      ...reactivateAuditError(args.error),
    },
  });
}

function readTokenString(value: string | null | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function resolveAuditOwnerSubjectId(req: RouteRequest, ownerSubjectId?: string | null): string | null {
  return ownerSubjectId ?? readTokenString(req.tokenInfo?.subject_id);
}

function reactivateObjectId(args: { connectionId?: string | null; connectorKey?: string | null }): string {
  return args.connectionId || args.connectorKey || "unknown_connection";
}

function reactivateAuditError(error: unknown): Record<string, unknown> {
  if (!error) {
    return {};
  }
  const code = (error as { code?: unknown } | null)?.code;
  return {
    error: {
      code: typeof code === "string" ? code : "api_error",
      http_status: httpStatusForOperationError(error),
    },
  };
}

// Owner-token guard mirroring buildRevokeRequireOwner. Emits a failed-
// authorization audit before rejecting a non-owner bearer so the audit
// trail is complete for client/mcp_package bearers that reach the route.
function buildReactivateRequireOwner(
  ctx: MountOwnerConnectionReactivateContext,
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
    const { connectionId, connectorKey } = readConnectionTarget(ctx, req, selector);
    await emitReactivateAudit(ctx, req, res, {
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

// Resolve the single REVOKED connection for a connector-keyed reactivate.
// Mirrors resolveActiveByConnector but for `status = 'revoked'` rows:
//   - no revoked connection → connector_instance_not_found (404)
//   - multiple revoked connections → ambiguous_connection (409)
//   - exactly one → return its connectorInstanceId
async function resolveRevokedConnectorNamespace(
  ctx: MountOwnerConnectionReactivateContext,
  ownerSubjectId: string,
  connectorKey: string
): Promise<ConnectorNamespace> {
  const revoked = await Promise.resolve(
    ctx.listRevokedConnectionsForConnector({ ownerSubjectId, connectorId: connectorKey })
  );
  if (revoked.length === 0) {
    const err = new Error(
      `No revoked connector instance for owner '${ownerSubjectId}' and connector '${connectorKey}'.`
    ) as Error & { code: string };
    err.code = "connector_instance_not_found";
    throw err;
  }
  if (revoked.length > 1) {
    const available = revoked
      .map((binding) => ctx.projectBindingForWire(binding))
      .filter((row): row is WireConnection => row !== null);
    throw new ctx.AmbiguousConnectionError(
      `Connector '${connectorKey}' has multiple revoked connections. Retry with a specific connection_id.`,
      available
    );
  }
  // revoked.length === 1 at this point; find() is used instead of [0] to
  // produce a typed `ActiveBinding | undefined` that the compiler can narrow
  // cleanly (avoids the noNonNullAssertion lint rule on [0]!).
  const instance = revoked.find(Boolean) as ActiveBinding;
  return {
    connectorId: instance.connectorId ?? connectorKey,
    connectorInstanceId: instance.connectorInstanceId,
  };
}

async function resolveConnectionReactivateNamespace(
  ctx: MountOwnerConnectionReactivateContext,
  req: RouteRequest,
  res: RouteResponse,
  ownerSubjectId: string,
  target: ReactivateTarget
): Promise<ConnectorNamespace | null> {
  const addressed = decodeURIComponent(req.params.connectionId as string);
  target.connectionId = addressed;
  try {
    return await ctx.resolveOwnerConnectorNamespace(req, null, {
      ownerSubjectId,
      allowDefaultAccount: false,
      allowStatuses: ["revoked"],
      connectorInstanceId: addressed,
    });
  } catch (resolveErr) {
    const code = (resolveErr as { code?: unknown })?.code;
    if (code === "connector_instance_inactive") {
      ctx.pdppError(
        res,
        409,
        "connector_instance_not_revoked",
        `Connection '${addressed}' is not revoked; only revoked connections can be reactivated.`
      );
      return null;
    }
    throw resolveErr;
  }
}

async function resolveConnectorReactivateNamespace(
  ctx: MountOwnerConnectionReactivateContext,
  ownerSubjectId: string,
  target: ReactivateTarget,
  req: RouteRequest
): Promise<ConnectorNamespace> {
  const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
  target.connectorKey = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
  return resolveRevokedConnectorNamespace(ctx, ownerSubjectId, target.connectorKey);
}

async function resolveReactivateNamespace(
  ctx: MountOwnerConnectionReactivateContext,
  req: RouteRequest,
  res: RouteResponse,
  ownerSubjectId: string,
  selector: "connection_id" | "connector_id",
  target: ReactivateTarget
): Promise<ConnectorNamespace | null> {
  if (selector === "connection_id") {
    return resolveConnectionReactivateNamespace(ctx, req, res, ownerSubjectId, target);
  }
  return resolveConnectorReactivateNamespace(ctx, ownerSubjectId, target, req);
}

function reactivateTimestamp(ctx: MountOwnerConnectionReactivateContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

async function applyReactivate(
  ctx: MountOwnerConnectionReactivateContext,
  connectorInstanceId: string
): Promise<{ reactivated: ReactivatedInstance; stamp: string }> {
  const stamp = reactivateTimestamp(ctx);
  const reactivated = await Promise.resolve(
    ctx.updateConnectorInstanceStatus(connectorInstanceId, {
      status: "active",
      updatedAt: stamp,
      revokedAt: null,
    })
  );
  ctx.invalidateConnectorSummariesCache?.();
  // Scoped, awaited dirty marking: reactivation flips status back to active
  // and clears revoked_at — both durable summary evidence. Instance id known.
  await ctx.markConnectorSummaryEvidenceDirty?.({
    connectorInstanceId,
    reason: "owner reactivate changed connection lifecycle evidence",
  });
  return { reactivated, stamp };
}

function reactivateResponse(
  connectionId: string | null,
  connectorKey: string | null,
  reactivated: ReactivatedInstance,
  stamp: string
): Record<string, unknown> {
  return {
    object: "owner_connection_reactivate",
    connection_id: connectionId,
    connector_id: connectorKey,
    connector_key: connectorKey,
    status: reactivated.status ?? "active",
    reactivated_at: stamp,
  };
}

// Shared handler body for both reactivate routes. Resolves the namespace with
// `allowStatuses: ['revoked']` so that:
//   - a foreign/unknown id → connector_instance_not_found (404)
//   - an already-active (non-revoked) connection → connector_instance_inactive
//     (400) from the resolver, which the handler re-labels as
//     connector_instance_not_revoked (409) to give callers a typed guard
//   - a revoked connection → resolved, then flipped to active
//
// On success returns 200 `{ object: "owner_connection_reactivate",
// connection_id, connector_key, status: "active", reactivated_at }`.
function buildReactivateHandler(
  ctx: MountOwnerConnectionReactivateContext,
  selector: "connection_id" | "connector_id"
): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
    const target: ReactivateTarget = { connectionId: null, connectorKey: null };
    try {
      const namespace = await resolveReactivateNamespace(ctx, req, res, ownerSubjectId, selector, target);
      if (!namespace) {
        return;
      }

      target.connectionId = namespace.connectorInstanceId;
      target.connectorKey = ctx.canonicalConnectorKey(namespace.connectorId) ?? namespace.connectorId;

      const { reactivated, stamp } = await applyReactivate(ctx, namespace.connectorInstanceId);
      await emitReactivateAudit(ctx, req, res, {
        connectionId: target.connectionId,
        connectorKey: target.connectorKey,
        outcome: "succeeded",
        ownerSubjectId,
        selector,
      });
      res.status(200).json(reactivateResponse(target.connectionId, target.connectorKey, reactivated, stamp));
    } catch (err) {
      await emitReactivateAudit(ctx, req, res, {
        connectionId: target.connectionId,
        connectorKey: target.connectorKey,
        error: err,
        outcome: "failed",
        ownerSubjectId,
        selector,
      });
      ctx.handleError(res, err);
    }
  };
}

export function mountOwnerConnectionReactivate(app: AppLike, ctx: MountOwnerConnectionReactivateContext): void {
  app.post(
    "/v1/owner/connections/:connectionId/reactivate",
    { contract: "ownerReactivateConnection" },
    ctx.requireToken,
    buildReactivateRequireOwner(ctx, "connection_id"),
    buildReactivateHandler(ctx, "connection_id")
  );
  app.post(
    "/v1/owner/connectors/:connectorId/reactivate",
    { contract: "ownerReactivateConnector" },
    ctx.requireToken,
    buildReactivateRequireOwner(ctx, "connector_id"),
    buildReactivateHandler(ctx, "connector_id")
  );
}
