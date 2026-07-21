// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Ingest-failure shaping for the connector runtime.
//
// When a RECORD batch is ingested to the RS over the owner token, the HTTP
// response can fail (non-2xx) or be structurally invalid (unparseable body,
// missing accepted/rejected counts). These helpers turn those outcomes into
// Error objects carrying the runtime's structured `failure_reason`,
// `response_status`, and bounded `ingest_failure` detail block that the
// terminal `run.failed` event and owner UI consume.
//
// Extracted from runtime/index.js: pure response→Error shaping with no
// runtime state, no secret handling, and no grant/scope enforcement.

export function runtimeFailureReasonFromResponse(status, code) {
  if (status === 401) return 'authentication_error';
  if (status === 403) return code || 'permission_error';
  if (status === 429) return code || 'rate_limit_error';
  if (status >= 400 && status < 500 && code) return code;
  return null;
}

export function buildHttpFailure(message, status, bodyText) {
  let code = null;
  try {
    const parsed = JSON.parse(bodyText);
    code = parsed?.error?.code || null;
  } catch {}

  const err = new Error(`${message}: ${status} ${bodyText}`);
  const failureReason = runtimeFailureReasonFromResponse(status, code);
  if (failureReason) {
    err.failure_reason = failureReason;
  }
  if (code) {
    err.pdpp_error_code = code;
  }
  err.response_status = status;
  return err;
}

export function responseBodyBytes(bodyText) {
  return Buffer.byteLength(String(bodyText || ''), 'utf8');
}

export function buildIngestFailureDetails({
  batchSize,
  bodyText,
  contentType,
  phase,
  status,
  stream,
}) {
  return {
    stream,
    batch_size: batchSize,
    http_status: status,
    phase,
    response_content_type: contentType || null,
    response_body_bytes: responseBodyBytes(bodyText),
  };
}

export function buildIngestHttpFailure(message, stream, batchSize, status, bodyText, contentType) {
  const err = buildHttpFailure(message, status, bodyText);
  if (!err.failure_reason) {
    err.failure_reason = 'ingest_http_error';
  }
  err.ingest_failure = buildIngestFailureDetails({
    batchSize,
    bodyText,
    contentType,
    phase: 'http_response',
    status,
    stream,
  });
  return err;
}

export function buildInvalidIngestResponseFailure({ batchSize, bodyText, cause, contentType, phase, status, stream }) {
  const err = new Error(`Ingest response for ${stream} was invalid after HTTP ${status}: ${cause}`);
  err.failure_reason = 'ingest_response_invalid';
  err.response_status = status;
  err.ingest_failure = buildIngestFailureDetails({
    batchSize,
    bodyText,
    contentType,
    phase,
    status,
    stream,
  });
  return err;
}
