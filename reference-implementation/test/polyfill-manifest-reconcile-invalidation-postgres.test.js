/**
 * Postgres-backed regression for the connector-wide record invalidation
 * helper that the polyfill manifest reconciler calls on the
 * reference-fixture → polyfill transition.
 *
 * Before this fix, `deleteAllRecordsForConnector(connectorId)` read and
 * wrote only through the SQLite primitives. In Postgres deployments
 * (`PDPP_STORAGE_BACKEND=postgres`, where `reconcilePolyfillManifests`
 * defaults on at startup) the SQLite shadow namespace was empty, so the
 * helper reported `deletedCount = 0` and left stale Postgres records
 * sitting under the prior-shape manifest fingerprint. This test pins the
 * fix: with the active backend set to Postgres, the helper SHALL discover
 * the seeded `(connector_instance_id, stream)` pairs from Postgres and
 * SHALL delete the corresponding records, record_changes, version_counter,
 * and blob_bindings rows.
 *
 * Env gate: `PDPP_TEST_POSTGRES_URL` must be set (Compose Postgres proof
 * service). Each scenario uses a uniquely-named `(connector_id,
 * connector_instance_id)` pair so concurrent runs do not collide on the
 * shared schema, and cleans up any residual rows under that connector_id
 * at teardown.
 *
 * Spec: openspec/changes/fix-polyfill-record-invalidation-postgres-routing/
 *       specs/reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import { deleteAllRecordsForConnector } from '../server/records.js';
import { postgresIngestRecord } from '../server/postgres-records.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from '../server/postgres-storage.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('postgres connector-wide record invalidation (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  test('deleteAllRecordsForConnector invalidates Postgres-backed records', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `https://registry.pdpp.test/connectors/pg_invalidate_${suffix}`;
    const connectorInstanceId = `cin_pg_invalidate_${suffix}`;
    const streamA = 'top_artists';
    const streamB = 'saved_tracks';

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    try {
      const storageTarget = { connectorId, connectorInstanceId };

      // Seed two streams under the same connector. The connector-wide
      // invalidation must reach both.
      await postgresIngestRecord(storageTarget, {
        stream: streamA,
        key: 'spotify:artist:owner-real-1',
        data: {
          id: 'spotify:artist:owner-real-1',
          name: 'Real Owner Artist 1',
          source_updated_at: '2026-04-25T00:00:00.000Z',
        },
        op: 'upsert',
        emitted_at: '2026-04-25T00:00:00.000Z',
      });
      await postgresIngestRecord(storageTarget, {
        stream: streamA,
        key: 'spotify:artist:owner-real-2',
        data: {
          id: 'spotify:artist:owner-real-2',
          name: 'Real Owner Artist 2',
          source_updated_at: '2026-04-25T00:00:00.000Z',
        },
        op: 'upsert',
        emitted_at: '2026-04-25T00:00:00.000Z',
      });
      await postgresIngestRecord(storageTarget, {
        stream: streamB,
        key: 'spotify:track:owner-real-1',
        data: {
          id: 'spotify:track:owner-real-1',
          name: 'Saved Track 1',
          saved_at: '2026-04-25T00:00:00.000Z',
        },
        op: 'upsert',
        emitted_at: '2026-04-25T00:00:00.000Z',
      });

      // Baseline: three live records exist in Postgres for this connector.
      const baseline = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM records
           WHERE connector_id = $1 AND deleted = FALSE`,
        [connectorId],
      );
      assert.equal(
        Number(baseline.rows[0]?.count || 0),
        3,
        'baseline: three Postgres records present before invalidation',
      );

      // Invalidate via the connector-wide helper — the exact entry point
      // the polyfill manifest reconciler calls on the seed → polyfill
      // transition.
      const result = await deleteAllRecordsForConnector(connectorId);
      assert.equal(
        result.deletedCount,
        3,
        'Postgres path reports a non-zero deletedCount matching the seeded rows',
      );
      assert.deepEqual(
        [...result.streams].sort(),
        [streamA, streamB].sort(),
        'returns both seeded streams',
      );

      // Records, record_changes, and version_counter are all drained for
      // this connector. The shared schema may carry rows from other tests
      // under different (connector_id, connector_instance_id) pairs; scope
      // every assertion by connector_id so we do not race them.
      const recordsAfter = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM records WHERE connector_id = $1`,
        [connectorId],
      );
      assert.equal(
        Number(recordsAfter.rows[0]?.count || 0),
        0,
        'no records rows remain for the invalidated connector',
      );

      const changesAfter = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM record_changes WHERE connector_id = $1`,
        [connectorId],
      );
      assert.equal(
        Number(changesAfter.rows[0]?.count || 0),
        0,
        'no record_changes rows remain for the invalidated connector',
      );

      const counterAfter = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM version_counter
           WHERE connector_instance_id = $1`,
        [connectorInstanceId],
      );
      assert.equal(
        Number(counterAfter.rows[0]?.count || 0),
        0,
        'version_counter rows for this connector_instance are dropped',
      );

      const bindingsAfter = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM blob_bindings WHERE connector_id = $1`,
        [connectorId],
      );
      assert.equal(
        Number(bindingsAfter.rows[0]?.count || 0),
        0,
        'blob_bindings rows for this connector are dropped',
      );
    } finally {
      try {
        await postgresQuery(
          `DELETE FROM blob_bindings WHERE connector_id = $1`,
          [connectorId],
        );
        await postgresQuery(
          `DELETE FROM record_changes WHERE connector_id = $1`,
          [connectorId],
        );
        await postgresQuery(
          `DELETE FROM records WHERE connector_id = $1`,
          [connectorId],
        );
        await postgresQuery(
          `DELETE FROM version_counter WHERE connector_instance_id = $1`,
          [connectorInstanceId],
        );
      } catch {}
      await closePostgresStorage();
      closeDb();
    }
  });
}
