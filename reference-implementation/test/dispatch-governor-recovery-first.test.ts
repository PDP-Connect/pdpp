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

import assert from "node:assert/strict";
import test from "node:test";

import {
  createDispatchGovernor,
  type DispatchGovernorDeps,
  type DispatchGovernorRuntimeState,
} from "../runtime/scheduler/dispatch-governor.ts";
import type { RunRecord } from "../runtime/scheduler-domain-types.ts";

function freshRuntime(): DispatchGovernorRuntimeState {
  return {
    announcedBackoffClass: new Map(),
    announcedBlockedClass: new Map(),
    history: [],
    lastRunTime: new Map(),
    notifiedCooldownIdentity: new Map(),
  };
}

function makeGovernor(overrides: Partial<DispatchGovernorDeps> = {}) {
  const runtime = overrides.runtime ?? freshRuntime();
  return createDispatchGovernor({
    getForwardEvidenceDebt: overrides.getForwardEvidenceDebt ?? (() => false),
    getLastSuccessfulRunAt: overrides.getLastSuccessfulRunAt ?? (() => null),
    getNonPressureRecoverableCount: overrides.getNonPressureRecoverableCount ?? (() => 0),
    getSourcePressureGaps: overrides.getSourcePressureGaps ?? (() => []),
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    onHumanRequiredStateEscalation: overrides.onHumanRequiredStateEscalation ?? (() => {}),
    runtime,
  });
}

function schedule(overrides = {}) {
  return {
    connectorId: "gmail-recovery-first-connector",
    connectorInstanceId: "gmail-recovery-first-connector",
    connectorPath: "/unused",
    intervalMs: 60_000,
    manifest: {},
    ownerSubjectId: "owner_local",
    ownerToken: "owner-token",
    ...overrides,
  };
}

// A schedule whose ordinary forward-walk is DUE: no history at all (no
// failure streak, no cooldown), and `now` is far past the interval anchor —
// `lastRunTime` unset means `resolveLastRunEpochMs` falls back to 0, so
// `elapsed = now - 0 = now`, comfortably beyond both the interval and the
// recovery cadence.
const DUE_NOW = 10 * 60 * 60 * 1000; // 10h "since epoch" in test time

test("due forward-walk + eligible non-pressure recovery gaps -> recoveryOnly wins the tick", async () => {
  const governor = makeGovernor({
    getNonPressureRecoverableCount: () => 10_264, // the live Gmail backlog
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), DUE_NOW);

  assert.equal(result.eligible, true, "the tick still dispatches");
  assert.equal(
    result.recoveryOnly,
    true,
    "existing bounded recovery must win over fresh forward-walk work when both are due — THE FIX"
  );
});

test("due forward-walk + zero recoverable gaps -> normal forward-walk dispatch (recoveryOnly=false)", async () => {
  const governor = makeGovernor({
    getNonPressureRecoverableCount: () => 0,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), DUE_NOW);

  assert.equal(result.eligible, true, "ordinary forward-walk is still due and dispatches");
  assert.equal(result.recoveryOnly, false, "no recovery backlog -> normal forward collection, not recovery-only");
});

test("blocked connector -> no recovery launch even with a large eligible recovery backlog", async () => {
  const now = DUE_NOW;
  // BLOCKED_PROMOTION_THRESHOLD is 7 consecutive same-class failures by
  // default (connection-health-policy.ts); seed a streak past it so
  // `recommendedHealthState === "blocked"`.
  const connectorId = "gmail-recovery-first-connector";
  const failedHistory: RunRecord[] = Array.from({ length: 8 }, (_, i) => ({
    attempt: 1,
    checkpointSummary: null,
    completedAt: new Date(now - (8 - i) * 1000).toISOString(),
    connectorError: null,
    connectorId,
    connectorInstanceId: connectorId,
    error: "connector_reported_failed",
    failureReason: null,
    knownGaps: [],
    recordsEmitted: 0,
    reportedRecordsEmitted: null,
    runId: null,
    source: { id: connectorId, kind: "connector" },
    startedAt: new Date(now - (8 - i) * 1000 - 1000).toISOString(),
    status: "failed",
    terminalReason: "connector_reported_failed",
    traceId: null,
  }));
  const runtime = freshRuntime();
  runtime.history.push(...failedHistory);
  runtime.lastRunTime.set(connectorId, now - (8 - 8) * 1000 || now - 1000);

  const governor = makeGovernor({
    getNonPressureRecoverableCount: () => 10_264,
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(result.eligible, false, "a blocked connector never auto-dispatches, even for recovery");
  assert.equal(result.recoveryOnly, false, "blocked overrides recoveryOnly to false unconditionally");
});

test("pressure-only backlog (zero non-pressure recoverable) preserves normal cooldown semantics", async () => {
  const now = DUE_NOW;
  const runtime = freshRuntime();
  // Anchor the last run recently so the base interval has NOT elapsed,
  // isolating this case to the source-pressure cooldown path (mirrors
  // scheduler-cooldown-recovery-eligibility.test.js's cooldown-still-defers
  // control case, but driven directly against the governor).
  runtime.lastRunTime.set("gmail-recovery-first-connector", now - 200);

  const governor = makeGovernor({
    getNonPressureRecoverableCount: () => 0,
    getSourcePressureGaps: () => [
      {
        attemptCount: 6,
        lastPressureAt: new Date(now).toISOString(),
        nextAttemptAfter: null,
        reason: "upstream_pressure",
      },
    ],
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule({ intervalMs: 50 }), now);

  assert.equal(result.eligible, false, "pressure cooldown still defers the whole dispatch with no non-pressure work");
  assert.equal(result.recoveryOnly, false);
  assert.ok(
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    /source_pressure_cooldown_applied/.test(result.skipToEmit?.error ?? ""),
    "the cooldown still emits its normal cooling-off skip record"
  );
});

test("recovery cadence not elapsed -> no premature recovery launch", async () => {
  const now = 1000; // small `now` relative to lastRunTime below
  const runtime = freshRuntime();
  // Anchor lastRunTime just a moment before `now` so `elapsed` is tiny —
  // well under both the forward-walk interval AND the recovery cadence
  // (one base schedule interval).
  runtime.lastRunTime.set("gmail-recovery-first-connector", now - 10);

  const governor = makeGovernor({
    getNonPressureRecoverableCount: () => 10_264,
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule({ intervalMs: 60_000 }), now);

  assert.equal(result.eligible, false, "neither forward-walk nor recovery cadence has elapsed yet");
  assert.equal(result.recoveryOnly, false, "recovery must not launch before its own cadence elapses");
});

test("recovery cadence elapsed but forward-walk interval not yet elapsed (legacy !eligible branch) still recovers", async () => {
  // Regression guard: the pre-existing `!eligible && recoveryCadenceElapsed`
  // path (recovery covers for a not-yet-due forward walk, e.g. a stale
  // failure-backoff streak inflating `effectiveIntervalMs`) must keep working
  // after widening the condition to `recoveryCadenceElapsed` unconditionally.
  // `recoveryCadenceElapsed` compares against the RAW base `scheduleIntervalMs`
  // (not the back-off-inflated `effectiveIntervalMs`), so a failure streak that
  // inflates the forward-walk interval without changing the base interval
  // reproduces "recovery cadence elapsed, forward-walk not yet due".
  const connectorId = "gmail-recovery-first-connector";
  const lastFailAt = 1_000_000;
  const failedHistory: RunRecord[] = Array.from({ length: 6 }, (_, i) => ({
    attempt: 1,
    checkpointSummary: null,
    completedAt: new Date(lastFailAt - (6 - i) * 1000).toISOString(),
    connectorError: null,
    connectorId,
    connectorInstanceId: connectorId,
    error: "connector_reported_failed",
    failureReason: null,
    knownGaps: [],
    recordsEmitted: 0,
    reportedRecordsEmitted: null,
    runId: null,
    source: { id: connectorId, kind: "connector" },
    startedAt: new Date(lastFailAt - (6 - i) * 1000 - 1000).toISOString(),
    status: "failed",
    terminalReason: "connector_reported_failed",
    traceId: null,
  }));
  const runtime = freshRuntime();
  runtime.history.push(...failedHistory);
  runtime.lastRunTime.set(connectorId, lastFailAt);

  const governor = makeGovernor({
    getNonPressureRecoverableCount: () => 10_264,
    runtime,
  });

  // Base interval 50ms; 6 consecutive same-class failures inflate the
  // failure-backoff `effectiveIntervalMs` (2^(6-3) = 8x => 400ms) far beyond
  // the recovery cadence (one base interval = 50ms). `now` sits past the
  // recovery cadence (50ms elapsed) but short of the inflated backoff window
  // (400ms elapsed) — forward-walk is not yet due, recovery cadence is.
  const now = lastFailAt + 60;
  const result = await governor.evaluateBackoffDispatch(schedule({ intervalMs: 50 }), now);

  assert.equal(result.eligible, true, "recovery-only launch still fires when only the recovery cadence has elapsed");
  assert.equal(result.recoveryOnly, true);
});

// ── Forward-evidence-debt bound (fix-pre-provenance-terminal-generation-semantics) ──
//
// Recovery-first has no forward bound on its own: live evidence showed a
// connection's last fact-carrying forward run was 5+ days and ~640 runs ago,
// with recovery-only winning every tick since. These cases drive the
// governor's own `getForwardEvidenceDebt` probe directly (mirroring how the
// other probes above are driven) to prove N consecutive recovery-only ticks
// with aged/missing terminal evidence eventually yield to one forward
// dispatch, and that dispatch resumes recovery-first once fresh evidence lands.

test("N consecutive recovery-only ticks (fresh evidence) followed by evidence aging into debt, then healing after a forward dispatch", async () => {
  // Simulates the self-healing loop end to end: while evidence stays fresh,
  // recovery-first wins every tick (no starvation risk yet). Once evidence
  // ages into debt, the very next tick diverts to forward collection instead
  // of extending the streak further. That one forward dispatch is modeled as
  // minting fresh evidence (debt flips back to false), so the tick right
  // after it resumes recovery-first — proving the bound self-heals in both
  // directions with no manual intervention.
  let debt = false;
  const governor = makeGovernor({
    getForwardEvidenceDebt: () => debt,
    getNonPressureRecoverableCount: () => 10_264,
  });

  for (let i = 0; i < 3; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: localized test assertion preserves its explicit contract.
    const result = await governor.evaluateBackoffDispatch(schedule(), DUE_NOW + i);
    assert.equal(result.eligible, true, `tick ${i}: still dispatches`);
    assert.equal(result.recoveryOnly, true, `tick ${i}: recovery-only wins while evidence is fresh`);
  }

  // Evidence ages past FORWARD_EVIDENCE_MAX_AGE with no forward run having
  // occurred in the interim (recovery-only ticks mint no forward facts).
  debt = true;
  const forwardTick = await governor.evaluateBackoffDispatch(schedule(), DUE_NOW + 100);
  assert.equal(forwardTick.eligible, true, "the tick still dispatches");
  assert.equal(forwardTick.recoveryOnly, false, "debt diverts this tick to forward collection");

  // That forward run mints fresh, current-generation terminal evidence.
  debt = false;
  const healedTick = await governor.evaluateBackoffDispatch(schedule(), DUE_NOW + 200);
  assert.equal(healedTick.eligible, true);
  assert.equal(healedTick.recoveryOnly, true, "fresh evidence -> recovery-first resumes on the very next tick");
});

test("aged terminal evidence with an eligible recovery backlog diverts one tick to forward collection", async () => {
  const governor = makeGovernor({
    getForwardEvidenceDebt: () => true, // forward evidence is missing/historical/aged
    getNonPressureRecoverableCount: () => 10_264, // large eligible non-pressure backlog
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), DUE_NOW);

  assert.equal(result.eligible, true, "the tick still dispatches");
  assert.equal(
    result.recoveryOnly,
    false,
    "forward-evidence debt bounds the otherwise-unbounded recovery-first default — forward collection wins this tick"
  );
});

test("recovery-first resumes once forward evidence is no longer in debt", async () => {
  const governor = makeGovernor({
    getForwardEvidenceDebt: () => false, // fresh, current terminal evidence
    getNonPressureRecoverableCount: () => 10_264,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), DUE_NOW);

  assert.equal(result.eligible, true);
  assert.equal(result.recoveryOnly, true, "no debt -> recovery-first wins the tick exactly as before this change");
});

test("the forward-evidence-debt probe is only consulted when non-pressure recovery is otherwise eligible", async () => {
  let probeCalls = 0;
  const governor = makeGovernor({
    getForwardEvidenceDebt: () => {
      probeCalls += 1;
      return true;
    },
    getNonPressureRecoverableCount: () => 0, // no recovery backlog at all
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), DUE_NOW);

  assert.equal(result.recoveryOnly, false, "no recovery backlog -> ordinary forward-walk regardless of debt");
  assert.equal(
    probeCalls,
    0,
    "the debt probe is skipped entirely when recovery is not otherwise eligible (no wasted read)"
  );
});

test("a forward-evidence-debt probe failure fails closed to false (no debt) and preserves recovery-first", async () => {
  const governor = makeGovernor({
    getForwardEvidenceDebt: () => {
      throw new Error("evidence read unavailable");
    },
    getNonPressureRecoverableCount: () => 10_264,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), DUE_NOW);

  assert.equal(result.eligible, true);
  assert.equal(
    result.recoveryOnly,
    true,
    "a probe failure must not divert every failing tick to forward collection — fail closed to no debt"
  );
});

// ── P1-B regression: debt must never make a tick dispatch NOTHING ───────────
//
// Fable review (2026-07-21, PART 2 §3): debt only suppressed the recovery-only
// branch; `eligible` stayed `intervalElapsed && !cooldownDefers`. When the
// recovery cadence had elapsed but the failure-backoff-inflated forward-walk
// interval had not — the exact live deadlock shape the surviving
// "recovery cadence elapsed but forward-walk interval not yet elapsed" test
// above documents — a debt-true tick dispatched NEITHER recovery NOR forward:
// `{"probeCalls":1,"eligible":false,"recoveryOnly":false}`. Lifted directly
// from the review's own repro (`~/.tmp/fable-review-repro-governor-donothing.mjs`).
// Debt may only PREFER forward when forward is otherwise eligible; it must
// never veto recovery's own independent cadence and leave the tick dispatching
// nothing.
test("debt=true + failure-backoff-inflated interval (forward not otherwise eligible) -> recovery-only proceeds, never a do-nothing tick", async () => {
  const connectorId = "gmail-recovery-first-connector";
  const lastFailAt = 10 * 60 * 60 * 1000;
  const failedHistory: RunRecord[] = Array.from({ length: 6 }, (_, i) => ({
    attempt: 1,
    checkpointSummary: null,
    completedAt: new Date(lastFailAt - (6 - i) * 1000).toISOString(),
    connectorError: null,
    connectorId,
    connectorInstanceId: connectorId,
    error: "connector_reported_failed",
    failureReason: null,
    knownGaps: [],
    recordsEmitted: 0,
    reportedRecordsEmitted: null,
    runId: null,
    source: { id: connectorId, kind: "connector" },
    startedAt: new Date(lastFailAt - (6 - i) * 1000 - 1000).toISOString(),
    status: "failed",
    terminalReason: "connector_reported_failed",
    traceId: null,
  }));
  const runtime = freshRuntime();
  runtime.history.push(...failedHistory);
  runtime.lastRunTime.set(connectorId, lastFailAt);

  let probeCalls = 0;
  const governor = makeGovernor({
    getForwardEvidenceDebt: () => {
      probeCalls += 1;
      return true; // aged/missing forward evidence
    },
    getNonPressureRecoverableCount: () => 10_264, // large eligible backlog
    runtime,
  });

  // Base interval 50ms; 6 consecutive same-class failures inflate the
  // failure-backoff `effectiveIntervalMs` to ~400ms. `now` sits past the
  // recovery cadence (50ms elapsed) but short of the inflated backoff window
  // (400ms elapsed) — forward-walk is NOT otherwise eligible, recovery
  // cadence IS.
  const now = lastFailAt + 60;
  const result = await governor.evaluateBackoffDispatch(schedule({ intervalMs: 50 }), now);

  assert.equal(probeCalls, 1, "the debt probe is still consulted (recovery is otherwise eligible)");
  assert.equal(result.eligible, true, "the tick MUST dispatch something — debt can never produce a do-nothing tick");
  assert.equal(
    result.recoveryOnly,
    true,
    "forward is not otherwise eligible (backoff-inflated interval), so debt falls back to recovery-only on its own independent cadence"
  );
});

test("debt=true + forward otherwise eligible still selects forward (existing behavior unaffected by the P1-B fallback)", async () => {
  const governor = makeGovernor({
    getForwardEvidenceDebt: () => true,
    getNonPressureRecoverableCount: () => 10_264,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), DUE_NOW);

  assert.equal(result.eligible, true);
  assert.equal(
    result.recoveryOnly,
    false,
    "forward-walk is due (DUE_NOW) and no backoff/cooldown gates it, so debt correctly selects forward collection"
  );
});
