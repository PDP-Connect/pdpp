// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the spine-source startup-backfill hardening.
 *
 * Proves that normal Postgres startup performs only bounded schema DDL: it
 * creates the source columns + index on a fresh DB, and on a subsequent boot
 * it does NOT backfill source values into existing NULL rows (the unbounded
 * per-row backfill is gone from the boot path). Also covers store-parity of
 * the summary index DDL and source derivation in unfiltered summaries.
 *
 * Postgres-backed; gated on PDPP_TEST_POSTGRES_URL. Each test creates and
 * drops its own temporary database so the live proof DB is never mutated.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import pg from 'pg';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  initPostgresStorage,
  closePostgresStorage,
  getPostgresPool,
} from '../server/postgres-storage.js';
import { mergeEventRows, postgresListSpineCorrelations } from '../lib/postgres-spine.js';

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

test('SQLite boot creates source/run summary index for spine aggregation', () => {
  closeDb();
  try {
    initDb(':memory:');

    const row = getDb()
      .prepare(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`
      )
      .get('idx_spine_events_source_run_summary');

    assert.ok(row?.sql, 'idx_spine_events_source_run_summary exists');
    assert.match(
      row.sql,
      /ON spine_events\(source_kind, source_id, run_id, occurred_at DESC\)/
    );
    assert.match(row.sql, /WHERE run_id IS NOT NULL/);
  } finally {
    closeDb();
  }
});

test('spine_events source/run summary index DDL is store-parity', () => {
  const sqliteDdl = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
  const postgresDdl = readFileSync(
    new URL('../server/postgres-storage.js', import.meta.url),
    'utf8'
  );

  assert.match(
    sqliteDdl,
    /CREATE INDEX IF NOT EXISTS idx_spine_events_source_run_summary\s+ON spine_events\(source_kind, source_id, run_id, occurred_at DESC\)\s+WHERE run_id IS NOT NULL/
  );
  assert.match(
    postgresDdl,
    /CREATE INDEX IF NOT EXISTS idx_pg_spine_events_source_run_summary\s+ON spine_events\(source_kind, source_id, run_id, occurred_at DESC\)\s+WHERE run_id IS NOT NULL/
  );
});

test('mergeEventRows keeps distinct rows that share a null/duplicate event_seq, deduping by event_id instead', () => {
  // Postgres's spine_events.event_seq is BIGSERIAL UNIQUE, so a live Postgres
  // row can never actually have a null or duplicate event_seq — this
  // exercises mergeEventRows directly as a defensive-correctness unit test,
  // not a live-data reproduction, since the schema itself prevents the
  // triggering condition on this backend today.
  //
  // Bug: the old dedup key was `Number.isFinite(Number(event_seq)) ? Number(event_seq) : event_id`.
  // `Number(null) === 0`, and `Number.isFinite(0)` is true, so the fallback
  // to event_id never triggered for a JS `null` (as opposed to `undefined`)
  // event_seq — every row sharing a null event_seq silently collapsed onto
  // the same map key, and only the last one survived.
  const rows = [
    { event_id: 'evt-a', event_seq: null, status: 'in_progress' },
    { event_id: 'evt-b', event_seq: null, status: 'failed' },
    { event_id: 'evt-c', event_seq: 5, status: 'succeeded' },
  ];
  const merged = mergeEventRows(rows);
  assert.equal(merged.length, 3, 'expected all three distinct events to survive the merge');
  const ids = merged.map((row) => row.event_id);
  assert.ok(ids.includes('evt-a'), 'evt-a must not be collapsed by evt-b sharing a null event_seq');
  assert.ok(ids.includes('evt-b'), 'evt-b must not be collapsed by evt-a sharing a null event_seq');
  assert.ok(ids.includes('evt-c'));
});

test('mergeEventRows deterministically orders rows that share a null/duplicate event_seq by event_id', () => {
  const merged = mergeEventRows([
    { event_id: 'evt-z', event_seq: null, status: 'a' },
    { event_id: 'evt-a', event_seq: null, status: 'b' },
  ]);
  assert.deepEqual(merged.map((row) => row.event_id), ['evt-a', 'evt-z']);
});

test('mergeEventRows sorts null-event_seq rows after every real numbered row, regardless of event_id', () => {
  // Bug this guards: the old comparator coerced event_seq with
  // `Number(event_seq) || 0`, so `Number(null) === 0` placed null-seq rows
  // BEFORE any row whose real event_seq is >= 1 — including a row whose
  // event_id would otherwise sort after it. `evt-aaa`'s event_id sorts
  // before `evt-real`'s alphabetically, so a naive event_id-only check on
  // two nulls (as in the test above) cannot catch this: it requires mixing
  // a null row with a low-but-nonzero real event_seq to expose the bug.
  const merged = mergeEventRows([
    { event_id: 'evt-aaa-null', event_seq: null, status: 'a' },
    { event_id: 'evt-real', event_seq: 1, status: 'b' },
  ]);
  assert.deepEqual(
    merged.map((row) => row.event_id),
    ['evt-real', 'evt-aaa-null'],
    'the real numbered row (event_seq=1) must sort before the null-event_seq row, even though "evt-aaa-null" < "evt-real" alphabetically',
  );
});

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

  test('batched summary hydration orders each correlation by event_seq, not insertion/return order', async () => {
    // postgresListSpineCorrelations batches every page row's event window into
    // one query using ROW_NUMBER() OVER (PARTITION BY ...). The window
    // function's ORDER BY only decides partition MEMBERSHIP (which rows have
    // rn <= N) — it makes no promise about the order the outer query returns
    // rows in. summarizeRows derives status/source/browser-surface state from
    // array position (first/last event, reverse scans), so a batched fetch
    // that forgot an explicit outer ORDER BY could silently pick an earlier
    // event as "last" if the planner ever returns rows out of event_seq order.
    //
    // Interleaving inserts across two correlations (instead of writing each
    // correlation's events consecutively) means physical/heap insertion order
    // does NOT already coincide with per-correlation event_seq order, so this
    // does not rely on the planner happening to preserve insertion order.
    await withTempDb(async (url) => {
      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      const pool = getPostgresPool();

      async function insertOrderedEvent({ eventId, traceId, eventType, status, occurredAt }) {
        await pool.query(
          `INSERT INTO spine_events (
             event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
             actor_type, actor_id, object_type, object_id, status, data_json, version
           ) VALUES ($1,$2,$3,$3,'scn',$4,'system','tester','obj','obj-1',$5,'{}'::jsonb,'v1')`,
          [eventId, eventType, occurredAt, traceId, status],
        );
      }

      // Interleaved: trace-order-a's events are inserted between trace-order-b's,
      // so event_seq for A and B alternates rather than running in two blocks.
      for (let i = 0; i < 3; i += 1) {
        await insertOrderedEvent({
          eventId: `order-a-${i}`,
          traceId: 'trace_order_a',
          eventType: 'run.progress',
          status: i === 2 ? 'succeeded' : 'in_progress',
          occurredAt: `2026-04-01T00:00:0${i}Z`,
        });
        await insertOrderedEvent({
          eventId: `order-b-${i}`,
          traceId: 'trace_order_b',
          eventType: 'run.progress',
          status: i === 2 ? 'failed' : 'in_progress',
          occurredAt: `2026-04-02T00:00:0${i}Z`,
        });
      }

      const page = await postgresListSpineCorrelations('trace', { q: 'trace_order_', limit: 10 });
      const byId = new Map(page.summaries.map((summary) => [summary.trace_id, summary]));
      assert.equal(byId.get('trace_order_a')?.status, 'succeeded');
      assert.equal(byId.get('trace_order_b')?.status, 'failed');
    });
  });

  test('batched head/tail/terminal queries pin an explicit outer ORDER BY in their SQL text', async () => {
    // The prior test proves correct output for datasets where neither local
    // Postgres nor SQLite's planner happens to violate the window function's
    // (undocumented) tendency to return rows already sorted by partition +
    // event_seq — so it cannot fail if the ORDER BY clause were ever removed
    // from the query text. This test pins the actual SQL string instead: it
    // fails immediately if a future edit drops the outer ORDER BY, regardless
    // of whether the current planner's behavior happens to mask the bug.
    await withTempDb(async (url) => {
      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      const pool = getPostgresPool();

      const capturedSql = [];
      const originalQuery = pool.query.bind(pool);
      pool.query = (sql, ...rest) => {
        if (typeof sql === 'string' && sql.includes('spine_events')) {
          capturedSql.push(sql);
        }
        return originalQuery(sql, ...rest);
      };

      try {
        await insertEvent(pool, {
          eventId: 'order-by-pin-e1',
          actorType: 'system',
          actorId: 'tester',
          runId: 'run_order_by_pin',
          dataJson: {},
        });

        await postgresListSpineCorrelations('run', { q: 'run_order_by_pin', limit: 10 });
      } finally {
        pool.query = originalQuery;
      }

      // Every batched query that assigns ROW_NUMBER() then filters on rn must
      // also carry an outer ORDER BY on the correlation column + event_seq —
      // the window function's own ORDER BY only decides partition
      // membership, not the order the outer SELECT returns rows in. It must
      // also carry an event_id tie-break: event_seq alone is not a total
      // order (legacy rows can share or null it). Both the outer ORDER BY
      // and the window function's own partition-ordering ORDER BY must pin
      // an explicit null-last policy via `(event_seq IS NULL)` rather than
      // relying on Postgres's or SQLite's differing NULL-default ordering
      // (Postgres: NULL sorts last on ASC by default; SQLite: NULL sorts
      // first on ASC by default) — see EVENT_ROW_ORDER_ASC/DESC in
      // lib/postgres-spine.js.
      const rankedQueries = capturedSql.filter((sql) => sql.includes('ROW_NUMBER()'));
      assert.ok(rankedQueries.length > 0, 'expected at least one batched ROW_NUMBER() query to run');
      for (const sql of rankedQueries) {
        const partitionOrderBy = sql.slice(sql.indexOf('PARTITION BY'), sql.search(/WHERE\s+rn\s*<=/i));
        assert.match(
          partitionOrderBy,
          /event_seq IS NULL/i,
          `expected the window function's partition ORDER BY to pin an explicit null-last policy in:\n${sql}`,
        );
        const afterFilter = sql.slice(sql.search(/WHERE\s+rn\s*<=/i));
        assert.match(
          afterFilter,
          /ORDER BY/i,
          `expected an outer ORDER BY after the rn filter in:\n${sql}`,
        );
        assert.match(
          afterFilter,
          /event_id/i,
          `expected the outer ORDER BY to carry an event_id tie-break in:\n${sql}`,
        );
        assert.match(
          afterFilter,
          /event_seq IS NULL/i,
          `expected the outer ORDER BY to pin an explicit null-last policy in:\n${sql}`,
        );
      }
    });
  });

  test('batched tail-window admission excludes null-event_seq rows under the null-last DESC policy, even at scale where every row cannot fit in the head window', async () => {
    // Postgres's spine_events.event_seq is BIGSERIAL NOT NULL UNIQUE, so a
    // live row can never actually carry a null event_seq — insert directly
    // via raw SQL against a temp table with the NOT NULL constraint
    // dropped, to exercise the null-last ordering policy defensively.
    //
    // Why the ASC-only ("head") window cannot discriminate this mutation on
    // Postgres: fetchRowsForSummaries's `head` query (SUMMARY_EVENT_HEAD_LIMIT
    // = 5000, ASC) is the only window `trace`/`grant` correlations ever use
    // (`kind !== 'run'` returns straight after `head`, lib/postgres-spine.js).
    // Postgres's OWN default NULL ordering already sorts NULL last on ASC
    // (unlike SQLite, which sorts NULL first on ASC by default) — a fact
    // verified directly against a live engine this session:
    //   ORDER BY seq ASC, id ASC            -> {1, NULL, NULL}  (already null-last)
    //   ORDER BY (seq IS NULL), seq ASC, id ASC -> {1, NULL, NULL}  (identical)
    // So removing `(event_seq IS NULL)` from EVENT_ROW_ORDER_ASC changes
    // nothing observable on Postgres for any ASC-only path or for any `run`
    // correlation with <=SUMMARY_EVENT_HEAD_LIMIT total events, since `head`
    // alone already contains every row and mergeEventRows re-sorts the
    // final merged array with its own (unmutated) JS comparator regardless
    // of what order the SQL returned rows in — an ASC-only or small-scale
    // fixture would pass this assertion whether or not the SQL policy text
    // is present, which is exactly the gap this test must not repeat.
    //
    // Where the mutation IS observable: Postgres's DESC default is the
    // OPPOSITE of its ASC default — NULL sorts FIRST on DESC by default,
    // verified directly this session:
    //   ORDER BY seq DESC, id DESC            -> {NULL, NULL, 1}  (null-FIRST, wrong)
    //   ORDER BY (seq IS NULL), seq DESC, id DESC -> {1, NULL, NULL} (null-last, required)
    // `fetchRowsForSummaries`'s `tail`/`terminal` DESC windows exist only
    // for `kind === 'run'`, each with a small LIMIT (200 / 10). Those LIMITs
    // only affect MEMBERSHIP (which rows are admitted into the merged
    // array at all), not just order, once the correlation's total event
    // count exceeds `head`'s 5000-row ASC window — below that threshold
    // every row already reaches `head`, so the tail/terminal windows are
    // redundant regardless of the DESC mutation. This is the scale this
    // fixture must clear to be genuinely discriminating (confirmed by hand
    // this session: an 11-row and a >200-but-<5000-row fixture both failed
    // to discriminate the DESC mutation for exactly this reason).
    //
    // Fixture: 5020 real-numbered rows (event_seq 1..5020, status "mid",
    // event_type "run.progress_reported" — NOT a run-terminal type, so
    // projectSummaryStatus's terminal-event branch never fires and cannot
    // mask an ordering defect) plus 5 null-event_seq rows (status
    // "null-tail"). `head` (ASC, LIMIT 5000) admits only event_seq
    // 1..5000 (5020 numbered rows > 5000, so the top 20 by event_seq and
    // all 5 null rows are excluded from `head` regardless of ordering
    // policy). Whether event_seq 5001..5020 and the null rows reach the
    // final merged array depends entirely on `tail`'s DESC admission
    // (LIMIT 200): under the required null-last DESC policy, the null
    // rows sort after every numbered row even in DESC, so `tail` admits
    // only the top 200 real-numbered rows (event_seq 5020..4821) and the 5
    // null rows never reach the array — status must be "mid". Under the
    // mutation (bare `event_seq DESC, event_id DESC`, Postgres's default
    // null-FIRST-on-DESC), the 5 null rows occupy tail ranks 1-5, admitting
    // them into the array while displacing 5 real rows at the bottom of the
    // window — status flips to "null-tail". `event_count` is aggregate-
    // derived (assembleSummaryObject overwrites it from the independent SQL
    // aggregate row) and stays 5025 either way, proving it cannot detect
    // this membership shift — `status` is the field that can, since
    // projectSummaryStatus computes it from the hydrated `events` array and
    // assembleSummaryObject passes it through untouched.
    await withTempDb(async (url) => {
      await initPostgresStorage({ backend: 'postgres', databaseUrl: url });
      const pool = getPostgresPool();
      await pool.query('ALTER TABLE spine_events ALTER COLUMN event_seq DROP NOT NULL');

      const runId = 'run_null_seq_tail_admission';
      const NUMBERED_COUNT = 5020;
      const values = [];
      const params = [];
      for (let i = 1; i <= NUMBERED_COUNT; i += 1) {
        const base = params.length;
        values.push(
          `($${base + 1}, $${base + 2}, 'run.progress_reported', '2026-04-08T00:00:00Z', '2026-04-08T00:00:00Z', 'scn', 'trc_null_seq_tail', 'system', 'tester', 'run', $${base + 1}, 'mid', $${base + 3}, '{}'::jsonb, 'v1')`,
        );
        params.push(`evt-mid-${i}`, i, runId);
      }
      await pool.query(
        `INSERT INTO spine_events (
           event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id, data_json, version
         ) VALUES ${values.join(', ')}`,
        params,
      );
      for (let i = 1; i <= 5; i += 1) {
        await pool.query(
          `INSERT INTO spine_events (
             event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
             actor_type, actor_id, object_type, object_id, status, run_id, data_json, version
           ) VALUES ($1, NULL, 'run.progress_reported', '2026-04-08T00:00:00Z', '2026-04-08T00:00:00Z',
             'scn', 'trc_null_seq_tail', 'system', 'tester', 'run', $1, 'null-tail', $2, '{}'::jsonb, 'v1')`,
          [`evt-null-${i}`, runId],
        );
      }

      const page = await postgresListSpineCorrelations('run', { q: runId, limit: 10 });
      const summary = page.summaries.find((s) => s.run_id === runId || s.id === runId);
      assert.ok(summary, 'expected a summary for the run with null-event_seq rows at scale');
      assert.equal(
        summary.status,
        'mid',
        'the tail window must admit only real-numbered rows under the null-last DESC policy; a null-event_seq row reaching the merged array (status "null-tail") means the tail window wrongly admitted it ahead of a real row',
      );
      assert.equal(summary.event_count, NUMBERED_COUNT + 5);
    });
  });
}
