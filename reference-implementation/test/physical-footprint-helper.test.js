/**
 * Physical-footprint helper — read-only on-disk database size for the
 * operator deployment-diagnostics surface.
 *
 * Pins the must-hold properties from:
 *   openspec/changes/surface-database-physical-footprint/
 *     specs/reference-implementation-architecture/spec.md
 *
 * 1. On a non-Postgres backend the helper degrades cleanly: physical_bytes is
 *    null and top_relations is null — never a fabricated 0 (§ "honest about
 *    absence and backend"). This path is always runnable.
 * 2. On a live Postgres backend it reports a positive physical_bytes equal to
 *    pg_database_size, a bounded top_relations list ordered largest-first,
 *    every relation size <= physical_bytes, and the listed relations summing
 *    to <= physical_bytes (top-N truncation, approximate composition).
 * 3. The read is read-only — only pure pg_*_size functions, no DDL/DML. The
 *    live path asserts the catalog xact counters do not register writes.
 *
 * The live cases are gated on PDPP_TEST_POSTGRES_URL and skip cleanly when
 * unset, matching postgres-runtime-storage.test.js.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closePostgresStorage,
  collectPhysicalFootprint,
  initPostgresStorage,
  isPostgresStorageBackend,
  postgresQuery,
} from '../server/postgres-storage.js';

// ─── always-runnable: non-Postgres degrades to unmeasured ───────────────────

test('collectPhysicalFootprint returns null/null on a non-Postgres backend', async () => {
  // Ensure the module is in its default (sqlite) state — close any pool a
  // prior test left open. closePostgresStorage() resets activeBackend.
  await closePostgresStorage();
  assert.equal(isPostgresStorageBackend(), false, 'precondition: sqlite backend');

  const footprint = await collectPhysicalFootprint();
  assert.equal(footprint.physical_bytes, null, 'physical_bytes is null, not a fabricated 0');
  assert.equal(footprint.top_relations, null, 'top_relations is null on non-Postgres');
  // Defense: the SQLite path must never emit a numeric zero, which would read
  // as "0 bytes on disk" for a database it simply did not measure.
  assert.notEqual(footprint.physical_bytes, 0);
});

// ─── live Postgres path ─────────────────────────────────────────────────────

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('physical footprint live behavior (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  test('collectPhysicalFootprint reports a positive total and bounded, ordered relations on Postgres', async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      assert.equal(isPostgresStorageBackend(), true, 'precondition: postgres backend');

      const footprint = await collectPhysicalFootprint();

      // Total is a positive byte count derived from pg_database_size. We do
      // NOT assert exact equality with a second read: pdpp_proof is a live,
      // concurrently-written database, so two pg_database_size reads taken
      // milliseconds apart can legitimately differ by a few pages. Assert the
      // helper value is within a small relative tolerance of a fresh read —
      // tight enough to prove it is the database size, loose enough to
      // tolerate concurrent writes.
      assert.equal(typeof footprint.physical_bytes, 'number');
      assert.ok(footprint.physical_bytes > 0, 'physical_bytes is positive');
      const dbSizeRow = await postgresQuery(
        'SELECT pg_database_size(current_database()) AS bytes'
      );
      const freshDbSize = Number(dbSizeRow.rows[0].bytes);
      const relativeDelta = Math.abs(footprint.physical_bytes - freshDbSize) / freshDbSize;
      assert.ok(
        relativeDelta < 0.01,
        `physical_bytes (${footprint.physical_bytes}) is within 1% of pg_database_size (${freshDbSize}); delta=${relativeDelta}`
      );

      // Relations are a bounded, largest-first list.
      assert.ok(Array.isArray(footprint.top_relations), 'top_relations is an array');
      assert.ok(footprint.top_relations.length <= 8, 'top_relations is bounded to the top-N');

      let runningSum = 0;
      let prev = Number.POSITIVE_INFINITY;
      for (const relation of footprint.top_relations) {
        assert.equal(typeof relation.name, 'string');
        assert.ok(relation.name.length > 0, 'relation name is non-empty');
        assert.equal(typeof relation.bytes, 'number');
        assert.ok(relation.bytes >= 0, 'relation size is non-negative');
        assert.ok(relation.bytes <= prev, 'relations are ordered largest-first');
        assert.ok(
          relation.bytes <= footprint.physical_bytes,
          'no single relation exceeds the whole database'
        );
        prev = relation.bytes;
        runningSum += relation.bytes;
      }
      // Top-N truncation: the listed relations never exceed the whole. They
      // legitimately sum to LESS than physical_bytes (the long tail, shared
      // catalogs, free space, WAL are not enumerated) — an equality assertion
      // would be wrong and is deliberately avoided.
      assert.ok(runningSum <= footprint.physical_bytes, 'listed relations sum to <= the whole');
    } finally {
      await closePostgresStorage();
    }
  });

  test('collectPhysicalFootprint does not write to the database (read-only)', async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      // pg_stat_database tuple counters register inserts/updates/deletes.
      // A pure pg_*_size read must not move them. We compare the committed
      // write counters across the footprint call.
      const before = await postgresQuery(
        `SELECT tup_inserted + tup_updated + tup_deleted AS writes
           FROM pg_stat_database WHERE datname = current_database()`
      );
      await collectPhysicalFootprint();
      const after = await postgresQuery(
        `SELECT tup_inserted + tup_updated + tup_deleted AS writes
           FROM pg_stat_database WHERE datname = current_database()`
      );
      assert.equal(
        Number(after.rows[0].writes),
        Number(before.rows[0].writes),
        'footprint read registered no inserts/updates/deletes'
      );
    } finally {
      await closePostgresStorage();
    }
  });
}
