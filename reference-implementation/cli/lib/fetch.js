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
