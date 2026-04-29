/**
 * Canonical `rs.records.delete_stream` operation.
 *
 * Owns the RS bulk-delete semantics for `DELETE /v1/streams/:stream/records`:
 * connector_id presence validation (`invalid_request`), manifest stream
 * existence (`not_found`), and the `{ deleted_record_count }` completion-event
 * payload.
 *
 * The operation does not own:
 *
 * - mutation-event emission (`mutation.requested` / `mutation.completed` /
 *   `mutation.rejected`) — the host adapter still owns instrumentation
 *   dispatch and trace id wiring; the operation reports the values the host
 *   needs to populate `mutation.completed`.
 * - HTTP framework wiring, owner auth, or response writing.
 *
 * Atomicity, durable write ordering, and any cross-table cleanup remain the
 * responsibility of the underlying `deleteAllRecords` capability. The
 * operation MUST NOT batch, parallelize, or partially apply the delete.
 *
 * Boundary rules:
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, sandbox modules, the Fastify host module
 *   (`server/index.js`), the records module (`server/records.js`), or
 *   `process` / `process.env`.
 */

export interface RecordsDeleteStreamInput {
  /** Connector id parsed from the query string. May be null/empty. */
  readonly connectorId: string | null;
  /** Stream name from the request path. */
  readonly streamName: string;
}

export interface RecordsDeleteStreamDependencies {
  /**
   * Manifest visibility check. Returns true when the connector manifest
   * declares the named stream. Hosts wire the existing
   * `resolveRegisteredConnectorManifest(connectorId).streams[*].name` lookup.
   */
  hasManifestStream(connectorId: string, streamName: string): boolean | Promise<boolean>;
  /**
   * Delete all records for the connector + stream. Hosts wire the existing
   * `deleteAllRecords` capability, which owns durable atomicity. Returns the
   * number of records deleted, which the operation propagates back to the
   * host for the `mutation.completed` payload.
   */
  deleteAllRecords(connectorId: string, streamName: string): number | Promise<number>;
}

export interface RecordsDeleteStreamOutput {
  readonly deletedRecordCount: number;
}

export class RecordsDeleteStreamInvalidRequestError extends Error {
  readonly code: "invalid_request";

  constructor(message: string) {
    super(message);
    this.name = "RecordsDeleteStreamInvalidRequestError";
    this.code = "invalid_request";
  }
}

export class RecordsDeleteStreamNotFoundError extends Error {
  readonly code: "not_found";

  constructor(message: string) {
    super(message);
    this.name = "RecordsDeleteStreamNotFoundError";
    this.code = "not_found";
  }
}

/**
 * Execute the canonical `rs.records.delete_stream` operation.
 *
 * Order matches the previous native route:
 *   1. invalid_request when connector_id is missing/empty.
 *   2. not_found when the manifest does not declare the stream.
 *   3. delete_all_records (host capability owns durable atomicity).
 *   4. return the deleted record count.
 */
export async function executeRecordsDeleteStream(
  input: RecordsDeleteStreamInput,
  dependencies: RecordsDeleteStreamDependencies,
): Promise<RecordsDeleteStreamOutput> {
  const connectorId = typeof input.connectorId === "string" ? input.connectorId : null;
  if (!connectorId) {
    throw new RecordsDeleteStreamInvalidRequestError(
      "connector_id must be a single non-empty string",
    );
  }

  const visible = await dependencies.hasManifestStream(connectorId, input.streamName);
  if (!visible) {
    throw new RecordsDeleteStreamNotFoundError(
      `Stream '${input.streamName}' not found for connector ${connectorId}`,
    );
  }

  const deletedRecordCount = await dependencies.deleteAllRecords(
    connectorId,
    input.streamName,
  );

  return { deletedRecordCount };
}
