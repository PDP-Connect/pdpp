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
