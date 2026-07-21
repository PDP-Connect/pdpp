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

import { introspect } from './auth.js';
import {
  emitQueryReceived,
  emitQueryRejected,
  ensureRequestId,
  getProtectedResourceMetadataUrl,
  pdppError,
  setReferenceTraceId,
} from './request-helpers.ts';

// ─── Auth-private helpers ─────────────────────────────────────────────────────

function httpQuotedString(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

function setProtectedResourceMetadataChallenge(res) {
  const metadataUrl = getProtectedResourceMetadataUrl(res);
  if (!metadataUrl) {
    return;
  }
  res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${httpQuotedString(metadataUrl)}"`);
}

// ─── Auth-gate query context ─────────────────────────────────────────────────

function inferAuthGateQueryProjection(req) {
  const parsedLimit = typeof req.query?.limit === 'string' ? Number.parseInt(req.query.limit, 10) : null;
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null;
  const hasChangesSince = typeof req.query?.changes_since === 'string' && req.query.changes_since.length > 0;

  return { hasChangesSince, limit };
}

function projectAuthGateRouteContext(segments, req, queryProjection) {
  if (segments.length === 2) {
    return { queryShape: 'stream_list', streamId: null };
  }
  if (segments.length === 3) {
    return { queryShape: 'stream_metadata', streamId: segments[2] };
  }
  if (segments.length === 4 && segments[3] === 'aggregate') {
    return {
      queryShape: 'stream_aggregate',
      streamId: segments[2],
      metric: typeof req.query?.metric === 'string' ? req.query.metric : null,
      field: typeof req.query?.field === 'string' ? req.query.field : null,
      groupBy: typeof req.query?.group_by === 'string' ? req.query.group_by : null,
    };
  }
  if (segments.length === 4 && segments[3] === 'records') {
    return {
      queryShape: 'record_list',
      streamId: segments[2],
      requestedRecordId: null,
      hasChangesSince: queryProjection.hasChangesSince,
      limit: queryProjection.limit,
    };
  }
  if (segments.length === 5 && segments[3] === 'records') {
    return { queryShape: 'record_detail', streamId: segments[2], requestedRecordId: segments[4] };
  }

  return null;
}

function inferAuthGateQueryContext(req) {
  if (req.method !== 'GET') return null;

  const segments = String(req.path || '')
    .split('/')
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  if (segments[0] !== 'v1' || segments[1] !== 'streams') return null;
  const queryProjection = inferAuthGateQueryProjection(req);
  return projectAuthGateRouteContext(segments, req, queryProjection);
}

// ─── Auth middleware ──────────────────────────────────────────────────────────

export async function requireToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    setProtectedResourceMetadataChallenge(res);
    return pdppError(res, 401, 'authentication_error', 'Missing Bearer token');
  }
  const token = auth.slice(7);
  const info = await introspect(token);
  if (!info.active) {
    if (info.trace_id) {
      setReferenceTraceId(res, info.trace_id);
    }
    const authGateQuery = inferAuthGateQueryContext(req);
    if (authGateQuery && info.trace_id) {
      const authGateContext = {
        tokenInfo: info,
        queryId: ensureRequestId(res),
        actorType: 'client',
        actorId: info.client_id || null,
        traceId: info.trace_id,
        scenarioId: info.scenario_id || undefined,
        streamId: authGateQuery.streamId,
        queryData: {
          query_shape: authGateQuery.queryShape,
          auth_gate: true,
          ...(authGateQuery.queryShape === 'record_list'
            ? {
                has_changes_since: authGateQuery.hasChangesSince ?? false,
                limit: authGateQuery.limit ?? null,
              }
            : {}),
          ...(authGateQuery.requestedRecordId
            ? { requested_record_id: authGateQuery.requestedRecordId }
            : {}),
        },
      };
      await emitQueryReceived(authGateContext, req);
      await emitQueryRejected(authGateContext, req, {
        code: info.inactive_reason || 'authentication_error',
        message:
          info.inactive_reason === 'grant_revoked'
            ? 'Grant has been revoked'
            : info.inactive_reason === 'grant_expired'
              ? 'Grant has expired'
              : info.inactive_reason === 'grant_invalid'
                ? 'Grant is malformed or no longer valid'
                : 'Invalid or expired token',
      });
    }
    if (info.inactive_reason === 'grant_revoked') {
      return pdppError(res, 403, 'grant_revoked', 'Grant has been revoked');
    }
    if (info.inactive_reason === 'grant_expired') {
      return pdppError(res, 403, 'grant_expired', 'Grant has expired');
    }
    if (info.inactive_reason === 'grant_invalid') {
      return pdppError(res, 403, 'grant_invalid', 'Grant is malformed or no longer valid');
    }
    setProtectedResourceMetadataChallenge(res);
    return pdppError(res, 401, 'authentication_error', 'Invalid or expired token');
  }
  req.tokenInfo = info;
  next();
}

export function requireOwner(req, res, next) {
  if (req.tokenInfo.pdpp_token_kind !== 'owner') {
    return pdppError(res, 403, 'permission_error', 'Owner token required');
  }
  next();
}

export function requireClient(req, res, next) {
  if (req.tokenInfo.pdpp_token_kind !== 'client') {
    return pdppError(res, 403, 'permission_error', 'Client token required');
  }
  next();
}

// Accept either a per-grant client token (the normal RS token) or a
// hosted-MCP grant-package token. The package token is only meaningful at
// `/mcp`; every other resource-server route stays gated by `requireClient`
// so package tokens cannot reach REST surfaces. Owner tokens are always
// rejected — there is no owner-mode MCP.
export function requireClientOrMcpPackage(req, res, next) {
  const kind = req.tokenInfo?.pdpp_token_kind;
  if (kind !== 'client' && kind !== 'mcp_package') {
    return pdppError(
      res,
      403,
      'permission_error',
      'MCP requires a grant-scoped client or MCP package token. Owner-agent bearers are REST/control-plane credentials; use owner-agent REST onboarding for local owner automation.',
    );
  }
  next();
}
