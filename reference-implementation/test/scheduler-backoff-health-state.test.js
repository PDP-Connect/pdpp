/**
 * Mutation-killing coverage for two branches of `runtime/scheduler-backoff.ts`
 * that the existing `scheduler-backoff.test.js` leaves unpinned:
 *
 *   1. `recommendedHealthState` — the existing suite only ever asserts it is
 *      `null` (no back-off) or reads `effectiveIntervalMs`. The
 *      `cooling_off` value and, critically, its promotion to `blocked` at the
 *      `BLOCKED_PROMOTION_THRESHOLD` (7) boundary are never asserted. A mutant
 *      that swaps the two strings, or flips `>=` to `>` / `<`, would survive.
 *
 *   2. `isCounterResetStatus` — an exported helper with zero direct coverage.
 *
 * This is back-off *timing/health* math only — no grant/scope enforcement is
 * exercised or changed (the `terminal:grant_revoked` reason string is only
 * ever compared as an opaque class label, never acted on here).
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { BLOCKED_PROMOTION_THRESHOLD } from '../runtime/connection-health-policy.ts';
import {
  computeNextRunWithBackoff,
  isCounterResetStatus,
} from '../runtime/scheduler-backoff.ts';

const BASE_INTERVAL_MS = 60_000;
const T0 = Date.parse('2026-05-16T00:00:00.000Z');

function failedRun() {
  return {
    status: 'failed',
    terminalReason: 'authentication_error',
    completedAt: '2026-05-16T00:00:00.000Z',
  };
}

function streak(n) {
  return Array.from({ length: n }, failedRun);
}

// ─── recommendedHealthState: cooling_off vs blocked ──────────────────────

test('recommendedHealthState is cooling_off just over the back-off threshold', () => {
  // 3 same-class failures = default threshold; back-off engages but is not
  // yet blocked.
  const decision = computeNextRunWithBackoff(streak(3), BASE_INTERVAL_MS, T0);
  assert.equal(decision.backoffApplied, true);
  assert.equal(decision.recommendedHealthState, 'cooling_off');
});

test('recommendedHealthState stays cooling_off one below the blocked promotion threshold', () => {
  const decision = computeNextRunWithBackoff(
    streak(BLOCKED_PROMOTION_THRESHOLD - 1),
    BASE_INTERVAL_MS,
    T0,
  );
  assert.equal(decision.consecutiveFailures, BLOCKED_PROMOTION_THRESHOLD - 1);
  assert.equal(decision.recommendedHealthState, 'cooling_off');
});

test('recommendedHealthState promotes to blocked exactly at the promotion threshold', () => {
  const decision = computeNextRunWithBackoff(
    streak(BLOCKED_PROMOTION_THRESHOLD),
    BASE_INTERVAL_MS,
    T0,
  );
  assert.equal(decision.consecutiveFailures, BLOCKED_PROMOTION_THRESHOLD);
  assert.equal(decision.backoffApplied, true);
  assert.equal(decision.recommendedHealthState, 'blocked');
});

test('recommendedHealthState stays blocked above the promotion threshold', () => {
  const decision = computeNextRunWithBackoff(
    streak(BLOCKED_PROMOTION_THRESHOLD + 3),
    BASE_INTERVAL_MS,
    T0,
  );
  assert.equal(decision.recommendedHealthState, 'blocked');
});

test('recommendedHealthState is null when no back-off is engaged', () => {
  const decision = computeNextRunWithBackoff(streak(2), BASE_INTERVAL_MS, T0);
  assert.equal(decision.backoffApplied, false);
  assert.equal(decision.recommendedHealthState, null);
});

test('recommendedHealthState is null for a manual bypass even with a deep streak', () => {
  const decision = computeNextRunWithBackoff(
    streak(BLOCKED_PROMOTION_THRESHOLD + 5),
    BASE_INTERVAL_MS,
    T0,
    { manual: true },
  );
  assert.equal(decision.backoffApplied, false);
  assert.equal(decision.recommendedHealthState, null);
});

// ─── isCounterResetStatus ────────────────────────────────────────────────

test('isCounterResetStatus is true only for a succeeded run', () => {
  assert.equal(isCounterResetStatus('succeeded'), true);
});

test('isCounterResetStatus is false for non-success statuses', () => {
  assert.equal(isCounterResetStatus('failed'), false);
  assert.equal(isCounterResetStatus('skipped'), false);
  assert.equal(isCounterResetStatus('running'), false);
});
