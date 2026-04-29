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
 * Per-line ingest order is preserved exactly: the operation iterates lines
 * sequentially and awaits each `ingestRecord` call before advancing. It MUST
 * NOT parallelize ingest, batch ingests, or coalesce errors.
 *
 * Atomicity and durable write ordering for each record remain the
 * responsibility of the underlying `ingestRecord` capability. A failure on
 * one line increments `records_rejected` and continues; it MUST NOT roll back
 * earlier accepted records (matches the previous native route behavior).
 *
 * Boundary rules:
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, sandbox modules, the Fastify host module
 *   (`server/index.js`), the records module (`server/records.js`), or
 *   `process` / `process.env`.
 */

export interface RecordsIngestInput {
  /** Connector id parsed from the query string. May be null/empty. */
  readonly connectorId: string | null;
  /** Stream name from the request path. */
  readonly streamName: string;
  /** Raw NDJSON body as received by the host. */
  readonly body: string | null | undefined;
}

export interface RecordsIngestDependencies {
  hasManifestStream(connectorId: string, streamName: string): boolean | Promise<boolean>;
  /**
   * Ingest a single parsed record under the connector + stream. Hosts wire
   * the existing `ingestRecord(connectorId, { ...record, stream })` capability,
   * which owns durable write ordering for that record. Throws on failure;
   * the operation increments `records_rejected` and collects the message.
   */
  ingestRecord(
    connectorId: string,
    record: Record<string, unknown>,
  ): unknown | Promise<unknown>;
}

export interface RecordsIngestEnvelope {
  readonly stream: string;
  readonly records_accepted: number;
  readonly records_rejected: number;
  readonly errors: readonly string[];
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
 * Split a raw NDJSON body into non-empty lines. The matching split rule is
 * exposed so hosts can compute `submitted_record_count` for the
 * `mutation.requested` event before invoking the operation, without
 * duplicating the line-model rule.
 */
export function parseLines(body: string | null | undefined): string[] {
  if (typeof body !== "string" || body.length === 0) return [];
  return body.split("\n").filter((line) => line.trim().length > 0);
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
  dependencies: RecordsIngestDependencies,
): Promise<RecordsIngestOutput> {
  const lines = parseLines(input.body);
  const submittedRecordCount = lines.length;

  const connectorId = typeof input.connectorId === "string" ? input.connectorId : null;
  if (!connectorId) {
    throw new RecordsIngestInvalidRequestError(
      "connector_id must be a single non-empty string",
    );
  }

  const visible = await dependencies.hasManifestStream(connectorId, input.streamName);
  if (!visible) {
    throw new RecordsIngestNotFoundError(
      `Stream '${input.streamName}' not found for connector ${connectorId}`,
    );
  }

  let recordsAccepted = 0;
  let recordsRejected = 0;
  const errors: string[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      await dependencies.ingestRecord(connectorId, {
        ...parsed,
        stream: input.streamName,
      });
      recordsAccepted += 1;
    } catch (err) {
      recordsRejected += 1;
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return {
    envelope: {
      stream: input.streamName,
      records_accepted: recordsAccepted,
      records_rejected: recordsRejected,
      errors,
    },
    submittedRecordCount,
  };
}
