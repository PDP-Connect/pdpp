// HTTP adapter for the bearer-authed owner-agent connection-DELETE control
// routes:
//
//   DELETE /v1/owner/connections/:connectionId
//   DELETE /v1/owner/connectors/:connectorId
//
// These are the owner-agent (bearer) connection-scoped DELETE siblings of the
// run/schedule/revoke control routes. Unlike revoke (a zero-cascade soft-flip),
// delete is the destructive connection-scoped purge: it erases ONE connection's
// records/history/blobs/search/attention and its schedule,
// clears its device source-instance back-reference, and removes the
// connector_instances row — all keyed strictly on one connector_instance_id
// (== connection_id), all in one all-or-nothing transaction (the search-index
// teardown is a rebuildable projection cleaned up after that commit). It does
// NOT erase an in-flight run's active-run lease — a connection with an active
// run is REFUSED, not deleted. It PRESERVES the audit spine, disclosure grants, sibling
// connections, and the device edge itself.
//
// What delete is (and is NOT):
//   - Delete erases the PAST and removes the configuration. Revoke stops the
//     FUTURE and preserves the past. They are deliberately separate owner
//     actions with separate routes and audit event types. Delete is NOT revoke.
//   - Delete is keyed on exactly one connection_id. It NEVER widens to
//     connector_id, so a sibling connection of the same connector type is
//     untouched (invariant I1).
//   - Delete preserves spine_events (the durable evidence the deletion
//     happened; it has no connector_instance_id column) and appends an
//     owner_agent.connection.delete event (I3).
//
// Ownership + scoping:
//   - the :connectionId route hands the raw connection_id to the store's
//     `deleteConnection`, which resolves the row and verifies
//     `instance.ownerSubjectId === ownerSubjectId` BEFORE any mutation. A
//     foreign-owner OR unknown OR already-deleted id surfaces as
//     connector_instance_not_found (404), so existence is never leaked across
//     owners and a repeat delete is a clean typed 404 (invariants I4/I5). The
//     connection need not be active to be deletable (a revoked-but-present
//     connection is still deletable), so this route does NOT use the
//     active-gating namespace resolver for the connection_id path.
//   - the :connectorId route is addressed by connector type only; it resolves
//     the connector's single ACTIVE connection through the namespace resolver,
//     or rejects with a typed ambiguous_connection (409) carrying the available
//     connection_id values and retry_with: connection_id.
//   - delete refuses with connection_run_active (409) when an active-run lease
//     exists for the id (I7), and with default_account_delete_unsupported (409)
//     for a default-account binding whose deterministic id would silently
//     re-materialize (I6 / Decision 1 fallback). Both are raised by the store.
//
// Every delete attempt (success and failure) emits non-secret
// owner_agent.connection.delete spine evidence: actor kind, client id/name,
// target connection/connector, selector, operation, outcome, deletion-summary
// counts, request id. Bearer tokens and provider secrets and record contents
// are never logged.
//
// `/mcp` owner-bearer rejection (requireClientOrMcpPackage) is untouched: this
// route is REST-control-plane only, requireToken + requireOwner. Defining it
// adds no delete capability reachable over /mcp with an owner bearer (I9).
//
// Spec: openspec/changes/add-owner-connection-delete-contract/specs/
//       reference-owner-agent-control-surface/spec.md
//       reference-connector-instances/spec.md

import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";
import { codeToStatus } from "./ref-error-status.ts";

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
  delete(path: string, ...args: RouteArg<RouteHandler>[]): AppLike;
}

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

// Non-secret deletion summary the store returns. Counts + stable ids only.
interface DeleteSummary {
  readonly connection_id: string;
  readonly connector_id: string;
  readonly deleted_record_count: number;
  readonly deleted_stream_count: number;
  readonly device_refs_cleared: number;
  readonly schedule_deleted: boolean;
  readonly source_kind: string;
}

interface TraceContext {
  readonly request_id: string;
  readonly scenario_id: string;
  readonly trace_id: string;
}

interface AmbiguousConnectionErrorLike extends Error {
  available_connections: WireConnection[];
  code: string;
  retry_with: string;
}

export interface MountOwnerConnectionDeleteContext {
  AmbiguousConnectionError: new (
    message: string,
    availableConnections: WireConnection[]
  ) => AmbiguousConnectionErrorLike;
  canonicalConnectorKey(value: string | null | undefined): string | null;
  createTraceContext(input?: { scenarioId?: string }): TraceContext;
  // Connection-scoped destructive delete primitive. Resolves + verifies owner
  // ownership BEFORE any mutation, refuses active-run / default-account, purges
  // data + state, deletes the row, returns the non-secret deletion summary.
  deleteConnection(
    connectorInstanceId: string,
    options: { ownerSubjectId: string; now?: string | undefined }
  ): Promise<DeleteSummary>;
  emitSpineEvent(event: Record<string, unknown>): Promise<unknown>;
  ensureRequestId(res: RouteResponse): string;
  getOwnerTokenSubjectId(req: unknown): string;
  handleError(res: unknown, err: unknown): void;
  listActiveBindingsForGrant(input: {
    ownerSubjectId: string;
    connectorId: string;
  }): Promise<ActiveBinding[]> | ActiveBinding[];
  now?(): string;
  pdppError: PdppErrorFn;
  projectBindingForWire(instance: ActiveBinding): WireConnection | null;
  requireOwner: MiddlewareHandler;
  requireToken: MiddlewareHandler;
  // Owner-scoped namespace resolution — used ONLY for the connector-only path
  // (auto-select the single active connection or throw ambiguity). The
  // connection_id path resolves ownership inside `deleteConnection` instead, so
  // a non-active-but-present connection is still deletable.
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

function httpStatusForDeleteError(err: unknown): number {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? (codeToStatus[code] ?? 500) : 500;
}

function buildAuditTrace(ctx: MountOwnerConnectionDeleteContext, req: RouteRequest, res: RouteResponse): TraceContext {
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

// Emits one non-secret owner_agent.connection.delete spine event. Carries the
// selector (connection_id vs connector_id) and, on success, the deletion
// summary counts. Never carries the bearer token, provider secrets, or record
// contents.
async function emitDeleteAudit(
  ctx: MountOwnerConnectionDeleteContext,
  req: RouteRequest,
  res: RouteResponse,
  args: {
    connectionId?: string | null;
    connectorKey?: string | null;
    error?: unknown;
    outcome: "succeeded" | "failed";
    ownerSubjectId?: string | null;
    selector: "connection_id" | "connector_id";
    summary?: DeleteSummary | null;
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
    event_type: "owner_agent.connection.delete",
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
      operation: "delete",
      outcome: args.outcome,
      target_resource: "connection",
      ...(args.summary
        ? {
            deletion_summary: {
              deleted_record_count: args.summary.deleted_record_count,
              deleted_stream_count: args.summary.deleted_stream_count,
              schedule_deleted: args.summary.schedule_deleted,
              device_refs_cleared: args.summary.device_refs_cleared,
            },
          }
        : {}),
      ...(args.error
        ? {
            error: {
              code: typeof code === "string" ? code : "api_error",
              http_status: httpStatusForDeleteError(args.error),
            },
          }
        : {}),
    },
  });
}

// Owner guard that emits a failed-authorization audit before rejecting a
// non-owner bearer, mirroring the run/schedule/revoke routes.
function buildDeleteRequireOwner(
  ctx: MountOwnerConnectionDeleteContext,
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
    const { connectionId, connectorKey } = readDeleteTarget(ctx, req, selector);
    await emitDeleteAudit(ctx, req, res, {
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

function readDeleteTarget(
  ctx: MountOwnerConnectionDeleteContext,
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

// Maps the resolver's connector-only ambiguity to the public typed
// ambiguous_connection (409) carrying the available connection_id values and
// retry_with: connection_id. Any other resolver error is rethrown unchanged.
async function rethrowAsAmbiguousConnection(
  ctx: MountOwnerConnectionDeleteContext,
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

// Shared handler body for both routes. For the connector-only selector it
// resolves the single active connection (or throws typed ambiguity); for the
// connection_id selector it deletes the addressed id directly (ownership +
// existence + run-active + default-account guards live in the store). On
// success returns 200 with the non-secret deletion summary so the agent can
// confirm exactly what was erased.
function buildDeleteHandler(
  ctx: MountOwnerConnectionDeleteContext,
  selector: "connection_id" | "connector_id"
): RouteHandler {
  return async (req: RouteRequest, res: RouteResponse) => {
    const ownerSubjectId = ctx.getOwnerTokenSubjectId(req);
    let connectionId: string | null = null;
    let connectorKey: string | null = null;
    try {
      if (selector === "connection_id") {
        connectionId = decodeURIComponent(req.params.connectionId as string);
      } else {
        const rawConnectorId = decodeURIComponent(req.params.connectorId as string);
        connectorKey = ctx.canonicalConnectorKey(rawConnectorId) ?? rawConnectorId;
        let namespace: ConnectorNamespace;
        try {
          namespace = await ctx.resolveOwnerConnectorNamespace(req, rawConnectorId, {
            ownerSubjectId,
            allowDefaultAccount: false,
          });
        } catch (resolveErr) {
          await rethrowAsAmbiguousConnection(ctx, resolveErr, ownerSubjectId, connectorKey);
          // rethrowAsAmbiguousConnection always throws; unreachable.
          return;
        }
        connectionId = namespace.connectorInstanceId;
        connectorKey = ctx.canonicalConnectorKey(namespace.connectorId) ?? namespace.connectorId;
      }

      const now = ctx.now ? ctx.now() : undefined;
      const summary = await ctx.deleteConnection(connectionId as string, { ownerSubjectId, now });
      connectionId = summary.connection_id;
      connectorKey = ctx.canonicalConnectorKey(summary.connector_id) ?? summary.connector_id;

      await emitDeleteAudit(ctx, req, res, {
        connectionId,
        connectorKey,
        outcome: "succeeded",
        ownerSubjectId,
        selector,
        summary,
      });
      res.status(200).json({
        object: "owner_connection_delete",
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
      await emitDeleteAudit(ctx, req, res, {
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

export function mountOwnerConnectionDelete(app: AppLike, ctx: MountOwnerConnectionDeleteContext): void {
  app.delete(
    "/v1/owner/connections/:connectionId",
    { contract: "ownerDeleteConnection" },
    ctx.requireToken,
    buildDeleteRequireOwner(ctx, "connection_id"),
    buildDeleteHandler(ctx, "connection_id")
  );
  app.delete(
    "/v1/owner/connectors/:connectorId",
    { contract: "ownerDeleteConnector" },
    ctx.requireToken,
    buildDeleteRequireOwner(ctx, "connector_id"),
    buildDeleteHandler(ctx, "connector_id")
  );
}
