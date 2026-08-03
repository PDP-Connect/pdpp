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
// REVISE 1 (gate 2026-08-03): the first version of this fix measured elapsed
// time since LAST RUN (`runtime.lastRunTime`), which does not track when
// evidence actually became invalid. The gate proved this defeats the
// per-instance jitter for the case that matters most: any connection idle
// long enough (or a fleet-wide process restart re-evaluating every
// connector's `lastRunTime`-anchored eligibility on the identical tick)
// already has `elapsed` far past the whole ceiling+jitter band, so jitter —
// which only varies the ADMISSION THRESHOLD — never separates WHEN each
// instance actually admits. Fixed by anchoring on the durable, atomically-
// stamped `terminal_facts_invalidated_at` column instead.
//
// REVISE 2 (second gate, 2026-08-03): the REVISE-1 fix's `invalidatedAtMs
// === null` branch unconditionally admitted (no ceiling, no jitter) — and
// this branch is reachable by TWO realistic, independently-correlated
// fleet-wide mechanisms neither exercised at cohort scale by the REVISE-1
// suite: (a) `hasForwardEvidenceDebt`'s OTHER debt branch (a `current`-state
// row with a stale/missing per-stream fact map) NEVER gets an anchor
// stamped at all — the state never leaves `current` — and that debt class
// is itself fleet-correlated via the shared periodic fold sweep; (b) the new
// anchor probe itself fails closed to `null` on ANY error, and a single
// shared failure mode (DB blip, pool exhaustion) hits every concurrent probe
// call at once. Both routes reproduced the SAME all-at-once thundering-herd
// shape the whole fix exists to prevent, just via a different route than
// REVISE-1's original defect.
//
// This REVISE 2 closure: (1) `invalidatedAtMs === null` now `admit: false`
// — it only skips THIS tick's early-reproof optimization, never the
// connection's ordinary scheduled cadence; (2) reproof consultation is
// scoped STRICTLY to `isManifestGenerationInvalidatedDebt`
// (`terminal_facts.state !== "current"`) via a new `inScope` flag on the
// anchor probe's result — the `current`-state-stale-fact-map debt class
// never enters this path at all, closing route (a); (3) a bounded,
// backend-neutral `backfillTerminalFactsInvalidatedAt` repair
// (connector-summary-read-model.ts) gives EVERY existing non-current
// legacy row (not just newly-invalidated ones) a durable anchor on its
// next probe, so the null-anchor state is transient, not permanent, for
// the in-scope class; (4)/(5) below.
//
// This suite drives `createDispatchGovernor(...).evaluateBackoffDispatch`
// directly (the same seam `dispatch-governor-recovery-first.test.ts` drives).

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_REPROOF_CEILING_MS, DEFAULT_REPROOF_JITTER_SPAN_MS } from "../runtime/recovery-decision.ts";
import {
  createDispatchGovernor,
  type DispatchGovernorDeps,
  type DispatchGovernorRuntimeState,
} from "../runtime/scheduler/dispatch-governor.ts";
import type { ForwardEvidenceInvalidationProbeResult, RunRecord } from "../runtime/scheduler-domain-types.ts";

function freshRuntime(): DispatchGovernorRuntimeState {
  return {
    announcedBackoffClass: new Map(),
    announcedBlockedClass: new Map(),
    history: [],
    lastRunTime: new Map(),
    notifiedCooldownIdentity: new Map(),
  };
}

function notInScope(): ForwardEvidenceInvalidationProbeResult {
  return { inScope: false, invalidatedAtMs: null };
}

function anchored(invalidatedAtMs: number | null): ForwardEvidenceInvalidationProbeResult {
  return { inScope: true, invalidatedAtMs };
}

function makeGovernor(overrides: Partial<DispatchGovernorDeps> = {}) {
  const runtime = overrides.runtime ?? freshRuntime();
  return createDispatchGovernor({
    getForwardEvidenceDebt: overrides.getForwardEvidenceDebt ?? (() => false),
    getForwardEvidenceInvalidatedAtMs: overrides.getForwardEvidenceInvalidatedAtMs ?? (() => notInScope()),
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

test("manifest bump -> zero recovery backlog, in scope, anchored -> reproof admits well before the 12h schedule interval", async () => {
  const runtime = freshRuntime();
  // The connection's last completed run is ANCIENT (well before the
  // invalidation) — proving the bound is measured from invalidatedAtMs, not
  // from lastRunTime (which the REVISE-1 predecessor incorrectly used).
  const now = TWELVE_HOURS_MS * 100;
  const invalidatedAtMs = now - (DEFAULT_CEILING_MS + 1);
  runtime.lastRunTime.set("amazon-reproof-connector", now - TWELVE_HOURS_MS * 50);

  const governor = makeGovernor({
    getForwardEvidenceDebt: () => true, // manifest-generation-transition staleness
    getForwardEvidenceInvalidatedAtMs: () => anchored(invalidatedAtMs),
    getNonPressureRecoverableCount: () => 0, // no pending detail gaps at all
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(result.eligible, true, "the bounded reproof run must dispatch, not wait for the 12h interval");
  assert.equal(result.recoveryOnly, false, "a reproof run is an ordinary forward attempt, not a recovery drain");
});

test("manifest bump, in scope, anchored -> reproof does NOT admit before its own ceiling elapses since invalidation", async () => {
  const runtime = freshRuntime();
  const now = TWELVE_HOURS_MS * 100;
  const invalidatedAtMs = now - 5 * 60 * 1000; // invalidated only 5 minutes ago
  runtime.lastRunTime.set("amazon-reproof-connector", now - (DEFAULT_CEILING_MS + 1)); // last run was well past the ceiling, but that's the WRONG anchor

  const governor = makeGovernor({
    getForwardEvidenceDebt: () => true,
    getForwardEvidenceInvalidatedAtMs: () => anchored(invalidatedAtMs),
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

test("in scope but invalidatedAtMs=null (not yet backfilled) -> does NOT admit; ordinary cadence untouched", async () => {
  const runtime = freshRuntime();
  const now = TWELVE_HOURS_MS * 100;
  runtime.lastRunTime.set("amazon-reproof-connector", now - (DEFAULT_CEILING_MS + 1));

  const governor = makeGovernor({
    getForwardEvidenceDebt: () => true,
    getForwardEvidenceInvalidatedAtMs: () => anchored(null),
    getNonPressureRecoverableCount: () => 0,
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(
    result.eligible,
    false,
    "REVISE 2: a null anchor must never admit unconditionally — it only skips this tick's early-reproof optimization"
  );
});

test("out of scope (inScope=false) -> reproof never admits, and the general debt boolean is never even consulted for reproof's own decision", async () => {
  const runtime = freshRuntime();
  const now = TWELVE_HOURS_MS * 100;
  runtime.lastRunTime.set("amazon-reproof-connector", now - (DEFAULT_CEILING_MS + 1));

  let invalidatedAtProbeCalls = 0;
  let debtProbeCalls = 0;
  const governor = makeGovernor({
    // The broad debt boolean is true (e.g. a current-state row with a stale
    // fact map) but the connection is explicitly OUT OF SCOPE for manifest-
    // generation reproof — the second gate's required narrowing.
    getForwardEvidenceDebt: () => {
      debtProbeCalls += 1;
      return true;
    },
    getForwardEvidenceInvalidatedAtMs: () => {
      invalidatedAtProbeCalls += 1;
      return notInScope();
    },
    getNonPressureRecoverableCount: () => 0, // recovery-only sub-flow never reaches its own debt probe either
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(invalidatedAtProbeCalls, 1, "the anchor probe is still called (it's how scope is determined)");
  assert.equal(
    debtProbeCalls,
    0,
    "the general debt probe must NEVER be consulted by the reproof branch directly — reproof gates on inScope alone, discriminating this from the removed 'gate on the broad debt boolean' design"
  );
  assert.equal(
    result.eligible,
    false,
    "out-of-scope debt must never enter decideForwardEvidenceReproof at all, regardless of an anchor value"
  );
});

test("healthy connection (no forward-evidence debt, no recovery backlog) never calls the general debt probe, and the anchor probe reports not-in-scope -> no early dispatch", async () => {
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
      return notInScope(); // a healthy row is genuinely out of scope
    },
    getNonPressureRecoverableCount: () => 0,
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(
    debtProbeCalls,
    0,
    "with zero recovery backlog, the recovery-only sub-flow never calls the general debt probe either — reproof no longer reads it at all (second gate REVISE: reproof gates on the anchor probe's own inScope flag, not the general debt boolean)"
  );
  assert.equal(
    invalidatedAtProbeCalls,
    1,
    "the anchor probe IS consulted once (that's how inScope is determined) and reports out-of-scope"
  );
  assert.equal(result.eligible, false, "out of scope -> no early dispatch, ordinary 12h cadence still governs");
});

test("blocked connection is never admitted early by reproof, even in scope with an elapsed ceiling", async () => {
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
    getForwardEvidenceInvalidatedAtMs: () => anchored(now - (DEFAULT_CEILING_MS + 1)),
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
      return anchored(0);
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

test("reproof admits independently of the general debt probe -- recovery-only's own recovery-cadence gate is untouched by this fix", async () => {
  // lastRunTime is recent relative to the 12h recovery cadence
  // (recoveryCadenceElapsed is false), so the recovery-only sub-flow's own
  // debt probe is never reached here — this test isolates reproof's
  // admission to its OWN anchor-probe-driven path, confirming reproof no
  // longer reads the general debt boolean at all (second gate REVISE).
  let debtProbeCalls = 0;
  const runtime = freshRuntime();
  const now = TWELVE_HOURS_MS * 100;
  runtime.lastRunTime.set("amazon-reproof-connector", now - (DEFAULT_CEILING_MS + 1));

  const governor = makeGovernor({
    getForwardEvidenceDebt: () => {
      debtProbeCalls += 1;
      return true;
    },
    getForwardEvidenceInvalidatedAtMs: () => anchored(now - (DEFAULT_CEILING_MS + 1)),
    getNonPressureRecoverableCount: () => 10, // a small backlog, but NOT yet on its own recovery cadence
    runtime,
  });

  const result = await governor.evaluateBackoffDispatch(schedule(), now);

  assert.equal(result.eligible, true, "reproof admits on the anchor probe's inScope+ceiling bound alone");
  assert.equal(
    debtProbeCalls,
    0,
    "recoveryCadenceElapsed is false here, so the recovery-only sub-flow never reaches its own debt probe, and reproof no longer reads the general debt boolean at all"
  );
  assert.equal(result.recoveryOnly, false, "an admitted reproof run is an ordinary forward attempt, not recovery-only");
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
    getForwardEvidenceInvalidatedAtMs: () => anchored(now - (fiveMinuteIntervalMs + 1)),
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

test("getForwardEvidenceInvalidatedAtMs omitted -> defaults to not-in-scope -> never enters reproof (never a silent unconditional admit)", async () => {
  const runtime = freshRuntime();
  const now = TWELVE_HOURS_MS * 100;
  runtime.lastRunTime.set("amazon-reproof-connector", now - (DEFAULT_CEILING_MS + 1));

  // Deliberately do NOT provide getForwardEvidenceInvalidatedAtMs — a host
  // that has not wired the new probe must stay on its safe, conservative
  // default: no early reproof at all, never the removed unconditional-admit
  // shape.
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

  assert.equal(
    result.eligible,
    false,
    "an unwired invalidation probe must default to no-early-reproof, never unconditional admit"
  );
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
        getForwardEvidenceInvalidatedAtMs: () => anchored(sharedInvalidatedAtMs),
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

// ── Second gate's required cohort-scale null/probe-error tests (item 5) ─────
//
// Both routes to the removed unconditional-admit branch, at fleet scale:
// (a) every instance sharing a null anchor because it is genuinely
// out-of-scope (case-b debt, or a not-yet-backfilled legacy row observed
// mid-transition) must show 0 early admissions, not N; (b) a correlated
// probe-error window hitting every concurrent call must ALSO show 0 early
// admissions, not N — while the ordinary schedule remains fully independent
// and unaffected either way.

test("cohort-scale, REVISE-2 fix proven: 20 instances ALL in scope but with a null (not-yet-backfilled) anchor produce 0 early admissions, not 20", async () => {
  const now = TWELVE_HOURS_MS * 100;
  const ids = Array.from({ length: 20 }, (_, i) => `cin_null_anchor_cohort_${i}`);

  const results = await Promise.all(
    ids.map(async (id) => {
      const runtime = freshRuntime();
      // Ordinary forward-walk deliberately NOT due (recent lastRunTime), so
      // any admission observed can only have come from the reproof path.
      runtime.lastRunTime.set(id, now - 60_000);
      const governor = makeGovernor({
        getForwardEvidenceDebt: () => true,
        getForwardEvidenceInvalidatedAtMs: () => anchored(null), // in scope, but no anchor yet
        getNonPressureRecoverableCount: () => 0,
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

  assert.equal(
    results.filter(Boolean).length,
    0,
    "a shared null anchor across an entire in-scope cohort must produce ZERO early admissions, not N — this is the exact defect the second gate found"
  );
});

test("cohort-scale, REVISE-2 fix proven: 20 instances ALL hitting a correlated probe error produce 0 early admissions, not 20, and ordinary schedule stays eligible once genuinely due", async () => {
  const now = TWELVE_HOURS_MS * 100;
  const ids = Array.from({ length: 20 }, (_, i) => `cin_probe_error_cohort_${i}`);

  // First: every instance idle, NOT yet due on its own 12h cadence, all
  // hitting a simulated correlated probe failure (e.g. a DB blip during a
  // fleet-wide restart) -> must show 0 early admissions.
  const earlyResults = await Promise.all(
    ids.map(async (id) => {
      const runtime = freshRuntime();
      runtime.lastRunTime.set(id, now - 60_000); // not yet due on its own cadence
      const governor = makeGovernor({
        getForwardEvidenceDebt: () => true,
        getForwardEvidenceInvalidatedAtMs: () => {
          throw new Error("simulated correlated probe failure (DB blip / pool exhaustion)");
        },
        getNonPressureRecoverableCount: () => 0,
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
  assert.equal(
    earlyResults.filter(Boolean).length,
    0,
    "a correlated probe-error window across an entire cohort must produce ZERO early admissions, not N"
  );

  // Second: the SAME cohort, but now genuinely due on its own ordinary 12h
  // cadence — proving the probe failure never blocked or delayed the
  // connection's real schedule, only the early-reproof optimization.
  const dueResults = await Promise.all(
    ids.map(async (id) => {
      const runtime = freshRuntime();
      runtime.lastRunTime.set(id, now - TWELVE_HOURS_MS - 1); // now genuinely due
      const governor = makeGovernor({
        getForwardEvidenceDebt: () => true,
        getForwardEvidenceInvalidatedAtMs: () => {
          throw new Error("simulated correlated probe failure (DB blip / pool exhaustion)");
        },
        getNonPressureRecoverableCount: () => 0,
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
  assert.equal(
    dueResults.filter(Boolean).length,
    ids.length,
    "ordinary schedule eligibility must be completely unaffected by the reproof probe's failure — every instance genuinely due on its own 12h cadence still dispatches"
  );
});

test("cohort-scale: manual/unsafe connectors stay blocked from early reproof even across a null-anchor or probe-error cohort (automation gate unaffected)", async () => {
  // A blocked connection (failure-streak escalated, per the existing
  // backoff gate) must never be admitted early by reproof regardless of
  // the anchor's shape — this is the SAME guard proven for a single
  // instance above, re-asserted at cohort scale for both the null-anchor
  // and probe-error routes together, since the second gate's finding was
  // specifically about correlated cohort behavior.
  const now = TWELVE_HOURS_MS * 100;
  const ids = Array.from({ length: 6 }, (_, i) => `cin_blocked_cohort_${i}`);

  const results = await Promise.all(
    ids.map(async (id, index) => {
      const failedHistory: RunRecord[] = Array.from({ length: 8 }, (_, i) => ({
        attempt: 1,
        checkpointSummary: null,
        completedAt: new Date(now - (8 - i) * 1000).toISOString(),
        connectorError: null,
        connectorId: id,
        connectorInstanceId: id,
        error: "connector_reported_failed",
        failureReason: null,
        knownGaps: [],
        recordsEmitted: 0,
        reportedRecordsEmitted: null,
        runId: null,
        source: { id, kind: "connector" },
        startedAt: new Date(now - (8 - i) * 1000 - 1000).toISOString(),
        status: "failed",
        terminalReason: "connector_reported_failed",
        traceId: null,
      }));
      const runtime = freshRuntime();
      runtime.history.push(...failedHistory);
      runtime.lastRunTime.set(id, now - (DEFAULT_CEILING_MS + 1));
      const useNullAnchor = index % 2 === 0;
      const governor = makeGovernor({
        getForwardEvidenceDebt: () => true,
        getForwardEvidenceInvalidatedAtMs: () => {
          if (useNullAnchor) {
            return anchored(null);
          }
          throw new Error("simulated correlated probe failure");
        },
        getNonPressureRecoverableCount: () => 0,
        runtime,
      });
      const result = await governor.evaluateBackoffDispatch(
        schedule({ connectorId: id, connectorInstanceId: id }),
        now
      );
      return result.eligible;
    })
  );

  assert.ok(
    results.every((eligible) => eligible === false),
    "every blocked connector in the cohort must stay blocked regardless of null-anchor or probe-error routes"
  );
});
