// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression: `summarizeEvents` (exposed via `listSpineCorrelations` for the
 * `run` correlation key) must reflect the run's lifecycle status — i.e. the
 * most recent run-terminal event (`run.completed` / `run.failed`) — and NOT
 * the status of incidental sub-resource events that share the run_id (e.g.
 * `run.stream_session_resolved`, which carries `status: "completed"` when an
 * operator-side stream cleanly closes, independent of the connector run's
 * outcome).
 *
 * Bug: before the fix in `lib/spine.ts`, the summarizer walked the event
 * array from the end and took the most recent non-"unknown" `status` value,
 * regardless of the event_type. A run that emitted both `run.failed` AND a
 * later `run.stream_session_resolved` (status="completed") would surface as
 * "completed" — dishonest about the real outcome.
 *
 * Fix: prefer the most recent run-terminal event's status; only fall back to
 * the "last non-unknown status across any event_type" path when no terminal
 * event exists yet (run still in flight).
 *
 * `summarizeEvents` is not exported, so we exercise it via the public path
 * that wraps it: write events to the SQLite spine, then call
 * `listSpineCorrelations('run', ...)` and inspect the summary's status.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, getDb, initDb } from '../server/db.js';
import { emitSpineEvent, listSpineCorrelations } from '../lib/spine.ts';

async function withSpine(fn) {
  initDb();
  try {
    await fn();
  } finally {
    closeDb();
  }
}

test('run summary status prefers run-terminal events over later sub-resource events', async () => {
  await withSpine(async () => {
    const runId = 'run_terminal_priority';

    // Event 1: the run's terminal failure. This should drive the summary status.
    await emitSpineEvent({
      event_type: 'run.failed',
      run_id: runId,
      status: 'failed',
      object_type: 'run',
      object_id: runId,
      occurred_at: '2026-04-01T00:00:01Z',
    });

    // Event 2: a sub-resource event that fires *after* the run failed (e.g. the
    // operator-side stream session for the same run cleanly drains and resolves
    // with status="completed"). Without the fix, this leaks into the summary
    // status — masking the real failure.
    await emitSpineEvent({
      event_type: 'run.stream_session_resolved',
      run_id: runId,
      status: 'completed',
      object_type: 'stream_session',
      object_id: 'sess_1',
      occurred_at: '2026-04-01T00:00:02Z',
    });

    const page = await listSpineCorrelations('run', { limit: 50 });
    const summary = page.summaries.find((s) => s.run_id === runId || s.id === runId);
    assert.ok(summary, 'expected a summary for the failed run');
    assert.equal(
      summary.status,
      'failed',
      'run summary must reflect run.failed, not the later stream_session_resolved',
    );
  });
});

test('run summary falls back to last non-unknown status when no run-terminal event exists yet', async () => {
  await withSpine(async () => {
    const runId = 'run_in_flight_fallback';

    // A run that has only emitted a sub-resource event (no run.completed /
    // run.failed yet). The fallback path must still surface the most recent
    // non-"unknown" status so in-flight runs aren't reported as "unknown"
    // when there is real status signal to show.
    await emitSpineEvent({
      event_type: 'run.stream_session_resolved',
      run_id: runId,
      status: 'completed',
      object_type: 'stream_session',
      object_id: 'sess_2',
      occurred_at: '2026-04-01T00:00:01Z',
    });

    const page = await listSpineCorrelations('run', { limit: 50 });
    const summary = page.summaries.find((s) => s.run_id === runId || s.id === runId);
    assert.ok(summary, 'expected a summary for the in-flight run');
    assert.equal(
      summary.status,
      'completed',
      'with no run-terminal event, fallback should use the most recent non-unknown status',
    );
  });
});

test('started-only run without an active controller row is projected as failed orphan', async () => {
  await withSpine(async () => {
    const runId = 'run_started_only_orphan';

    await emitSpineEvent({
      event_type: 'run.started',
      run_id: runId,
      status: 'started',
      object_type: 'run',
      object_id: runId,
      actor_type: 'runtime',
      actor_id: 'github',
      occurred_at: '2026-04-01T00:00:01Z',
      data: {
        boot_epoch: '00000000-0000-4000-8000-000000000001',
        seq: 1,
      },
    });

    const page = await listSpineCorrelations('run', { limit: 50 });
    const summary = page.summaries.find((s) => s.run_id === runId || s.id === runId);
    assert.ok(summary, 'expected a summary for the orphaned run');
    assert.equal(summary.status, 'failed');
    assert.deepEqual(summary.failure, {
      event_type: 'run.started',
      reason: 'orphaned_started_run',
    });
  });
});

test('started-only run with an active controller row is projected as in progress', async () => {
  await withSpine(async () => {
    const runId = 'run_started_only_active';

    await emitSpineEvent({
      event_type: 'run.started',
      run_id: runId,
      status: 'started',
      object_type: 'run',
      object_id: runId,
      actor_type: 'runtime',
      actor_id: 'ynab',
      occurred_at: '2026-04-01T00:00:01Z',
      data: {
        boot_epoch: '00000000-0000-4000-8000-000000000002',
        seq: 1,
      },
    });

    getDb()
      .prepare(
        `INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run('cin_ynab', 'ynab', runId, 'trc_active', 'default', '2026-04-01T00:00:01Z');

    const page = await listSpineCorrelations('run', { limit: 50 });
    const summary = page.summaries.find((s) => s.run_id === runId || s.id === runId);
    assert.ok(summary, 'expected a summary for the active run');
    assert.equal(summary.status, 'in_progress');
    assert.equal(summary.failure, null);
  });
});

test('browser-surface profile key gives run summary exact connection identity', async () => {
  await withSpine(async () => {
    const runId = 'run_browser_surface_stale_setup';

    await emitSpineEvent({
      event_type: 'run.browser_surface_failed',
      run_id: runId,
      status: 'surface_failed',
      object_type: 'run',
      object_id: runId,
      actor_type: 'runtime',
      actor_id: 'chase',
      source_kind: 'connector',
      source_id: 'chase',
      occurred_at: '2026-04-01T00:00:01Z',
      data: {
        source: { kind: 'connector', id: 'chase' },
        browser_surface: {
          pending_run_id: runId,
          browser_surface_status: 'surface_failed',
          browser_surface_wait_reason: 'surface_unhealthy',
          browser_surface_lease_id: 'lease_stale_setup',
          browser_surface_profile_key: 'chase:cin_expired_setup',
        },
      },
    });

    const page = await listSpineCorrelations('run', { limit: 50 });
    const summary = page.summaries.find((s) => s.run_id === runId || s.id === runId);
    assert.ok(summary, 'expected a summary for the browser surface run');
    assert.equal(summary.status, 'surface_failed');
    assert.equal(summary.connector_id, 'chase');
    assert.equal(summary.connection_id, 'cin_expired_setup');
    assert.equal(summary.connector_instance_id, 'cin_expired_setup');
    assert.equal(summary.browser_surface_profile_key, 'chase:cin_expired_setup');
  });
});

test('runtime event connection identity gives run summary exact connection identity', async () => {
  await withSpine(async () => {
    const runId = 'run_connection_identity';

    await emitSpineEvent({
      event_type: 'run.started',
      run_id: runId,
      status: 'started',
      object_type: 'run',
      object_id: runId,
      actor_type: 'runtime',
      actor_id: 'github',
      source_kind: 'connector',
      source_id: 'github',
      occurred_at: '2026-04-01T00:00:01Z',
      data: {
        source: { kind: 'connector', id: 'github' },
        connection_id: 'cin_github_personal',
        connector_instance_id: 'cin_github_personal',
        boot_epoch: '00000000-0000-4000-8000-000000000003',
        seq: 1,
      },
    });
    await emitSpineEvent({
      event_type: 'run.completed',
      run_id: runId,
      status: 'succeeded',
      object_type: 'run',
      object_id: runId,
      actor_type: 'runtime',
      actor_id: 'github',
      source_kind: 'connector',
      source_id: 'github',
      occurred_at: '2026-04-01T00:00:02Z',
      data: {
        source: { kind: 'connector', id: 'github' },
        connection_id: 'cin_github_personal',
        connector_instance_id: 'cin_github_personal',
        records_emitted: 0,
      },
    });

    const page = await listSpineCorrelations('run', { limit: 50 });
    const summary = page.summaries.find((s) => s.run_id === runId || s.id === runId);
    assert.ok(summary, 'expected a summary for the connection-scoped run');
    assert.equal(summary.status, 'succeeded');
    assert.equal(summary.connector_id, 'github');
    assert.deepEqual(summary.source, { kind: 'connector', id: 'github' });
    assert.equal(summary.connection_id, 'cin_github_personal');
    assert.equal(summary.connector_instance_id, 'cin_github_personal');
  });
});

test('batched summary hydration orders each correlation by event_seq, not insertion/return order', async () => {
  // listSpineCorrelationsSqlite batches every page row's event window into one
  // query using ROW_NUMBER() OVER (PARTITION BY ...). The window function's
  // ORDER BY only decides partition MEMBERSHIP (which rows have rn <= N) — it
  // makes no promise about the order the outer query returns rows in.
  // summarizeEvents derives status from the last non-"unknown"-status event by
  // array position, so a batched fetch missing an explicit outer ORDER BY
  // could silently pick an earlier event as "last".
  //
  // Interleaving two runs' events (instead of writing each run's events
  // consecutively) means insertion order does not already coincide with
  // per-run event_seq order, so this does not rely on that being a
  // coincidence.
  await withSpine(async () => {
    const runA = 'run_order_a';
    const runB = 'run_order_b';
    for (let i = 0; i < 3; i += 1) {
      await emitSpineEvent({
        event_type: 'run.stream_session_resolved',
        run_id: runA,
        status: i === 2 ? 'succeeded' : 'in_progress',
        object_type: 'stream_session',
        object_id: `sess_a_${i}`,
        occurred_at: `2026-04-03T00:00:0${i}Z`,
      });
      await emitSpineEvent({
        event_type: 'run.stream_session_resolved',
        run_id: runB,
        status: i === 2 ? 'failed' : 'in_progress',
        object_type: 'stream_session',
        object_id: `sess_b_${i}`,
        occurred_at: `2026-04-04T00:00:0${i}Z`,
      });
    }

    const page = await listSpineCorrelations('run', { limit: 50 });
    const byId = new Map(page.summaries.map((s) => [s.run_id || s.id, s]));
    assert.equal(byId.get(runA)?.status, 'succeeded');
    assert.equal(byId.get(runB)?.status, 'failed');
  });
});

test('batched head query pins an explicit outer ORDER BY in its SQL text', async () => {
  // The prior test proves correct output for datasets where SQLite's window
  // function planner happens to already return rows sorted by partition +
  // event_seq — an implementation detail, not a documented guarantee — so it
  // cannot fail if the ORDER BY clause were ever removed from the query
  // text. This test pins the actual SQL string instead: it fails immediately
  // if a future edit drops the outer ORDER BY, regardless of whether the
  // current SQLite version's behavior happens to mask the bug.
  await withSpine(async () => {
    await emitSpineEvent({
      event_type: 'run.stream_session_resolved',
      run_id: 'run_order_by_pin',
      status: 'in_progress',
      object_type: 'stream_session',
      object_id: 'sess_pin',
      occurred_at: '2026-04-05T00:00:00Z',
    });

    // getDb() returns a Proxy (server/db.js's withCachedPrepare) whose `get`
    // trap always returns its own cached-prepare closure, so overriding
    // `db.prepare` directly is not observed. Patch the underlying
    // better-sqlite3 Database prototype instead — the Proxy's trap still
    // calls through to `target.prepare`, which resolves to this prototype
    // method.
    const Database = (await import('better-sqlite3')).default;
    const capturedSql = [];
    const originalPrepare = Database.prototype.prepare;
    Database.prototype.prepare = function patchedPrepare(sql, ...rest) {
      if (typeof sql === 'string' && sql.includes('spine_events') && sql.includes('ROW_NUMBER()')) {
        capturedSql.push(sql);
      }
      return originalPrepare.call(this, sql, ...rest);
    };

    try {
      await listSpineCorrelations('run', { q: 'run_order_by_pin', limit: 10 });
    } finally {
      Database.prototype.prepare = originalPrepare;
    }

    assert.ok(capturedSql.length > 0, 'expected at least one batched ROW_NUMBER() query to run');
    for (const sql of capturedSql) {
      // Both the window function's own partition-ordering ORDER BY and the
      // outer ORDER BY must pin an explicit null-last policy via
      // `(event_seq IS NULL)` rather than relying on SQLite's or Postgres's
      // differing NULL-default ordering (SQLite: NULL sorts first on ASC by
      // default; Postgres: NULL sorts last on ASC by default) — see
      // EVENT_ROW_ORDER_ASC in lib/spine.ts and lib/postgres-spine.js.
      const partitionOrderBy = sql.slice(sql.indexOf('PARTITION BY'), sql.search(/WHERE\s+rn\s*<=/i));
      assert.match(
        partitionOrderBy,
        /event_seq IS NULL/i,
        `expected the window function's partition ORDER BY to pin an explicit null-last policy in:\n${sql}`,
      );
      const afterFilter = sql.slice(sql.search(/WHERE\s+rn\s*<=/i));
      assert.match(afterFilter, /ORDER BY/i, `expected an outer ORDER BY after the rn filter in:\n${sql}`);
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

test('batched summary hydration places null-event_seq rows last in the hydrated array, driving a status with no run-terminal override and no independent aggregate involved', async () => {
  // Legacy pre-migration rows can carry a NULL event_seq (server/db.js adds
  // the column non-destructively; see the event_seq migration comment
  // there). Insert directly via raw SQL — emitSpineEvent always assigns a
  // real event_seq via insert-event.sql's MAX(event_seq)+1 subquery, so it
  // cannot produce this row shape itself.
  //
  // This uses a `trace` correlation (not `run`) and a non-run event_type
  // (`trace.step_recorded`) deliberately: `pickSummaryStatus` only special-
  // cases run-terminal event types (run.completed/failed/...) and
  // run.started leases (see lib/spine.ts). With neither present, it falls
  // straight through to `findLatestStatus(events, () => true)`, which scans
  // the array from `events.length - 1` down to 0 and returns the first
  // non-"unknown" status it finds — i.e. it is driven purely by hydrated
  // ARRAY POSITION, with no status precedence that could mask an ordering
  // bug. This is the gap in the prior version of this fixture: it used a
  // `run` correlation whose numbered event was `run.failed` (a run-terminal
  // type), so run-status precedence made the assertion pass regardless of
  // whether the null-last ordering was correct.
  //
  // `hydrateAggregateRow` (lib/spine.ts) also overwrites the hydrated
  // summary's `first_at`/`last_at`/`event_count` with the independent SQL
  // aggregate row's values after `summarizeEvents` runs — so none of those
  // three fields can prove anything about hydration order. `status` is the
  // one field `hydrateAggregateRow` leaves untouched (for non-`grant` kind),
  // so it is the only field in the public summary shape that is provably
  // derived from the merged/ordered array rather than an aggregate query.
  //
  // Two NULL-event_seq rows (status "stale-a" / "stale-b", the later of the
  // two by occurred_at is "stale-b"), plus one real-numbered row
  // (event_seq=1, status "fresh") that chronologically precedes both null
  // rows. Under the required null-last total order, the hydrated array ends
  // [..., fresh, stale-a, stale-b] (real row first by event_seq, then null
  // rows ordered by their own event_id tie-break, `evt-stale-a` <
  // `evt-stale-b`), so the array-position scan must land on "stale-b" —
  // NOT "fresh", even though "fresh" is chronologically most recent and has
  // a real, non-null sequence number. If the null-last policy were removed
  // (SQLite's ASC-NULL-first default), the null rows would sort BEFORE the
  // numbered row instead, and the array-last element would become "fresh"
  // — a different, wrong status. That is the exact discriminating mutation
  // this test guards against.
  await withSpine(async () => {
    const traceId = 'trace_null_seq_order_sensitive';
    const db = getDb();

    db.prepare(
      `INSERT INTO spine_events (
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, data_json, version
       ) VALUES (?, NULL, 'trace.step_recorded', ?, ?, 'scn', ?,
         'system', 'tester', 'trace_step', ?, 'stale-a', '{}', 'v1')`
    ).run('evt-stale-a', '2026-04-07T00:00:02Z', '2026-04-07T00:00:02Z', traceId, 'step-a');
    db.prepare(
      `INSERT INTO spine_events (
         event_id, event_seq, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, data_json, version
       ) VALUES (?, NULL, 'trace.step_recorded', ?, ?, 'scn', ?,
         'system', 'tester', 'trace_step', ?, 'stale-b', '{}', 'v1')`
    ).run('evt-stale-b', '2026-04-07T00:00:03Z', '2026-04-07T00:00:03Z', traceId, 'step-b');

    await emitSpineEvent({
      event_type: 'trace.step_recorded',
      trace_id: traceId,
      status: 'fresh',
      object_type: 'trace_step',
      object_id: 'step-fresh',
      occurred_at: '2026-04-07T00:00:01Z',
    });

    const page = await listSpineCorrelations('trace', { q: traceId, limit: 50 });
    const summary = page.summaries.find((s) => s.trace_id === traceId || s.id === traceId);
    assert.ok(summary, 'expected a summary for the trace with null-event_seq rows');
    assert.equal(
      summary.status,
      'stale-b',
      'the array-position-derived status must reflect the null-event_seq row that sorts last under the null-last policy, not the chronologically-latest real-numbered row',
    );
  });
});
