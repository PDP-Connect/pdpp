import assert from 'node:assert/strict';
import test from 'node:test';

import { computeConnectionHealth, deriveSourcePressureBacklog } from '../runtime/connection-health.ts';

// Source-pressure detail-gap backlog rollup
// (`surface-source-pressure-detail-gap-backlog`). The rollup is additive,
// nullable, reason-scoped to source pressure, honest about absence (null vs 0)
// and about the read bound (a floor, never a silently-truncated exact total),
// and is pure annotation that never moves the headline projection.

const NOW = '2026-05-19T12:00:00.000Z';

/** A pending pressure gap in the cooldown governor's shape. */
function gap(overrides = {}) {
  return {
    reason: 'upstream_pressure',
    attemptCount: 0,
    nextAttemptAfter: null,
    ...overrides,
  };
}

/** Default healthy input: succeeded run, complete coverage, fresh. */
function healthyInput(overrides = {}) {
  return {
    schedule: { enabled: true },
    observedAt: NOW,
    run: {
      latestStatus: 'succeeded',
      hasDegradingGaps: false,
      lastSuccessAt: '2026-05-19T00:00:00.000Z',
      reasonCode: null,
    },
    backoff: null,
    attention: null,
    coverage: { axis: 'complete' },
    freshness: { axis: 'fresh' },
    outbox: null,
    projection: null,
    activity: null,
    ...overrides,
  };
}

// ─── deriveSourcePressureBacklog: pure helper ────────────────────────────────

test('backlog: null/absent evidence yields a null rollup', () => {
  assert.equal(deriveSourcePressureBacklog(null), null);
  assert.equal(deriveSourcePressureBacklog(undefined), null);
});

test('backlog: unreadable store yields null, not a fabricated zero', () => {
  const rollup = deriveSourcePressureBacklog({ pendingGaps: [], unreadable: true });
  assert.equal(rollup, null);
});

test('backlog: readable-but-drained is a real 0, distinct from null', () => {
  const rollup = deriveSourcePressureBacklog({ pendingGaps: [], unreadable: false });
  assert.notEqual(rollup, null);
  assert.equal(rollup.pending, 0);
  assert.equal(rollup.pending_is_floor, false);
  assert.equal(rollup.max_attempt_count, 0);
  assert.equal(rollup.next_attempt_at, null);
  assert.equal(rollup.recovered, null);
});

test('backlog: pending counts only source-pressure gaps', () => {
  const rollup = deriveSourcePressureBacklog({
    pendingGaps: [
      gap({ reason: 'upstream_pressure' }),
      gap({ reason: 'rate_limited' }),
      gap({ reason: 'temporary_unavailable' }),
      gap({ reason: 'not_found' }),
      gap({ reason: null }),
    ],
    unreadable: false,
  });
  assert.equal(rollup.pending, 2);
});

test('backlog: only non-source-pressure gaps reports 0 pending', () => {
  const rollup = deriveSourcePressureBacklog({
    pendingGaps: [gap({ reason: 'temporary_unavailable' }), gap({ reason: 'not_found' })],
    unreadable: false,
  });
  assert.equal(rollup.pending, 0);
});

test('backlog: max_attempt_count is the max across source-pressure gaps', () => {
  const rollup = deriveSourcePressureBacklog({
    pendingGaps: [
      gap({ attemptCount: 1 }),
      gap({ attemptCount: 4 }),
      gap({ attemptCount: 2 }),
      // non-pressure gap with a high attempt count must not contribute
      gap({ reason: 'not_found', attemptCount: 99 }),
    ],
    unreadable: false,
  });
  assert.equal(rollup.pending, 3);
  assert.equal(rollup.max_attempt_count, 4);
});

test('backlog: next_attempt_at is the latest gap-authored floor', () => {
  const rollup = deriveSourcePressureBacklog({
    pendingGaps: [
      gap({ nextAttemptAfter: '2026-05-19T13:00:00.000Z' }),
      gap({ nextAttemptAfter: '2026-05-19T15:30:00.000Z' }),
      gap({ nextAttemptAfter: null }),
    ],
    unreadable: false,
  });
  assert.equal(rollup.next_attempt_at, '2026-05-19T15:30:00.000Z');
});

test('backlog: next_attempt_at is null when no gap authored a floor', () => {
  const rollup = deriveSourcePressureBacklog({
    pendingGaps: [gap(), gap()],
    unreadable: false,
  });
  assert.equal(rollup.next_attempt_at, null);
});

test('backlog: pending is a floor when the bounded read hits its limit', () => {
  const pendingGaps = Array.from({ length: 100 }, () => gap());
  const rollup = deriveSourcePressureBacklog({ pendingGaps, readLimit: 100, unreadable: false });
  assert.equal(rollup.pending, 100);
  assert.equal(rollup.pending_is_floor, true);
});

test('backlog: pending can be a zero floor when a full mixed-reason page has no pressure gaps', () => {
  const pendingGaps = Array.from({ length: 100 }, () => gap({ reason: 'temporary_unavailable' }));
  const rollup = deriveSourcePressureBacklog({ pendingGaps, readLimit: 100, unreadable: false });
  assert.equal(rollup.pending, 0);
  assert.equal(rollup.pending_is_floor, true);
});

test('backlog: pending is exact when the read did not hit the bound', () => {
  const pendingGaps = Array.from({ length: 12 }, () => gap());
  const rollup = deriveSourcePressureBacklog({ pendingGaps, readLimit: 100, unreadable: false });
  assert.equal(rollup.pending, 12);
  assert.equal(rollup.pending_is_floor, false);
});

test('backlog: an empty backlog is never a floor even with a bound', () => {
  const rollup = deriveSourcePressureBacklog({ pendingGaps: [], readLimit: 100, unreadable: false });
  assert.equal(rollup.pending, 0);
  assert.equal(rollup.pending_is_floor, false);
});

test('backlog: pending is exact when no read bound is supplied', () => {
  const pendingGaps = Array.from({ length: 100 }, () => gap());
  const rollup = deriveSourcePressureBacklog({ pendingGaps, readLimit: null, unreadable: false });
  assert.equal(rollup.pending, 100);
  assert.equal(rollup.pending_is_floor, false);
});

test('backlog: recovered is null when not computed and passed through when present', () => {
  const drained = deriveSourcePressureBacklog({ pendingGaps: [gap()], unreadable: false });
  assert.equal(drained.recovered, null);

  const withRecovered = deriveSourcePressureBacklog({ pendingGaps: [gap()], recovered: 7, unreadable: false });
  assert.equal(withRecovered.recovered, 7);
});

test('backlog: pending is never inferred from record counts (no record input exists)', () => {
  // The helper has no access to collected record counts — its only numeric
  // input is the durable gap rows. This guards the contract by construction:
  // a connection with many records but no pending pressure gaps reports 0.
  const rollup = deriveSourcePressureBacklog({ pendingGaps: [], unreadable: false });
  assert.equal(rollup.pending, 0);
});

// ─── computeConnectionHealth: snapshot integration + decomplection ───────────

test('snapshot: exposes detail_gap_backlog derived from the evidence', () => {
  const snap = computeConnectionHealth(
    healthyInput({
      detailGapBacklog: {
        pendingGaps: [gap({ attemptCount: 3, nextAttemptAfter: '2026-05-19T14:00:00.000Z' })],
        readLimit: 100,
        unreadable: false,
      },
    })
  );
  assert.notEqual(snap.detail_gap_backlog, null);
  assert.equal(snap.detail_gap_backlog.pending, 1);
  assert.equal(snap.detail_gap_backlog.max_attempt_count, 3);
  assert.equal(snap.detail_gap_backlog.next_attempt_at, '2026-05-19T14:00:00.000Z');
  assert.equal(snap.detail_gap_backlog.recovered, null);
});

test('snapshot: detail_gap_backlog is null when no evidence is supplied', () => {
  const snap = computeConnectionHealth(healthyInput());
  assert.equal(snap.detail_gap_backlog, null);
});

test('snapshot: detail_gap_backlog is null when the gap store is unreadable', () => {
  const snap = computeConnectionHealth(
    healthyInput({ detailGapBacklog: { pendingGaps: [], unreadable: true } })
  );
  assert.equal(snap.detail_gap_backlog, null);
});

test('snapshot: backlog rollup does not move the headline projection', () => {
  const base = computeConnectionHealth(healthyInput());
  const withBacklog = computeConnectionHealth(
    healthyInput({
      detailGapBacklog: {
        pendingGaps: [gap({ attemptCount: 5 }), gap({ attemptCount: 2 })],
        readLimit: 100,
        unreadable: false,
      },
    })
  );
  // Headline + every axis + forward disposition + CTA are byte-identical: the
  // rollup is pure annotation and changes only `detail_gap_backlog`.
  assert.equal(withBacklog.state, base.state);
  assert.equal(withBacklog.state, 'healthy');
  assert.equal(withBacklog.reason_code, base.reason_code);
  assert.equal(withBacklog.forward_disposition, base.forward_disposition);
  assert.deepEqual(withBacklog.axes, base.axes);
  assert.equal(withBacklog.next_action, base.next_action);
  assert.equal(withBacklog.next_attempt_at, base.next_attempt_at);
  // The only difference is the additive rollup.
  assert.equal(base.detail_gap_backlog, null);
  assert.equal(withBacklog.detail_gap_backlog.pending, 2);
});

test('snapshot: a drained backlog (real 0) also leaves the headline untouched', () => {
  const base = computeConnectionHealth(healthyInput());
  const withDrained = computeConnectionHealth(
    healthyInput({ detailGapBacklog: { pendingGaps: [], unreadable: false } })
  );
  assert.equal(withDrained.state, base.state);
  assert.deepEqual(withDrained.axes, base.axes);
  assert.equal(withDrained.forward_disposition, base.forward_disposition);
  assert.notEqual(withDrained.detail_gap_backlog, null);
  assert.equal(withDrained.detail_gap_backlog.pending, 0);
});

test('snapshot: backlog carries only counts + an optional ISO timestamp (no secrets)', () => {
  const snap = computeConnectionHealth(
    healthyInput({
      detailGapBacklog: {
        pendingGaps: [gap({ attemptCount: 1, nextAttemptAfter: '2026-05-19T14:00:00.000Z' })],
        readLimit: 100,
        unreadable: false,
      },
    })
  );
  const rollup = snap.detail_gap_backlog;
  // Exactly the contract's fields, nothing else (no locator/payload/source).
  assert.deepEqual(Object.keys(rollup).sort(), [
    'max_attempt_count',
    'next_attempt_at',
    'pending',
    'pending_is_floor',
    'recovered',
  ]);
  assert.equal(typeof rollup.pending, 'number');
  assert.equal(typeof rollup.max_attempt_count, 'number');
  assert.equal(typeof rollup.pending_is_floor, 'boolean');
  assert.ok(rollup.next_attempt_at === null || typeof rollup.next_attempt_at === 'string');
  assert.ok(rollup.recovered === null || typeof rollup.recovered === 'number');
});

test('snapshot: manual-refresh connector still exposes the backlog', () => {
  // A manual/background-unsafe connector never arms a scheduler cooldown, so
  // its connection-level next_attempt_at stays null — but the backlog rollup
  // and its own next-attempt floor are still exposed.
  const snap = computeConnectionHealth(
    healthyInput({
      refresh: { backgroundSafe: false, recommendedMode: 'manual' },
      backoff: null,
      detailGapBacklog: {
        pendingGaps: [gap({ attemptCount: 2, nextAttemptAfter: '2026-05-19T16:00:00.000Z' })],
        readLimit: 100,
        unreadable: false,
      },
    })
  );
  assert.equal(snap.next_attempt_at, null);
  assert.notEqual(snap.detail_gap_backlog, null);
  assert.equal(snap.detail_gap_backlog.pending, 1);
  assert.equal(snap.detail_gap_backlog.next_attempt_at, '2026-05-19T16:00:00.000Z');
});
