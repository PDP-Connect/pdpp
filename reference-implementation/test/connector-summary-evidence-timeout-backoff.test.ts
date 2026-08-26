// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Regression coverage for the 2026-08-26 production starvation: one
 * connection's evidence repair could not finish inside the per-unit
 * `statement_timeout` bound, so it was cancelled, left `dirty`, re-discovered
 * next pass, and — because `repairCandidates` deliberately always attempts the
 * FIRST selected candidate regardless of the deadline (the fix for a DIFFERENT
 * starvation, 2026-08-18, see
 * `connector-summary-evidence-bounded-reconciliation.test.ts`) — consumed the
 * whole round before any other dirty row was reached.
 *
 * Measured on the owner's instance: 58 cancellations in one hour for a single
 * connection (~29 minutes of wall clock), while the fleet recomputed 3 rows in
 * that hour and 0 in the final 15 minutes. Two healthy connections read "Not
 * measured" for 2h and 5h behind it.
 *
 * The two mechanisms proven here:
 *   1. A permanently-timing-out unit does not consume every round — after its
 *      first cancellation it is deferred, and the OTHER dirty rows drain.
 *   2. It still retries eventually (back-off, not a permanent dead-letter): a
 *      connection that recovers must be able to go green on its own.
 *
 * The whale's own repair (chunked/resumable) is a separate change; this file
 * only proves it stops taxing everyone else.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { runScopedConnectorReconciliation } from "../server/connector-summary-evidence-bounded-reconciliation.ts";
import { remainingStatementBudgetMs } from "../server/connector-summary-evidence-engine.ts";

/**
 * The other half of the fix, pinned on the REAL function: a depleted
 * allowance must report `0`, not the 500ms floor. Returning the floor
 * unconditionally is what admitted a doomed unit on every pass.
 *
 * `0` must never reach `postgresQueryBounded` — Postgres reads
 * `statement_timeout = 0` as UNLIMITED, which would remove the bound
 * entirely — so the engine's two query wrappers refuse admission on `0`
 * instead of passing it through.
 */
test("a depleted admission allowance reports zero, not the 500ms floor", () => {
  assert.equal(remainingStatementBudgetMs(null), null, "no deadline stays unbounded");
  assert.equal(remainingStatementBudgetMs(Date.now() - 1000), 0, "an expired allowance must be zero");
  assert.equal(remainingStatementBudgetMs(Date.now() - 1), 0, "a just-expired allowance must be zero");
  // A live-but-tiny allowance still gets the genuine 500ms minimum: the floor
  // remains a real minimum for an ADMITTED unit, which is the bound the owner
  // ruled stays untouched.
  assert.equal(remainingStatementBudgetMs(Date.now() + 5), 500, "a live allowance keeps the 500ms minimum");
});

type Reason = "dirty";

const WHALE = "cin_whale";

/**
 * Mirrors `repairCandidate`'s post-fix contract WITHOUT the Postgres backend:
 * a unit already inside its back-off window returns `deferred` immediately
 * (consuming its turn, writing nothing), and a unit that times out arms the
 * back-off. `nowMs` is injected so the test never sleeps for real.
 */
function backoffAwareRepair(options: {
  readonly alwaysTimesOut: ReadonlySet<string>;
  readonly attempts: string[];
  readonly backoffMs: number;
  readonly backoffUntil: Map<string, number>;
  readonly now: () => number;
  readonly repaired: Set<string>;
}) {
  const { alwaysTimesOut, attempts, backoffMs, backoffUntil, now, repaired } = options;
  return (id: string) => {
    const until = backoffUntil.get(id);
    if (until !== undefined && now() < until) {
      return Promise.resolve({
        deferred: true,
        failed: false,
        persisted: true,
        row: { connector_instance_id: id },
      });
    }
    attempts.push(id);
    if (alwaysTimesOut.has(id)) {
      // The cancelled unit: arms back-off, writes no evidence, stays dirty.
      backoffUntil.set(id, now() + backoffMs);
      return Promise.resolve({
        deferred: false,
        failed: true,
        persisted: true,
        row: { connector_instance_id: id },
      });
    }
    repaired.add(id);
    return Promise.resolve({
      deferred: false,
      failed: false,
      persisted: true,
      row: { connector_instance_id: id },
    });
  };
}

async function runRounds(options: {
  readonly alwaysTimesOut: ReadonlySet<string>;
  readonly attempts: string[];
  readonly backoffMs: number;
  readonly backoffUntil: Map<string, number>;
  readonly dirtyIds: readonly string[];
  readonly now: () => number;
  readonly repaired: Set<string>;
  readonly rounds: number;
}) {
  const { alwaysTimesOut, attempts, backoffMs, backoffUntil, dirtyIds, now, repaired, rounds } = options;
  for (let round = 0; round < rounds; round += 1) {
    // The whale sorts FIRST — the worst case, since it is the
    // always-attempted candidate. The round has a live budget (production:
    // 2000ms), so a round is free to reach further candidates; what made the
    // production sweep single-file was the whale BURNING that budget, not the
    // budget being absent. An expired deadline here would prove nothing about
    // the fix — `repairCandidates` would break after candidate #1 regardless.
    const deadline = Date.now() + 2000;
    // biome-ignore lint/performance/noAwaitInLoops: rounds are inherently sequential.
    await runScopedConnectorReconciliation<
      { connector_instance_id: string },
      Reason,
      { connector_instance_id: string }
    >({
      candidateReasons: undefined,
      connectorInstanceIds: dirtyIds,
      deadline,
      discover: () =>
        Promise.resolve({
          candidates: new Map<string, Reason>(
            dirtyIds.filter((id) => !repaired.has(id)).map((id) => [id, "dirty" as const])
          ),
          instanceRows: dirtyIds.map((id) => ({ connector_instance_id: id })),
        }),
      maxCandidates: undefined,
      prune: () => Promise.resolve(0),
      repair: backoffAwareRepair({ alwaysTimesOut, attempts, backoffMs, backoffUntil, now, repaired }),
    });
  }
}

test("dirty rows drain at normal throughput while a permanently-timing-out unit is present", async () => {
  const healthy = ["cin_reddit", "cin_codex", "cin_ynab", "cin_gmail"];
  const dirtyIds = [WHALE, ...healthy];
  const attempts: string[] = [];
  const repaired = new Set<string>();
  const backoffUntil = new Map<string, number>();
  const clock = 1_000_000;

  await runRounds({
    alwaysTimesOut: new Set([WHALE]),
    attempts,
    backoffMs: 60_000,
    backoffUntil,
    dirtyIds,
    now: () => clock,
    repaired,
    // One round per healthy row, plus the round the whale's first (and only)
    // attempt consumes.
    rounds: healthy.length + 1,
  });

  // THE BEHAVIORAL CLAIM: every healthy row recomputed.
  assert.deepEqual(
    [...repaired].sort(),
    [...healthy].sort(),
    "every healthy dirty row must recompute even though a permanently-timing-out unit shares the queue"
  );

  // And the whale was attempted ONCE, not once per round — the starvation.
  const whaleAttempts = attempts.filter((id) => id === WHALE).length;
  assert.equal(whaleAttempts, 1, `the timing-out unit must be attempted once, not every round (was ${whaleAttempts})`);
});

test("the timing-out unit is retried after its back-off expires, not dead-lettered", async () => {
  const attempts: string[] = [];
  const repaired = new Set<string>();
  const backoffUntil = new Map<string, number>();
  let clock = 1_000_000;
  const backoffMs = 60_000;

  await runRounds({
    alwaysTimesOut: new Set([WHALE]),
    attempts,
    backoffMs,
    backoffUntil,
    dirtyIds: [WHALE],
    now: () => clock,
    repaired,
    rounds: 3,
  });
  assert.equal(attempts.length, 1, "inside the back-off window the unit is not re-attempted");

  // Advance past the back-off: it must get another turn, so a connection that
  // recovers is never permanently stuck at "Not measured".
  clock += backoffMs + 1;
  await runRounds({
    alwaysTimesOut: new Set([WHALE]),
    attempts,
    backoffMs,
    backoffUntil,
    dirtyIds: [WHALE],
    now: () => clock,
    repaired,
    rounds: 1,
  });
  assert.equal(attempts.length, 2, "once the back-off expires the unit must be retried");
});
