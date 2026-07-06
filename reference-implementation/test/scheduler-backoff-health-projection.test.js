/**
 * Unit coverage for two scheduler-backoff read-model behaviors that
 * `scheduler-backoff.test.js` does NOT pin:
 *
 *   1. `isCounterResetStatus(status)` — the boolean projection that says whether
 *      a run status clears sticky back-off state. Only `"succeeded"` resets;
 *      `"failed"` and `"skipped"` do not. (Zero by-name coverage today.)
 *
 *   2. The `recommendedHealthState` field of `computeNextRunWithBackoff` — the
 *      dashboard-pill projection derived from the failure streak. The existing
 *      suite asserts back-off timing exhaustively but only ever checks
 *      `recommendedHealthState === null` (the no-back-off baseline). It never
 *      pins the engaged states:
 *        - streak over the back-off threshold but below
 *          BLOCKED_PROMOTION_THRESHOLD (7) => "cooling_off";
 *        - streak at/above BLOCKED_PROMOTION_THRESHOLD => "blocked" (scheduler
 *          should stop auto-dispatching entirely).
 *
 * This module is pure (no I/O). No DB, no server, no fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeNextRunWithBackoff,
  isCounterResetStatus,
} from '../runtime/scheduler-backoff.ts';
import { BLOCKED_PROMOTION_THRESHOLD } from '../runtime/connection-health-policy.ts';

// Build a `failed` RunRecord carrying a stable reason class so a streak groups.
function failedRun(overrides = {}) {
  return {
    attempt: 1,
    checkpointSummary: null,
    completedAt: '2026-07-01T00:00:00.000Z',
    connectorId: 'chatgpt',
    knownGaps: [],
    recordsEmitted: 0,
    source: 'schedule',
    startedAt: '2026-07-01T00:00:00.000Z',
    status: 'failed',
    terminalReason: 'authentication_error',
    ...overrides,
  };
}

function streakOf(n) {
  return Array.from({ length: n }, () => failedRun());
}

const BASE_INTERVAL_MS = 60_000;
const LAST_RUN_AT_MS = Date.parse('2026-07-01T00:00:00.000Z');

// --- isCounterResetStatus ---------------------------------------------------

test('isCounterResetStatus: only "succeeded" resets the back-off counter', () => {
  assert.equal(isCounterResetStatus('succeeded'), true, 'succeeded resets');
  assert.equal(isCounterResetStatus('failed'), false, 'failed does not reset');
  assert.equal(isCounterResetStatus('skipped'), false, 'skipped does not reset');
});

// --- computeNextRunWithBackoff recommendedHealthState projection ------------

test('sanity: BLOCKED_PROMOTION_THRESHOLD is 7 (the promotion boundary under test)', () => {
  assert.equal(BLOCKED_PROMOTION_THRESHOLD, 7);
});

test('recommendedHealthState: an engaged streak below the blocked threshold reports "cooling_off"', () => {
  // 3 failures = threshold; back-off engaged; 3 < 7 => cooling_off.
  const decision = computeNextRunWithBackoff(streakOf(3), BASE_INTERVAL_MS, LAST_RUN_AT_MS);
  assert.equal(decision.backoffApplied, true, 'precondition: back-off engaged');
  assert.equal(decision.recommendedHealthState, 'cooling_off', `state: ${decision.recommendedHealthState}`);
});

test('recommendedHealthState: streak one below the blocked threshold is still "cooling_off"', () => {
  const decision = computeNextRunWithBackoff(
    streakOf(BLOCKED_PROMOTION_THRESHOLD - 1),
    BASE_INTERVAL_MS,
    LAST_RUN_AT_MS,
  );
  assert.equal(decision.consecutiveFailures, BLOCKED_PROMOTION_THRESHOLD - 1);
  assert.equal(decision.recommendedHealthState, 'cooling_off', `state: ${decision.recommendedHealthState}`);
});

test('recommendedHealthState: streak AT the blocked threshold promotes to "blocked"', () => {
  const decision = computeNextRunWithBackoff(
    streakOf(BLOCKED_PROMOTION_THRESHOLD),
    BASE_INTERVAL_MS,
    LAST_RUN_AT_MS,
  );
  assert.equal(decision.consecutiveFailures, BLOCKED_PROMOTION_THRESHOLD);
  assert.equal(decision.recommendedHealthState, 'blocked', `state: ${decision.recommendedHealthState}`);
});

test('recommendedHealthState: streak above the blocked threshold stays "blocked"', () => {
  const decision = computeNextRunWithBackoff(
    streakOf(BLOCKED_PROMOTION_THRESHOLD + 3),
    BASE_INTERVAL_MS,
    LAST_RUN_AT_MS,
  );
  assert.equal(decision.recommendedHealthState, 'blocked', `state: ${decision.recommendedHealthState}`);
});

test('recommendedHealthState: no back-off (below threshold) reports null, not cooling_off', () => {
  // 2 failures, default threshold 3 => not engaged => null.
  const decision = computeNextRunWithBackoff(streakOf(2), BASE_INTERVAL_MS, LAST_RUN_AT_MS);
  assert.equal(decision.backoffApplied, false, 'precondition: not engaged');
  assert.equal(decision.recommendedHealthState, null, `state: ${decision.recommendedHealthState}`);
});

test('recommendedHealthState: manual bypass reports null even with a blocked-length streak', () => {
  const decision = computeNextRunWithBackoff(
    streakOf(BLOCKED_PROMOTION_THRESHOLD + 5),
    BASE_INTERVAL_MS,
    LAST_RUN_AT_MS,
    { manual: true },
  );
  assert.equal(decision.backoffApplied, false, 'manual bypasses back-off');
  assert.equal(decision.recommendedHealthState, null, 'manual bypass has no health recommendation');
});
