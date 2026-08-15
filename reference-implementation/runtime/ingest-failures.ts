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

interface IngestEnvelopeContractViolationFailureInput {
  batchSize: number;
  recordsAccepted: number;
  recordsRejected: number;
  status: number;
  stream: string;
}

/**
 * Defensive protocol-violation net, NOT the primary silent-drop defense.
 *
 * The primary defense lives server-side: `rs.records.ingest` (the
 * operation) classifies every per-record failure as PERMANENT (a genuine
 * data defect — malformed JSON, a schema/identity violation; same input
 * always fails identically) or SYSTEMIC (a storage/coordination failure
 * that never proved the record's own data invalid, or any error the host's
 * classifier does not recognize — unknown defaults to systemic). Any
 * systemic failure anywhere in a batch makes the operation throw
 * `RecordsIngestSystemicFailureError`, which the route maps to a non-2xx
 * (503) response — so `readIngestResponse`'s `!resp.ok` branch above already
 * throws a retryable failure for that case via `buildIngestHttpFailure`,
 * BEFORE this function is ever reached. A 2xx response with `records_rejected`
 * covering some or even all of the batch is the intentional, unchanged
 * per-record isolation contract and must resolve as a counted, continued
 * success no matter how many records it rejects — count alone was
 * historically (and wrongly) used to infer retryability here, which
 * conflated N legitimate permanent rejections with a systemic one.
 *
 * What this function actually guards is a conforming-RS-contract VIOLATION:
 * a 2xx response whose own `records_accepted + records_rejected` doesn't sum
 * to the batch size at all — a shape the current server-side contract should
 * never produce (every line in the runtime's own well-formed NDJSON is
 * always accounted for in the envelope, or the batch throws non-2xx first).
 * Seeing it anyway means the RS answering this request is not honoring its
 * own contract (a stale/non-reference-implementation RS, or a bug) — a
 * distinct, rarer failure mode from "some records were rejected," which
 * this function deliberately does NOT trigger on.
 */
export function buildIngestEnvelopeContractViolationFailure({
  batchSize,
  recordsAccepted,
  recordsRejected,
  status,
  stream,
}: IngestEnvelopeContractViolationFailureInput): ErrorWithFailureReason {
  const err = new Error(
    `Ingest for ${stream} returned a 2xx envelope whose records_accepted+records_rejected ` +
      `(${recordsAccepted}+${recordsRejected}) does not account for the submitted batch (${batchSize}) after HTTP ` +
      `${status}; the RS is not honoring the rs.records.ingest envelope contract — treating as a non-successful, retryable failure`
  ) as ErrorWithFailureReason;
  err.failure_reason = "ingest_envelope_contract_violation";
  err.pdpp_error_code = "ingest_envelope_contract_violation";
  err.response_status = status;
  err.ingest_failure = buildIngestFailureDetails({
    batchSize,
    bodyText: null,
    contentType: null,
    phase: "envelope_contract_violation",
    status,
    stream,
  });
  return err;
}
