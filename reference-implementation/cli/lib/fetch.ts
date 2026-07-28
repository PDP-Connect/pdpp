// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PdppCliError, PdppHttpError } from "./errors.ts";

// A JSON-parseable HTTP error body: the reference server's error responses
// are objects with any of these optional fields (never all at once), but an
// upstream (e.g. a native provider) can also return a non-object or
// non-JSON body, which falls through to the generic "HTTP <status>" message
// below rather than one of these three.
interface FetchErrorBodyShape {
  error?: { message?: string };
  error_description?: string;
  message?: string;
}

export interface FetchJsonResult {
  body: unknown;
  headers: Headers;
  status: number;
}

export async function fetchJson(url: string, opts: RequestInit = {}): Promise<FetchJsonResult> {
  let resp: Response;
  try {
    resp = await fetch(url, opts);
  } catch (error) {
    // PdppCliError's constructor carries context via `details` (see errors.ts),
    // not the native Error `cause` chain; the message already folds in the
    // underlying error, and CLI errors are rendered to a human terminal
    // (handleError in index.ts prints `.message`), not re-thrown for
    // programmatic unwrapping.
    // biome-ignore lint/style/useErrorCause: see comment above
    throw new PdppCliError(`Network request failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const text = await resp.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!resp.ok) {
    const errorBody = body && typeof body === "object" ? (body as FetchErrorBodyShape) : null;
    const message =
      errorBody?.error_description ||
      errorBody?.error?.message ||
      errorBody?.message ||
      `HTTP ${resp.status} ${resp.statusText}`;
    throw new PdppHttpError(message, resp.status, body, extractReferenceQueryMetadata(resp.headers));
  }

  return { body, headers: resp.headers, status: resp.status };
}

// Accepts `true` because callers pass a resolveOwnerToken/resolveClientToken
// result straight through, and a bare `--token` flag with no value resolves
// to the literal `true` (see args.ts CliFlagValue) rather than a string —
// pre-existing behavior this migration preserves.
export function bearer(token?: string | true | null): { Authorization: string } | Record<string, never> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Every reference `_ref` list/timeline endpoint wraps its rows in
// `{ data: [...] }`. Commands that render a table need just the array; this
// narrows a fetchJson `body` (unknown network JSON) down to that array,
// or [] when the shape does not match (matching the pre-migration
// `body.data || []` fallback).
export function bodyDataArray(body: unknown): unknown[] {
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: unknown[] }).data;
  }
  return [];
}

// The pagination cursor on the same `{ data: [...], next_cursor }` page
// shape bodyDataArray reads; null when the response has no next page (or is
// not a paginated page at all).
export function bodyNextCursor(body: unknown): string | null {
  if (body && typeof body === "object") {
    const cursor = (body as { next_cursor?: unknown }).next_cursor;
    if (typeof cursor === "string") {
      return cursor;
    }
  }
  return null;
}

export interface OwnerSessionHeadersOpts {
  ownerSessionCookie?: string;
}

// Headers needed to call `_ref` reads when the reference server has
// placeholder owner-auth enabled (PDPP_OWNER_PASSWORD set). The owner
// session is a signed HTTP-only cookie issued by `POST /owner/login`;
// CLI callers cannot drive a browser flow, so they pass the raw
// session cookie value via `PDPP_OWNER_SESSION_COOKIE`. When unset the
// helper is a no-op and local-dev `_ref` reads stay open.
export function ownerSessionHeaders(opts: OwnerSessionHeadersOpts = {}): { Cookie: string } | Record<string, never> {
  const fromOpts = typeof opts.ownerSessionCookie === "string" ? opts.ownerSessionCookie : "";
  const fromEnv =
    typeof process.env.PDPP_OWNER_SESSION_COOKIE === "string" ? process.env.PDPP_OWNER_SESSION_COOKIE : "";
  const value = (fromOpts || fromEnv).trim();
  if (!value) {
    return {};
  }
  // Accept either a bare value or a `name=value` pair. The reference
  // cookie name is `pdpp_owner_session`; if the caller passes only the
  // value we attach the canonical name.
  const cookie = value.includes("=") ? value : `pdpp_owner_session=${value}`;
  return { Cookie: cookie };
}

export function attachReferenceQueryMetadata(body: unknown, headers: Headers | undefined): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }

  const { request_id: requestId, reference_trace_id: referenceTraceId } = extractReferenceQueryMetadata(headers);
  if (!(requestId || referenceTraceId)) {
    return body;
  }

  return {
    ...body,
    ...(requestId ? { request_id: requestId } : {}),
    ...(referenceTraceId ? { reference_trace_id: referenceTraceId } : {}),
  };
}

export interface ReferenceQueryMetadata {
  reference_trace_id: string | null;
  request_id: string | null;
}

export function extractReferenceQueryMetadata(headers: Headers | undefined): ReferenceQueryMetadata {
  return {
    reference_trace_id: headers?.get("PDPP-Reference-Trace-Id") || null,
    request_id: headers?.get("Request-Id") || null,
  };
}
