// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Bounded forward-evidence reproof governor (fix-uat-manifest-reproof-governor).
//
// Live evidence: a connector manifest-generation bump (persistManifestAndAdvanceGenerations,
// server/auth.ts) durably clears `connector_summary_evidence.terminal_facts_state`
// to non-`current` for every instance of that connector_id until each
// instance's OWN next successful run stamps the new generation
// (connector-summary-read-model.ts's `foldTerminalEventFacts`). The audit
// (scripts/stream-health-audit) correctly reports `runtime_evidence_missing`
// during this gap — fail-closed evidence semantics are intentional and must
// be preserved. But before this fix, nothing closed the gap PROMPTLY for a
// connector with an empty non-pressure recovery backlog: `evaluateBackoffDispatch`
// only ever consulted `hasForwardEvidenceDebt` inside the
// `recoveryCadenceElapsed && nonPressureRecoveryEligible` branch, so a
// connection with zero pending detail gaps (live: Amazon x2, Reddit) stayed
// `runtime_evidence_missing` until its OWN ordinary schedule interval elapsed
// — up to 12h.
//
// This suite drives `createDispatchGovernor(...).evaluateBackoffDispatch`
// directly (the same seam `dispatch-governor-recovery-first.test.ts` drives)
// to pin: (1) the new bounded reproof path admits an early tick when debt
// exists and no recovery backlog would otherwise trigger it, (2) it never
// fires earlier than genuinely due, (3) it never overrides a `blocked`
// connection, and (4) it costs nothing (no probe) once evidence heals.

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
    reproofOptions: overrides.reproofOptions ?? { jitterSpanMs: 0 },
    runtime,
  });
}

function schedule(overrides = {}) {
  return {
    connectorId: "amazon-reproof-connector",
    connectorInstanceId: "amazon-reproof-connector",
    connectorPath: "/unused",
    intervalMs: 12 * 60 * 60 * 1000, // the live 12h Amazon/Reddit cadence
    manifest: {},
    ownerToken: "owner-token",
    ...overrides,
  };
}

const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const DEFAULT_CEILING_MS = 30 * 60 * 1000;

test("manifest bump -> zero recovery backlog -> reproof admits well before the 12h schedule interval", async () => {
  const runtime = freshRuntime();
  // Anchor the last run recently enough that ordinary forward-walk is NOT
  // due, but past the reproof ceiling — reproducing "just bumped, long
  // interval, nothing else would fire for hours".
  const now = TWELVE_HOURS_MS * 100;
  runtime.lastRunTime.set("amazon-reproof-connector", now - (DEFAULT_CEILING_MS + 1));

  const governor = makeGovernor({
    getForwardEvidenceDebt: () => true, // manifest-generation-transition staleness
    getNonPressureRecoverableCount: () => 0, // no pending detail gaps at all
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(result.eligible, true, "the bounded reproof run must dispatch, not wait for the 12h interval");
  assert.equal(result.recoveryOnly, false, "a reproof run is an ordinary forward attempt, not a recovery drain");
});

test("manifest bump -> zero recovery backlog -> reproof does NOT admit before its own ceiling elapses", async () => {
  const runtime = freshRuntime();
  const now = TWELVE_HOURS_MS * 100;
  runtime.lastRunTime.set("amazon-reproof-connector", now - 5 * 60 * 1000); // only 5 minutes elapsed

  const governor = makeGovernor({
    getForwardEvidenceDebt: () => true,
    getNonPressureRecoverableCount: () => 0,
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(result.eligible, false, "5 minutes elapsed must not admit against the 30-minute ceiling");
});

test("healthy connection (no forward-evidence debt) never probes debt when already ineligible, and never dispatches early", async () => {
  let probeCalls = 0;
  const runtime = freshRuntime();
  const now = TWELVE_HOURS_MS * 100;
  runtime.lastRunTime.set("amazon-reproof-connector", now - (DEFAULT_CEILING_MS + 1));

  const governor = makeGovernor({
    getForwardEvidenceDebt: () => {
      probeCalls += 1;
      return false; // evidence is current — no manifest-generation-transition gap
    },
    getNonPressureRecoverableCount: () => 0,
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(probeCalls, 1, "debt is probed once the ceiling window is open (that's the whole point)");
  assert.equal(result.eligible, false, "no debt -> no early dispatch, ordinary 12h cadence still governs");
});

test("blocked connection is never admitted early by reproof, even with debt and an elapsed ceiling", async () => {
  const connectorId = "amazon-reproof-connector";
  const now = TWELVE_HOURS_MS * 100;
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
  runtime.lastRunTime.set(connectorId, now - (DEFAULT_CEILING_MS + 1));

  let probeCalls = 0;
  const governor = makeGovernor({
    getForwardEvidenceDebt: () => {
      probeCalls += 1;
      return true;
    },
    getNonPressureRecoverableCount: () => 0,
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(result.eligible, false, "a blocked connection never auto-dispatches, reproof included");
  assert.equal(probeCalls, 0, "debt is never even probed once the connection is already blocked (fail-closed guard)");
});

test("ordinary forward-walk already due -> reproof probe is skipped (no wasted read, no double-dispatch)", async () => {
  let probeCalls = 0;
  const governor = makeGovernor({
    getForwardEvidenceDebt: () => {
      probeCalls += 1;
      return true;
    },
    getNonPressureRecoverableCount: () => 0,
  });

  // No lastRunTime set -> resolveLastRunEpochMs falls back to 0 -> ordinary
  // forward-walk is already due at any nonzero `now`.
  const result = await governor.evaluateBackoffDispatch(schedule(), TWELVE_HOURS_MS * 100);

  assert.equal(result.eligible, true, "ordinary forward-walk fires as normal");
  assert.equal(probeCalls, 0, "reproof's own debt probe never fires when the tick is already eligible");
});

test("eligible non-pressure recovery backlog shares the SAME debt probe result as reproof (no double probe)", async () => {
  let probeCalls = 0;
  const runtime = freshRuntime();
  const now = TWELVE_HOURS_MS * 100;
  runtime.lastRunTime.set("amazon-reproof-connector", now - (DEFAULT_CEILING_MS + 1));

  const governor = makeGovernor({
    getForwardEvidenceDebt: () => {
      probeCalls += 1;
      return true;
    },
    getNonPressureRecoverableCount: () => 10, // a small eligible non-pressure backlog
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(result.eligible, true);
  assert.equal(
    probeCalls,
    1,
    "the debt probe is memoized per tick — the recovery-only branch's own probe answers reproof's question too"
  );
  assert.equal(result.recoveryOnly, false, "debt still bounds recovery-first the same as before this change");
});

test("connector with a short schedule interval is unaffected: reproof ceiling never widens an already-fast cadence", async () => {
  const runtime = freshRuntime();
  const fiveMinuteIntervalMs = 5 * 60 * 1000;
  const now = 10 * 60 * 60 * 1000;
  // Ordinary forward-walk is already due at this elapsed time for a 5m
  // interval connector -- confirms reproof does not need to intervene, and
  // is never consulted, for a connector whose own cadence is already tight.
  runtime.lastRunTime.set("fast-connector", now - (fiveMinuteIntervalMs + 1));

  let probeCalls = 0;
  const governor = makeGovernor({
    getForwardEvidenceDebt: () => {
      probeCalls += 1;
      return true;
    },
    getNonPressureRecoverableCount: () => 0,
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(
    schedule({
      connectorId: "fast-connector",
      connectorInstanceId: "fast-connector",
      intervalMs: fiveMinuteIntervalMs,
    }),
    now
  );

  assert.equal(result.eligible, true, "ordinary forward-walk already covers a fast-cadence connector");
  assert.equal(probeCalls, 0, "reproof's debt probe is skipped when the tick is already eligible on its own cadence");
});
