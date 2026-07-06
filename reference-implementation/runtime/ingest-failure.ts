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
    stream,
    batch_size: batchSize,
    http_status: status,
    phase,
    response_content_type: contentType || null,
    response_body_bytes: responseBodyBytes(bodyText),
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
): Promise<{ records_accepted: number; records_rejected: number }> {
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

  if (
    !result ||
    typeof result !== "object" ||
    !Number.isFinite((result as Record<string, unknown>).records_accepted) ||
    !Number.isFinite((result as Record<string, unknown>).records_rejected)
  ) {
    throw buildInvalidIngestResponseFailure({
      batchSize,
      bodyText,
      cause: "expected numeric records_accepted and records_rejected",
      contentType,
      phase: "validate_response",
      status: resp.status,
      stream,
    });
  }

  return result as { records_accepted: number; records_rejected: number };
}
