// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Postgres-backed driver for the aggregation-rows conformance harness.
 *
 * Drives the REAL production `listRowsForAggregation` via the Postgres backend
 * by:
 *
 *   1. Opening a fresh in-memory SQLite db (required by `initDb` for the
 *      auth/manifest layer even when storage is Postgres).
 *   2. Initialising the Postgres pool and running the production schema
 *      bootstrap via `initPostgresStorage`.
 *   3. Seeding rows via the production `ingestRecord` (which routes through
 *      the Postgres path when `isPostgresStorageBackend()` is true).
 *   4. Calling the production `listRowsForAggregation` and returning its
 *      output verbatim.
 *
 * Isolation: all rows seeded by this driver carry a connector_id prefixed
 * with a session-unique suffix. `teardown()` deletes those rows by
 * connector_id from the shared Postgres schema, then closes the pool.
 *
 * Deliberately does NOT create its own schema or tables — it uses the real
 * production schema bootstrapped by `bootstrapPostgresSchema`. This means
 * the harness runs against the same DDL that production code targets.
 *
 * The driver is gated by its caller (the test file) and SHALL NOT be imported
 * from any production code path.
 *
 * Spec: openspec/changes/pilot-storage-backend-interface/
 */

import { closeDb, initDb } from '../../server/db.js';
import { registerConnector } from '../../server/auth.js';
import { ingestRecord, listRowsForAggregation } from '../../server/records.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from '../../server/postgres-storage.js';
import {
  CONFORMANCE_MANIFEST,
  CONFORMANCE_CONNECTOR_ID,
} from './aggregation-rows-conformance.js';

/**
 * @param {object} options
 * @param {string} options.connectionString  e.g. PDPP_TEST_POSTGRES_URL
 */
export function createPostgresAggregationRowsDriver({ connectionString }) {
  if (!connectionString) {
    throw new Error('createPostgresAggregationRowsDriver requires connectionString');
  }

  // Build a session-unique connector_id to avoid collisions when running
  // multiple parallel test workers against the same Postgres instance.
  const suffix = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e8).toString(36)}`;
  const connectorId = `${CONFORMANCE_CONNECTOR_ID}_${suffix}`;

  // The manifest must carry the same connector_id used for seeding.
  const manifest = {
    ...CONFORMANCE_MANIFEST,
    connector_id: connectorId,
  };

  return {
    async setup() {
      // The auth layer (registerConnector) always writes to SQLite even in
      // Postgres storage mode, so we need an in-memory SQLite db.
      initDb(':memory:');
      await initPostgresStorage({ backend: 'postgres', databaseUrl: connectionString });
      await registerConnector(manifest);
    },

    async teardown() {
      try {
        // Remove all rows seeded during this driver's lifetime.
        await postgresQuery(
          'DELETE FROM records WHERE connector_id = $1',
          [connectorId],
        );
        // Also clean up the connector registration from the Postgres connectors
        // table (bootstrapped by the production schema).
        await postgresQuery(
          'DELETE FROM connectors WHERE connector_id = $1',
          [connectorId],
        );
      } finally {
        await closePostgresStorage();
        closeDb();
      }
    },

    /**
     * Seed records for a given (connectorInstanceId, stream) via the real
     * production `ingestRecord`. The explicit connector_instance_id is passed
     * via the storage-target object so the multi-account isolation scenario
     * works without relying on the default instance-id derivation.
     *
     * For deleted rows we upsert first, then issue a targeted UPDATE to set
     * `deleted = TRUE` directly in Postgres.
     *
     * @param {string} connectorInstanceId
     * @param {string} stream
     * @param {Array<{key: string, data: object, deleted?: boolean}>} records
     */
    async seed(connectorInstanceId, stream, records) {
      const storageTarget = {
        connector_id: connectorId,
        connector_instance_id: connectorInstanceId,
      };

      for (const record of records) {
        await ingestRecord(storageTarget, {
          stream,
          key: record.key,
          data: record.data,
          emitted_at: '2026-01-01T00:00:00.000Z',
          op: 'upsert',
        });

        if (record.deleted) {
          await postgresQuery(
            `UPDATE records
                SET deleted = TRUE
              WHERE connector_instance_id = $1
                AND stream = $2
                AND record_key = $3`,
            [connectorInstanceId, stream, record.key],
          );
        }
      }
    },

    /**
     * Call the REAL production `listRowsForAggregation` and return its output
     * as a plain array. The Postgres branch already returns an Array; wrapping
     * with Array.from() is a no-op for arrays and keeps the driver interface
     * symmetric with the SQLite driver (which wraps a Generator).
     *
     * @param {string} connectorInstanceId
     * @param {string} stream
     * @returns {Promise<Array<{record_key: string, record_json: string}>>}
     */
    async listRows(connectorInstanceId, stream) {
      return Array.from(await listRowsForAggregation(connectorInstanceId, stream));
    },
  };
}
