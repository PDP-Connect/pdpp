// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `rs.records.ingest` operation.
 *
 * Owns the RS ingest semantics for `POST /v1/ingest/:stream`:
 *
 * - body line splitting / non-empty filter (the operation owns the line
 *   model);
 * - connector_id presence validation (`invalid_request`);
 * - manifest stream existence (`not_found`);
 * - per-line JSON parse + ingest, with accepted / rejected counters and a
 *   parallel errors array;
 * - the public `{ stream, records_accepted, records_rejected, errors }`
 *   response envelope.
 *
 * The capability is deliberately per-line and ordered: the operation parses
 * one line, awaits that line's `ingestRecord` call, then advances. It MUST
 * NOT parallelize ingest, batch ingests, or coalesce errors.
 *
 * Atomicity and durable write ordering for each record remain the
 * responsibility of the underlying ingest capability. A failure on one line
 * increments `records_rejected` and continues; it MUST NOT roll back earlier
 * accepted records (matches the previous native route behavior).
 *
 * Boundary rules:
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, sandbox modules, the Fastify host module
 *   (`server/index.js`), the records module (`server/records.js`), or
 *   `process` / `process.env`.
 */

export interface RecordsIngestInput {
  /** Raw NDJSON body as received by the host. */
  readonly body: string | null | undefined;
  /** Connector id parsed from the query string. May be null/empty. */
  readonly connectorId: string | null;
  /** Connector instance id parsed from the query string. Optional for legacy connector-only compatibility. */
  readonly connectorInstanceId?: string | null;
  /** Stream name from the request path. */
  readonly streamName: string;
}

/**
 * A single record's ingest failure, classified by the host's own typed error
 * shape (never by matching `.message` text). `retryable: false` is the
 * intentional per-record isolation contract this operation has always
 * supported — a malformed/invalid record, same input fails identically on
 * every retry. `retryable: true` means the record's OWN data was never
 * proven bad; a storage/coordination failure (or an error the host's
 * classifier does not recognize — see the "unknown defaults to retryable"
 * rule in `server/records.ts`'s `classifyIngestFailure`) prevented the
 * durable write from being confirmed. At least one `retryable: true` line
 * anywhere in the batch makes the whole HTTP response non-2xx (see
 * `executeRecordsIngest`), even if other lines in the same request
 * genuinely and permanently failed or committed durably — a systemic
 * failure must never be reported as an ordinary partial-rejection success.
 */
export interface IngestLineFailure {
  readonly message: string;
  readonly retryable: boolean;
}

export interface RecordsIngestDependencies {
  hasManifestStream: (connectorId: string, streamName: string) => boolean | Promise<boolean>;
  /**
   * Ingest a single parsed record under the connector instance + stream.
   * Hosts wire the existing durable ingest capability after resolving
   * connector-only compatibility to a connector instance. Throws on failure;
   * the operation classifies the thrown error (via the host's own typed
   * shape) and increments `records_rejected`.
   */
  ingestRecord: (
    connectorId: string,
    connectorInstanceId: string | null,
    record: Record<string, unknown>
  ) => unknown | Promise<unknown>;
}

export interface RecordsIngestEnvelope {
  readonly errors: readonly string[];
  readonly records_accepted: number;
  readonly records_rejected: number;
  readonly stream: string;
}

export interface RecordsIngestOutput {
  readonly envelope: RecordsIngestEnvelope;
  /**
   * Number of non-empty lines parsed from the body (the same value used by
   * the host's `mutation.requested` `submitted_record_count`). Hosts that
   * need to populate this on the requested-event MAY call `parseLines`
   * directly, then pass `lines` back through `executeRecordsIngest` if they
   * have a reason to split the two phases.
   */
  readonly submittedRecordCount: number;
}

export class RecordsIngestInvalidRequestError extends Error {
  readonly code: "invalid_request";

  constructor(message: string) {
    super(message);
    this.name = "RecordsIngestInvalidRequestError";
    this.code = "invalid_request";
  }
}

export class RecordsIngestNotFoundError extends Error {
  readonly code: "not_found";

  constructor(message: string) {
    super(message);
    this.name = "RecordsIngestNotFoundError";
    this.code = "not_found";
  }
}

/**
 * At least one record in this batch failed with a systemic/retryable
 * classification (see `IngestLineFailure`) — a storage or coordination
 * failure that never proved the record's own data invalid. The route maps
 * this to a non-2xx response so the runtime's ingest transport (which trusts
 * `resp.ok` as its success signal) fails the run and retries instead of
 * reading a 200 envelope that would otherwise read as an ordinary partial
 * per-record rejection. This is deliberately thrown even when OTHER records
 * in the same batch committed durably or failed permanently — a durable
 * write is never rolled back, and retrying the same batch is safe because
 * ingest is idempotent per the manifest's primary_key/upsert semantics, so
 * an accepted-prefix does not duplicate on retry.
 */
export class RecordsIngestSystemicFailureError extends Error {
  readonly code: "ingest_batch_storage_error";
  readonly retryableFailureCount: number;

  constructor(message: string, retryableFailureCount: number) {
    super(message);
    this.name = "RecordsIngestSystemicFailureError";
    this.code = "ingest_batch_storage_error";
    this.retryableFailureCount = retryableFailureCount;
  }
}

/**
 * Split a raw NDJSON body into non-empty lines. The matching split rule is
 * exposed so hosts can compute `submitted_record_count` for the
 * `mutation.requested` event before invoking the operation, without
 * duplicating the line-model rule.
 */
export function parseLines(body: string | null | undefined): string[] {
  if (typeof body !== "string" || body.length === 0) {
    return [];
  }
  return body.split("\n").filter((line) => line.trim().length > 0);
}

/**
 * Classify an error thrown directly by the single-record `ingestRecord`
 * dependency. Reads the SAME typed `.retryable` boolean a host's storage
 * layer already attaches to its own classified failures (see
 * `server/records.ts`'s `classifyIngestFailure`) when present; falls back to
 * retryable/systemic for any error the host did not classify (an
 * unrecognized shape thrown before classification could run, or a host that
 * doesn't classify at all). Never inspects `.message`.
 */
function classifyThrownIngestError(err: unknown): IngestLineFailure {
  const message = err instanceof Error ? err.message : String(err);
  const retryableField = (err as { retryable?: unknown } | null)?.retryable;
  const retryable = typeof retryableField === "boolean" ? retryableField : true;
  return { message, retryable };
}

function buildIngestEnvelope(stream: string, lineErrors: readonly (IngestLineFailure | null)[]): RecordsIngestEnvelope {
  let recordsAccepted = 0;
  let recordsRejected = 0;
  const errors: string[] = [];
  for (const error of lineErrors) {
    if (error === null) {
      recordsAccepted += 1;
    } else {
      recordsRejected += 1;
      errors.push(error.message);
    }
  }
  return { errors, records_accepted: recordsAccepted, records_rejected: recordsRejected, stream };
}

function countRetryableFailures(lineErrors: readonly (IngestLineFailure | null)[]): number {
  let count = 0;
  for (const error of lineErrors) {
    if (error?.retryable) {
      count += 1;
    }
  }
  return count;
}

function firstRetryableFailureMessage(lineErrors: readonly (IngestLineFailure | null)[]): string | null {
  for (const error of lineErrors) {
    if (error?.retryable) {
      return error.message;
    }
  }
  return null;
}

/**
 * Execute the canonical `rs.records.ingest` operation.
 *
 * Order matches the previous native route:
 *   1. parse non-empty NDJSON lines.
 *   2. invalid_request when connector_id is missing/empty.
 *   3. not_found when the manifest does not declare the stream.
 *   4. iterate lines sequentially. Each line is JSON.parsed and ingested
 *      under `{ ...record, stream }`. JSON.parse failures and ingest throws
 *      both increment records_rejected and append the message to errors.
 *   5. return the envelope plus submitted_record_count for instrumentation.
 */
export async function executeRecordsIngest(
  input: RecordsIngestInput,
  dependencies: RecordsIngestDependencies
): Promise<RecordsIngestOutput> {
  const lines = parseLines(input.body);
  const submittedRecordCount = lines.length;

  const connectorId = typeof input.connectorId === "string" ? input.connectorId : null;
  if (!connectorId) {
    throw new RecordsIngestInvalidRequestError("connector_id must be a single non-empty string");
  }

  const visible = await dependencies.hasManifestStream(connectorId, input.streamName);
  if (!visible) {
    throw new RecordsIngestNotFoundError(`Stream '${input.streamName}' not found for connector ${connectorId}`);
  }

  const lineErrors = new Array<IngestLineFailure | null>(lines.length).fill(null);

  for (const [lineIndex, line] of lines.entries()) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch (err) {
      lineErrors[lineIndex] = { message: err instanceof Error ? err.message : String(err), retryable: false };
      continue;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Preserves established ordered async behavior and mutation timing.
      await dependencies.ingestRecord(connectorId, input.connectorInstanceId ?? null, {
        ...parsed,
        stream: input.streamName,
      });
    } catch (err) {
      lineErrors[lineIndex] = classifyThrownIngestError(err);
    }
  }

  // At least one line failed systemically (retryable: true) — a storage or
  // coordination failure that never proved that line's OWN data invalid.
  // This is thrown AFTER every per-record write already ran to completion
  // (each record's durable write is its own independent transaction; a later
  // record's failure never rolls back an earlier one), so any records that
  // committed durably or failed permanently in the SAME batch stay exactly
  // as they are — this only changes what the HTTP RESPONSE reports. A caller
  // that trusts a 2xx status as its success signal (the runtime's ingest
  // transport does) must never read this batch as ordinary partial-rejection
  // success: retrying the identical batch is safe (idempotent per the
  // manifest's primary_key/upsert semantics), so surfacing it as a non-2xx,
  // retryable failure is strictly safer than the 200 envelope this replaces.
  const retryableFailureCount = countRetryableFailures(lineErrors);
  if (retryableFailureCount > 0) {
    const firstMessage = firstRetryableFailureMessage(lineErrors);
    throw new RecordsIngestSystemicFailureError(
      `Ingest for stream '${input.streamName}' had ${retryableFailureCount} systemic/retryable record failure(s) ` +
        `out of ${lines.length} submitted; first: ${firstMessage ?? "(no message)"}`,
      retryableFailureCount
    );
  }

  return {
    envelope: buildIngestEnvelope(input.streamName, lineErrors),
    submittedRecordCount,
  };
}
