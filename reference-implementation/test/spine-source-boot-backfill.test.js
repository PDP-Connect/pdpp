/**
 * Tests for the spine-source startup-backfill hardening.
 *
 * Proves:
 *   1. Normal Postgres startup performs only bounded schema DDL: it creates
 *      the source columns + index on a fresh DB, and on a subsequent boot it
 *      does NOT backfill source values into existing NULL rows (the unbounded
 *      per-row backfill is gone from the boot path).
 *   2. The explicit `backfill-spine-source` maintenance script is dry-run by
 *      default, resolves resolvable NULL rows in bounded batches under
 *      --apply, leaves genuinely-sourceless rows NULL, and is idempotent.
 *
 * Postgres-backed; gated on PDPP_TEST_POSTGRES_URL. Each test creates and
 * drops its own temporary database so the live proof DB is never mutated.
 *
 * Spec: openspec/changes/harden-startup-data-backfills
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import pg from 'pg';

import {
  initPostgresStorage,
  closePostgresStorage,
  getPostgresPool,
} from '../server/postgres-storage.js';
import { postgresListSpineCorrelations } from '../lib/postgres-spine.js';
import { backfillSpineSource } from '../scripts/backfill-spine-source/backfill-spine-source.mjs';

const { Pool } = pg;
const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

// A deterministic temp DB name per file run. Date.now/Math.random are fine in
// test code (unlike workflow scripts).
let tempCounter = 0;
function tempDbName() {
  tempCounter += 1;
  return `pdpp_spine_boot_${process.pid}_${tempCounter}`;
}

function adminUrl(url) {
  const u = new URL(url);
  u.pathname = '/postgres';
  return u.toString();
}

function dbUrl(url, dbName) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

async function withTempDb(fn) {
  const admin = new Pool({ connectionString: adminUrl(POSTGRES_URL) });
  const name = tempDbName();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } catch (err) {
    await admin.end();
    throw err;
  }
  const url = dbUrl(POSTGRES_URL, name);
  try {
    await fn(url);
  } finally {
    try {
      await closePostgresStorage();
    } catch {}
    // Terminate stragglers, then drop.
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name],
      );
    } catch {}
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
    } catch {}
    await admin.end();
  }
}

// Insert a minimal spine_events row with NULL source columns. `actorType`
// 'runtime' + actorId makes the row resolvable (deriveSpineSource → connector);
// any other actor_type with an empty payload is genuinely sourceless.
async function insertEvent(pool, { eventId, actorType, actorId, dataJson, runId = null }) {
  await pool.query(
    `INSERT INTO spine_events (
       event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, object_type, object_id, status, run_id, data_json, version
     ) VALUES ($1,'test.event','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z',
       'scn','trace-1',$2,$3,'obj','obj-1','ok',$4,$5::jsonb,'v1')`,
    [eventId, actorType, actorId, runId, JSON.stringify(dataJson ?? {})],
  );
}

async function columnExists(pool, table, column) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return r.rowCount > 0;
}

async function indexExists(pool, name) {
  const r = await pool.query(`SELECT 1 FROM pg_indexes WHERE indexname = $1`, [name]);
  return r.rowCount > 0;
}

if (!POSTGRES_URL) {
  test('spine-source boot/backfill DB tests (skipped: PDPP_TEST_POSTGRES_URL unset)', { skip: true }, () => {});
} else {
  test('boot creates source columns + index on a fresh database', async () => {
    await withTempDb(async (url) => {
      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      const pool = getPostgresPool();
      assert.equal(await columnExists(pool, 'spine_events', 'source_kind'), true);
      assert.equal(await columnExists(pool, 'spine_events', 'source_id'), true);
      assert.equal(await indexExists(pool, 'idx_pg_spine_events_source'), true);
      assert.equal(await indexExists(pool, 'idx_pg_spine_events_trace_recent'), true);
      assert.equal(await indexExists(pool, 'idx_pg_spine_events_run_recent'), true);
      assert.equal(await indexExists(pool, 'idx_pg_spine_events_grant_recent'), true);
      assert.equal(await indexExists(pool, 'idx_pg_spine_events_source_run_summary'), true);
    });
  });

  test('reboot does NOT backfill source values into existing NULL rows', async () => {
    await withTempDb(async (url) => {
      // First boot installs schema.
      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      let pool = getPostgresPool();

      // Seed a RESOLVABLE NULL-source row (runtime actor → connector source).
      // If boot still backfilled, this row's columns would become non-NULL.
      await insertEvent(pool, {
        eventId: 'ev-resolvable',
        actorType: 'runtime',
        actorId: 'gmail',
        dataJson: {},
      });
      // Sanity: it is NULL right after insert.
      const before = await pool.query(
        `SELECT source_kind, source_id FROM spine_events WHERE event_id = 'ev-resolvable'`,
      );
      assert.equal(before.rows[0].source_kind, null);
      assert.equal(before.rows[0].source_id, null);

      // Second boot (simulated restart). It must NOT touch row values.
      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      pool = getPostgresPool();
      const after = await pool.query(
        `SELECT source_kind, source_id FROM spine_events WHERE event_id = 'ev-resolvable'`,
      );
      assert.equal(after.rows[0].source_kind, null, 'boot must not backfill source_kind');
      assert.equal(after.rows[0].source_id, null, 'boot must not backfill source_id');
    });
  });

  test('backfill script: dry-run reports the split and writes nothing; apply converges; re-run is a no-op', async () => {
    await withTempDb(async (url) => {
      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      const bootPool = getPostgresPool();

      // Two resolvable rows (runtime actor) + two genuinely-sourceless rows.
      await insertEvent(bootPool, { eventId: 'r1', actorType: 'runtime', actorId: 'gmail' });
      await insertEvent(bootPool, { eventId: 'r2', actorType: 'runtime', actorId: 'slack' });
      await insertEvent(bootPool, { eventId: 's1', actorType: 'subject', actorId: 'owner' });
      await insertEvent(bootPool, { eventId: 's2', actorType: 'client', actorId: 'app-1' });

      // Use an independent pool for the script (mirrors operator invocation).
      const pool = new Pool({ connectionString: url });
      try {
        // Dry-run: nothing written, correct split reported.
        const dry = await backfillSpineSource({ pool, apply: false, batchSize: 1 });
        assert.equal(dry.scanned, 4);
        assert.equal(dry.resolved, 2);
        assert.equal(dry.unresolvable, 2);
        assert.equal(dry.written, 0);
        assert.ok(dry.batches >= 4, 'batchSize=1 should page row-by-row');

        const stillNull = await pool.query(
          `SELECT count(*)::int AS n FROM spine_events WHERE source_kind IS NULL`,
        );
        assert.equal(stillNull.rows[0].n, 4, 'dry-run must not write');

        // Apply: resolvable rows filled, sourceless left NULL.
        const applied = await backfillSpineSource({ pool, apply: true, batchSize: 2 });
        assert.equal(applied.resolved, 2);
        assert.equal(applied.unresolvable, 2);
        assert.equal(applied.written, 2);

        const r1 = await pool.query(
          `SELECT source_kind, source_id FROM spine_events WHERE event_id = 'r1'`,
        );
        assert.equal(r1.rows[0].source_kind, 'connector');
        assert.equal(r1.rows[0].source_id, 'gmail');

        const sourceless = await pool.query(
          `SELECT count(*)::int AS n FROM spine_events
             WHERE event_id IN ('s1','s2') AND source_kind IS NULL`,
        );
        assert.equal(sourceless.rows[0].n, 2, 'sourceless rows stay NULL');

        // Re-run: no resolvable rows remain → no writes.
        const second = await backfillSpineSource({ pool, apply: true, batchSize: 10 });
        assert.equal(second.resolved, 0);
        assert.equal(second.written, 0);
        assert.equal(second.unresolvable, 2, 'sourceless tail still scanned but never written');
      } finally {
        await pool.end();
      }
    });
  });

  test('backfill script also mirrors source into data_json for resolved rows', async () => {
    await withTempDb(async (url) => {
      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      const bootPool = getPostgresPool();
      await insertEvent(bootPool, { eventId: 'm1', actorType: 'runtime', actorId: 'oura' });

      const pool = new Pool({ connectionString: url });
      try {
        await backfillSpineSource({ pool, apply: true, batchSize: 10 });
        const r = await pool.query(
          `SELECT data_json FROM spine_events WHERE event_id = 'm1'`,
        );
        assert.deepEqual(r.rows[0].data_json.source, { kind: 'connector', id: 'oura' });
      } finally {
        await pool.end();
      }
    });
  });

  test('unfiltered Postgres summaries derive source for legacy NULL-source rows', async () => {
    await withTempDb(async (url) => {
      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      const pool = getPostgresPool();

      await insertEvent(pool, {
        eventId: 'legacy-json-source',
        actorType: 'system',
        actorId: 'pdpp_reference',
        runId: 'run_json_source',
        dataJson: { source: { kind: 'connector', id: 'gmail' } },
      });
      await insertEvent(pool, {
        eventId: 'legacy-runtime-source',
        actorType: 'runtime',
        actorId: 'slack',
        runId: 'run_runtime_source',
        dataJson: {},
      });

      const page = await postgresListSpineCorrelations('run', { limit: 10 });
      const byRun = new Map(page.summaries.map((summary) => [summary.run_id, summary]));

      assert.deepEqual(byRun.get('run_json_source')?.source, {
        kind: 'connector',
        id: 'gmail',
      });
      assert.equal(byRun.get('run_json_source')?.connector_id, 'gmail');
      assert.deepEqual(byRun.get('run_runtime_source')?.source, {
        kind: 'connector',
        id: 'slack',
      });
      assert.equal(byRun.get('run_runtime_source')?.connector_id, 'slack');
    });
  });

  test('unfiltered Postgres summary first pages return recent distinct correlations', async () => {
    await withTempDb(async (url) => {
      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      const pool = getPostgresPool();

      for (let i = 0; i < 120; i += 1) {
        await insertEvent(pool, {
          eventId: `trace-a-${i}`,
          actorType: 'client',
          actorId: 'app-a',
          dataJson: {},
        });
        await pool.query(
          `UPDATE spine_events
             SET trace_id = 'trace_a',
                 occurred_at = $1,
                 recorded_at = $1
           WHERE event_id = $2`,
          [`2026-06-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`, `trace-a-${i}`],
        );
      }
      await insertEvent(pool, {
        eventId: 'trace-b',
        actorType: 'client',
        actorId: 'app-b',
        dataJson: {},
      });
      await pool.query(
        `UPDATE spine_events
           SET trace_id = 'trace_b',
               occurred_at = '2026-05-31T23:59:59.000Z',
               recorded_at = '2026-05-31T23:59:59.000Z'
         WHERE event_id = 'trace-b'`,
      );
      await insertEvent(pool, {
        eventId: 'trace-c',
        actorType: 'client',
        actorId: 'app-c',
        dataJson: {},
      });
      await pool.query(
        `UPDATE spine_events
           SET trace_id = 'trace_c',
               occurred_at = '2026-05-31T23:59:58.000Z',
               recorded_at = '2026-05-31T23:59:58.000Z'
         WHERE event_id = 'trace-c'`,
      );

      const page = await postgresListSpineCorrelations('trace', { limit: 2 });
      assert.deepEqual(page.summaries.map((summary) => summary.trace_id), ['trace_a', 'trace_b']);
      assert.equal(page.hasMore, true);
      assert.equal(page.summaries[0].event_count, 120);
    });
  });
}
