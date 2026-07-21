// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Recovery-first governor fix.
//
// Live evidence: Gmail cin_12407c1afb78d56848fe0b20 has 10,264 non-pressure
// pending attachment gaps. A due manual/ordinary run claimed 256, then
// entered forward-walk (Fetching new messages/Deriving threads) and made no
// bounded-recovery progress for 5+ minutes, because `evaluateBackoffDispatch`
// only checked for eligible non-pressure recovery work inside the `!eligible`
// branch: when ordinary forward-walk was ALREADY due (`eligible === true`),
// the non-pressure recovery probe was never even called, so existing bounded
// recovery work never won the tick over fresh forward-walk work.
//
// This suite drives `createDispatchGovernor(...).evaluateBackoffDispatch`
// directly — the exact seam the scheduler interval loop calls every tick —
// so each case pins the eligible/recoveryOnly decision without needing a full
// connector process or scheduler timer harness.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDispatchGovernor } from '../runtime/scheduler/dispatch-governor.ts';

function freshRuntime() {
  return {
    announcedBackoffClass: new Map(),
    announcedBlockedClass: new Map(),
    history: [],
    lastRunTime: new Map(),
    notifiedCooldownIdentity: new Map(),
  };
}

function makeGovernor(overrides = {}) {
  const runtime = overrides.runtime ?? freshRuntime();
  return createDispatchGovernor({
    getLastSuccessfulRunAt: overrides.getLastSuccessfulRunAt ?? (() => null),
    getNonPressureRecoverableCount: overrides.getNonPressureRecoverableCount ?? (() => 0),
    getSourcePressureGaps: overrides.getSourcePressureGaps ?? (() => []),
    onHumanRequiredStateEscalation: overrides.onHumanRequiredStateEscalation ?? (() => {}),
    runtime,
  });
}

function schedule(overrides = {}) {
  return {
    connectorId: 'gmail-recovery-first-connector',
    connectorInstanceId: 'gmail-recovery-first-connector',
    connectorPath: '/unused',
    intervalMs: 60_000,
    ownerToken: 'owner-token',
    manifest: {},
    ...overrides,
  };
}

// A schedule whose ordinary forward-walk is DUE: no history at all (no
// failure streak, no cooldown), and `now` is far past the interval anchor —
// `lastRunTime` unset means `resolveLastRunEpochMs` falls back to 0, so
// `elapsed = now - 0 = now`, comfortably beyond both the interval and the
// recovery cadence.
const DUE_NOW = 10 * 60 * 60 * 1000; // 10h "since epoch" in test time

test('due forward-walk + eligible non-pressure recovery gaps -> recoveryOnly wins the tick', async () => {
  const governor = makeGovernor({
    getNonPressureRecoverableCount: () => 10_264, // the live Gmail backlog
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), DUE_NOW);

  assert.equal(result.eligible, true, 'the tick still dispatches');
  assert.equal(
    result.recoveryOnly,
    true,
    'existing bounded recovery must win over fresh forward-walk work when both are due — THE FIX',
  );
});

test('due forward-walk + zero recoverable gaps -> normal forward-walk dispatch (recoveryOnly=false)', async () => {
  const governor = makeGovernor({
    getNonPressureRecoverableCount: () => 0,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), DUE_NOW);

  assert.equal(result.eligible, true, 'ordinary forward-walk is still due and dispatches');
  assert.equal(result.recoveryOnly, false, 'no recovery backlog -> normal forward collection, not recovery-only');
});

test('blocked connector -> no recovery launch even with a large eligible recovery backlog', async () => {
  const now = DUE_NOW;
  // BLOCKED_PROMOTION_THRESHOLD is 7 consecutive same-class failures by
  // default (connection-health-policy.ts); seed a streak past it so
  // `recommendedHealthState === "blocked"`.
  const connectorId = 'gmail-recovery-first-connector';
  const failedHistory = Array.from({ length: 8 }, (_, i) => ({
    connectorId,
    connectorInstanceId: connectorId,
    source: { kind: 'connector', id: connectorId },
    status: 'failed',
    terminalReason: 'connector_reported_failed',
    failureReason: null,
    connectorError: null,
    error: 'connector_reported_failed',
    recordsEmitted: 0,
    reportedRecordsEmitted: null,
    checkpointSummary: null,
    knownGaps: [],
    runId: null,
    traceId: null,
    startedAt: new Date(now - (8 - i) * 1000 - 1000).toISOString(),
    completedAt: new Date(now - (8 - i) * 1000).toISOString(),
    attempt: 1,
  }));
  const runtime = freshRuntime();
  runtime.history.push(...failedHistory);
  runtime.lastRunTime.set(connectorId, now - (8 - 8) * 1000 || now - 1000);

  const governor = makeGovernor({
    runtime,
    getNonPressureRecoverableCount: () => 10_264,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(result.eligible, false, 'a blocked connector never auto-dispatches, even for recovery');
  assert.equal(result.recoveryOnly, false, 'blocked overrides recoveryOnly to false unconditionally');
});

test('pressure-only backlog (zero non-pressure recoverable) preserves normal cooldown semantics', async () => {
  const now = DUE_NOW;
  const runtime = freshRuntime();
  // Anchor the last run recently so the base interval has NOT elapsed,
  // isolating this case to the source-pressure cooldown path (mirrors
  // scheduler-cooldown-recovery-eligibility.test.js's cooldown-still-defers
  // control case, but driven directly against the governor).
  runtime.lastRunTime.set('gmail-recovery-first-connector', now - 200);

  const governor = makeGovernor({
    runtime,
    getSourcePressureGaps: () => [
      { reason: 'upstream_pressure', attemptCount: 6, nextAttemptAfter: null, lastPressureAt: new Date(now).toISOString() },
    ],
    getNonPressureRecoverableCount: () => 0,
  });

  const result = await governor.evaluateBackoffDispatch(schedule({ intervalMs: 50 }), now);

  assert.equal(result.eligible, false, 'pressure cooldown still defers the whole dispatch with no non-pressure work');
  assert.equal(result.recoveryOnly, false);
  assert.ok(
    /source_pressure_cooldown_applied/.test(result.skipToEmit?.error ?? ''),
    'the cooldown still emits its normal cooling-off skip record',
  );
});

test('recovery cadence not elapsed -> no premature recovery launch', async () => {
  const now = 1_000; // small `now` relative to lastRunTime below
  const runtime = freshRuntime();
  // Anchor lastRunTime just a moment before `now` so `elapsed` is tiny —
  // well under both the forward-walk interval AND the recovery cadence
  // (one base schedule interval).
  runtime.lastRunTime.set('gmail-recovery-first-connector', now - 10);

  const governor = makeGovernor({
    runtime,
    getNonPressureRecoverableCount: () => 10_264,
  });

  const result = await governor.evaluateBackoffDispatch(schedule({ intervalMs: 60_000 }), now);

  assert.equal(result.eligible, false, 'neither forward-walk nor recovery cadence has elapsed yet');
  assert.equal(result.recoveryOnly, false, 'recovery must not launch before its own cadence elapses');
});

test('recovery cadence elapsed but forward-walk interval not yet elapsed (legacy !eligible branch) still recovers', async () => {
  // Regression guard: the pre-existing `!eligible && recoveryCadenceElapsed`
  // path (recovery covers for a not-yet-due forward walk, e.g. a stale
  // failure-backoff streak inflating `effectiveIntervalMs`) must keep working
  // after widening the condition to `recoveryCadenceElapsed` unconditionally.
  // `recoveryCadenceElapsed` compares against the RAW base `scheduleIntervalMs`
  // (not the back-off-inflated `effectiveIntervalMs`), so a failure streak that
  // inflates the forward-walk interval without changing the base interval
  // reproduces "recovery cadence elapsed, forward-walk not yet due".
  const connectorId = 'gmail-recovery-first-connector';
  const lastFailAt = 1_000_000;
  const failedHistory = Array.from({ length: 6 }, (_, i) => ({
    connectorId,
    connectorInstanceId: connectorId,
    source: { kind: 'connector', id: connectorId },
    status: 'failed',
    terminalReason: 'connector_reported_failed',
    failureReason: null,
    connectorError: null,
    error: 'connector_reported_failed',
    recordsEmitted: 0,
    reportedRecordsEmitted: null,
    checkpointSummary: null,
    knownGaps: [],
    runId: null,
    traceId: null,
    startedAt: new Date(lastFailAt - (6 - i) * 1000 - 1000).toISOString(),
    completedAt: new Date(lastFailAt - (6 - i) * 1000).toISOString(),
    attempt: 1,
  }));
  const runtime = freshRuntime();
  runtime.history.push(...failedHistory);
  runtime.lastRunTime.set(connectorId, lastFailAt);

  const governor = makeGovernor({
    runtime,
    getNonPressureRecoverableCount: () => 10_264,
  });

  // Base interval 50ms; 6 consecutive same-class failures inflate the
  // failure-backoff `effectiveIntervalMs` (2^(6-3) = 8x => 400ms) far beyond
  // the recovery cadence (one base interval = 50ms). `now` sits past the
  // recovery cadence (50ms elapsed) but short of the inflated backoff window
  // (400ms elapsed) — forward-walk is not yet due, recovery cadence is.
  const now = lastFailAt + 60;
  const result = await governor.evaluateBackoffDispatch(schedule({ intervalMs: 50 }), now);

  assert.equal(result.eligible, true, 'recovery-only launch still fires when only the recovery cadence has elapsed');
  assert.equal(result.recoveryOnly, true);
});
