/**
 * Mutation-killing unit coverage for the pure evidence-mapping helpers in
 * `runtime/connector-verdict-input.ts`. `streamPriority`, `buildStreamRollups`,
 * and `buildProgressEvidence` had no direct test; `progressMode` was invoked
 * once (for the manual case only). These mappers decide the worst-wins rollup
 * priority, per-stream retryability/attention attribution, and the progress
 * model the verdict privileges — a mutant flipping a clause here silently
 * mis-renders connection health.
 *
 * Pure mapping; no grant/auth/token/consent logic (no RED tokens in the
 * module). No source is changed.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProgressEvidence,
  buildStreamRollups,
  progressMode,
  streamPriority,
} from '../runtime/connector-verdict-input.ts';

function snapshot(axes = {}) {
  return { axes: { attention: 'none', coverage: 'complete', ...axes } };
}

// ─── streamPriority ──────────────────────────────────────────────────────

test('streamPriority treats an unknown/undefined stream as required', () => {
  assert.equal(streamPriority(undefined), 'required');
});

test('streamPriority keeps a required (default or explicit) stream required', () => {
  assert.equal(streamPriority({ name: 'a' }), 'required');
  assert.equal(streamPriority({ name: 'a', required: true }), 'required');
});

test('streamPriority marks a non-required stream with an accepted policy accepted_absence', () => {
  assert.equal(streamPriority({ name: 'a', required: false, coverage_policy: 'deferred' }), 'accepted_absence');
  assert.equal(streamPriority({ name: 'a', required: false, coverage_policy: 'unavailable' }), 'accepted_absence');
});

test('streamPriority marks a non-required collect / no-policy stream optional', () => {
  assert.equal(streamPriority({ name: 'a', required: false, coverage_policy: 'collect' }), 'optional');
  assert.equal(streamPriority({ name: 'a', required: false }), 'optional');
});

test('streamPriority keeps a contradictory required+accepted-policy stream required', () => {
  assert.equal(streamPriority({ name: 'a', required: true, coverage_policy: 'deferred' }), 'required');
});

// ─── progressMode ────────────────────────────────────────────────────────

test('progressMode prefers local_device above all other signals', () => {
  assert.equal(
    progressMode({ localDeviceBacked: true, refresh: null, schedule: { enabled: true }, hasRecoveredDetailGaps: true }),
    'local_device',
  );
});

test('progressMode is deferred for a scheduled connector draining recovered detail gaps', () => {
  assert.equal(
    progressMode({ localDeviceBacked: false, refresh: null, schedule: { enabled: true }, hasRecoveredDetailGaps: true }),
    'deferred',
  );
});

test('progressMode is manual for a non-scheduled connection', () => {
  assert.equal(
    progressMode({ localDeviceBacked: false, refresh: null, schedule: null, hasRecoveredDetailGaps: false }),
    'manual',
  );
});

test('progressMode is manual when the refresh contract is manual-only', () => {
  assert.equal(
    progressMode({
      localDeviceBacked: false,
      refresh: { recommendedMode: 'manual' },
      schedule: { enabled: true },
      hasRecoveredDetailGaps: false,
    }),
    'manual',
  );
});

test('progressMode is scheduled for an explicit manual-default background-safe schedule', () => {
  assert.equal(
    progressMode({
      localDeviceBacked: false,
      refresh: { recommendedMode: 'manual', backgroundSafe: true },
      schedule: { enabled: true },
      hasRecoveredDetailGaps: false,
    }),
    'scheduled',
  );
});

test('progressMode is scheduled otherwise', () => {
  assert.equal(
    progressMode({ localDeviceBacked: false, refresh: null, schedule: { enabled: true }, hasRecoveredDetailGaps: false }),
    'scheduled',
  );
});

// ─── buildProgressEvidence ───────────────────────────────────────────────

test('buildProgressEvidence maps every field through and defaults observed_at to null', () => {
  assert.deepEqual(
    buildProgressEvidence({
      mode: 'scheduled',
      retainedRecords: 5,
      recordsCommittedLastRun: null,
      gapsDrainedLastRun: 2,
      lastRefreshedAt: '2026-01-01T00:00:00.000Z',
    }),
    {
      mode: 'scheduled',
      retained_records: 5,
      records_committed_last_run: null,
      gaps_drained_last_run: 2,
      last_refreshed_at: '2026-01-01T00:00:00.000Z',
      observed_at: null,
    },
  );
});

test('buildProgressEvidence forwards an explicit observed_at', () => {
  assert.equal(
    buildProgressEvidence({
      mode: 'manual',
      retainedRecords: null,
      recordsCommittedLastRun: null,
      gapsDrainedLastRun: null,
      lastRefreshedAt: null,
      observedAt: '2026-02-02T00:00:00.000Z',
    }).observed_at,
    '2026-02-02T00:00:00.000Z',
  );
});

// ─── buildStreamRollups ──────────────────────────────────────────────────

test('buildStreamRollups maps considered "unknown" to null and marks retryable coverage', () => {
  const [rollup] = buildStreamRollups(
    [{ stream: 'messages', collected: 10, considered: 'unknown', coverage_condition: 'retryable_gap', pending_detail_gaps: 0 }],
    [{ name: 'messages', required: true }],
    snapshot({ coverage: 'partial' }),
  );
  assert.equal(rollup.considered, null);
  assert.equal(rollup.coverage, 'retryable_gap');
  assert.equal(rollup.gap_retryable, true);
  assert.equal(rollup.priority, 'required');
});

test('buildStreamRollups marks a stream retryable when detail gaps remain even on complete coverage', () => {
  const [rollup] = buildStreamRollups(
    [{ stream: 'm', collected: 1, considered: 1, coverage_condition: 'complete', pending_detail_gaps: 3 }],
    [{ name: 'm' }],
    snapshot({ coverage: 'partial' }),
  );
  assert.equal(rollup.gap_retryable, true);
});

test('buildStreamRollups attributes connection attention only to non-complete streams', () => {
  const attentive = snapshot({ attention: 'needs_action' });
  const [nonComplete] = buildStreamRollups(
    [{ stream: 'm', collected: 1, considered: 2, coverage_condition: 'partial', pending_detail_gaps: 1 }],
    [{ name: 'm' }],
    attentive,
  );
  assert.equal(nonComplete.attention_open, true);

  const [complete] = buildStreamRollups(
    [{ stream: 'm', collected: 1, considered: 1, coverage_condition: 'complete', pending_detail_gaps: 0 }],
    [{ name: 'm' }],
    attentive,
  );
  assert.equal(complete.attention_open, false);
});

test('buildStreamRollups downgrades a per-run report gap to optional when the connection coverage is complete', () => {
  const [rollup] = buildStreamRollups(
    [{ stream: 'm', collected: 1, considered: 1, coverage_condition: 'partial', pending_detail_gaps: 0 }],
    [{ name: 'm', required: true }],
    snapshot({ coverage: 'complete' }),
  );
  // connectionCompleteReportGap: complete coverage + no pending gaps + a
  // non-terminal incomplete per-run condition -> effectivePriority optional.
  assert.equal(rollup.priority, 'optional');
});

test('buildStreamRollups keeps a terminal gap load-bearing even under complete connection coverage', () => {
  for (const terminal of ['terminal_gap', 'unsupported', 'unavailable']) {
    const [rollup] = buildStreamRollups(
      [{ stream: 'm', collected: 1, considered: 1, coverage_condition: terminal, pending_detail_gaps: 0 }],
      [{ name: 'm', required: true }],
      snapshot({ coverage: 'complete' }),
    );
    assert.equal(rollup.priority, 'required', terminal);
  }
});
