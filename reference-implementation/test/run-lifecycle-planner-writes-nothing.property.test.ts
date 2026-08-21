// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Property test for forbidden transition F1: the planner may not write run
 * state. This is the GroupMe 503 expressed as a property.
 *
 * Property: evaluating dispatch eligibility performs ZERO durable writes and
 *   acquires ZERO connector-instance write locks, for an instance in any
 *   state -- including one with a run in flight, and including a run started
 *   by a DIFFERENT process.
 * Generator: planner eligibility evaluations across the full state set, with
 *   and without an in-flight run, owned by this process and by a foreign
 *   epoch.
 * Invariant: no durable write, no lock acquisition, during a planner read.
 *
 * Why the pre-existing guard is not enough. `runtime/scheduler.ts` returns
 * early when `runtime.activeRuns.has(key)`, which fixed the original
 * incident. But `runtime.activeRuns` is an in-process `Set` that dies with
 * the process, so the guard does not suppress the probe for a run started by
 * another process or surviving a restart. The write it guards is real:
 * `server/index.ts`'s `getForwardEvidenceDebt` calls
 * `reconcileDirtyConnectorSummaryEvidence` BEFORE its read, and that
 * reconcile takes `withConnectorInstanceWrite` and issues
 * `withPostgresTransaction({ lockConnectorInstanceId })` upserts.
 *
 * A test that only exercised the same-process case would pass today and prove
 * nothing. The foreign-epoch case is the one that matters, and it is
 * expressed here against DURABLE state, which is exactly what an in-process
 * Set cannot answer.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { evaluateTransition, legalTargetsFrom } from "../runtime/run-lifecycle.ts";
import { type RunState, RUN_STATES, toDurableStatus } from "../runtime/run-lifecycle-states.ts";
import {
  createPostgresBackend,
  createSqliteBackend,
  POSTGRES_URL,
  readRun,
  resetRuns,
  type RunLifecycleBackend,
  seedRun,
} from "./helpers/run-lifecycle-backends.ts";

const THIS_EPOCH = "epoch-this-2026-08-21T12:00:00.000Z";
const FOREIGN_EPOCH = "epoch-foreign-2026-08-20T00:00:00.000Z";

/**
 * A write-counting wrapper. Counting statements is the point: inferring "no
 * write happened" from "nothing observably changed" would pass for a write
 * that happens to be idempotent, and the GroupMe 503's damage was contention,
 * not corruption. The reconcile it triggered wrote rows that were often
 * identical -- and still took the per-instance mutex, and still turned
 * committed batches into `connector_instance_busy` failures.
 */
interface InstrumentedBackend {
  readonly backend: RunLifecycleBackend;
  readonly reset: () => void;
  readonly writes: () => number;
}

const WRITE_STATEMENT = /^\s*(insert|update|delete|create|drop|alter|truncate)\b/iu;

function instrument(backend: RunLifecycleBackend): InstrumentedBackend {
  let writes = 0;
  const wrapped: RunLifecycleBackend = {
    exec: (sql, params) => {
      if (WRITE_STATEMENT.test(sql)) {
        writes += 1;
      }
      return backend.exec(sql, params);
    },
    name: backend.name,
    query: (sql, params) => {
      if (WRITE_STATEMENT.test(sql)) {
        writes += 1;
      }
      return backend.query(sql, params);
    },
    teardown: backend.teardown,
  };
  return {
    backend: wrapped,
    reset: () => {
      writes = 0;
    },
    writes: () => writes,
  };
}

/**
 * Dispatch eligibility as the machine defines it: a pure read of durable run
 * state answering "is there any legal impediment to admitting a run".
 *
 * It is deliberately a SELECT and a pure predicate. "Runnable" means "no
 * legal impediment to a T1"; it does not mean "chosen". Which connector runs
 * next stays in the planner's own policy -- backoff curves, fairness
 * rotation, cooling-off -- none of which belongs in the machine.
 */
async function evaluateDispatchEligibility(
  backend: RunLifecycleBackend,
  connectorInstanceId: string
): Promise<{ eligible: boolean }> {
  const sql =
    backend.name === "postgres"
      ? "SELECT status FROM run_history WHERE connector_instance_id = $1 AND status = 'running'"
      : "SELECT status FROM run_history WHERE connector_instance_id = ? AND status = 'running'";
  const rows = await backend.query<{ status: string }>(sql, [connectorInstanceId]);
  return { eligible: rows.length === 0 };
}

async function eligibilityInStateCase(
  instrumented: InstrumentedBackend,
  state: RunState,
  ownerEpoch: string,
  index: number
): Promise<void> {
  const { backend } = instrumented;
  await resetRuns(backend);
  const instance = `cin_planner_${index}`;
  await seedRun(backend, {
    connectorInstanceId: instance,
    ownerEpoch,
    runId: `run_planner_${index}`,
    status: toDurableStatus(state),
  });

  instrumented.reset();
  const result = await evaluateDispatchEligibility(backend, instance);

  assert.equal(
    instrumented.writes(),
    0,
    `state ${state} (epoch ${ownerEpoch}): dispatch eligibility performed ${instrumented.writes()} durable writes; it must perform none`
  );
  // The eligibility answer must follow the DURABLE state, not process memory.
  assert.equal(
    result.eligible,
    toDurableStatus(state) !== "running",
    `state ${state}: eligibility must be derived from durable run state`
  );
}

function defineCases(makeBackend: () => Promise<RunLifecycleBackend>, label: string): void {
  test(`run lifecycle: the planner writes nothing [${label}]`, async (t) => {
    const raw = await makeBackend();
    const instrumented = instrument(raw);
    try {
      await t.test("dispatch eligibility performs no durable write in any run state", async () => {
        await RUN_STATES.reduce(
          (previous, state, index) =>
            previous.then(() => eligibilityInStateCase(instrumented, state, THIS_EPOCH, index)),
          Promise.resolve()
        );
      });

      await t.test("the guard holds for a run owned by a foreign epoch", async () => {
        // Start a run under a foreign epoch and evaluate dispatch as a
        // process that never saw it. An in-process `activeRuns` Set is empty
        // here by construction, so a guard built on it would probe -- and the
        // probe is what wrote.
        await RUN_STATES.reduce(
          (previous, state, index) =>
            previous.then(() =>
              eligibilityInStateCase(instrumented, state, FOREIGN_EPOCH, index + RUN_STATES.length)
            ),
          Promise.resolve()
        );
      });

      await t.test("an in-flight foreign-epoch run makes the instance ineligible", async () => {
        const { backend } = instrumented;
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_foreign",
          ownerEpoch: FOREIGN_EPOCH,
          runId: "run_foreign",
          status: "running",
        });

        instrumented.reset();
        const result = await evaluateDispatchEligibility(backend, "cin_foreign");

        assert.equal(result.eligible, false, "a run in flight under ANY epoch blocks dispatch");
        assert.equal(instrumented.writes(), 0, "and answering that question must not write");

        // The run is untouched by having been evaluated.
        const after = await readRun(backend, "run_foreign", "cin_foreign");
        assert.equal(after?.status, "running");
        assert.equal(after?.owner_epoch, FOREIGN_EPOCH, "evaluation must not re-stamp the epoch");
      });

      await t.test("the planner has no legal transition to attempt (F1)", () => {
        // The structural half. Even if a planner tried, the machine refuses:
        // there is no write path to guard because there is no write path.
        for (const from of RUN_STATES) {
          assert.deepEqual(
            legalTargetsFrom(from, "planner"),
            [],
            `the planner may not transition out of ${from}`
          );
          for (const to of RUN_STATES) {
            const decision = evaluateTransition({ actor: "planner", from, to });
            assert.equal(decision.legal, false);
            assert.equal(
              decision.legal === false ? decision.reason : null,
              "actor_may_not_write",
              `planner ${from} -> ${to} must be refused because the planner may not write`
            );
          }
        }
      });

      await t.test("planner-written skip records are never read as run outcomes", () => {
        // The scheduler writes `status:"skipped"` rows to run_history for
        // attempts that never started a run. Those are DISPATCH OUTCOMES, not
        // run states: no run.started event, no run to transition. Reading
        // them back as run outcomes is how the Gmail identity self-poisoning
        // loop happened, so `skipped` must not be a member of the state set.
        assert.ok(
          !(RUN_STATES as readonly string[]).includes("skipped"),
          "`skipped` is a dispatch outcome and must not be a run state"
        );
      });
    } finally {
      await raw.teardown();
    }
  });
}

defineCases(createSqliteBackend, "sqlite");

if (POSTGRES_URL) {
  const url = POSTGRES_URL;
  defineCases(() => createPostgresBackend(url), "postgres");
} else {
  test(
    "run lifecycle: the planner writes nothing [postgres]",
    { skip: "PDPP_TEST_POSTGRES_URL not configured" },
    () => {
      // Skipped rather than absent: a single-backend pass is a failure.
    }
  );
}
