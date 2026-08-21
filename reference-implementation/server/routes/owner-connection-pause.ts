// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the bearer-authed owner-agent connection-pause control
// routes:
//
//   POST /v1/owner/connections/:connectionId/pause
//   POST /v1/owner/connectors/:connectorId/pause
//
// Pause is the inverse of resume (`owner-connection-resume.ts`): it flips a
// single `active` connection to `paused`, so no future scheduled or manual run
// lands for it. Already-collected records, grants, schedule rows, the stored
// credential, and the audit spine are never touched — the transition is a pure
// status flip on the connector-instance row, zero cascade.
//
// Why pause exists alongside revoke: revoke is the durable "stop collecting
// from this account, I am done with it" act, and its inverse (`reactivate`)
// is deliberately an explicit re-initiate. Pause is the reversible, low-stakes
// "stop collecting for now, keep everything" act — the owner keeps the
// connection, its credential, and its history, and resumes when ready. Before
// pause existed as an ACTION, `paused` was a state the system could land a row
// in (e.g. a recovered historical-archive transplant) but that no owner could
// ever deliberately produce, which made the resume half of this pair reachable
// only by accident.
//
// Key design choices that mirror `owner-connection-resume.ts`:
//   - Same auth adapter: `requireToken` + `requireOwner` (bearer owner-kind).
//   - Same resolver (`resolveOwnerConnectorNamespace`), with
//     `allowStatuses: ['active']` so only a collectible connection can be
//     paused. A foreign/unknown id surfaces as `connector_instance_not_found`
//     (404); an already-paused (or revoked, or draft) connection surfaces as
//     `connector_instance_inactive` (400) from the resolver, which the caller
//     re-labels as `connector_instance_not_active` (409) so a repeat pause is
//     a clean typed no-op rather than an opaque 400.
//   - Same ambiguity path on the connector-only route
//     (`ambiguous_connector_instance` -> `ambiguous_connection` 409).
//   - Same audit event family shape, named `owner_agent.connection.pause`.
//   - `updateConnectorInstanceStatus` with `status: 'paused'` flips the row;
//     `revokedAt` is left `null` (pausing is not revoking, so there is nothing
//     to set — a paused row must never read as revoked on any surface).

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

// Express-shaped surface, structurally typed (mirrors owner-connection-resume.ts).
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
  end: () => unknown;
  getHeader: (name: string) => string | number | string[] | undefined;
  json: (body: unknown) => unknown;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;
type NextFn = () => unknown | Promise<unknown>;

interface AppLike {
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

interface PausedInstance {
  readonly connectorInstanceId?: string | null;
  readonly status?: string | null;
}

interface PauseTarget {
  connectionId: string | null;
  connectorKey: string | null;
}

export interface MountOwnerConnectionPauseContext {
  AmbiguousConnectionError: new (
    message: string,
    availableConnections: WireConnection[]
  ) => AmbiguousConnectionErrorLike;
  canonicalConnectorKey: (value: string | null | undefined) => string | null;
  createTraceContext: (input?: { scenarioId?: string }) => TraceContext;
  emitSpineEvent: (event: Record<string, unknown>) => Promise<unknown>;
  ensureRequestId: (res: RouteResponse) => string;
  getOwnerTokenSubjectId: (req: unknown) => string;
  handleError: (res: unknown, err: unknown) => void;
  invalidateConnectorSummariesCache?: () => void;
  // Returns all ACTIVE connections owned by `ownerSubjectId` for the given
  // connector. Used by the connector-only route to find the single active
  // connection to pause (mirroring `listPausedConnectionsForConnector` on the
  // resume route).
  listActiveBindingsForGrant: (input: {
    ownerSubjectId: string;
    connectorId: string;
  }) => Promise<ActiveBinding[]> | ActiveBinding[];
  markConnectorSummaryEvidenceDirty?: (input: { connectorInstanceId: string; reason?: string }) => Promise<void> | void;
  now?: () => string;
  pdppError: PdppErrorFn;
  projectBindingForWire: (instance: ActiveBinding) => WireConnection | null;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  // Resolves the connector-instance namespace for the given owner. Accepts
  // `allowStatuses: ['active']` so only a collectible connection resolves
  // (foreign/unknown id -> connector_instance_not_found 404; non-active id ->
  // connector_instance_inactive 400, which the handler re-labels as
  // connector_instance_not_active 409).
  resolveOwnerConnectorNamespace: (
    req: unknown,
    connectorId: string | null,
    options?: {
      readonly allowDefaultAccount?: boolean;
      readonly allowStatuses?: readonly string[];
      readonly connectorInstanceId?: string | null;
      readonly ownerSubjectId?: string;
    }
  ) => Promise<ConnectorNamespace>;
  setReferenceTraceId: (res: RouteResponse, traceId: string) => void;
  // Shared store primitive. Flips the instance status; never touches revokedAt.
  updateConnectorInstanceStatus: (
    connectorInstanceId: string,
    options: { status: "paused"; updatedAt: string }
  ) => Promise<PausedInstance> | PausedInstance;
}

// Context slice `applyPause` needs. A strict subset of
// `MountOwnerConnectionPauseContext`, so the bearer route and the
// owner-session route (`ref-connection-pause.ts`) share ONE status-flip
// implementation — exactly the arrangement `applyResume` uses for the
// opposite direction.
export interface PauseApplyContext {
  invalidateConnectorSummariesCache?: () => void;
  now?: () => string;
  updateConnectorInstanceStatus: (
    connectorInstanceId: string,
    options: { status: "paused"; updatedAt: string }
  ) => Promise<PausedInstance> | PausedInstance;
}

// Emits one non-secret `owner_agent.connection.pause` spine event. The
// selector records whether the action was addressed by `connection_id` or by
// `connector_id`. No bearer token or provider secret is ever logged.
async function emitPauseAudit(
  ctx: MountOwnerConnectionPauseContext,
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
    actor_id: clientId ?? ownerSubjectId ?? actorKind,
    actor_type: actorKind,
    client_id: clientId,
    data: {
      actor_kind: actorKind,
      auth_token_kind: req.tokenInfo?.pdpp_token_kind ?? null,
      client_id: clientId,
      client_name: clientName,
      connection_id: args.connectionId ?? null,
      connector_key: args.connectorKey ?? null,
      operation: "pause",
      outcome: args.outcome,
      selector: args.selector,
      target_resource: "connection",
      ...pauseAuditError(args.error),
    },
    event_type: "owner_agent.connection.pause",
    object_id: pauseObjectId(args),
    object_type: "connection",
    request_id: trace.request_id,
    scenario_id: trace.scenario_id,
    status: args.outcome,
    subject_id: ownerSubjectId,
    subject_type: "subject",
    trace_id: trace.trace_id,
  });
}

function readTokenString(value: string | null | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function resolveAuditOwnerSubjectId(req: RouteRequest, ownerSubjectId?: string | null): string | null {
  return ownerSubjectId ?? readTokenString(req.tokenInfo?.subject_id);
}

function pauseObjectId(args: { connectionId?: string | null; connectorKey?: string | null }): string {
  return args.connectionId || args.connectorKey || "unknown_connection";
}

function pauseAuditError(error: unknown): Record<string, unknown> {
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

// Owner-token guard mirroring buildResumeRequireOwner. Emits a failed-
// authorization audit before rejecting a non-owner bearer so the audit trail
// is complete for client/mcp_package bearers that reach the route.
function buildPauseRequireOwner(
  ctx: MountOwnerConnectionPauseContext,
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
    await emitPauseAudit(ctx, req, res, {
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

// Resolve the single ACTIVE connection for a connector-keyed pause. Mirrors
// resolvePausedConnectorNamespace on the resume route, for `status = 'active'`
// rows:
//   - no active connection -> connector_instance_not_found (404)
//   - multiple active connections -> ambiguous_connection (409)
//   - exactly one -> return its connectorInstanceId
async function resolveActiveConnectorNamespace(
  ctx: MountOwnerConnectionPauseContext,
  ownerSubjectId: string,
  connectorKey: string
): Promise<ConnectorNamespace> {
  const active = await Promise.resolve(ctx.listActiveBindingsForGrant({ connectorId: connectorKey, ownerSubjectId }));
  if (active.length === 0) {
    const err = new Error(
      `No active connector instance for owner '${ownerSubjectId}' and connector '${connectorKey}'.`
    ) as Error & { code: string };
    err.code = "connector_instance_not_found";
    throw err;
  }
  if (active.length > 1) {
    const available = active
      .map((binding) => ctx.projectBindingForWire(binding))
      .filter((row): row is WireConnection => row !== null);
    throw new ctx.AmbiguousConnectionError(
      `Connector '${connectorKey}' has multiple active connections. Retry with a specific connection_id.`,
      available
    );
  }
  // active.length === 1 at this point; find() is used instead of [0] to
  // produce a typed `ActiveBinding | undefined` that the compiler can narrow
  // cleanly (avoids the noNonNullAssertion lint rule on [0]!).
  const instance = active.find(Boolean) as ActiveBinding;
  return {
    connectorId: instance.connectorId ?? connectorKey,
    connectorInstanceId: instance.connectorInstanceId,
  };
}

async function resolveConnectionPauseNamespace(
  ctx: MountOwnerConnectionPauseContext,
  req: RouteRequest,
  res: RouteResponse,
  ownerSubjectId: string,
  target: PauseTarget
): Promise<ConnectorNamespace | null> {
  const addressed = decodeURIComponent(req.params.connectionId as string);
  target.connectionId = addressed;
  try {
    return await ctx.resolveOwnerConnectorNamespace(req, null, {
      allowDefaultAccount: false,
      allowStatuses: ["active"],
      connectorInstanceId: addressed,
      ownerSubjectId,
    });
  } catch (resolveErr) {
    const { code } = resolveErr as { code?: unknown };
    if (code === "connector_instance_inactive") {
      ctx.pdppError(
        res,
        409,
        "connector_instance_not_active",
        `Connection '${addressed}' is not active; only active connections can be paused.`
      );
      return null;
    }
    throw resolveErr;
  }
}

// biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
async function resolveConnectorPauseNamespace(
  ctx: MountOwnerConnectionPauseContext,
  ownerSubjectId: string,
  target: PauseTarget,
  req: RouteRequest
): Promise<ConnectorNamespace> {
  const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
  target.connectorKey = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
  return resolveActiveConnectorNamespace(ctx, ownerSubjectId, target.connectorKey);
}

// biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
async function resolvePauseNamespace(
  ctx: MountOwnerConnectionPauseContext,
  req: RouteRequest,
  res: RouteResponse,
  ownerSubjectId: string,
  selector: "connection_id" | "connector_id",
  target: PauseTarget
): Promise<ConnectorNamespace | null> {
  if (selector === "connection_id") {
    return resolveConnectionPauseNamespace(ctx, req, res, ownerSubjectId, target);
  }
  return resolveConnectorPauseNamespace(ctx, ownerSubjectId, target, req);
}

function pauseTimestamp(ctx: PauseApplyContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

// Shared active -> paused status-flip primitive, the exact mirror of
// `applyResume`. Both the bearer route and the owner-session route
// (`ref-connection-pause.ts`) call THIS rather than writing their own status
// flip. Deliberately takes no source-binding-kind guard: unlike the implicit
// auto-resume hooks, every pause in this codebase is an explicit owner act.
export async function applyPause(
  ctx: PauseApplyContext,
  connectorInstanceId: string
): Promise<{ paused: PausedInstance; stamp: string }> {
  const stamp = pauseTimestamp(ctx);
  const paused = await Promise.resolve(
    ctx.updateConnectorInstanceStatus(connectorInstanceId, {
      status: "paused",
      updatedAt: stamp,
    })
  );
  ctx.invalidateConnectorSummariesCache?.();
  // `updateConnectorInstanceStatus` (-> `store.updateStatus`) marks summary
  // evidence dirty in the SAME transaction as the status write — a separate
  // post-hoc call here would be redundant, not additive (matches resume).
  return { paused, stamp };
}

export function pauseResponse(
  connectionId: string | null,
  connectorKey: string | null,
  paused: PausedInstance,
  stamp: string
): Record<string, unknown> {
  return {
    connection_id: connectionId,
    connector_id: connectorKey,
    connector_key: connectorKey,
    object: "owner_connection_pause",
    paused_at: stamp,
    status: paused.status ?? "paused",
  };
}

// Shared handler body for both pause routes. Resolves the namespace with
// `allowStatuses: ['active']` so that:
//   - a foreign/unknown id -> connector_instance_not_found (404)
//   - a non-active connection -> connector_instance_inactive (400) from the
//     resolver, which the handler re-labels as connector_instance_not_active
//     (409) to give callers a typed guard
//   - an active connection -> resolved, then flipped to paused
//
// On success returns 200 `{ object: "owner_connection_pause", connection_id,
// connector_key, status: "paused", paused_at }`.
function buildPauseHandler(
  ctx: MountOwnerConnectionPauseContext,
  selector: "connection_id" | "connector_id"
): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
    const target: PauseTarget = { connectionId: null, connectorKey: null };
    try {
      const namespace = await resolvePauseNamespace(ctx, req, res, ownerSubjectId, selector, target);
      if (!namespace) {
        return;
      }

      target.connectionId = namespace.connectorInstanceId;
      target.connectorKey = ctx.canonicalConnectorKey(namespace.connectorId) ?? namespace.connectorId;

      const { paused, stamp } = await applyPause(ctx, namespace.connectorInstanceId);
      await emitPauseAudit(ctx, req, res, {
        connectionId: target.connectionId,
        connectorKey: target.connectorKey,
        outcome: "succeeded",
        ownerSubjectId,
        selector,
      });
      res.status(200).json(pauseResponse(target.connectionId, target.connectorKey, paused, stamp));
    } catch (err) {
      await emitPauseAudit(ctx, req, res, {
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

export function mountOwnerConnectionPause(app: AppLike, ctx: MountOwnerConnectionPauseContext): void {
  app.post(
    "/v1/owner/connections/:connectionId/pause",
    { contract: "ownerPauseConnection" },
    ctx.requireToken,
    buildPauseRequireOwner(ctx, "connection_id"),
    buildPauseHandler(ctx, "connection_id")
  );
  app.post(
    "/v1/owner/connectors/:connectorId/pause",
    { contract: "ownerPauseConnector" },
    ctx.requireToken,
    buildPauseRequireOwner(ctx, "connector_id"),
    buildPauseHandler(ctx, "connector_id")
  );
}
