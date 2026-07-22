// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * StorageBackend interface for record-level storage operations.
 *
 * Each dialect (SQLite, Postgres) provides one implementation. The
 * orchestration layer selects the adapter once via
 * `isPostgresStorageBackend()` and then calls through the interface;
 * dialect-specific SQL never leaks into shared orchestration code.
 *
 * `record_json` is ALWAYS a string in the returned rows. Postgres stores
 * record_json as jsonb; the adapter must JSON.stringify() before returning
 * so callers can rely on a uniform string type.
 */

import { iterate, referenceQueries } from "../lib/db.ts";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.js";

/**
 * A single row as returned by `listRowsForAggregation`.
 *
 * `record_json` is guaranteed to be a JSON string (never a parsed object)
 * regardless of how the underlying dialect stores the payload.
 */
export interface AggregationRow {
  record_json: string;
  record_key: string;
}

/**
 * Minimal storage interface for aggregation reads.
 *
 * `listRowsForAggregation` returns every non-deleted row for the given
 * connector instance + stream, ordered by record_key ascending. `record_json`
 * must be a string. The returned value is iterable so SQLite can preserve its
 * existing lazy iterator behavior while Postgres can return its materialized
 * row array.
 */
export interface StorageBackend {
  listRowsForAggregation(params: { connectorInstanceId: string; stream: string }): Promise<Iterable<AggregationRow>>;
}

/**
 * Postgres adapter — wraps the existing dialect-specific query verbatim.
 */
function createPostgresStorageBackend(): StorageBackend {
  return {
    async listRowsForAggregation({ connectorInstanceId, stream }) {
      const result = await postgresQuery(
        `SELECT record_key, record_json
           FROM records
          WHERE connector_instance_id = $1
            AND stream = $2
            AND deleted = FALSE
          ORDER BY record_key ASC`,
        [connectorInstanceId, stream]
      );
      return result.rows.map((row: { record_key: string; record_json: unknown }) => ({
        record_key: row.record_key,
        record_json: typeof row.record_json === "string" ? row.record_json : JSON.stringify(row.record_json),
      }));
    },
  };
}

/**
 * SQLite adapter — wraps the existing iterate() call verbatim.
 */
function createSqliteStorageBackend(): StorageBackend {
  return {
    // biome-ignore lint/suspicious/useAwait: sync sqlite iterator; async satisfies the shared StorageBackend contract.
    async listRowsForAggregation({ connectorInstanceId, stream }) {
      return iterate<AggregationRow>(referenceQueries.recordsAggregateIterateStreamRecordsForAggregation, [
        connectorInstanceId,
        stream,
      ]);
    },
  };
}

/**
 * Select and return the appropriate StorageBackend for the current process.
 * Call once at the adapter-selection point; do not call inside shared
 * orchestration loops.
 */
export function createStorageBackend(): StorageBackend {
  if (isPostgresStorageBackend()) {
    return createPostgresStorageBackend();
  }
  return createSqliteStorageBackend();
}
