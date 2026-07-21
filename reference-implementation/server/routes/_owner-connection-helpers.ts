// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Shared helpers for the owner-connection route-family adapters.
//
// All five functions in this file are behavior-identical copies extracted
// verbatim from the six mutation files (owner-connection-{run,revoke,
// diagnostics,delete,reactivate,schedule}.ts) and owner-connections.ts.
// They are pure utility functions with no side effects beyond the ctx
// calls they delegate; each caller file drops its local copy and imports
// from here. No logic or operator changes are made.
//
// Structural ctx types are intentionally narrow — each helper declares
// only the ctx fields it actually reads, so any caller whose concrete ctx
// object satisfies the structural constraint (all six do) is accepted by
// TypeScript without additional coupling.

import type { TraceContext, WireConnection } from "./_route-contract.ts";
import { codeToStatus } from "./ref-error-status.ts";

// Minimal request slice all helpers need (tokenInfo only).
interface TokenInfoRequest {
  readonly tokenInfo?: {
    readonly pdpp_token_kind?: string | null;
    readonly scenario_id?: string | null;
  } | null;
}

// Minimal response slice buildAuditTrace needs (passed opaquely to ctx).
// The actual RouteResponse in each caller is structurally wider; using
// `unknown` here keeps this file free of per-adapter type bindings.
type OpaqueResponse = unknown;

// ---- auditActorKind --------------------------------------------------------

// Returns the actor-kind label to record in spine events.  Reads only the
// `pdpp_token_kind` field on `req.tokenInfo`.
export function auditActorKind(req: TokenInfoRequest): "owner_agent" | "client" | "mcp_package" | "unknown" {
  const kind = req.tokenInfo?.pdpp_token_kind;
  if (kind === "owner") {
    return "owner_agent";
  }
  if (kind === "client" || kind === "mcp_package") {
    return kind;
  }
  return "unknown";
}

// ---- buildAuditTrace -------------------------------------------------------

// Minimal ctx slice buildAuditTrace needs.
interface AuditTraceCtx {
  createTraceContext(input?: { scenarioId?: string }): TraceContext;
  ensureRequestId(res: OpaqueResponse): string;
  setReferenceTraceId(res: OpaqueResponse, traceId: string): void;
}

// Builds and attaches a trace context for the current request.  Sets the
// `X-Reference-Trace-Id` response header via ctx.setReferenceTraceId and
// returns the { request_id, scenario_id, trace_id } triple for embedding in
// spine events.
export function buildAuditTrace(ctx: AuditTraceCtx, req: TokenInfoRequest, res: OpaqueResponse): TraceContext {
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

// ---- readConnectionTarget --------------------------------------------------

// Minimal ctx slice readConnectionTarget needs.
interface ConnectionTargetCtx {
  canonicalConnectorKey(value: string | null | undefined): string | null;
}

// Minimal request slice readConnectionTarget needs.
interface ConnectionTargetRequest {
  readonly params: Readonly<Record<string, string>>;
}

// Reads the addressed target from the request path for audit labelling.
// For a connection-scoped route this is the `connection_id`; for a
// connector-scoped route it is the canonical connector key.
export function readConnectionTarget(
  ctx: ConnectionTargetCtx,
  req: ConnectionTargetRequest,
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

// ---- rethrowAsAmbiguousConnection ------------------------------------------

// Minimal ctx slice rethrowAsAmbiguousConnection needs.
interface AmbiguousConnectionCtx {
  AmbiguousConnectionError: new (message: string, availableConnections: WireConnection[]) => Error;
  listActiveBindingsForGrant(input: {
    ownerSubjectId: string;
    connectorId: string;
  }):
    | Promise<{ connectorId?: string | null; connectorInstanceId: string; displayName?: string | null }[]>
    | { connectorId?: string | null; connectorInstanceId: string; displayName?: string | null }[];
  projectBindingForWire(instance: {
    connectorId?: string | null;
    connectorInstanceId: string;
    displayName?: string | null;
  }): WireConnection | null;
}

// Maps the store's connector-only ambiguity (`ambiguous_connector_instance`)
// to the public, typed `ambiguous_connection` (409) error carrying the
// available `connection_id` values + owner-meaningful labels and
// `retry_with: connection_id`. Any other resolver error is rethrown unchanged.
export async function rethrowAsAmbiguousConnection(
  ctx: AmbiguousConnectionCtx,
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

// ---- httpStatusForOperationError -------------------------------------------

// Maps a domain error `code` to its HTTP status via the shared codeToStatus
// table, defaulting to 500 for unknown codes.  Used by all mutation adapters
// except owner-connection-diagnostics (which has a divergent hand-coded map).
export function httpStatusForOperationError(err: unknown): number {
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" ? (codeToStatus[code] ?? 500) : 500;
}
