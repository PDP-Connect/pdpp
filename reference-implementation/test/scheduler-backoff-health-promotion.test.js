// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeNextRunWithBackoff } from '../runtime/scheduler-backoff.ts';

// Mutation-killing complement for the back-off decision's HEALTH-STATE
// projection — the `recommendedHealthState` axis the scheduler surfaces to the
// dashboard pill. The existing suite exhaustively covers the interval curve, the
// caps, and the cross-path recovery, but only asserts recommendedHealthState in
// the null (no-back-off) case. This file pins the cooling_off → blocked
// promotion at BLOCKED_PROMOTION_THRESHOLD (7) and its exact boundary, plus that
// the interval keeps growing (via the maxExp clamp) while the state flips.
//
// A same-class failure streak is built purely from RunRecord fixtures — no DB.

const BASE = 60_000; // 1 minute
const T = '2026-05-15T00:00:00.000Z';

/** N consecutive same-class failed records (oldest→newest). */
function streak(n) {
  return Array.from({ length: n }, () => ({
    connectorId: 'c',
    source: { kind: 'connector', id: 'c' },
    status: 'failed',
    recordsEmitted: 0,
    reportedRecordsEmitted: null,
    checkpointSummary: null,
    knownGaps: [],
    runId: null,
    traceId: null,
    failureReason: null,
    terminalReason: 'authentication_error', // same class across the streak
    connectorError: null,
    startedAt: T,
    completedAt: T,
    attempt: 1,
  }));
}

function decide(n, options = {}) {
  return computeNextRunWithBackoff(streak(n), BASE, 0, options);
}

test('under threshold (3): no back-off, health state is null', () => {
  const r = decide(2);
  assert.equal(r.backoffApplied, false);
  assert.equal(r.recommendedHealthState, null);
});

test('at and just over threshold: back-off engages as cooling_off (not blocked yet)', () => {
  // 3 (== threshold) → first back-off, cooling_off.
  const three = decide(3);
  assert.equal(three.backoffApplied, true);
  assert.equal(three.recommendedHealthState, 'cooling_off');

  // 6 failures is still below the blocked promotion threshold of 7.
  const six = decide(6);
  assert.equal(six.recommendedHealthState, 'cooling_off', '6 consecutive failures is still cooling_off');
});

test('promotion boundary: 7 consecutive failures flips cooling_off → blocked', () => {
  const six = decide(6);
  const seven = decide(7);
  assert.equal(six.recommendedHealthState, 'cooling_off', 'one below the threshold stays cooling_off');
  assert.equal(seven.recommendedHealthState, 'blocked', 'crossing BLOCKED_PROMOTION_THRESHOLD promotes to blocked');
  // Both are still backing off; promotion changes the STATE, not whether back-off applies.
  assert.equal(seven.backoffApplied, true);
  assert.equal(seven.consecutiveFailures, 7);
});

test('deep streaks stay blocked and the interval is clamped by maxBackoffExp/maxBackoffMs', () => {
  // 20 failures: exponent = min(20-3, maxExp=8) = 8 → 2^8 * 60s = 256 min, under
  // the 24h cap. State stays blocked; the interval does not overflow past the cap.
  const deep = decide(20);
  assert.equal(deep.recommendedHealthState, 'blocked');
  assert.equal(deep.consecutiveFailures, 20);
  assert.equal(deep.effectiveIntervalMs, BASE * 2 ** 8, 'exponent clamped at maxBackoffExp=8');

  // With an explicit low maxBackoffExp, the interval clamps sooner but the
  // blocked state is unchanged (state is driven by the streak, not the exponent).
  const clamped = decide(20, { maxBackoffExp: 2 });
  assert.equal(clamped.effectiveIntervalMs, BASE * 2 ** 2, 'exponent clamped at the supplied maxBackoffExp');
  assert.equal(clamped.recommendedHealthState, 'blocked', 'health state is not affected by the exponent clamp');
});

test('a manual bypass drops the health state even in a blocked-depth streak', () => {
  const r = decide(10, { manual: true });
  assert.equal(r.backoffApplied, false);
  assert.equal(r.recommendedHealthState, null, 'manual run-now is never blocked/cooling_off');
  assert.equal(r.consecutiveFailures, 0);
});

test('a cross-path success clears blocked back to null even at blocked depth', () => {
  // 10 failures would be blocked, but a genuine success at/after the newest
  // failure breaks the streak → no back-off, null health state.
  const successAtMs = Date.parse(T); // == newest failure time → breaks streak
  const r = computeNextRunWithBackoff(streak(10), BASE, 0, { lastSuccessAtMs: successAtMs });
  assert.equal(r.backoffApplied, false);
  assert.equal(r.recommendedHealthState, null);
  assert.equal(r.consecutiveFailures, 0);
});
