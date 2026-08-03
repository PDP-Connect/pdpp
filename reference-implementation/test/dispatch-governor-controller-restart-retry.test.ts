// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Integration regression for the controller_restarted bounded-retry fix
// (fleet-transient-warning-convergence-0802, REVISE round).
//
// The pure-function unit test in scheduler-backoff.test.ts asserted only
// `nextRunAt` against a fast base interval, missing that
// `controllerRestartRetryDecision` hardcoded `effectiveIntervalMs` to
// CONTROLLER_RESTART_RETRY_MS (60s) regardless of which branch of the
// nextRunAt min() won. The dispatch governor's actual tick gate
// (`intervalElapsed = elapsed >= decision.effectiveIntervalMs`,
// dispatch-governor.ts) reads ONLY `effectiveIntervalMs` — never
// `nextRunAt` — so a sub-60s connector's restart-recovery tick silently
// waited the full 60s despite nextRunAt (and the "we'll try again" display
// copy) both promising the shorter base interval. This suite drives
// `createDispatchGovernor(...).evaluateBackoffDispatch` directly — the exact
// seam the scheduler interval loop calls every tick — to prove the real
// dispatch decision, not just the pure backoff computation, honors the
// shorter interval.

import assert from "node:assert/strict";
import test from "node:test";

import { createDispatchGovernor, type DispatchGovernorRuntimeState } from "../runtime/scheduler/dispatch-governor.ts";
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

function makeGovernor(runtime: DispatchGovernorRuntimeState) {
  return createDispatchGovernor({
    getForwardEvidenceDebt: () => false,
    getLastSuccessfulRunAt: () => null,
    getNonPressureRecoverableCount: () => 0,
    getSourcePressureGaps: () => [],
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    onHumanRequiredStateEscalation: () => {},
    runtime,
  });
}

const CONNECTOR_ID = "fast-poll-connector";
const CONNECTOR_INSTANCE_ID = "fast-poll-connector:default";
const FAST_INTERVAL_MS = 30_000; // sub-60s base interval — the exact shape that exposes the bug
const RESTART_AT_MS = 1_800_000_000_000; // arbitrary fixed epoch anchor

function schedule(overrides = {}) {
  return {
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    connectorPath: "/unused",
    intervalMs: FAST_INTERVAL_MS,
    manifest: {},
    ownerToken: "owner-token",
    ...overrides,
  };
}

function controllerRestartedRecord(): RunRecord {
  return {
    attempt: 1,
    checkpointSummary: null,
    completedAt: new Date(RESTART_AT_MS).toISOString(),
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    failureReason: "controller_restarted",
    knownGaps: [],
    recordsEmitted: 0,
    reportedRecordsEmitted: null,
    runId: null,
    source: { id: CONNECTOR_ID, kind: "connector" },
    startedAt: new Date(RESTART_AT_MS).toISOString(),
    status: "failed",
    terminalReason: null,
    traceId: null,
  };
}

function runtimeAfterRestart(): DispatchGovernorRuntimeState {
  const runtime = freshRuntime();
  runtime.history.push(controllerRestartedRecord());
  runtime.lastRunTime.set(CONNECTOR_INSTANCE_ID, RESTART_AT_MS);
  return runtime;
}

test("a sub-60s base-interval connector dispatches at its own shorter interval after a controller restart, not the full 60s bounded retry", async () => {
  const runtime = runtimeAfterRestart();
  const governor = makeGovernor(runtime);

  // 35s elapsed: past the 30s base interval, well short of the 60s bounded
  // retry. Pre-fix, effectiveIntervalMs was hardcoded to 60_000 regardless of
  // nextRunAt's min(), so intervalElapsed (35_000 >= 60_000) was false and
  // the governor withheld the tick here — a live behavioral regression
  // relative to both nextRunAt and the "we'll try again" display copy.
  const elapsedMs = 35_000;
  const result = await governor.evaluateBackoffDispatch(schedule(), RESTART_AT_MS + elapsedMs);

  assert.equal(
    result.decision.effectiveIntervalMs,
    FAST_INTERVAL_MS,
    "effectiveIntervalMs must equal the shorter base interval, not the 60s bounded-retry constant"
  );
  assert.equal(result.eligible, true, "the tick must dispatch once the shorter base interval has elapsed");
  assert.equal(result.decision.backoffApplied, false);
  assert.equal(result.decision.reasonClass, null);
});

test("a sub-60s base-interval connector does NOT dispatch before its own shorter interval has elapsed", async () => {
  const runtime = runtimeAfterRestart();
  const governor = makeGovernor(runtime);

  // 15s elapsed: short of even the 30s base interval.
  const elapsedMs = 15_000;
  const result = await governor.evaluateBackoffDispatch(schedule(), RESTART_AT_MS + elapsedMs);

  assert.equal(result.decision.effectiveIntervalMs, FAST_INTERVAL_MS);
  assert.equal(result.eligible, false, "the tick must not dispatch before the base interval elapses");
});

test("a connector whose base interval exceeds the bounded retry still caps at 60s, dispatch governor agrees", async () => {
  const longIntervalMs = 5_400_000; // 90 minutes, matching the live Slack schedule
  const runtime = runtimeAfterRestart();
  const governor = makeGovernor(runtime);

  // 61s elapsed: past the 60s bounded retry, nowhere near the 90-minute base interval.
  const elapsedMs = 61_000;
  const result = await governor.evaluateBackoffDispatch(
    schedule({ intervalMs: longIntervalMs }),
    RESTART_AT_MS + elapsedMs
  );

  assert.equal(
    result.decision.effectiveIntervalMs,
    60_000,
    "the bounded retry caps at 60s when it is the shorter value"
  );
  assert.equal(result.eligible, true, "the tick must dispatch once the bounded 60s retry has elapsed");
});
