// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

interface IngestFailureDetails {
  batch_size: number;
  http_status: number;
  phase: string;
  response_body_bytes: number;
  response_content_type: string | null;
  stream: string;
}

interface IngestHttpFailureError extends Error {
  failure_reason?: string;
  ingest_failure?: IngestFailureDetails;
  pdpp_error_code?: string;
  response_status?: number;
}

type BuildHttpFailureFn = (message: string, status: number, bodyText: string) => IngestHttpFailureError;

export interface IngestRejectionReceipt {
  code: string;
  input_index: number;
  receipt_id: string;
}

export interface IngestResult {
  records_accepted: number;
  records_attempted: number;
  records_rejected: number;
  rejections: IngestRejectionReceipt[];
}

interface BuildHttpFailureDeps {
  buildHttpFailure: BuildHttpFailureFn;
}

function responseBodyBytes(bodyText: string | null | undefined): number {
  return Buffer.byteLength(String(bodyText ?? ""), "utf8");
}

function buildIngestFailureDetails({
  batchSize,
  bodyText,
  contentType,
  phase,
  status,
  stream,
}: {
  batchSize: number;
  bodyText: string;
  contentType: string | null;
  phase: string;
  status: number;
  stream: string;
}): IngestFailureDetails {
  return {
    batch_size: batchSize,
    http_status: status,
    phase,
    response_body_bytes: responseBodyBytes(bodyText),
    response_content_type: contentType || null,
    stream,
  };
}

function buildIngestHttpFailure(
  message: string,
  stream: string,
  batchSize: number,
  status: number,
  bodyText: string,
  contentType: string | null,
  { buildHttpFailure }: BuildHttpFailureDeps
): IngestHttpFailureError {
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

function buildInvalidIngestResponseFailure({
  batchSize,
  bodyText,
  cause,
  contentType,
  phase,
  status,
  stream,
}: {
  batchSize: number;
  bodyText: string;
  cause: string;
  contentType: string | null;
  phase: string;
  status: number;
  stream: string;
}): IngestHttpFailureError {
  const err: IngestHttpFailureError = new Error(
    `Ingest response for ${stream} was invalid after HTTP ${status}: ${cause}`
  );
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

export async function readIngestResponse(
  resp: Response,
  stream: string,
  batchSize: number,
  { buildHttpFailure }: BuildHttpFailureDeps
): Promise<IngestResult> {
  const contentType = resp.headers.get("content-type");
  const bodyText = await resp.text();
  if (!resp.ok) {
    throw buildIngestHttpFailure(`Ingest failed for ${stream}`, stream, batchSize, resp.status, bodyText, contentType, {
      buildHttpFailure,
    });
  }

  let result: unknown;
  try {
    result = JSON.parse(bodyText);
  } catch (err) {
    throw buildInvalidIngestResponseFailure({
      batchSize,
      bodyText,
      cause: err instanceof Error ? err.message : String(err),
      contentType,
      phase: "parse_response",
      status: resp.status,
      stream,
    });
  }

  const validationError = validateIngestResponseContract(result, batchSize);
  if (validationError) {
    throw buildInvalidIngestResponseFailure({
      batchSize,
      bodyText,
      cause: validationError,
      contentType,
      phase: "validate_response",
      status: resp.status,
      stream,
    });
  }

  return result as IngestResult;
}

function validateIngestResponseContract(result: unknown, batchSize: number): string | null {
  if (!result || typeof result !== "object") {
    return "expected JSON object ingest response";
  }

  const record = result as Record<string, unknown>;
  return validateIngestCounts(record, batchSize) || validateRejectionEnvelope(record, batchSize);
}

function validateIngestCounts(record: Record<string, unknown>, batchSize: number): string | null {
  const recordsAttempted = record.records_attempted;
  const recordsAccepted = record.records_accepted;
  const recordsRejected = record.records_rejected;
  if (
    !(
      isNonnegativeInteger(recordsAttempted) &&
      isNonnegativeInteger(recordsAccepted) &&
      isNonnegativeInteger(recordsRejected)
    )
  ) {
    return "expected integer nonnegative records_attempted, records_accepted, and records_rejected";
  }

  if (recordsAttempted !== batchSize) {
    return "records_attempted must equal submitted batch size";
  }
  if (recordsAttempted !== recordsAccepted + recordsRejected) {
    return "records_attempted must equal records_accepted plus records_rejected";
  }

  return null;
}

function validateRejectionEnvelope(record: Record<string, unknown>, batchSize: number): string | null {
  const recordsRejected = record.records_rejected;
  if (!isNonnegativeInteger(recordsRejected)) {
    return "expected integer nonnegative records_rejected";
  }

  if (!Array.isArray(record.rejections)) {
    return "expected rejections array";
  }
  if (record.rejections.length !== recordsRejected) {
    return "rejections length must equal records_rejected";
  }

  return validateRejectionVector(record.rejections, batchSize);
}

function validateRejectionVector(rejections: unknown[], batchSize: number): string | null {
  const indexes = new Set<number>();
  for (const rejection of rejections) {
    const error = validateRejectionEntry(rejection, indexes, batchSize);
    if (error) {
      return error;
    }
  }

  return null;
}

function validateRejectionEntry(rejection: unknown, indexes: Set<number>, batchSize: number): string | null {
  if (!rejection || typeof rejection !== "object") {
    return "expected rejection entries to be objects";
  }
  const entry = rejection as Record<string, unknown>;
  return validateRejectionIndex(entry.input_index, indexes, batchSize) || validateRejectionReceiptFields(entry);
}

function validateRejectionIndex(inputIndex: unknown, indexes: Set<number>, batchSize: number): string | null {
  if (!isNonnegativeInteger(inputIndex) || inputIndex >= batchSize) {
    return "rejection input_index must be an integer inside the submitted batch";
  }
  if (indexes.has(inputIndex)) {
    return "rejection input_index values must be unique";
  }
  indexes.add(inputIndex);
  return null;
}

function validateRejectionReceiptFields(entry: Record<string, unknown>): string | null {
  if (!isNonemptyString(entry.receipt_id)) {
    return "rejection receipt_id must be a nonempty opaque string";
  }
  if (!isNonemptyString(entry.code)) {
    return "rejection code must be a nonempty typed string";
  }
  return null;
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
