// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// HTTP adapter for the bearer-authed owner-agent connection-resume control
// routes:
//
//   POST /v1/owner/connections/:connectionId/resume
//   POST /v1/owner/connectors/:connectorId/resume
//
// Resume is the `paused`-status sibling of `reactivate` (which is the clean
// inverse of revoke, `revoked` -> `active`): it flips a single `paused`
// connection back to `active`, so the connection becomes runnable again.
// Already-collected records, grants, schedule, and audit are never touched —
// the transition is a pure status flip on the connector-instance row, zero
// cascade.
//
// The shared `applyResume` primitive below is the only deliberate status
// transition that moves a connection from `paused` to `active`; the session
// route and credential-repair hooks reuse it rather than maintaining another
// status-flip implementation. Before this route existed, `paused` had a
// schema-valid
// enum value and read-path tolerance (setup-status, owner ingest) but no
// write path ever produced it AND no write path ever resumed it — a
// connection paused by an out-of-band operation (e.g. a recovered
// historical-archive row with no surviving credential, restored with
// `status: 'paused'` specifically because reactivating it as `active` with no
// credential would be unsafe) had no way back to `active` even after the
// owner re-sealed a working credential via the static-secret credential
// capture route. Resume closes that gap without inventing a new cascade:
// exactly like reactivate, it does not validate or re-supply credentials —
// the owner is expected to have already repaired the credential (e.g. via
// `POST /_ref/connections/:id/static-secret-credential`, which now admits a
// `paused` target) before calling resume. A resumed connection whose stored
// credential is still missing/invalid surfaces a typed credential error on
// its NEXT collection run, same as any other auth failure.
//
// Key design choices that mirror `owner-connection-reactivate.ts`:
//   - Same auth adapter: `requireToken` + `requireOwner` (bearer owner-kind).
//   - Same resolver (`resolveOwnerConnectorNamespace`) but with
//     `allowStatuses: ['paused']` so the active-status gate is replaced by a
//     paused-status gate. This means a foreign/unknown id still surfaces as
//     `connector_instance_not_found` (404) and an already-active (or revoked,
//     or draft) connection surfaces as `connector_instance_inactive` (400)
//     from the resolver, which the caller then re-labels as
//     `connector_instance_not_paused` (409).
//   - Same ambiguity path on the connector-only route
//     (`ambiguous_connector_instance` -> `ambiguous_connection` 409).
//   - Same audit event family shape, named `owner_agent.connection.resume`.
//   - `updateConnectorInstanceStatus` with `status: 'active'` flips the row;
//     `revokedAt` is left `null` (a paused row is never revoked, so there is
//     nothing to clear).

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

// Express-shaped surface, structurally typed (mirrors owner-connection-reactivate.ts).
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

interface ResumedInstance {
  readonly connectorInstanceId?: string | null;
  readonly status?: string | null;
}

interface ResumeTarget {
  connectionId: string | null;
  connectorKey: string | null;
}

// Minimal connector-instance row shape needed to enforce an optional
// source-binding-kind guard before resuming. Only `sourceBinding` is read.
export interface ResumeGuardableInstance {
  readonly sourceBinding?: unknown;
}

export interface MountOwnerConnectionResumeContext {
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
  listActiveBindingsForGrant: (input: {
    ownerSubjectId: string;
    connectorId: string;
  }) => Promise<ActiveBinding[]> | ActiveBinding[];
  // Returns all paused connections owned by `ownerSubjectId` for the given
  // connector. Used by the connector-only route to find the single paused
  // connection to resume (mirroring listRevokedConnectionsForConnector for
  // reactivate).
  listPausedConnectionsForConnector: (input: {
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
  // `allowStatuses: ['paused']` so the active-status gate is replaced with a
  // paused-status gate (foreign/unknown id -> connector_instance_not_found 404;
  // non-paused id -> connector_instance_inactive 400, which the handler
  // re-labels as connector_instance_not_paused 409).
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
    options: { status: "active"; updatedAt: string }
  ) => Promise<ResumedInstance> | ResumedInstance;
}

// Context slice `resumePausedConnectorInstance` needs to enforce an optional
// source-binding-kind guard. A strict subset of
// `MountOwnerConnectionResumeContext` plus a connector-instance getter, so
// both the bearer route (which never passes `requireSourceBindingKind`) and
// the session route (which always does, pinned to `historical_archive`) can
// share ONE status-flip implementation.
export interface ResumeApplyContext {
  getConnectorInstance?: (
    connectorInstanceId: string
  ) => Promise<ResumeGuardableInstance | null> | ResumeGuardableInstance | null;
  invalidateConnectorSummariesCache?: () => void;
  now?: () => string;
  updateConnectorInstanceStatus: (
    connectorInstanceId: string,
    options: { status: "active"; updatedAt: string }
  ) => Promise<ResumedInstance> | ResumedInstance;
}

function sourceBindingKindOf(instance: ResumeGuardableInstance | null): string | null {
  const binding = instance?.sourceBinding;
  if (!binding || typeof binding !== "object") {
    return null;
  }
  const { kind } = binding as { kind?: unknown };
  return typeof kind === "string" ? kind : null;
}

// Asserts the target connection's source-binding kind matches
// `requiredKind` before a resume proceeds. Used ONLY by callers that pass
// `requireSourceBindingKind` (the session-authed resume path and the
// credential-capture/browser-run auto-resume call sites) — the existing
// bearer resume routes never pass this, so their behavior (resume any
// paused row) is unchanged.
async function assertResumeSourceBindingKind(
  ctx: ResumeApplyContext,
  connectorInstanceId: string,
  requiredKind: string
): Promise<void> {
  if (typeof ctx.getConnectorInstance !== "function") {
    const err = new Error(
      "A connector-instance getter is required to enforce a source-binding-kind guard on resume."
    ) as Error & { code: string };
    err.code = "connector_instance_store_required";
    throw err;
  }
  const instance = await Promise.resolve(ctx.getConnectorInstance(connectorInstanceId));
  const actualKind = sourceBindingKindOf(instance);
  if (actualKind !== requiredKind) {
    const err = new Error(
      `Connection '${connectorInstanceId}' is not a '${requiredKind}' connection; only '${requiredKind}' rows can be resumed through this path.`
    ) as Error & { code: string };
    err.code = "connector_instance_not_paused";
    throw err;
  }
}

// Emits one non-secret `owner_agent.connection.resume` spine event. The
// selector records whether the action was addressed by `connection_id` or by
// `connector_id`. No bearer token or provider secret is ever logged.
async function emitResumeAudit(
  ctx: MountOwnerConnectionResumeContext,
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
      operation: "resume",
      outcome: args.outcome,
      selector: args.selector,
      target_resource: "connection",
      ...resumeAuditError(args.error),
    },
    event_type: "owner_agent.connection.resume",
    object_id: resumeObjectId(args),
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

function resumeObjectId(args: { connectionId?: string | null; connectorKey?: string | null }): string {
  return args.connectionId || args.connectorKey || "unknown_connection";
}

function resumeAuditError(error: unknown): Record<string, unknown> {
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

// Owner-token guard mirroring buildReactivateRequireOwner. Emits a failed-
// authorization audit before rejecting a non-owner bearer so the audit trail
// is complete for client/mcp_package bearers that reach the route.
function buildResumeRequireOwner(
  ctx: MountOwnerConnectionResumeContext,
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
    await emitResumeAudit(ctx, req, res, {
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

// Resolve the single PAUSED connection for a connector-keyed resume. Mirrors
// resolveRevokedConnectorNamespace but for `status = 'paused'` rows:
//   - no paused connection -> connector_instance_not_found (404)
//   - multiple paused connections -> ambiguous_connection (409)
//   - exactly one -> return its connectorInstanceId
async function resolvePausedConnectorNamespace(
  ctx: MountOwnerConnectionResumeContext,
  ownerSubjectId: string,
  connectorKey: string
): Promise<ConnectorNamespace> {
  const paused = await Promise.resolve(
    ctx.listPausedConnectionsForConnector({ connectorId: connectorKey, ownerSubjectId })
  );
  if (paused.length === 0) {
    const err = new Error(
      `No paused connector instance for owner '${ownerSubjectId}' and connector '${connectorKey}'.`
    ) as Error & { code: string };
    err.code = "connector_instance_not_found";
    throw err;
  }
  if (paused.length > 1) {
    const available = paused
      .map((binding) => ctx.projectBindingForWire(binding))
      .filter((row): row is WireConnection => row !== null);
    throw new ctx.AmbiguousConnectionError(
      `Connector '${connectorKey}' has multiple paused connections. Retry with a specific connection_id.`,
      available
    );
  }
  // paused.length === 1 at this point; find() is used instead of [0] to
  // produce a typed `ActiveBinding | undefined` that the compiler can narrow
  // cleanly (avoids the noNonNullAssertion lint rule on [0]!).
  const instance = paused.find(Boolean) as ActiveBinding;
  return {
    connectorId: instance.connectorId ?? connectorKey,
    connectorInstanceId: instance.connectorInstanceId,
  };
}

async function resolveConnectionResumeNamespace(
  ctx: MountOwnerConnectionResumeContext,
  req: RouteRequest,
  res: RouteResponse,
  ownerSubjectId: string,
  target: ResumeTarget
): Promise<ConnectorNamespace | null> {
  const addressed = decodeURIComponent(req.params.connectionId as string);
  target.connectionId = addressed;
  try {
    return await ctx.resolveOwnerConnectorNamespace(req, null, {
      allowDefaultAccount: false,
      allowStatuses: ["paused"],
      connectorInstanceId: addressed,
      ownerSubjectId,
    });
  } catch (resolveErr) {
    const { code } = resolveErr as { code?: unknown };
    if (code === "connector_instance_inactive") {
      ctx.pdppError(
        res,
        409,
        "connector_instance_not_paused",
        `Connection '${addressed}' is not paused; only paused connections can be resumed.`
      );
      return null;
    }
    throw resolveErr;
  }
}

// biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
async function resolveConnectorResumeNamespace(
  ctx: MountOwnerConnectionResumeContext,
  ownerSubjectId: string,
  target: ResumeTarget,
  req: RouteRequest
): Promise<ConnectorNamespace> {
  const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
  target.connectorKey = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
  return resolvePausedConnectorNamespace(ctx, ownerSubjectId, target.connectorKey);
}

// biome-ignore lint/suspicious/useAwait: The async signature is part of this caller-facing contract.
async function resolveResumeNamespace(
  ctx: MountOwnerConnectionResumeContext,
  req: RouteRequest,
  res: RouteResponse,
  ownerSubjectId: string,
  selector: "connection_id" | "connector_id",
  target: ResumeTarget
): Promise<ConnectorNamespace | null> {
  if (selector === "connection_id") {
    return resolveConnectionResumeNamespace(ctx, req, res, ownerSubjectId, target);
  }
  return resolveConnectorResumeNamespace(ctx, ownerSubjectId, target, req);
}

function resumeTimestamp(ctx: ResumeApplyContext): string {
  return ctx.now ? ctx.now() : new Date().toISOString();
}

// Shared paused -> active status-flip primitive. When `requireSourceBindingKind`
// is supplied, the target's `source_binding.kind` must match exactly or the
// resume is refused with `connector_instance_not_paused` (409) BEFORE any
// write — the bearer resume routes never pass this (so their existing
// "resume any paused row" behavior and tests are unchanged); the session
// route and the credential-capture/browser-run auto-resume call sites always
// pass `"historical_archive"`.
export async function applyResume(
  ctx: ResumeApplyContext,
  connectorInstanceId: string,
  options?: { requireSourceBindingKind?: string }
): Promise<{ resumed: ResumedInstance; stamp: string }> {
  if (options?.requireSourceBindingKind) {
    await assertResumeSourceBindingKind(ctx, connectorInstanceId, options.requireSourceBindingKind);
  }
  const stamp = resumeTimestamp(ctx);
  const resumed = await Promise.resolve(
    ctx.updateConnectorInstanceStatus(connectorInstanceId, {
      status: "active",
      updatedAt: stamp,
    })
  );
  ctx.invalidateConnectorSummariesCache?.();
  // `updateConnectorInstanceStatus` (-> `store.updateStatus`) marks summary
  // evidence dirty in the SAME transaction as the status write — a separate
  // post-hoc call here would be redundant, not additive (matches reactivate).
  return { resumed, stamp };
}

export function resumeResponse(
  connectionId: string | null,
  connectorKey: string | null,
  resumed: ResumedInstance,
  stamp: string
): Record<string, unknown> {
  return {
    connection_id: connectionId,
    connector_id: connectorKey,
    connector_key: connectorKey,
    object: "owner_connection_resume",
    resumed_at: stamp,
    status: resumed.status ?? "active",
  };
}

// Shared handler body for both resume routes. Resolves the namespace with
// `allowStatuses: ['paused']` so that:
//   - a foreign/unknown id -> connector_instance_not_found (404)
//   - a non-paused connection -> connector_instance_inactive (400) from the
//     resolver, which the handler re-labels as connector_instance_not_paused
//     (409) to give callers a typed guard
//   - a paused connection -> resolved, then flipped to active
//
// On success returns 200 `{ object: "owner_connection_resume", connection_id,
// connector_key, status: "active", resumed_at }`.
function buildResumeHandler(
  ctx: MountOwnerConnectionResumeContext,
  selector: "connection_id" | "connector_id"
): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
    const target: ResumeTarget = { connectionId: null, connectorKey: null };
    try {
      const namespace = await resolveResumeNamespace(ctx, req, res, ownerSubjectId, selector, target);
      if (!namespace) {
        return;
      }

      target.connectionId = namespace.connectorInstanceId;
      target.connectorKey = ctx.canonicalConnectorKey(namespace.connectorId) ?? namespace.connectorId;

      const { resumed, stamp } = await applyResume(ctx, namespace.connectorInstanceId);
      await emitResumeAudit(ctx, req, res, {
        connectionId: target.connectionId,
        connectorKey: target.connectorKey,
        outcome: "succeeded",
        ownerSubjectId,
        selector,
      });
      res.status(200).json(resumeResponse(target.connectionId, target.connectorKey, resumed, stamp));
    } catch (err) {
      await emitResumeAudit(ctx, req, res, {
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

export function mountOwnerConnectionResume(app: AppLike, ctx: MountOwnerConnectionResumeContext): void {
  app.post(
    "/v1/owner/connections/:connectionId/resume",
    { contract: "ownerResumeConnection" },
    ctx.requireToken,
    buildResumeRequireOwner(ctx, "connection_id"),
    buildResumeHandler(ctx, "connection_id")
  );
  app.post(
    "/v1/owner/connectors/:connectorId/resume",
    { contract: "ownerResumeConnector" },
    ctx.requireToken,
    buildResumeRequireOwner(ctx, "connector_id"),
    buildResumeHandler(ctx, "connector_id")
  );
}
