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
 * The default capability is deliberately per-line and ordered: the operation
 * awaits each `ingestRecord` call before advancing. Hosts that provide the
 * optional `ingestRecords` capability may batch only the already-parsed
 * records; they still return one result per input record so parse and ingest
 * failures remain line-addressable and ordered.
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
  /**
   * Optional host optimization for a single NDJSON request. The input is in
   * line order and contains only successfully parsed records. Each result is
   * either null (accepted) or a classified `IngestLineFailure` for that
   * record. Hosts MUST preserve the same per-record durability and
   * failure-isolation contract as `ingestRecord`, and MUST classify
   * `retryable` from their own typed error shape, never by guessing from a
   * message string.
   */
  ingestRecords?: (
    connectorId: string,
    connectorInstanceId: string | null,
    records: readonly Record<string, unknown>[]
  ) => readonly (IngestLineFailure | null)[] | Promise<readonly (IngestLineFailure | null)[]>;
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

interface ParsedRecordLines {
  readonly lineErrors: Array<IngestLineFailure | null>;
  readonly parsedLineIndexes: number[];
  readonly parsedRecords: Record<string, unknown>[];
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

function parseRecordLines(lines: readonly string[], streamName: string): ParsedRecordLines {
  const lineErrors = new Array<IngestLineFailure | null>(lines.length).fill(null);
  const parsedRecords: Record<string, unknown>[] = [];
  const parsedLineIndexes: number[] = [];

  for (const [lineIndex, line] of lines.entries()) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      parsedRecords.push({ ...parsed, stream: streamName });
      parsedLineIndexes.push(lineIndex);
    } catch (err) {
      // Malformed NDJSON is permanent by construction: the same bytes will
      // never parse differently on retry. Never retryable.
      lineErrors[lineIndex] = { message: err instanceof Error ? err.message : String(err), retryable: false };
    }
  }

  return { lineErrors, parsedLineIndexes, parsedRecords };
}

async function ingestParsedRecords(
  connectorId: string,
  connectorInstanceId: string | null,
  parsedRecords: readonly Record<string, unknown>[],
  dependencies: RecordsIngestDependencies
): Promise<readonly (IngestLineFailure | null)[]> {
  if (parsedRecords.length === 0) {
    return [];
  }
  if (dependencies.ingestRecords) {
    return await ingestWithBatchCapability(connectorId, connectorInstanceId, parsedRecords, dependencies.ingestRecords);
  }
  return await ingestSequentially(connectorId, connectorInstanceId, parsedRecords, dependencies.ingestRecord);
}

async function ingestWithBatchCapability(
  connectorId: string,
  connectorInstanceId: string | null,
  parsedRecords: readonly Record<string, unknown>[],
  ingestRecords: NonNullable<RecordsIngestDependencies["ingestRecords"]>
): Promise<readonly (IngestLineFailure | null)[]> {
  try {
    const results = await ingestRecords(connectorId, connectorInstanceId, parsedRecords);
    if (results.length !== parsedRecords.length) {
      throw new Error(`ingestRecords returned ${results.length} results for ${parsedRecords.length} records`);
    }
    return results;
  } catch (err) {
    // The batch capability itself threw (not a per-record outcome) — e.g. a
    // connection-level failure before any per-record result could be
    // produced. Unclassifiable by definition (no per-record typed error to
    // read), so every line in the batch defaults to retryable/systemic, same
    // as an unrecognized error code at the storage layer.
    const message = err instanceof Error ? err.message : String(err);
    return parsedRecords.map(() => ({ message, retryable: true }));
  }
}

async function ingestSequentially(
  connectorId: string,
  connectorInstanceId: string | null,
  parsedRecords: readonly Record<string, unknown>[],
  ingestRecord: RecordsIngestDependencies["ingestRecord"]
): Promise<readonly (IngestLineFailure | null)[]> {
  const errors: Array<IngestLineFailure | null> = new Array(parsedRecords.length).fill(null);
  for (const [recordIndex, record] of parsedRecords.entries()) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: Preserves established ordered async behavior when the host has no batch capability.
      await ingestRecord(connectorId, connectorInstanceId, record);
    } catch (err) {
      errors[recordIndex] = classifyThrownIngestError(err);
    }
  }
  return errors;
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

function applyIngestErrors(
  lineErrors: Array<IngestLineFailure | null>,
  parsedLineIndexes: readonly number[],
  ingestErrors: readonly (IngestLineFailure | null)[]
): void {
  for (const [recordIndex, error] of ingestErrors.entries()) {
    const lineIndex = parsedLineIndexes[recordIndex];
    if (lineIndex !== undefined) {
      lineErrors[lineIndex] = error;
    }
  }
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
 *   4. JSON.parse each line and ingest under `{ ...record, stream }`.
 *      JSON.parse failures and ingest errors both increment records_rejected
 *      and append the message to errors. If the host exposes `ingestRecords`,
 *      valid records use that capability once while preserving line order in
 *      the returned results; otherwise the established sequential capability
 *      is used.
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

  const parsed = parseRecordLines(lines, input.streamName);
  const ingestErrors = await ingestParsedRecords(
    connectorId,
    input.connectorInstanceId ?? null,
    parsed.parsedRecords,
    dependencies
  );
  applyIngestErrors(parsed.lineErrors, parsed.parsedLineIndexes, ingestErrors);

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
  const retryableFailureCount = countRetryableFailures(parsed.lineErrors);
  if (retryableFailureCount > 0) {
    const firstMessage = firstRetryableFailureMessage(parsed.lineErrors);
    throw new RecordsIngestSystemicFailureError(
      `Ingest for stream '${input.streamName}' had ${retryableFailureCount} systemic/retryable record failure(s) ` +
        `out of ${lines.length} submitted; first: ${firstMessage ?? "(no message)"}`,
      retryableFailureCount
    );
  }

  return {
    envelope: buildIngestEnvelope(input.streamName, parsed.lineErrors),
    submittedRecordCount,
  };
}
