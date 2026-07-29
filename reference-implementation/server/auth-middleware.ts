// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Auth-middleware cluster for the PDPP reference resource server.
 *
 * Concept: request authentication/authorization gate middleware.
 *
 * Invariant: each exported middleware (requireToken, requireOwner,
 * requireClient, requireClientOrMcpPackage) is a pure (req, res, next)
 * Express middleware that does not capture startServer state. Token validity
 * is determined via the `introspect` import from ./auth.js; no other module
 * in this file reaches back into server/index.js (no back-edge).
 *
 * Generic request/response infra (pdppError, ensureRequestId, etc.) lives in
 * ./request-helpers.js — this module imports from there; it does not re-export them.
 */

import { introspect } from "./auth.ts";
import {
  emitQueryReceived,
  emitQueryRejected,
  ensureRequestId,
  getProtectedResourceMetadataUrl,
  pdppError,
  setReferenceTraceId,
} from "./request-helpers.ts";

interface ResponseLike {
  getHeader: (name: string) => unknown;
  json: (body: unknown) => void;
  locals?: Record<string, unknown>;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ResponseLike;
}

interface RequestLike {
  headers: { authorization?: string; [key: string]: unknown };
  method: string;
  path: string;
  query: Record<string, unknown>;
  tokenInfo?: unknown;
}

interface AuthGateQueryProjection {
  hasChangesSince: boolean;
  limit: number | null;
}

interface AuthGateRouteContext {
  field?: string | null;
  groupBy?: string | null;
  hasChangesSince?: boolean;
  limit?: number | null;
  metric?: string | null;
  queryShape: "record_detail" | "record_list" | "stream_aggregate" | "stream_list" | "stream_metadata";
  requestedRecordId?: string | null;
  streamId: string | null;
}

interface InactiveTokenInfo {
  client_id?: string | null;
  inactive_reason?: string;
  scenario_id?: string | null;
  trace_id?: string | null;
}

type Next = () => void;

// ─── Auth-private helpers ─────────────────────────────────────────────────────

function httpQuotedString(value: unknown): string {
  return String(value).replace(/["\\]/g, "\\$&");
}

function setProtectedResourceMetadataChallenge(res: ResponseLike): void {
  const metadataUrl = getProtectedResourceMetadataUrl(res);
  if (!metadataUrl) {
    return;
  }
  res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${httpQuotedString(metadataUrl)}"`);
}

// ─── Auth-gate query context ─────────────────────────────────────────────────

function inferAuthGateQueryProjection(req: RequestLike): AuthGateQueryProjection {
  const parsedLimit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : null;
  const limit = parsedLimit !== null && Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null;
  const hasChangesSince = typeof req.query.changes_since === "string" && req.query.changes_since.length > 0;

  return { hasChangesSince, limit };
}

function projectAuthGateRouteContext(
  segments: string[],
  req: RequestLike,
  queryProjection: AuthGateQueryProjection
): AuthGateRouteContext | null {
  if (segments.length === 2) {
    return { queryShape: "stream_list", streamId: null };
  }
  if (segments.length === 3) {
    return { queryShape: "stream_metadata", streamId: segments[2] ?? null };
  }
  if (segments.length === 4 && segments[3] === "aggregate") {
    return {
      field: typeof req.query.field === "string" ? req.query.field : null,
      groupBy: typeof req.query.group_by === "string" ? req.query.group_by : null,
      metric: typeof req.query.metric === "string" ? req.query.metric : null,
      queryShape: "stream_aggregate",
      streamId: segments[2] ?? null,
    };
  }
  if (segments.length === 4 && segments[3] === "records") {
    return {
      hasChangesSince: queryProjection.hasChangesSince,
      limit: queryProjection.limit,
      queryShape: "record_list",
      requestedRecordId: null,
      streamId: segments[2] ?? null,
    };
  }
  if (segments.length === 5 && segments[3] === "records") {
    return { queryShape: "record_detail", requestedRecordId: segments[4] ?? null, streamId: segments[2] ?? null };
  }

  return null;
}

function inferAuthGateQueryContext(req: RequestLike): AuthGateRouteContext | null {
  if (req.method !== "GET") {
    return null;
  }

  const segments = String(req.path || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  if (segments[0] !== "v1" || segments[1] !== "streams") {
    return null;
  }
  const queryProjection = inferAuthGateQueryProjection(req);
  return projectAuthGateRouteContext(segments, req, queryProjection);
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

function inactiveTokenMessage(reason: string | undefined): string {
  if (reason === "grant_revoked") {
    return "Grant has been revoked";
  }
  if (reason === "grant_expired") {
    return "Grant has expired";
  }
  if (reason === "grant_invalid") {
    return "Grant is malformed or no longer valid";
  }
  return "Invalid or expired token";
}

async function emitInactiveTokenQuery(req: RequestLike, res: ResponseLike, info: InactiveTokenInfo): Promise<void> {
  const authGateQuery = inferAuthGateQueryContext(req);
  if (!(authGateQuery && info.trace_id)) {
    return;
  }
  const authGateContext = {
    actorId: info.client_id || null,
    actorType: "client",
    queryData: {
      auth_gate: true,
      query_shape: authGateQuery.queryShape,
      ...(authGateQuery.queryShape === "record_list"
        ? { has_changes_since: authGateQuery.hasChangesSince ?? false, limit: authGateQuery.limit ?? null }
        : {}),
      ...(authGateQuery.requestedRecordId ? { requested_record_id: authGateQuery.requestedRecordId } : {}),
    },
    queryId: ensureRequestId(res),
    ...(info.scenario_id ? { scenarioId: info.scenario_id } : {}),
    streamId: authGateQuery.streamId,
    tokenInfo: info,
    traceId: info.trace_id,
  };
  await emitQueryReceived(authGateContext, req);
  await emitQueryRejected(
    authGateContext,
    req,
    Object.assign(new Error("Token rejected at auth gate"), {
      code: info.inactive_reason || "authentication_error",
      message: inactiveTokenMessage(info.inactive_reason),
    })
  );
}

async function respondToInactiveToken(req: RequestLike, res: ResponseLike, info: InactiveTokenInfo): Promise<void> {
  if (info.trace_id) {
    setReferenceTraceId(res, info.trace_id);
  }
  await emitInactiveTokenQuery(req, res, info);
  if (info.inactive_reason === "grant_revoked") {
    return pdppError(res, 403, "grant_revoked", "Grant has been revoked");
  }
  if (info.inactive_reason === "grant_expired") {
    return pdppError(res, 403, "grant_expired", "Grant has expired");
  }
  if (info.inactive_reason === "grant_invalid") {
    return pdppError(res, 403, "grant_invalid", "Grant is malformed or no longer valid");
  }
  setProtectedResourceMetadataChallenge(res);
  return pdppError(res, 401, "authentication_error", "Invalid or expired token");
}

export async function requireToken(req: RequestLike, res: ResponseLike, next: Next): Promise<void> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    setProtectedResourceMetadataChallenge(res);
    return pdppError(res, 401, "authentication_error", "Missing Bearer token");
  }
  const token = auth.slice(7);
  const info = await introspect(token);
  if (!info.active) {
    const inactiveInfo: InactiveTokenInfo = "inactive_reason" in info ? info : {};
    return respondToInactiveToken(req, res, inactiveInfo);
  }
  req.tokenInfo = info;
  next();
}

export function requireOwner(req: RequestLike, res: ResponseLike, next: Next): void {
  if (!isTokenInfo(req.tokenInfo)) {
    pdppError(res, 403, "permission_error", "Owner token required");
    return;
  }
  if (req.tokenInfo.pdpp_token_kind !== "owner") {
    pdppError(res, 403, "permission_error", "Owner token required");
    return;
  }
  next();
}

export function requireClient(req: RequestLike, res: ResponseLike, next: Next): void {
  if (!isTokenInfo(req.tokenInfo)) {
    pdppError(res, 403, "permission_error", "Client token required");
    return;
  }
  if (req.tokenInfo.pdpp_token_kind !== "client") {
    pdppError(res, 403, "permission_error", "Client token required");
    return;
  }
  next();
}

// Accept either a per-grant client token (the normal RS token) or a
// hosted-MCP grant-package token. The package token is only meaningful at
// `/mcp`; every other resource-server route stays gated by `requireClient`
// so package tokens cannot reach REST surfaces. Owner tokens are always
// rejected — there is no owner-mode MCP.
function isTokenInfo(value: unknown): value is { pdpp_token_kind?: string } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireClientOrMcpPackage(req: RequestLike, res: ResponseLike, next: Next): void {
  const kind = isTokenInfo(req.tokenInfo) ? req.tokenInfo.pdpp_token_kind : undefined;
  if (kind !== "client" && kind !== "mcp_package") {
    pdppError(
      res,
      403,
      "permission_error",
      "MCP requires a grant-scoped client or MCP package token. Owner-agent bearers are REST/control-plane credentials; use owner-agent REST onboarding for local owner automation."
    );
    return;
  }
  next();
}
