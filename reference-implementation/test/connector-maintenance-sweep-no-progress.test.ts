// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * No-progress telemetry and alerting (design reviewer finding P2-4):
 * "`incomplete: true` is not a progress signal. The system ran for an hour
 * while repeatedly reporting an incomplete pass. That state did not
 * distinguish: backlog shrinking; cursor advancing; candidates attempted
 * but deferred; identical no-op replay; a phase never receiving service."
 *
 * Real incident measured on production (2026-08-17): the dirty backlog sat
 * pinned at exactly 8 rows for many minutes while passes alternated
 * `repaired: 1` / `repaired: 0` and always reported `incomplete: true`.
 * Nothing distinguished "repairing rows that are immediately re-dirtied"
 * from "converging normally." Finding it required manual DB polling.
 *
 * These tests drive `createResumableConnectorMaintenanceSweep` through a
 * mocked `runEvidenceSweep` adapter (unit-level, no DB), so each round's
 * reported `eligibleBacklog`/`prunedComplete` can be scripted directly —
 * exactly the shape `runBoundedSummaryEvidenceSweep`'s real
 * `BoundedSweepResult` reports (see that interface's `eligibleBacklog` doc
 * in `connector-summary-read-model.ts` for the live schema this mocks).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createResumableConnectorMaintenanceSweep } from "../server/connector-maintenance-sweep.ts";
import { closeDb, initDb } from "../server/db.ts";
import type { ConnectorMaintenanceCursorStore } from "../server/stores/connector-maintenance-cursor-store.ts";

function memoryCursorStore(): ConnectorMaintenanceCursorStore {
  let cursor: string | null = null;
  let generation = 0;
  let lease: { generation: number; resumeAfterId: string | null; token: string } | null = null;
  return {
    acquire: () => {
      if (lease) {
        return Promise.resolve(null);
      }
      generation += 1;
      lease = { generation, resumeAfterId: cursor, token: `lease_${generation}` };
      return Promise.resolve(lease);
    },
    commit: ({ lease: candidate, resumeAfterId }) => {
      if (lease?.generation !== candidate.generation || lease.token !== candidate.token) {
        return Promise.resolve(false);
      }
      cursor = resumeAfterId;
      lease = null;
      return Promise.resolve(true);
    },
    release: (candidate) => {
      if (lease?.generation !== candidate.generation || lease.token !== candidate.token) {
        return Promise.resolve(false);
      }
      lease = null;
      return Promise.resolve(true);
    },
  };
}

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    initDb(":memory:");
    try {
      await fn();
    } finally {
      closeDb();
    }
  };
}

/** One scripted round result, shaped like `runBoundedSummaryEvidenceSweep`'s `BoundedSweepResult`. */
function round(overrides: {
  eligibleBacklog?: number;
  failed?: number;
  incomplete?: boolean;
  prunedComplete?: boolean;
  resumeAfterId?: string | null;
}) {
  return {
    discovered: 0,
    eligibleBacklog: overrides.eligibleBacklog ?? 0,
    failed: overrides.failed ?? 0,
    incomplete: overrides.incomplete ?? true,
    prunedComplete: overrides.prunedComplete ?? false,
    repaired: 0,
    resumeAfterId: overrides.resumeAfterId ?? null,
    skipped: 0,
  };
}

function runnerWithAlerts(rounds: ReturnType<typeof round>[]) {
  const alerts: { consecutiveNoProgressPasses: number; eligibleBacklog: number }[] = [];
  let index = 0;
  const sweep = createResumableConnectorMaintenanceSweep(
    {
      evidenceSweepMaxDurationMs: 1,
      evidenceSweepPageSize: 1,
      onNoProgressAlert: (info) => alerts.push(info),
      runEvidenceSweep: () => {
        const next = rounds[Math.min(index, rounds.length - 1)];
        index += 1;
        return Promise.resolve(next);
      },
    },
    memoryCursorStore()
  );
  return { alerts, sweep };
}

test(
  "REAL INCIDENT: a dirty backlog pinned at 8 rows while repaired alternates 1/0 alerts at the threshold, never before it",
  withTempDb(async () => {
    // Every round reports the SAME eligibleBacklog (8) — the real production
    // shape: `repaired` alternated 1/0 underneath (not modeled here since
    // `roundMadeProgress` deliberately ignores `repaired`), and every pass
    // reported `incomplete: true`. The backlog never shrinks.
    //
    // A "pass" is a TRANSITION between two observations, not a raw round: the
    // FIRST round this process observes a backlog count bootstraps the
    // baseline (nothing to compare against yet) rather than counting as a
    // pass — see `NO_PROGRESS_ALERT_THRESHOLD_PASSES`'s doc. So N=3
    // non-shrinking PASSES needs 1 baseline + 3 comparison rounds = 4 total
    // observed rounds before the alert fires.
    const { alerts, sweep } = runnerWithAlerts([
      round({ eligibleBacklog: 8 }),
      round({ eligibleBacklog: 8 }),
      round({ eligibleBacklog: 8 }),
      round({ eligibleBacklog: 8 }),
      round({ eligibleBacklog: 8 }),
    ]);

    for (let i = 0; i < 3; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Each round must observe the prior round's counter state.
      await sweep.runEvidenceSweepRound({ maxDurationMs: 1 });
    }
    assert.deepEqual(
      alerts,
      [],
      "round 1 bootstraps the baseline; rounds 2-3 are only the first two no-progress passes"
    );

    await sweep.runEvidenceSweepRound({ maxDurationMs: 1 });
    assert.equal(alerts.length, 1, "round 4 is the third consecutive no-progress PASS — fires exactly one alert");
    assert.deepEqual(alerts[0], { consecutiveNoProgressPasses: 3, eligibleBacklog: 8 });

    await sweep.runEvidenceSweepRound({ maxDurationMs: 1 });
    assert.equal(alerts.length, 2, "a further stuck round alerts again (still stuck)");
    assert.deepEqual(alerts[1], { consecutiveNoProgressPasses: 4, eligibleBacklog: 8 });
  })
);

test(
  "the first round this process ever observes a backlog count bootstraps the baseline and never alerts on its own",
  withTempDb(async () => {
    const { alerts, sweep } = runnerWithAlerts([round({ eligibleBacklog: 100 })]);
    const result = await sweep.runEvidenceSweepRound({ maxDurationMs: 1 });
    assert.deepEqual(alerts, [], "a single observed round, however large the backlog, is never itself an alert");
    assert.equal(result?.eligibleBacklog, 100);
  })
);

test(
  "the counter RESETS the moment the backlog genuinely shrinks, silencing the alert",
  withTempDb(async () => {
    // round 1 = 8 (bootstrap baseline, counter 0)
    // round 2 = 8 (8 !< 8, counter 1)
    // round 3 = 6 (6 < 8, SHRANK — resets counter to 0, new baseline 6)
    // round 4 = 6 (6 !< 6, counter 1)
    // round 5 = 6 (6 !< 6, counter 2)
    // round 6 = 6 (6 !< 6, counter 3 -> ALERT)
    const { alerts, sweep } = runnerWithAlerts([
      round({ eligibleBacklog: 8 }),
      round({ eligibleBacklog: 8 }),
      round({ eligibleBacklog: 6 }),
      round({ eligibleBacklog: 6 }),
      round({ eligibleBacklog: 6 }),
      round({ eligibleBacklog: 6 }),
    ]);

    for (let i = 0; i < 5; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential rounds by construction.
      await sweep.runEvidenceSweepRound({ maxDurationMs: 1 });
    }
    assert.deepEqual(
      alerts,
      [],
      "the shrink at round 3 reset the counter before it could reach 3 non-progress passes again"
    );

    await sweep.runEvidenceSweepRound({ maxDurationMs: 1 });
    assert.equal(alerts.length, 1, "the third consecutive no-progress PASS after the reset re-trips the alert");
    assert.deepEqual(alerts[0], { consecutiveNoProgressPasses: 3, eligibleBacklog: 6 });
  })
);

test(
  "a complete-set orphan prune counts as progress and resets the counter even if the backlog count itself is unchanged",
  withTempDb(async () => {
    const { alerts, sweep } = runnerWithAlerts([
      round({ eligibleBacklog: 5 }),
      round({ eligibleBacklog: 5 }),
      round({ eligibleBacklog: 5, prunedComplete: true }), // resets despite unchanged backlog
      round({ eligibleBacklog: 5 }),
      round({ eligibleBacklog: 5 }),
    ]);

    for (let i = 0; i < 4; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential rounds by construction.
      await sweep.runEvidenceSweepRound({ maxDurationMs: 1 });
    }
    assert.deepEqual(alerts, [], "the prune round resets the counter before 3 consecutive no-progress rounds accrue");
  })
);

test(
  "a backlog that reaches ZERO never alerts, even after many consecutive rounds report it — nothing left to converge",
  withTempDb(async () => {
    const { alerts, sweep } = runnerWithAlerts([
      round({ eligibleBacklog: 0, incomplete: false }),
      round({ eligibleBacklog: 0, incomplete: false }),
      round({ eligibleBacklog: 0, incomplete: false }),
      round({ eligibleBacklog: 0, incomplete: false }),
      round({ eligibleBacklog: 0, incomplete: false }),
    ]);

    for (let i = 0; i < 5; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential rounds by construction.
      await sweep.runEvidenceSweepRound({ maxDurationMs: 1 });
    }
    assert.deepEqual(alerts, [], "eligibleBacklog === 0 must never alert — there is no stuck work to report");
  })
);

test(
  "ACCOUNTS FOR finding 1 (double onPageConverged / double-count risk): the counter reads the backlog COUNT, not a repaired tally, so double-counted repairs cannot mask a stuck backlog",
  withTempDb(async () => {
    // Simulates a round where BOTH tranches process the same fleet and
    // `onPageConverged` fires twice, inflating any repaired-based counter —
    // modeled here by a large `repaired` value alongside an unmoved backlog.
    // `roundMadeProgress` must still see this as NO progress because it
    // never reads `repaired` at all.
    const { alerts, sweep } = runnerWithAlerts([
      { ...round({ eligibleBacklog: 8 }), repaired: 40 },
      { ...round({ eligibleBacklog: 8 }), repaired: 40 },
      { ...round({ eligibleBacklog: 8 }), repaired: 40 },
      { ...round({ eligibleBacklog: 8 }), repaired: 40 },
    ]);

    for (let i = 0; i < 4; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential rounds by construction.
      await sweep.runEvidenceSweepRound({ maxDurationMs: 1 });
    }
    assert.equal(alerts.length, 1, "a large repaired count must not suppress the alert when the backlog never shrinks");
  })
);

test(
  "a per-unit PostgresStatementTimeoutError abort (commit c7da5ea94) is treated as NON-progress, never crashes the round or masks a stuck backlog",
  withTempDb(async () => {
    // `postgresQueryBounded` (postgres-storage.ts) now throws
    // `PostgresStatementTimeoutError` when a sweep query's `SET LOCAL
    // statement_timeout` fires mid-round. Tracing the real call chain:
    // `repairCandidatePostgres`'s own try/catch (connector-summary-evidence-
    // engine.ts) turns a timeout on ONE candidate into `failed: true` for
    // that candidate WITHOUT throwing further, and a timeout during
    // discovery is caught by `observeConnectorSummaryEvidence`'s outer
    // try/catch, which returns `failureClasses: ["discovery"]`,
    // `reconciled: 0` — also without throwing. Either way, the ROUND still
    // completes and reports a result; it never crashes the sweep and never
    // reports the dirty row as repaired. This test proves the no-progress
    // counter's OWN handling of that already-caught outcome: a round whose
    // repair aborted (modeled here as `failed > 0` with an UNCHANGED
    // `eligibleBacklog`, exactly what the real call chain produces) must
    // count as a no-progress pass, not silently reset the counter.
    const { alerts, sweep } = runnerWithAlerts([
      round({ eligibleBacklog: 3 }),
      { ...round({ eligibleBacklog: 3 }), failed: 1 }, // discovery/repair unit aborted by statement_timeout
      { ...round({ eligibleBacklog: 3 }), failed: 1 },
      { ...round({ eligibleBacklog: 3 }), failed: 1 },
    ]);

    for (let i = 0; i < 3; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential rounds by construction.
      await sweep.runEvidenceSweepRound({ maxDurationMs: 1 });
    }
    assert.deepEqual(alerts, [], "not yet at the N=3 threshold");

    await sweep.runEvidenceSweepRound({ maxDurationMs: 1 });
    assert.equal(alerts.length, 1, "3 consecutive statement-timeout-aborted rounds correctly alert as stuck");
    assert.deepEqual(alerts[0], { consecutiveNoProgressPasses: 3, eligibleBacklog: 3 });
  })
);

test(
  "a caller that does not report eligibleBacklog (older/foreign adapter) never alerts — fail-open, not a false alarm",
  withTempDb(async () => {
    const alerts: unknown[] = [];
    const sweep = createResumableConnectorMaintenanceSweep(
      {
        evidenceSweepMaxDurationMs: 1,
        onNoProgressAlert: (info) => alerts.push(info),
        runEvidenceSweep: () => Promise.resolve({ incomplete: true, resumeAfterId: "cin_x" }),
      },
      memoryCursorStore()
    );

    for (let i = 0; i < 6; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential rounds by construction.
      await sweep.runEvidenceSweepRound({ maxDurationMs: 1 });
    }
    assert.deepEqual(alerts, [], "an adapter that never reports eligibleBacklog must never manufacture an alert");
  })
);

test(
  "a throwing onNoProgressAlert callback cannot break the resumable cursor contract",
  withTempDb(async () => {
    let calls = 0;
    const sweep = createResumableConnectorMaintenanceSweep(
      {
        evidenceSweepMaxDurationMs: 1,
        onNoProgressAlert: () => {
          calls += 1;
          throw new Error("alerting sink unavailable");
        },
        runEvidenceSweep: () => Promise.resolve(round({ eligibleBacklog: 4, resumeAfterId: "cin_stuck" })),
      },
      memoryCursorStore()
    );

    let last: Awaited<ReturnType<typeof sweep.runEvidenceSweepRound>> = null;
    for (let i = 0; i < 4; i += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Sequential rounds by construction.
      last = await sweep.runEvidenceSweepRound({ maxDurationMs: 1 });
    }
    assert.equal(calls, 1, "the alert fired exactly once at the threshold despite throwing");
    assert.deepEqual(last, {
      eligibleBacklog: 4,
      failed: 0,
      incomplete: true,
      prunedComplete: false,
      resumeAfterId: "cin_stuck",
    });
  })
);
