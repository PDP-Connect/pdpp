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
// connector with an empty non-pressure recovery backlog (live: Amazon x2,
// Reddit, 12h schedule interval).
//
// REVISE (gate 2026-08-03): the first version of this fix measured elapsed
// time since LAST RUN (`runtime.lastRunTime`), which does not track when
// evidence actually became invalid. The gate proved this defeats the
// per-instance jitter for the case that matters most: any connection idle
// long enough (or a fleet-wide process restart re-evaluating every
// connector's `lastRunTime`-anchored eligibility on the identical tick)
// already has `elapsed` far past the whole ceiling+jitter band, so jitter —
// which only varies the ADMISSION THRESHOLD — never separates WHEN each
// instance actually admits; every affected instance in a cohort fires on
// the same tick. The fix is a durable, atomically-stamped
// `terminal_facts_invalidated_at` anchor (server/connector-summary-read-model.ts's
// `updateStreamFacts`/`markAllTerminalFactsFailed`, both SQLite and
// Postgres) that every same-cohort instance shares (a manifest bump
// invalidates every instance of one connector_id in one transaction), so
// the ceiling+jitter bound genuinely spreads admission regardless of how
// long `now - invalidatedAt` eventually grows.
//
// This suite drives `createDispatchGovernor(...).evaluateBackoffDispatch`
// directly (the same seam `dispatch-governor-recovery-first.test.ts` drives)
// to pin: (1) the new bounded reproof path admits an early tick when debt
// exists and no recovery backlog would otherwise trigger it, anchored on
// invalidation time; (2) it never fires earlier than genuinely due,
// measured from invalidation, NOT last-run; (3) it never overrides a
// `blocked` connection; (4) it costs nothing (no probe) once evidence heals;
// (5) a long-idle/restart-shaped cohort — the exact gate attack — still
// spreads admission rather than thundering-herding.

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_REPROOF_CEILING_MS, DEFAULT_REPROOF_JITTER_SPAN_MS } from "../runtime/recovery-decision.ts";
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
    getForwardEvidenceInvalidatedAtMs: overrides.getForwardEvidenceInvalidatedAtMs ?? (() => null),
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

test("manifest bump -> zero recovery backlog -> reproof admits well before the 12h schedule interval, measured from invalidation", async () => {
  const runtime = freshRuntime();
  // The connection's last completed run is ANCIENT (well before the
  // invalidation) — proving the bound is measured from invalidatedAtMs, not
  // from lastRunTime (which the pre-revise version incorrectly used).
  const now = TWELVE_HOURS_MS * 100;
  const invalidatedAtMs = now - (DEFAULT_CEILING_MS + 1);
  runtime.lastRunTime.set("amazon-reproof-connector", now - TWELVE_HOURS_MS * 50);

  const governor = makeGovernor({
    getForwardEvidenceDebt: () => true, // manifest-generation-transition staleness
    getForwardEvidenceInvalidatedAtMs: () => invalidatedAtMs,
    getNonPressureRecoverableCount: () => 0, // no pending detail gaps at all
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(result.eligible, true, "the bounded reproof run must dispatch, not wait for the 12h interval");
  assert.equal(result.recoveryOnly, false, "a reproof run is an ordinary forward attempt, not a recovery drain");
});

test("manifest bump -> zero recovery backlog -> reproof does NOT admit before its own ceiling elapses since invalidation", async () => {
  const runtime = freshRuntime();
  const now = TWELVE_HOURS_MS * 100;
  const invalidatedAtMs = now - 5 * 60 * 1000; // invalidated only 5 minutes ago
  runtime.lastRunTime.set("amazon-reproof-connector", now - (DEFAULT_CEILING_MS + 1)); // last run was well past the ceiling, but that's the WRONG anchor

  const governor = makeGovernor({
    getForwardEvidenceDebt: () => true,
    getForwardEvidenceInvalidatedAtMs: () => invalidatedAtMs,
    getNonPressureRecoverableCount: () => 0,
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(
    result.eligible,
    false,
    "5 minutes since INVALIDATION must not admit against the 30-minute ceiling, even though lastRunTime looks old"
  );
});

test("healthy connection (no forward-evidence debt) never probes the invalidation anchor when already ineligible, and never dispatches early", async () => {
  let debtProbeCalls = 0;
  let invalidatedAtProbeCalls = 0;
  const runtime = freshRuntime();
  const now = TWELVE_HOURS_MS * 100;
  runtime.lastRunTime.set("amazon-reproof-connector", now - (DEFAULT_CEILING_MS + 1));

  const governor = makeGovernor({
    getForwardEvidenceDebt: () => {
      debtProbeCalls += 1;
      return false; // evidence is current — no manifest-generation-transition gap
    },
    getForwardEvidenceInvalidatedAtMs: () => {
      invalidatedAtProbeCalls += 1;
      return null;
    },
    getNonPressureRecoverableCount: () => 0,
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(debtProbeCalls, 1, "debt is probed once the ceiling window is open (that's the whole point)");
  assert.equal(invalidatedAtProbeCalls, 0, "the invalidation-anchor probe is never consulted when debt is false");
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

  let debtProbeCalls = 0;
  const governor = makeGovernor({
    getForwardEvidenceDebt: () => {
      debtProbeCalls += 1;
      return true;
    },
    getForwardEvidenceInvalidatedAtMs: () => now - (DEFAULT_CEILING_MS + 1),
    getNonPressureRecoverableCount: () => 0,
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(result.eligible, false, "a blocked connection never auto-dispatches, reproof included");
  assert.equal(
    debtProbeCalls,
    0,
    "debt is never even probed once the connection is already blocked (fail-closed guard)"
  );
});

test("ordinary forward-walk already due -> reproof probes are skipped (no wasted read, no double-dispatch)", async () => {
  let debtProbeCalls = 0;
  let invalidatedAtProbeCalls = 0;
  const governor = makeGovernor({
    getForwardEvidenceDebt: () => {
      debtProbeCalls += 1;
      return true;
    },
    getForwardEvidenceInvalidatedAtMs: () => {
      invalidatedAtProbeCalls += 1;
      return 0;
    },
    getNonPressureRecoverableCount: () => 0,
  });

  // No lastRunTime set -> resolveLastRunEpochMs falls back to 0 -> ordinary
  // forward-walk is already due at any nonzero `now`.
  const result = await governor.evaluateBackoffDispatch(schedule(), TWELVE_HOURS_MS * 100);

  assert.equal(result.eligible, true, "ordinary forward-walk fires as normal");
  assert.equal(debtProbeCalls, 0, "reproof's own debt probe never fires when the tick is already eligible");
  assert.equal(invalidatedAtProbeCalls, 0, "the invalidation-anchor probe never fires either");
});

test("eligible non-pressure recovery backlog shares the SAME debt probe result as reproof (no double debt probe)", async () => {
  let debtProbeCalls = 0;
  const runtime = freshRuntime();
  const now = TWELVE_HOURS_MS * 100;
  runtime.lastRunTime.set("amazon-reproof-connector", now - (DEFAULT_CEILING_MS + 1));

  const governor = makeGovernor({
    getForwardEvidenceDebt: () => {
      debtProbeCalls += 1;
      return true;
    },
    getForwardEvidenceInvalidatedAtMs: () => now - (DEFAULT_CEILING_MS + 1),
    getNonPressureRecoverableCount: () => 10, // a small eligible non-pressure backlog
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(result.eligible, true);
  assert.equal(
    debtProbeCalls,
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

  let debtProbeCalls = 0;
  const governor = makeGovernor({
    getForwardEvidenceDebt: () => {
      debtProbeCalls += 1;
      return true;
    },
    getForwardEvidenceInvalidatedAtMs: () => now - (fiveMinuteIntervalMs + 1),
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
  assert.equal(
    debtProbeCalls,
    0,
    "reproof's debt probe is skipped when the tick is already eligible on its own cadence"
  );
});

test("getForwardEvidenceInvalidatedAtMs omitted -> defaults to null -> unconditional admit once debt+ceiling-window-open (never a silent forever-wait)", async () => {
  const runtime = freshRuntime();
  const now = TWELVE_HOURS_MS * 100;
  runtime.lastRunTime.set("amazon-reproof-connector", now - (DEFAULT_CEILING_MS + 1));

  // Deliberately do NOT provide getForwardEvidenceInvalidatedAtMs — a host
  // that has not wired the new probe yet must still admit (not silently
  // wait forever), per decideForwardEvidenceReproof's null-anchor contract.
  const governor = createDispatchGovernor({
    getForwardEvidenceDebt: () => true,
    getLastSuccessfulRunAt: () => null,
    getNonPressureRecoverableCount: () => 0,
    getSourcePressureGaps: () => [],
    // biome-ignore lint/suspicious/noEmptyBlockStatements: localized test assertion preserves its explicit contract.
    onHumanRequiredStateEscalation: () => {},
    reproofOptions: { jitterSpanMs: 0 },
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(result.eligible, true, "an unwired invalidation probe must not silently stall reproof forever");
});

// ── The exact gate-reproduced attack, driven through the real dispatch seam ──

test("gate-reproduced attack, FIXED: a 20-instance cohort sharing one invalidation moment spreads admission at the jitter-window midpoint, not all-at-once", async () => {
  const now = TWELVE_HOURS_MS * 100;
  const sharedInvalidatedAtMs = now - (DEFAULT_REPROOF_CEILING_MS + Math.floor(DEFAULT_REPROOF_JITTER_SPAN_MS / 2));
  const ids = Array.from({ length: 20 }, (_, i) => `cin_gate_cohort_${i}`);

  const results = await Promise.all(
    ids.map(async (id) => {
      const runtime = freshRuntime();
      // Every cohort member's lastRunTime is RECENT (ordinary forward-walk
      // is deliberately NOT due, isolating this test to the reproof path
      // alone) but WILDLY different per instance (simulating real fleet
      // history) — proving any observed spread comes from the SHARED
      // invalidation anchor's jitter, not from ordinary cadence or from a
      // last-run coincidence.
      runtime.lastRunTime.set(id, now - (60_000 + id.length * 137));
      const governor = makeGovernor({
        getForwardEvidenceDebt: () => true,
        getForwardEvidenceInvalidatedAtMs: () => sharedInvalidatedAtMs,
        getNonPressureRecoverableCount: () => 0,
        // Default jitterSpanMs (do NOT zero it here — the whole point is
        // testing the real per-instance jitter spread).
        reproofOptions: {},
        runtime,
      });
      const result = await governor.evaluateBackoffDispatch(
        schedule({ connectorId: id, connectorInstanceId: id }),
        now
      );
      return result.eligible;
    })
  );

  const admittedCount = results.filter(Boolean).length;
  assert.ok(
    admittedCount > 0 && admittedCount < ids.length,
    `expected a MIX of admitted/not-yet-admitted instances at the jitter-window midpoint through the REAL dispatch seam (got ${admittedCount}/${ids.length}) — a uniform 0 or ${ids.length} would reproduce the gate's thundering-herd defect`
  );
});
