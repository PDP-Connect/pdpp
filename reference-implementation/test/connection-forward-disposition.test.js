import test from 'node:test';
import assert from 'node:assert/strict';

import { computeConnectionHealth } from '../runtime/connection-health.ts';

// Wiring tests for the connection-level `forward_disposition` surfaced on the
// `ConnectionHealthSnapshot`. The pure branch logic is covered exhaustively in
// `forward-disposition.test.js`; these tests prove the INTEGRATION the pure test
// cannot reach:
//
//   - that `computeConnectionHealth` maps its own evidence onto the five
//     disposition signals correctly (coverage axis -> gapRetryable, the
//     `AttentionClear` condition -> attentionOpen, freshness axis + refresh
//     policy through), and
//   - that the disposition stays consistent with the headline pill it sits
//     beside (an attention-blocked gap is `awaiting_owner` exactly when the
//     headline is `needs_attention`).
//
// See `define-connector-progress-evidence-contract` (tranche 2 wiring).

const NOW = '2026-05-19T12:00:00.000Z';

/** A manual / paused / not-background-safe connection that cannot self-refresh. */
const MANUAL_REFRESH = Object.freeze({ backgroundSafe: false, recommendedMode: 'manual' });
/** A schedulable, background-safe connection the scheduler refreshes on its own. */
const SCHEDULABLE_REFRESH = Object.freeze({ backgroundSafe: true, recommendedMode: 'automatic' });

/** Default input: enabled schedule, no policy violations, observed at NOW. */
function input(overrides = {}) {
  return {
    schedule: { enabled: true },
    run: null,
    backoff: null,
    attention: null,
    coverage: null,
    freshness: null,
    outbox: null,
    projection: null,
    activity: null,
    observedAt: NOW,
    ...overrides,
  };
}

function succeededRun(overrides = {}) {
  return {
    latestStatus: 'succeeded',
    hasDegradingGaps: false,
    lastSuccessAt: '2026-05-19T11:55:00.000Z',
    reasonCode: null,
    ...overrides,
  };
}

// ─── every snapshot carries a disposition ────────────────────────────────────

test('every snapshot carries a forward_disposition (default never-run -> checking)', () => {
  // A never-run connection has `unknown` coverage — absence of evidence, never
  // proof of completeness or a recoverable gap — so its disposition is
  // `checking`, not `complete` or `resumable`.
  const snap = computeConnectionHealth(input());
  assert.equal(snap.forward_disposition, 'checking');
  assert.equal(snap.state, 'idle');
});

// ─── complete ────────────────────────────────────────────────────────────────

test('healthy + complete coverage + fresh -> forward_disposition complete', () => {
  const snap = computeConnectionHealth(
    input({ run: succeededRun(), coverage: { axis: 'complete' }, freshness: { axis: 'fresh' } })
  );
  assert.equal(snap.state, 'healthy');
  assert.equal(snap.forward_disposition, 'complete');
});

// ─── owner_refresh_due: the manual-refresh seam, wired end to end ─────────────

test('complete coverage, manual-refresh stale -> idle headline + owner_refresh_due disposition', () => {
  // The seam: coverage stays complete, freshness stays stale, the headline is the
  // manual-stale `idle` advisory, and the disposition carries the owner-refresh
  // fact rather than collapsing to `complete` or claiming missing data.
  const snap = computeConnectionHealth(
    input({
      run: succeededRun(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: MANUAL_REFRESH,
    })
  );
  assert.equal(snap.axes.coverage, 'complete');
  assert.equal(snap.axes.freshness, 'stale');
  assert.equal(snap.state, 'idle');
  assert.equal(snap.forward_disposition, 'owner_refresh_due');
});

test('schedulable-stale is the scheduler\'s job, not owner_refresh_due', () => {
  const snap = computeConnectionHealth(
    input({
      run: succeededRun(),
      coverage: { axis: 'complete' },
      freshness: { axis: 'stale' },
      refresh: SCHEDULABLE_REFRESH,
    })
  );
  // A background-safe connection that goes stale degrades (the system was meant
  // to refresh it), and its disposition stays `complete` — staleness here is the
  // scheduler's responsibility, surfaced by the degraded headline, not an owner
  // refresh action.
  assert.equal(snap.forward_disposition, 'complete');
  assert.notEqual(snap.forward_disposition, 'owner_refresh_due');
});

// ─── resumable: a retryable gap, even when also stale ─────────────────────────

test('retryable_gap coverage -> resumable disposition (gapRetryable derived from axis)', () => {
  const snap = computeConnectionHealth(
    input({ run: succeededRun({ hasDegradingGaps: true }), coverage: { axis: 'retryable_gap' }, freshness: { axis: 'fresh' } })
  );
  assert.equal(snap.forward_disposition, 'resumable');
});

test('retryable_gap that is ALSO manual-refresh stale stays resumable (gap before freshness)', () => {
  const snap = computeConnectionHealth(
    input({
      run: succeededRun({ hasDegradingGaps: true }),
      coverage: { axis: 'retryable_gap' },
      freshness: { axis: 'stale' },
      refresh: MANUAL_REFRESH,
    })
  );
  // Staleness must not mask the recoverable gap: the disposition stays
  // `resumable`, not `owner_refresh_due`.
  assert.equal(snap.forward_disposition, 'resumable');
  assert.notEqual(snap.forward_disposition, 'owner_refresh_due');
});

// ─── awaiting_owner: gap blocked on open attention, consistent with headline ──

test('open attention + outstanding gap -> needs_attention headline AND awaiting_owner disposition', () => {
  // The consistency contract: when the headline is `needs_attention` because an
  // attention prompt is open, a stream with an outstanding gap is `awaiting_owner`
  // — the disposition reads attention from the SAME `AttentionClear` condition the
  // headline does, so the two never disagree.
  const snap = computeConnectionHealth(
    input({
      run: succeededRun({ latestStatus: 'failed', hasDegradingGaps: true }),
      coverage: { axis: 'retryable_gap' },
      freshness: { axis: 'fresh' },
      attention: {
        lifecycle: 'open',
        reasonCode: 'otp_required',
        actionTarget: 'dashboard',
        expiresAt: null,
        id: 'att-1',
        ownerAction: 'provide_value',
        responseContract: 'response_required',
      },
    })
  );
  assert.equal(snap.state, 'needs_attention');
  assert.equal(snap.forward_disposition, 'awaiting_owner');
});

test('expired attention is NOT open: disposition does not claim awaiting_owner', () => {
  // The `AttentionClear` condition treats an expired prompt as cleared, so the
  // disposition must agree — an expired prompt over a retryable gap is `resumable`,
  // not `awaiting_owner`.
  const snap = computeConnectionHealth(
    input({
      run: succeededRun({ hasDegradingGaps: true }),
      coverage: { axis: 'retryable_gap' },
      freshness: { axis: 'fresh' },
      attention: {
        lifecycle: 'open',
        reasonCode: 'otp_required',
        actionTarget: 'dashboard',
        expiresAt: '2026-05-19T11:00:00.000Z', // before observedAt NOW -> expired
      },
    })
  );
  assert.notEqual(snap.forward_disposition, 'awaiting_owner');
  assert.equal(snap.forward_disposition, 'resumable');
});

// ─── terminal ────────────────────────────────────────────────────────────────

test('terminal_gap coverage -> terminal disposition', () => {
  const snap = computeConnectionHealth(
    input({ run: succeededRun({ hasDegradingGaps: true }), coverage: { axis: 'terminal_gap' }, freshness: { axis: 'fresh' } })
  );
  assert.equal(snap.forward_disposition, 'terminal');
});

test('unsupported coverage -> terminal disposition', () => {
  const snap = computeConnectionHealth(
    input({ run: succeededRun(), coverage: { axis: 'unsupported' }, freshness: { axis: 'fresh' } })
  );
  assert.equal(snap.forward_disposition, 'terminal');
});

// ─── unknown denominator is checking, even when projection is healthy-ish ─────

test('absent coverage evidence -> unknown axis -> checking, never complete or retryable', () => {
  const snap = computeConnectionHealth(
    input({ run: succeededRun(), coverage: null, freshness: { axis: 'fresh' } })
  );
  assert.equal(snap.axes.coverage, 'unknown');
  assert.notEqual(snap.forward_disposition, 'complete');
  assert.notEqual(snap.forward_disposition, 'resumable');
  assert.equal(snap.forward_disposition, 'checking');
});

// ─── disposition is independent of an unreliable-projection headline ──────────

test('unreliable projection does not fabricate a complete disposition', () => {
  // The headline is forced to `unknown` by an unreliable read model, but the
  // disposition still reflects the coverage evidence honestly: unknown coverage
  // is `checking`, never `complete`.
  const snap = computeConnectionHealth(
    input({
      run: succeededRun(),
      coverage: { axis: 'unknown' },
      freshness: { axis: 'fresh' },
      projection: { unreliableSources: ['coverage_read_model'] },
    })
  );
  assert.equal(snap.state, 'unknown');
  assert.notEqual(snap.forward_disposition, 'complete');
  assert.equal(snap.forward_disposition, 'checking');
});
