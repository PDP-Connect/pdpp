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

interface ErrorWithFailureReason extends Error {
  failure_reason?: string;
  ingest_failure?: IngestFailureDetail;
  pdpp_error_code?: string;
  response_status?: number;
}

interface IngestFailureDetail {
  batch_size: number;
  http_status: number;
  phase: string;
  response_body_bytes: number;
  response_content_type: string | null;
  stream: string;
}

interface ErrorResponseData {
  error?: {
    code?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export function runtimeFailureReasonFromResponse(status: number, code: string | null | undefined): string | null {
  if (status === 401) {
    return "authentication_error";
  }
  if (status === 403) {
    return code || "permission_error";
  }
  if (status === 429) {
    return code || "rate_limit_error";
  }
  if (status >= 400 && status < 500 && code) {
    return code;
  }
  return null;
}

export function buildHttpFailure(message: string, status: number, bodyText: string): ErrorWithFailureReason {
  let code: string | null = null;
  try {
    const parsed = JSON.parse(bodyText) as ErrorResponseData;
    code = (parsed.error?.code as string | undefined) || null;
  } catch {
    // Ignore parse errors; code remains null on malformed JSON
  }

  const err = new Error(`${message}: ${status} ${bodyText}`) as ErrorWithFailureReason;
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

export function responseBodyBytes(bodyText: string | null | undefined): number {
  return Buffer.byteLength(String(bodyText || ""), "utf8");
}

interface IngestFailureDetailsInput {
  batchSize: number;
  bodyText: string | null | undefined;
  contentType: string | null | undefined;
  phase: string;
  status: number;
  stream: string;
}

export function buildIngestFailureDetails({
  batchSize,
  bodyText,
  contentType,
  phase,
  status,
  stream,
}: IngestFailureDetailsInput): IngestFailureDetail {
  return {
    batch_size: batchSize,
    http_status: status,
    phase,
    response_body_bytes: responseBodyBytes(bodyText),
    response_content_type: contentType || null,
    stream,
  };
}

export function buildIngestHttpFailure(
  message: string,
  stream: string,
  batchSize: number,
  status: number,
  bodyText: string,
  contentType: string | null | undefined
): ErrorWithFailureReason {
  const err = buildHttpFailure(message, status, bodyText);
  if (!err.failure_reason) {
    err.failure_reason = "ingest_http_error";
  }
  err.ingest_failure = buildIngestFailureDetails({
    batchSize,
    bodyText,
    contentType,
    phase: "http_response",
    status,
    stream,
  });
  return err;
}

interface InvalidIngestResponseFailureInput {
  batchSize: number;
  bodyText: string | null | undefined;
  cause: string;
  contentType: string | null | undefined;
  phase: string;
  status: number;
  stream: string;
}

export function buildInvalidIngestResponseFailure({
  batchSize,
  bodyText,
  cause,
  contentType,
  phase,
  status,
  stream,
}: InvalidIngestResponseFailureInput): ErrorWithFailureReason {
  const err = new Error(
    `Ingest response for ${stream} was invalid after HTTP ${status}: ${cause}`
  ) as ErrorWithFailureReason;
  err.failure_reason = "ingest_response_invalid";
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
