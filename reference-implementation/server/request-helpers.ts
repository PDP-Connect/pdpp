// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Generic request/response infrastructure helpers for the PDPP reference server.
 *
 * Concept: stateless helpers for request IDs, error responses, trace headers,
 * and query spine emission. No auth logic lives here.
 *
 * Dependency direction: this is a LEAF — it imports only from lib/spine.ts and
 * routes/ref-error-status.ts. Nothing imports from auth-middleware.ts or index.js.
 */

import { emitSpineEvent, generateSpineId, type SpineEventInput } from "../lib/spine.ts";
import { codeToStatus, typeFor } from "./routes/ref-error-status.ts";

// ─── Structural request/response shapes ──────────────────────────────────────
// Narrow structural views of the Express-shaped request/response objects the
// transport passes in; we type only the members these helpers read/write.

interface ResponseLike {
  getHeader: (name: string) => unknown;
  json: (body: { error: Record<string, unknown> }) => unknown;
  locals?: Record<string, unknown>;
  setHeader: (name: string, value: string) => void;
  status: (code: number) => ResponseLike;
}

interface RequestLike {
  headers: { authorization?: string | undefined; [key: string]: unknown };
}

interface ErrorWithCode extends Error {
  code?: string;
}

interface TokenInfoLike {
  client_id?: string | null;
  grant_id?: string | null;
  subject_id?: string | null;
}

interface QueryContext {
  actorId?: string | null;
  actorType?: string | null;
  queryData?: Record<string, unknown>;
  queryId?: string | null;
  receivedEmitted?: boolean;
  scenarioId?: string | null;
  sourceDescriptor?: unknown;
  streamId?: string | null;
  tokenInfo?: TokenInfoLike | null;
  traceId?: string | null;
}

interface PdppErrorExtras {
  available_connections?: unknown;
  retry_with?: unknown;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const PDPP_REFERENCE_TRACE_ID_HEADER = "PDPP-Reference-Trace-Id";
export const PROTECTED_RESOURCE_METADATA_URL_LOCAL = "protectedResourceMetadataUrl";
const PROTECTED_RESOURCE_METADATA_NEXT_STEP =
  "Fetch error.resource_metadata, then follow pdpp_agent_discovery.cli when token completion is available; otherwise request a scoped client grant without using an owner bearer token.";

// ─── Response helpers ────────────────────────────────────────────────────────

export function getProtectedResourceMetadataUrl(res: ResponseLike): string | null {
  const metadataUrl = res.locals?.[PROTECTED_RESOURCE_METADATA_URL_LOCAL];
  return typeof metadataUrl === "string" && metadataUrl ? metadataUrl : null;
}

export function ensureRequestId(res: ResponseLike): string {
  const existing = res.getHeader("Request-Id");
  if (typeof existing === "string" && existing.trim()) {
    return existing.trim();
  }
  const generated = generateSpineId("req");
  res.setHeader("Request-Id", generated);
  return generated;
}

export function setReferenceTraceId(res: ResponseLike, traceId: string | null | undefined): void {
  if (traceId) {
    res.setHeader(PDPP_REFERENCE_TRACE_ID_HEADER, traceId);
  }
}

export function pdppError(
  res: ResponseLike,
  status: number,
  code: string,
  message: string,
  param: string | null = null,
  extras: PdppErrorExtras | null = null
): void {
  const errorBody: Record<string, unknown> = { code, message, type: typeFor(status) };
  const body = { error: errorBody };
  if (param) {
    errorBody.param = param;
  }
  if (extras && typeof extras === "object") {
    if (Array.isArray(extras.available_connections)) {
      errorBody.available_connections = extras.available_connections;
    }
    if (typeof extras.retry_with === "string") {
      errorBody.retry_with = extras.retry_with;
    }
  }
  const resourceMetadataUrl = status === 401 ? getProtectedResourceMetadataUrl(res) : null;
  if (resourceMetadataUrl) {
    errorBody.resource_metadata = resourceMetadataUrl;
    errorBody.next_step = PROTECTED_RESOURCE_METADATA_NEXT_STEP;
  }
  errorBody.request_id = ensureRequestId(res);
  res.status(status).json(body);
}

// ─── Query spine emission ────────────────────────────────────────────────────

export async function emitQueryRejected(context: QueryContext, req: RequestLike, err: ErrorWithCode): Promise<void> {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (!context?.queryId) {
    return;
  }
  const code = err.code || "api_error";
  const status = codeToStatus[code] || 500;
  const data: Record<string, unknown> = {
    ...(context.queryData || {}),
    error: {
      code,
      http_status: status,
      message: err.message,
    },
  };
  if (Object.hasOwn(context, "sourceDescriptor")) {
    data.source = context.sourceDescriptor ?? null;
  }

  await emitSpineEvent({
    actor_id: context.actorId,
    actor_type: context.actorType,
    client_id: context.tokenInfo?.client_id || null,
    data,
    event_type: "query.rejected",
    grant_id: context.tokenInfo?.grant_id || null,
    object_id: context.queryId,
    object_type: "query",
    scenario_id: context.scenarioId,
    status: "failed",
    stream_id: context.streamId || null,
    subject_id: context.tokenInfo?.subject_id || null,
    subject_type: "subject",
    token_id: req.headers.authorization?.slice(7) || null,
    trace_id: context.traceId,
    // Cast bridges `exactOptionalPropertyTypes`: several context fields are
    // `string | null | undefined` at runtime (e.g. `scenarioId` from
    // `scenario_id || undefined`), which the runtime spine input accepts but
    // the stricter compile-time optional-property shape rejects. No value is
    // coerced — the emitted object is byte-identical to the pre-migration JS.
  } as SpineEventInput);
}

export async function emitQueryReceived(context: QueryContext, req: RequestLike): Promise<void> {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  if (!context?.queryId) {
    return;
  }
  if (context.receivedEmitted) {
    return;
  }
  context.receivedEmitted = true;

  const data: Record<string, unknown> = {
    ...(context.queryData || {}),
  };
  if (Object.hasOwn(context, "sourceDescriptor")) {
    data.source = context.sourceDescriptor ?? null;
  }

  await emitSpineEvent({
    actor_id: context.actorId,
    actor_type: context.actorType,
    client_id: context.tokenInfo?.client_id || null,
    data,
    event_type: "query.received",
    grant_id: context.tokenInfo?.grant_id || null,
    object_id: context.queryId,
    object_type: "query",
    scenario_id: context.scenarioId,
    status: "started",
    stream_id: context.streamId || null,
    subject_id: context.tokenInfo?.subject_id || null,
    subject_type: "subject",
    token_id: req.headers.authorization?.slice(7) || null,
    trace_id: context.traceId,
    // See the cast note in `emitQueryRejected` above — same runtime-vs-
    // exactOptional bridge; no value coercion.
  } as SpineEventInput);
}
