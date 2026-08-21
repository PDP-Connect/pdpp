// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Property test for forbidden transition F3: no transition may commit on a
 * premise that changed under it. This is the collector-runner drain/clock
 * boundary race generalized.
 *
 * Property: for any transition, if the run's state changes between the
 *   caller's observation and its write, the write does not commit.
 * Generator: transition attempts with a competing actor injected into the
 *   window between read and write, mutating the run to every other reachable
 *   state.
 * Invariant: the transition commits only if the observed state still holds at
 *   write time; otherwise it is refused and REPORTS refusal.
 *
 * The original incident: `drainCollectorOutbox` abandoned a due outbox row
 * because two clock reads used opposite boundary semantics (`<=` on claim,
 * `>` on `nextRetryTime`), so a deadline landing between the two reads
 * produced a false "empty" exit. The generalized defect is decide-then-write
 * against a premise nobody re-checked.
 *
 * A compare-and-swap makes the class unrepresentable rather than fixing the
 * instance -- which is the point: the same shape recurred in the maintenance
 * sweep three times after being named twice.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildTransitionStatement, interpretCasResult } from "../runtime/run-lifecycle.ts";
import { isTerminalRunState, type RunState, RUN_STATES, toDurableStatus } from "../runtime/run-lifecycle-states.ts";
import {
  createPostgresBackend,
  createSqliteBackend,
  POSTGRES_URL,
  readRun,
  resetRuns,
  type RunLifecycleBackend,
  seedRun,
} from "./helpers/run-lifecycle-backends.ts";

const EPOCH = "epoch-cas-2026-08-21T00:00:00.000Z";

async function transition(
  backend: RunLifecycleBackend,
  input: {
    connectorInstanceId: string;
    expectedState: RunState;
    runId: string;
    targetState: RunState;
  }
): Promise<{ changes: number; committed: boolean; reason: string | null }> {
  const statement = buildTransitionStatement(
    {
      completedAt: "2026-08-21T02:00:00.000Z",
      connectorInstanceId: input.connectorInstanceId,
      expectedState: input.expectedState,
      ownerEpoch: EPOCH,
      runId: input.runId,
      targetState: input.targetState,
      terminalReason: "test",
    },
    backend.name === "postgres" ? "postgres" : "sqlite"
  );
  const changes = await backend.exec(statement.sql, statement.params);
  const outcome = interpretCasResult(changes, input.targetState);
  return {
    changes,
    committed: outcome.committed,
    reason: outcome.committed ? null : outcome.reason,
  };
}

/**
 * One decide-then-write cycle with a competing mutation injected into the
 * window. The caller observes `running`, a competitor moves the run, and only
 * then does the caller write against its now-stale premise.
 */
async function staleWindowCase(
  backend: RunLifecycleBackend,
  competitorTarget: RunState,
  index: number
): Promise<void> {
  await resetRuns(backend);
  const runId = `run_cas_${index}`;
  const instance = `cin_cas_${index}`;
  await seedRun(backend, {
    connectorInstanceId: instance,
    ownerEpoch: EPOCH,
    runId,
    status: "running",
  });

  // 1. The caller OBSERVES the run.
  const observed = await readRun(backend, runId, instance);
  assert.equal(observed?.status, "running", `case ${index}: precondition`);

  // 2. A competitor moves it out from under the caller.
  const competitor = await transition(backend, {
    connectorInstanceId: instance,
    expectedState: "running",
    runId,
    targetState: competitorTarget,
  });
  assert.equal(competitor.committed, true, `case ${index}: the competitor's move must land`);

  // 3. The caller now writes against its stale premise.
  const late = await transition(backend, {
    connectorInstanceId: instance,
    expectedState: "running",
    runId,
    targetState: "succeeded",
  });

  assert.equal(late.committed, false, `case ${index}: a write on a stale premise must not commit`);
  assert.equal(late.changes, 0, `case ${index}: the stale write must match zero rows`);
  assert.equal(late.reason, "cas_lost", `case ${index}: refusal must be reported as a lost CAS`);

  const final = await readRun(backend, runId, instance);
  assert.equal(final?.status, competitorTarget, `case ${index}: the competitor's outcome must stand`);
}

function defineCases(makeBackend: () => Promise<RunLifecycleBackend>, label: string): void {
  test(`run lifecycle: no transition commits on a stale premise [${label}]`, async (t) => {
    const backend = await makeBackend();
    try {
      await t.test("a competing mutation in the read-write window refuses the transition", async () => {
        // Only states with a DISTINCT durable projection can be detected by a
        // CAS on `run_history.status`. `awaiting_interaction` and
        // `cancel_requested` deliberately project onto `running`
        // (toDurableStatus), so a competitor moving the run into one of them
        // leaves the durable premise unchanged and the caller's write still
        // commits -- correctly. Those are machine states the executor tracks,
        // not new durable statuses, and introducing new status literals for
        // them would be the observable behavior change D14 forbids.
        //
        // The next case pins that carve-out explicitly, so this exclusion is
        // a stated property rather than a quiet gap in coverage.
        const competitors = RUN_STATES.filter(
          (state) => toDurableStatus(state) !== "running" && state !== "pending"
        );
        assert.ok(competitors.length >= 4, "the distinct-projection competitor set must be non-trivial");
        await competitors.reduce(
          (previous, target, index) => previous.then(() => staleWindowCase(backend, target, index)),
          Promise.resolve()
        );
      });

      await t.test("states sharing the running projection do not falsify the premise", async () => {
        // The carve-out above, asserted rather than assumed. A competitor
        // moving `running -> awaiting_interaction` does not change the
        // durable status, so the premise "this run is durably running" still
        // holds and the caller's terminal write is correct to commit.
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_shared",
          ownerEpoch: EPOCH,
          runId: "run_shared",
          status: "running",
        });

        const competitor = await transition(backend, {
          connectorInstanceId: "cin_shared",
          expectedState: "running",
          runId: "run_shared",
          targetState: "awaiting_interaction",
        });
        assert.equal(competitor.committed, true);

        const after = await readRun(backend, "run_shared", "cin_shared");
        assert.equal(after?.status, "running", "awaiting_interaction projects onto the running status");

        const late = await transition(backend, {
          connectorInstanceId: "cin_shared",
          expectedState: "running",
          runId: "run_shared",
          targetState: "succeeded",
        });
        assert.equal(late.committed, true, "the durable premise still held, so the write commits");
      });

      await t.test("a refused transition reports refusal rather than silently no-oping", async () => {
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_report",
          ownerEpoch: EPOCH,
          runId: "run_report",
          status: "succeeded",
        });

        const refused = await transition(backend, {
          connectorInstanceId: "cin_report",
          expectedState: "running",
          runId: "run_report",
          targetState: "failed",
        });

        // A refusal that looks like success is how a false "empty" exit
        // happened. The caller must be able to tell the two apart, which
        // means the outcome carries a reason and is not merely `undefined`.
        assert.equal(refused.committed, false);
        assert.equal(refused.reason, "cas_lost");
        assert.notEqual(refused.reason, null, "a refusal must be distinguishable from a success");
      });

      await t.test("a transition whose premise still holds does commit", async () => {
        // The complement, and the reason this is not a vacuous property: a
        // predicate that refused EVERYTHING would satisfy every assertion
        // above. Refusal must be specific to the stale case.
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_fresh",
          ownerEpoch: EPOCH,
          runId: "run_fresh",
          status: "running",
        });

        const fresh = await transition(backend, {
          connectorInstanceId: "cin_fresh",
          expectedState: "running",
          runId: "run_fresh",
          targetState: "succeeded",
        });
        assert.equal(fresh.committed, true, "an unstale premise must commit");
        assert.equal(fresh.changes, 1);
      });

      await t.test("no decision reads the same fact twice with different boundary semantics", () => {
        // The literal drain/clock defect: one decision, one observation. The
        // structural guarantee is that the expected state travels INTO the
        // write as a parameter, so there is exactly one comparison and it
        // happens at write time. Two statements built for the same expected
        // state are byte-identical, which is what "one observation" means
        // here -- there is no second read to disagree with the first.
        const first = buildTransitionStatement(
          {
            completedAt: null,
            connectorInstanceId: "cin_x",
            expectedState: "running",
            ownerEpoch: EPOCH,
            runId: "run_x",
            targetState: "succeeded",
            terminalReason: null,
          },
          "sqlite"
        );
        const second = buildTransitionStatement(
          {
            completedAt: null,
            connectorInstanceId: "cin_x",
            expectedState: "running",
            ownerEpoch: EPOCH,
            runId: "run_x",
            targetState: "succeeded",
            terminalReason: null,
          },
          "sqlite"
        );
        assert.equal(first.sql, second.sql, "the predicate must be deterministic");
        assert.deepEqual(first.params, second.params);

        // And the expected state is genuinely in the statement, not compared
        // in application code before the write.
        assert.match(first.sql, /AND status = \?/u, "the expected state must be fenced in SQL");
        for (const state of RUN_STATES.filter((candidate) => isTerminalRunState(candidate))) {
          assert.ok(
            !first.sql.includes(`'${state}'`),
            "no state may be inlined as a literal; it must travel as a bound parameter"
          );
        }
      });
    } finally {
      await backend.teardown();
    }
  });
}

defineCases(createSqliteBackend, "sqlite");

if (POSTGRES_URL) {
  const url = POSTGRES_URL;
  defineCases(() => createPostgresBackend(url), "postgres");
} else {
  test(
    "run lifecycle: no transition commits on a stale premise [postgres]",
    { skip: "PDPP_TEST_POSTGRES_URL not configured" },
    () => {
      // Skipped rather than absent: a single-backend pass is a failure.
    }
  );
}
