// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * SQLite-backed driver for the aggregation-rows conformance harness.
 *
 * Drives the REAL production `listRowsForAggregation` via the SQLite backend
 * by calling the actual exported function from `server/records.js`. Seeding
 * uses `ingestRecord` (also production) and optionally a direct soft-delete
 * for the deleted-row scenario.
 *
 * Isolation: each `setup()` opens a fresh in-memory SQLite database.
 * `teardown()` closes it, which automatically discards all data.
 *
 * Spec: openspec/changes/pilot-storage-backend-interface/
 */

import { registerConnector } from "../../server/auth.ts";
import { closeDb, getDb, initDb } from "../../server/db.ts";
import { ingestRecord, listRowsForAggregation } from "../../server/records.ts";
import { CONFORMANCE_MANIFEST } from "./aggregation-rows-conformance.ts";

interface SeedRecord {
  data: Record<string, unknown>;
  deleted?: boolean;
  key: string;
}

export function createSqliteAggregationRowsDriver() {
  return {
    /**
     * Call the REAL production `listRowsForAggregation` and return its output
     * as a plain array. The SQLite backend returns a Generator (via `iterate`);
     * Array.from() consumes it uniformly so conformance assertions can use
     * `.length`, `.map()`, etc. without special-casing the backend.
     *
     * @param {string} connectorInstanceId
     * @param {string} stream
     * @returns {Promise<Array<{record_key: string, record_json: string}>>}
     */
    async listRows(connectorInstanceId: string, stream: string) {
      return Array.from(await listRowsForAggregation(connectorInstanceId, stream));
    },

    /**
     * Seed records for a given (connectorInstanceId, stream).
     *
     * The production `ingestRecord` resolves the connector_instance_id from
     * the storage target. To inject an explicit connector_instance_id (needed
     * for the multi-account isolation scenario) we pass a storage target
     * object with both `connector_id` and `connector_instance_id` set.
     *
     * For deleted rows we first upsert the record and then soft-delete it
     * directly on the underlying SQLite db to avoid coupling to a
     * delete-specific code path that may not exist at the record layer.
     *
     * @param {string} connectorInstanceId
     * @param {string} stream
     * @param {Array<{key: string, data: object, deleted?: boolean}>} records
     */
    async seed(connectorInstanceId: string, stream: string, records: SeedRecord[]): Promise<void> {
      const storageTarget = {
        connector_id: CONFORMANCE_MANIFEST.connector_id,
        connector_instance_id: connectorInstanceId,
      };

      for (const record of records) {
        // Always upsert first so the row exists in the db.
        // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
        await ingestRecord(storageTarget, {
          data: record.data,
          emitted_at: "2026-01-01T00:00:00.000Z",
          key: record.key,
          op: "upsert",
          stream,
        });

        if (record.deleted) {
          // Soft-delete directly in SQLite. The `deleted` column is an integer
          // (0/1) in the SQLite schema used by the reference implementation.
          getDb()
            .prepare("UPDATE records SET deleted = 1 WHERE connector_instance_id = ? AND stream = ? AND record_key = ?")
            .run(connectorInstanceId, stream, record.key);
        }
      }
    },
    async setup() {
      initDb(":memory:");
      await registerConnector(CONFORMANCE_MANIFEST);
    },

    // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
    async teardown() {
      closeDb();
    },
  };
}
