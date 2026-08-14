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
 * submitted non-empty lines into indexed inputs, then awaits each parsed
 * record's `ingestRecord` call before advancing. It MUST NOT parallelize
 * ingest, batch ingests, or coalesce errors.
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
  readonly body: Buffer | string | null | undefined;
  /** Connector id parsed from the query string. May be null/empty. */
  readonly connectorId: string | null;
  /** Connector instance id parsed from the query string. Optional for legacy connector-only compatibility. */
  readonly connectorInstanceId?: string | null;
  /**
   * Opt in to the hosted durable-rejection response contract. Existing
   * non-hosted callers retain the legacy count-only behavior unless this is
   * explicitly true.
   */
  readonly hostedRejectionReceipts?: boolean;
  /** Optional per-line byte ceiling supplied by hosts with a bounded body contract. */
  readonly maxLineBytes?: number | null;
  /** Optional hosted run id, threaded to durable rejection persistence when supplied. */
  readonly runId?: string | null;
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
  readonly code?: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface InsertOrReplayRejectionInput {
  readonly code: string;
  readonly connectorId: string;
  readonly connectorInstanceId?: string | null;
  readonly inputIndex: number;
  readonly rawLine: Buffer;
  readonly runId?: string | null;
  readonly stream: string;
}

export interface MarkAcceptedRecordRejectionStaleInput {
  readonly connectorId: string;
  readonly connectorInstanceId: string;
  readonly rawLine: Buffer;
  readonly recordKey?: string | null;
  readonly runId?: string | null;
  readonly stream: string;
}

export interface RejectionReceipt {
  readonly code: string;
  readonly input_index: number;
  readonly receipt_id: string;
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
  insertOrReplayRejection?: (input: InsertOrReplayRejectionInput) => RejectionReceipt | Promise<RejectionReceipt>;
  markAcceptedRecordRejectionsStale?: (input: MarkAcceptedRecordRejectionStaleInput) => unknown | Promise<unknown>;
  resolveAdmittedConnectorInstance?: (
    connectorId: string,
    requestedConnectorInstanceId: string | null
  ) => string | null | Promise<string | null>;
}

export interface RecordsIngestEnvelope {
  readonly errors: readonly string[];
  readonly records_accepted: number;
  readonly records_attempted?: number;
  readonly records_rejected: number;
  readonly rejections?: readonly RejectionReceipt[];
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
  readonly parsedInputs: ParsedRecordInput[];
}

interface ParsedRecordInput {
  readonly inputIndex: number;
  readonly parsedRecord: Record<string, unknown>;
  readonly rawLine: Buffer;
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

export class RecordsIngestResourceLimitError extends Error {
  readonly code: "resource_limit";

  constructor(message: string) {
    super(message);
    this.name = "RecordsIngestResourceLimitError";
    this.code = "resource_limit";
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
 *
 * Every field on this Error is public-safe by construction: `.message` is a
 * FIXED, bounded template built only from the stream name (manifest-declared)
 * and two counts (submitted by the caller itself). It never carries the
 * underlying classified failure's own text — that text originates from
 * `classifyIngestFailure`'s catch-all (any error a host does not recognize —
 * a raw SQLite/Postgres driver error, in production) and can carry SQL
 * fragments or bound-parameter values. This class has no other constructor
 * input and no other field, so there is nothing here for a future caller to
 * accidentally surface externally. The per-line classified detail is used
 * only transiently, inside `executeRecordsIngest`, to decide retryability
 * and the count — it is discarded once this Error is constructed, not
 * retained anywhere.
 */
export class RecordsIngestSystemicFailureError extends Error {
  readonly code: "ingest_batch_storage_error";
  readonly retryableFailureCount: number;

  constructor(streamName: string, retryableFailureCount: number, submittedCount: number, options?: ErrorOptions) {
    super(
      `Ingest for stream '${streamName}' had ${retryableFailureCount} systemic/retryable record failure(s) out of ${submittedCount} submitted; retry the batch`,
      options
    );
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
function isAsciiWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
}

function hasNonWhitespaceByte(line: Buffer): boolean {
  for (const byte of line) {
    if (!isAsciiWhitespace(byte)) {
      return true;
    }
  }
  return false;
}

export function parseLines(
  body: Buffer | string | null | undefined,
  options: { maxLineBytes?: number | null } = {}
): Buffer[] {
  let bytes: Buffer | null = null;
  if (Buffer.isBuffer(body)) {
    bytes = body;
  } else if (typeof body === "string") {
    bytes = Buffer.from(body, "utf8");
  }
  if (!bytes || bytes.length === 0) {
    return [];
  }
  const lines: Buffer[] = [];
  const maxLineBytes =
    typeof options.maxLineBytes === "number" && Number.isFinite(options.maxLineBytes) && options.maxLineBytes >= 0
      ? Math.floor(options.maxLineBytes)
      : null;
  let start = 0;
  for (let offset = 0; offset <= bytes.length; offset += 1) {
    if (offset === bytes.length || bytes[offset] === 0x0a) {
      const line = bytes.subarray(start, offset);
      if (hasNonWhitespaceByte(line)) {
        if (maxLineBytes !== null && line.length > maxLineBytes) {
          throw new RecordsIngestResourceLimitError(`NDJSON line exceeds ${maxLineBytes} bytes`);
        }
        lines.push(line);
      }
      start = offset + 1;
    }
  }
  return lines;
}

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function parseRecordLines(lines: readonly Buffer[], streamName: string): ParsedRecordLines {
  const lineErrors = new Array<IngestLineFailure | null>(lines.length).fill(null);
  const parsedInputs: ParsedRecordInput[] = [];

  for (const [lineIndex, line] of lines.entries()) {
    let decoded: string;
    try {
      decoded = strictUtf8Decoder.decode(line);
    } catch {
      lineErrors[lineIndex] = {
        code: "invalid_utf8",
        message: "Input line is not valid UTF-8",
        retryable: false,
      };
      continue;
    }
    try {
      const parsed = JSON.parse(decoded) as Record<string, unknown>;
      parsedInputs.push({ inputIndex: lineIndex, parsedRecord: { ...parsed, stream: streamName }, rawLine: line });
    } catch (err) {
      // Malformed NDJSON is permanent by construction: the same bytes will
      // never parse differently on retry. Never retryable.
      lineErrors[lineIndex] = {
        code: "malformed_ndjson",
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      };
    }
  }

  return { lineErrors, parsedInputs };
}

async function ingestParsedRecords(
  connectorId: string,
  connectorInstanceId: string | null,
  parsedInputs: readonly ParsedRecordInput[],
  dependencies: RecordsIngestDependencies,
  streamName: string,
  runId?: string | null
): Promise<readonly (IngestLineFailure | null)[]> {
  if (parsedInputs.length === 0) {
    return [];
  }
  const parsedRecords = parsedInputs.map((input) => input.parsedRecord);
  const results = await ingestSequentially(connectorId, connectorInstanceId, parsedRecords, dependencies.ingestRecord);
  await markAcceptedRecordRejectionsStale(
    connectorId,
    connectorInstanceId,
    streamName,
    parsedInputs,
    results,
    dependencies,
    runId
  );
  return results;
}

function recordKeyFromParsedRecord(record: Record<string, unknown>): string | null {
  const value = record.key ?? record.record_key;
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function markAcceptedRecordRejectionsStale(
  connectorId: string,
  connectorInstanceId: string | null,
  streamName: string,
  parsedInputs: readonly ParsedRecordInput[],
  results: readonly (IngestLineFailure | null)[],
  dependencies: RecordsIngestDependencies,
  runId?: string | null
): Promise<void> {
  if (!(connectorInstanceId && dependencies.markAcceptedRecordRejectionsStale)) {
    return;
  }
  for (const [recordIndex, result] of results.entries()) {
    if (result !== null) {
      continue;
    }
    const input = parsedInputs[recordIndex];
    if (!input) {
      continue;
    }
    // biome-ignore lint/performance/noAwaitInLoops: Accepted-line stale markers must preserve ingest order with host-side effects.
    await dependencies.markAcceptedRecordRejectionsStale({
      connectorId,
      connectorInstanceId,
      rawLine: input.rawLine,
      recordKey: recordKeyFromParsedRecord(input.parsedRecord),
      runId: runId ?? null,
      stream: streamName,
    });
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
      // biome-ignore lint/performance/noAwaitInLoops: Preserves established ordered async behavior.
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
  const code = (err as { code?: unknown } | null)?.code;
  const retryableField = (err as { retryable?: unknown } | null)?.retryable;
  const retryable = typeof retryableField === "boolean" ? retryableField : true;
  return { ...(typeof code === "string" ? { code } : {}), message, retryable };
}

function applyIngestErrors(
  lineErrors: Array<IngestLineFailure | null>,
  parsedInputs: readonly ParsedRecordInput[],
  ingestErrors: readonly (IngestLineFailure | null)[]
): void {
  for (const [recordIndex, error] of ingestErrors.entries()) {
    const lineIndex = parsedInputs[recordIndex]?.inputIndex;
    if (lineIndex !== undefined) {
      lineErrors[lineIndex] = error;
    }
  }
}

async function buildRejectionReceipts(args: {
  connectorId: string;
  connectorInstanceId: string | null;
  dependencies: RecordsIngestDependencies;
  lines: readonly Buffer[];
  lineErrors: readonly (IngestLineFailure | null)[];
  runId?: string | null;
  streamName: string;
}): Promise<readonly RejectionReceipt[]> {
  if (!args.dependencies.insertOrReplayRejection) {
    throw new RecordsIngestSystemicFailureError(
      args.streamName,
      args.lineErrors.filter((error) => error !== null).length,
      args.lines.length
    );
  }
  if (!args.connectorInstanceId) {
    throw new RecordsIngestSystemicFailureError(
      args.streamName,
      args.lineErrors.filter((error) => error !== null).length,
      args.lines.length
    );
  }
  const receipts: RejectionReceipt[] = [];
  try {
    for (const [inputIndex, error] of args.lineErrors.entries()) {
      if (error === null || error.retryable) {
        continue;
      }
      const { code } = error;
      if (!code) {
        throw new RecordsIngestSystemicFailureError(args.streamName, 1, args.lines.length);
      }
      receipts.push(
        // biome-ignore lint/performance/noAwaitInLoops: Rejection persistence must stay ordered with the response vector.
        await args.dependencies.insertOrReplayRejection({
          code,
          connectorId: args.connectorId,
          connectorInstanceId: args.connectorInstanceId,
          inputIndex,
          rawLine: args.lines[inputIndex] ?? Buffer.alloc(0),
          runId: args.runId ?? null,
          stream: args.streamName,
        })
      );
    }
  } catch (err) {
    if (err instanceof RecordsIngestSystemicFailureError) {
      throw err;
    }
    // biome-ignore lint/style/useErrorCause: RecordsIngestSystemicFailureError forwards ErrorOptions to Error.
    throw new RecordsIngestSystemicFailureError(args.streamName, 1, args.lines.length, { cause: err });
  }
  return receipts;
}

function validateRejectionReceipts(
  lineErrors: readonly (IngestLineFailure | null)[],
  rejections: readonly RejectionReceipt[]
): void {
  const rejectedIndexes = new Set<number>();
  for (const [index, error] of lineErrors.entries()) {
    if (error !== null) {
      rejectedIndexes.add(index);
    }
  }
  if (rejections.length !== rejectedIndexes.size) {
    throw new Error(
      `rejection receipt count ${rejections.length} does not match records_rejected ${rejectedIndexes.size}`
    );
  }
  const indexes = new Set<number>();
  for (const rejection of rejections) {
    if (
      !Number.isInteger(rejection.input_index) ||
      rejection.input_index < 0 ||
      rejection.input_index >= lineErrors.length ||
      indexes.has(rejection.input_index) ||
      !rejectedIndexes.has(rejection.input_index) ||
      typeof rejection.receipt_id !== "string" ||
      rejection.receipt_id.length === 0 ||
      typeof rejection.code !== "string" ||
      rejection.code.length === 0
    ) {
      throw new Error("malformed rejection receipt");
    }
    const expected = lineErrors[rejection.input_index];
    if (expected === undefined || expected === null || expected.code !== rejection.code) {
      throw new Error("rejection receipt code does not match classified line error");
    }
    indexes.add(rejection.input_index);
  }
}

function buildIngestEnvelope(
  stream: string,
  lineErrors: readonly (IngestLineFailure | null)[],
  rejections: readonly RejectionReceipt[] | null
): RecordsIngestEnvelope {
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
  if (rejections !== null) {
    validateRejectionReceipts(lineErrors, rejections);
    if (lineErrors.length !== recordsAccepted + recordsRejected) {
      throw new Error("hosted ingest response counts do not balance");
    }
    return {
      // Hosted durable receipts are the complete public rejection evidence.
      // Storage/parser messages can contain payload values or backend text;
      // retain the legacy messages only on the non-hosted compatibility path.
      errors: [],
      records_accepted: recordsAccepted,
      records_attempted: lineErrors.length,
      records_rejected: recordsRejected,
      rejections,
      stream,
    };
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

/**
 * Execute the canonical `rs.records.ingest` operation.
 *
 * Order matches the previous native route:
 *   1. parse non-empty NDJSON lines.
 *   2. invalid_request when connector_id is missing/empty.
 *   3. not_found when the manifest does not declare the stream.
 *   4. JSON.parse each line and ingest under `{ ...record, stream }`.
 *      JSON.parse failures and ingest errors both increment records_rejected
 *      and append the message to errors. The established sequential
 *      capability is always used.
 *   5. return the envelope plus submitted_record_count for instrumentation.
 */
export async function executeRecordsIngest(
  input: RecordsIngestInput,
  dependencies: RecordsIngestDependencies
): Promise<RecordsIngestOutput> {
  const lineOptions = input.maxLineBytes === undefined ? {} : { maxLineBytes: input.maxLineBytes };
  const lines = parseLines(input.body, lineOptions);
  const submittedRecordCount = lines.length;

  const connectorId = typeof input.connectorId === "string" ? input.connectorId : null;
  if (!connectorId) {
    throw new RecordsIngestInvalidRequestError("connector_id must be a single non-empty string");
  }

  const visible = await dependencies.hasManifestStream(connectorId, input.streamName);
  if (!visible) {
    throw new RecordsIngestNotFoundError(`Stream '${input.streamName}' not found for connector ${connectorId}`);
  }
  const connectorInstanceId = dependencies.resolveAdmittedConnectorInstance
    ? await dependencies.resolveAdmittedConnectorInstance(connectorId, input.connectorInstanceId ?? null)
    : (input.connectorInstanceId ?? null);

  const parsed = parseRecordLines(lines, input.streamName);
  const ingestErrors = await ingestParsedRecords(
    connectorId,
    connectorInstanceId,
    parsed.parsedInputs,
    dependencies,
    input.streamName,
    input.runId ?? null
  );
  applyIngestErrors(parsed.lineErrors, parsed.parsedInputs, ingestErrors);

  // Commit every permanent rejection receipt before deciding whether a
  // systemic sibling makes the overall request retryable. A later systemic
  // failure must not erase already-established recovery evidence; exact
  // request replay returns the same receipt.
  const rejections =
    input.hostedRejectionReceipts === true
      ? await buildRejectionReceipts({
          connectorId,
          connectorInstanceId,
          dependencies,
          lineErrors: parsed.lineErrors,
          lines,
          runId: input.runId ?? null,
          streamName: input.streamName,
        })
      : null;

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
    throw new RecordsIngestSystemicFailureError(input.streamName, retryableFailureCount, lines.length);
  }

  return {
    envelope: buildIngestEnvelope(input.streamName, parsed.lineErrors, rejections),
    submittedRecordCount,
  };
}
