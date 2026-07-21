// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PdppCliError, PdppHttpError } from './errors.js';

export async function fetchJson(url, opts = {}) {
  let resp;
  try {
    resp = await fetch(url, opts);
  } catch (error) {
    throw new PdppCliError(`Network request failed: ${error.message}`);
  }

  const text = await resp.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!resp.ok) {
    const message =
      body?.error_description ||
      body?.error?.message ||
      body?.message ||
      `HTTP ${resp.status} ${resp.statusText}`;
    throw new PdppHttpError(message, resp.status, body, extractReferenceQueryMetadata(resp.headers));
  }

  return { status: resp.status, body, headers: resp.headers };
}

export function bearer(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// Headers needed to call `_ref` reads when the reference server has
// placeholder owner-auth enabled (PDPP_OWNER_PASSWORD set). The owner
// session is a signed HTTP-only cookie issued by `POST /owner/login`;
// CLI callers cannot drive a browser flow, so they pass the raw
// session cookie value via `PDPP_OWNER_SESSION_COOKIE`. When unset the
// helper is a no-op and local-dev `_ref` reads stay open.
export function ownerSessionHeaders(opts = {}) {
  const fromOpts = typeof opts.ownerSessionCookie === 'string' ? opts.ownerSessionCookie : '';
  const fromEnv = typeof process.env.PDPP_OWNER_SESSION_COOKIE === 'string'
    ? process.env.PDPP_OWNER_SESSION_COOKIE
    : '';
  const value = (fromOpts || fromEnv).trim();
  if (!value) return {};
  // Accept either a bare value or a `name=value` pair. The reference
  // cookie name is `pdpp_owner_session`; if the caller passes only the
  // value we attach the canonical name.
  const cookie = value.includes('=') ? value : `pdpp_owner_session=${value}`;
  return { Cookie: cookie };
}

export function attachReferenceQueryMetadata(body, headers) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }

  const { request_id: requestId, reference_trace_id: referenceTraceId } = extractReferenceQueryMetadata(headers);
  if (!requestId && !referenceTraceId) {
    return body;
  }

  return {
    ...body,
    ...(requestId ? { request_id: requestId } : {}),
    ...(referenceTraceId ? { reference_trace_id: referenceTraceId } : {}),
  };
}

export function extractReferenceQueryMetadata(headers) {
  return {
    request_id: headers?.get('Request-Id') || null,
    reference_trace_id: headers?.get('PDPP-Reference-Trace-Id') || null,
  };
}
