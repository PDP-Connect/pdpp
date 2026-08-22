// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A server restart must not push the next run out by a full interval.
 *
 *   BUG: `newestHistoryEpochMs` (dispatch-governor.ts) walked run history and
 *   took the newest `completedAt` with NO status or reason filter. When a
 *   restart kills an in-flight run, reconciliation writes a terminal row whose
 *   `completedAt` is "now" — so that row became the schedule anchor and the
 *   connection waited a fresh full interval from the moment of the restart.
 *
 *   A source killed 11 hours into a 12-hour cycle therefore waited another 12
 *   hours. The restart did not merely lose the in-flight run; it then DELAYED
 *   the recovery run by an entire interval. That is why sources stayed stale
 *   long after a deploy.
 *
 *   Production scale (`run_history`): 45 restart-ended runs since 2026-08-15
 *   (28 `controller_terminated_before_run_finished` + 17 `controller_restarted`).
 *
 * FIX: skip restart-ended runs when computing that fallback anchor. They
 * observed nothing — the process died holding the run — so they are not
 * evidence that "we just ran".
 *
 * WHY THIS KEYS ON THE TERMINAL REASON, NOT THE STATUS. The two restart
 * reasons are stored with DIFFERENT statuses, verified against production:
 * `controller_terminated_before_run_finished` is `status='abandoned'` (28
 * rows) while `controller_restarted` is `status='failed'` (17 rows). A
 * status-only filter would silently miss the second — and would also be
 * dangerously broad, since ordinary failures MUST keep anchoring so back-off
 * works. The third test below is the guard for exactly that.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createDispatchGovernor,
  type DispatchGovernorDeps,
  type DispatchGovernorRuntimeState,
} from "../runtime/scheduler/dispatch-governor.ts";
import type { RunRecord, TerminalReason } from "../runtime/scheduler-domain-types.ts";

const CONNECTOR_ID = "slack-restart-anchor-connector";
const INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h, the production schedule shape
const NOW = 1_760_000_000_000;

function freshRuntime(): DispatchGovernorRuntimeState {
  return {
    announcedBackoffClass: new Map(),
    announcedBlockedClass: new Map(),
    history: [],
    lastRunTime: new Map(),
    notifiedCooldownIdentity: new Map(),
  };
}

function makeGovernor(runtime: DispatchGovernorRuntimeState, overrides: Partial<DispatchGovernorDeps> = {}) {
  return createDispatchGovernor({
    getForwardEvidenceDebt: overrides.getForwardEvidenceDebt ?? (() => false),
    getLastSuccessfulRunAt: overrides.getLastSuccessfulRunAt ?? (() => null),
    getNonPressureRecoverableCount: overrides.getNonPressureRecoverableCount ?? (() => 0),
    getSourcePressureGaps: overrides.getSourcePressureGaps ?? (() => []),
    // biome-ignore lint/suspicious/noEmptyBlockStatements: this suite asserts on dispatch eligibility, not escalation.
    onHumanRequiredStateEscalation: overrides.onHumanRequiredStateEscalation ?? (() => {}),
    runtime,
  });
}

function schedule(overrides = {}) {
  return {
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_ID,
    connectorPath: "/unused",
    intervalMs: INTERVAL_MS,
    manifest: {},
    ownerSubjectId: "owner_local",
    ownerToken: "owner-token",
    ...overrides,
  };
}

function runRecord(overrides: Partial<RunRecord> & { completedAt: string }): RunRecord {
  return {
    attempt: 1,
    checkpointSummary: null,
    connectorError: null,
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_ID,
    failureReason: null,
    knownGaps: [],
    recordsEmitted: 0,
    reportedRecordsEmitted: null,
    runId: null,
    source: { id: CONNECTOR_ID, kind: "connector" },
    startedAt: overrides.completedAt,
    status: "succeeded",
    terminalReason: null,
    traceId: null,
    ...overrides,
  };
}

/**
 * The production shape: a source that last really ran 11 hours ago (1 hour
 * short of its 12h interval), whose in-flight run was then killed by a restart
 * moments ago. `lastRunTime` is deliberately EMPTY — a run killed mid-flight
 * never reaches `persistLastRunTime` (run-executor.ts writes it only when a
 * run completes and records history), so the history fallback is the live path
 * for exactly this scenario.
 */
function historyElevenHoursInWithRestartKill(restartTerminalReason: TerminalReason, restartStatus: RunRecord["status"]) {
  return [
    runRecord({
      completedAt: new Date(NOW - 11 * 60 * 60 * 1000).toISOString(),
      status: "succeeded",
    }),
    runRecord({
      completedAt: new Date(NOW - 1000).toISOString(),
      failureReason: restartTerminalReason,
      status: restartStatus,
      terminalReason: restartTerminalReason,
    }),
  ];
}

// ─── (1) `abandoned` restart kill must not reset the clock ──────────────────

test("a controller_terminated_before_run_finished run does not push the next run out a full interval", async () => {
  const runtime = freshRuntime();
  runtime.history.push(
    ...historyElevenHoursInWithRestartKill("controller_terminated_before_run_finished", "abandoned")
  );
  const governor = makeGovernor(runtime);

  const result = await governor.evaluateBackoffDispatch(schedule(), NOW + 60 * 60 * 1000);

  // 11h + 1h = 12h since the last run that actually ran, so the connection is
  // due. Anchoring on the restart row instead would leave it ~11h short.
  assert.equal(
    result.eligible,
    true,
    "a restart-killed run observed nothing; it must not count as 'we just ran' and delay recovery by a full interval"
  );
});

// ─── (2) the `failed`-status restart reason is covered too ──────────────────

test("a controller_restarted run does not reset the anchor either, despite its failed status", async () => {
  const runtime = freshRuntime();
  runtime.history.push(...historyElevenHoursInWithRestartKill("controller_restarted", "failed"));
  const governor = makeGovernor(runtime);

  const result = await governor.evaluateBackoffDispatch(schedule(), NOW + 60 * 60 * 1000);

  assert.equal(
    result.eligible,
    true,
    "controller_restarted is stored with status='failed' (17 production rows) — a status-only filter would miss it"
  );
});

// ─── (3) THE GUARD: an ordinary failure must still anchor ───────────────────

test("an ordinary connector failure still anchors the schedule, so back-off is not weakened", async () => {
  const runtime = freshRuntime();
  runtime.history.push(
    runRecord({
      completedAt: new Date(NOW - 11 * 60 * 60 * 1000).toISOString(),
      status: "succeeded",
    }),
    // A real failure a second ago: the provider WAS contacted and it failed.
    // This must keep anchoring, or a failing connector becomes a hot retry
    // loop — strictly worse than the staleness this change set out to fix.
    runRecord({
      completedAt: new Date(NOW - 1000).toISOString(),
      failureReason: "connector_reported_failed",
      status: "failed",
      terminalReason: "connector_reported_failed",
    })
  );
  const governor = makeGovernor(runtime);

  const result = await governor.evaluateBackoffDispatch(schedule(), NOW + 60 * 60 * 1000);

  assert.equal(
    result.eligible,
    false,
    "a genuine failure one second ago must still hold the schedule; only restart-ended runs are excluded"
  );
});
