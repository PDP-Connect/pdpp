/**
 * Postgres-backed regression for the record-delete boundary.
 *
 * Two paths share one durable-tail construction in postgres-records.js:
 *
 *   1. `deleteAllRecords(storageTarget, stream)` — owner-authenticated
 *      per-stream reset (called from `rs.records.delete_stream`).
 *   2. `deleteAllRecordsForConnector(connectorId)` — connector-wide
 *      invalidation called by the polyfill manifest reconciler on the
 *      reference-fixture → polyfill transition.
 *
 * Before this fix, the connector-wide path was SQLite-only (so in
 * Postgres deployments the reconciler reported `deletedCount = 0` and
 * left stale records under the prior-shape manifest fingerprint), and
 * the per-stream postgres helper bundled its DELETEs into one
 * semicolon-separated string, which pg rejects when parameters are
 * present (extended-protocol prepared statements are single-statement).
 *
 * This test pins both paths together against a real Postgres so the
 * boundary stays consistent. The connector-wide path composes the
 * per-stream helper plus a blob_bindings drop; if the per-stream helper
 * regresses, the connector-wide test fails too.
 *
 * Env gate: `PDPP_TEST_POSTGRES_URL` must be set (Compose Postgres proof
 * service). Each scenario uses a uniquely-named `(connector_id,
 * connector_instance_id)` pair so concurrent runs do not collide on the
 * shared schema, and cleans up rows under those unique ids at teardown.
 *
 * Spec: openspec/changes/fix-polyfill-record-invalidation-postgres-routing/
 *       specs/reference-implementation-architecture/spec.md
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, initDb } from '../server/db.js';
import { deleteAllRecords, deleteAllRecordsForConnector } from '../server/records.js';
import { postgresIngestRecord } from '../server/postgres-records.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from '../server/postgres-storage.js';

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('postgres record-delete routing (skipped: PDPP_TEST_POSTGRES_URL unset)', {
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
      const storageTarget = { connector_id: connectorId, connector_instance_id: connectorInstanceId };

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

      // Records, record_changes, version_counter, and blob_bindings are
      // all drained for this connector. The shared schema may carry rows
      // from other tests under different (connector_id, connector_instance_id)
      // pairs; scope every assertion by connector_id so we do not race them.
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

  test('deleteAllRecords (per-stream) succeeds against Postgres and leaves sibling stream intact', async () => {
    // Companion regression for the sibling helper. Before the parameterized
    // multi-statement was split into individual DELETEs, this call threw
    // `cannot insert multiple commands into a prepared statement` and the
    // per-stream owner-reset path was effectively unusable on Postgres.
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `https://registry.pdpp.test/connectors/pg_stream_delete_${suffix}`;
    const connectorInstanceId = `cin_pg_stream_delete_${suffix}`;
    const streamTarget = 'top_artists';
    const streamSibling = 'saved_tracks';

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    try {
      const storageTarget = { connector_id: connectorId, connector_instance_id: connectorInstanceId };

      // Seed two streams. The per-stream delete must drop the target and
      // leave the sibling untouched.
      await postgresIngestRecord(storageTarget, {
        stream: streamTarget,
        key: 'a-1',
        data: { id: 'a-1', name: 'Target A1', source_updated_at: '2026-04-25T00:00:00.000Z' },
        op: 'upsert',
        emitted_at: '2026-04-25T00:00:00.000Z',
      });
      await postgresIngestRecord(storageTarget, {
        stream: streamTarget,
        key: 'a-2',
        data: { id: 'a-2', name: 'Target A2', source_updated_at: '2026-04-25T00:00:00.000Z' },
        op: 'upsert',
        emitted_at: '2026-04-25T00:00:00.000Z',
      });
      await postgresIngestRecord(storageTarget, {
        stream: streamSibling,
        key: 's-1',
        data: { id: 's-1', name: 'Sibling S1', saved_at: '2026-04-25T00:00:00.000Z' },
        op: 'upsert',
        emitted_at: '2026-04-25T00:00:00.000Z',
      });

      const targetBaseline = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM records
           WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE`,
        [connectorInstanceId, streamTarget],
      );
      assert.equal(Number(targetBaseline.rows[0]?.count || 0), 2, 'baseline: two records on target stream');

      const deletedCount = await deleteAllRecords(storageTarget, streamTarget);
      assert.equal(deletedCount, 2, 'per-stream delete reports the live-record count it removed');

      // Target stream is drained for records, record_changes, version_counter.
      const targetRecords = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM records
           WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, streamTarget],
      );
      assert.equal(Number(targetRecords.rows[0]?.count || 0), 0, 'target stream records are dropped');

      const targetChanges = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM record_changes
           WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, streamTarget],
      );
      assert.equal(Number(targetChanges.rows[0]?.count || 0), 0, 'target stream record_changes are dropped');

      const targetCounter = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM version_counter
           WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, streamTarget],
      );
      assert.equal(Number(targetCounter.rows[0]?.count || 0), 0, 'target stream version_counter is dropped');

      // Sibling stream survives.
      const siblingRecords = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM records
           WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE`,
        [connectorInstanceId, streamSibling],
      );
      assert.equal(
        Number(siblingRecords.rows[0]?.count || 0),
        1,
        'sibling stream records are untouched by the per-stream delete',
      );

      const siblingCounter = await postgresQuery(
        `SELECT COUNT(*)::int AS count FROM version_counter
           WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, streamSibling],
      );
      assert.equal(
        Number(siblingCounter.rows[0]?.count || 0),
        1,
        'sibling stream version_counter row is untouched',
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
