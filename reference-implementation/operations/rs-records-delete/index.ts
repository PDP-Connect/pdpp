// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `rs.records.delete` operation.
 *
 * Owns the RS single-record delete semantics for
 * `DELETE /v1/streams/:stream/records/:id`: connector_id presence validation
 * (`invalid_request`), manifest stream existence (`not_found`), and the
 * `{ deleted_record_count }` completion-event payload.
 *
 * Atomicity and durable write ordering remain the responsibility of the
 * underlying `deleteRecord` capability. The operation MUST NOT batch,
 * parallelize, or partially apply the delete.
 *
 * Boundary rules:
 * - This module SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL
 *   handle, a generic repository, sandbox modules, the Fastify host module
 *   (`server/index.js`), the records module (`server/records.js`), or
 *   `process` / `process.env`.
 */

export interface RecordsDeleteInput {
  /** Connector id parsed from the query string. May be null/empty. */
  readonly connectorId: string | null;
  /** Stream name from the request path. */
  readonly streamName: string;
  /** Decoded record id from the request path. */
  readonly recordId: string;
}

export interface RecordsDeleteDependencies {
  hasManifestStream(connectorId: string, streamName: string): boolean | Promise<boolean>;
  /**
   * Delete the single record. Hosts wire the existing `deleteRecord`
   * capability, which owns durable atomicity. Returns the number of records
   * deleted (0 when the id was not found, 1 otherwise) which the operation
   * propagates back to the host for the `mutation.completed` payload.
   */
  deleteRecord(
    connectorId: string,
    streamName: string,
    recordId: string,
  ): number | Promise<number>;
}

export interface RecordsDeleteOutput {
  readonly deletedRecordCount: number;
}

export class RecordsDeleteInvalidRequestError extends Error {
  readonly code: "invalid_request";

  constructor(message: string) {
    super(message);
    this.name = "RecordsDeleteInvalidRequestError";
    this.code = "invalid_request";
  }
}

export class RecordsDeleteNotFoundError extends Error {
  readonly code: "not_found";

  constructor(message: string) {
    super(message);
    this.name = "RecordsDeleteNotFoundError";
    this.code = "not_found";
  }
}

/**
 * Execute the canonical `rs.records.delete` operation.
 *
 * Order matches the previous native route:
 *   1. invalid_request when connector_id is missing/empty.
 *   2. not_found when the manifest does not declare the stream.
 *   3. delete_record (host capability owns durable atomicity).
 *   4. return the deleted record count (0 or 1).
 */
export async function executeRecordsDelete(
  input: RecordsDeleteInput,
  dependencies: RecordsDeleteDependencies,
): Promise<RecordsDeleteOutput> {
  const connectorId = typeof input.connectorId === "string" ? input.connectorId : null;
  if (!connectorId) {
    throw new RecordsDeleteInvalidRequestError(
      "connector_id must be a single non-empty string",
    );
  }

  const visible = await dependencies.hasManifestStream(connectorId, input.streamName);
  if (!visible) {
    throw new RecordsDeleteNotFoundError(
      `Stream '${input.streamName}' not found for connector ${connectorId}`,
    );
  }

  const deletedRecordCount = await dependencies.deleteRecord(
    connectorId,
    input.streamName,
    input.recordId,
  );

  return { deletedRecordCount };
}
