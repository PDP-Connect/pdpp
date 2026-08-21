// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Property test for forbidden transition F6: a run may not remain
 * non-terminal forever with no live owner epoch. This is the YNAB stuck-run
 * wedge as a property.
 *
 * Property: for any run abandoned mid-flight by an epoch that never returns,
 *   a terminal state is reachable, and afterwards the connector instance can
 *   admit a new run.
 * Generator: runs left non-terminal at every non-terminal state (`pending`,
 *   `running`, `awaiting_interaction`, `cancel_requested`) by an epoch that
 *   is then retired, followed by a successor boot.
 * Invariant: after the successor boots, the run is terminal AND a subsequent
 *   admission on that connector instance succeeds.
 *
 * The historical failure: a hung connector subprocess that never resolved or
 * rejected left an `activeRuns` entry forever, permanently 409-ing every
 * future manual run with `active_run_exists` until a process restart. The UAT
 * instance was later measured holding 7 of 8 `run_history` rows claiming
 * `running` as zombies up to two days old, each already carrying a
 * `run.abandoned` spine event -- the projection and the event log disagreeing
 * about the same run.
 *
 * The admission assertion is the load-bearing one. Terminalizing the run
 * while leaving the instance unable to admit work would satisfy a naive
 * "is it terminal?" check and still reproduce the outage.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildAdjudicationStatement, evaluateTransition, legalTargetsFrom } from "../runtime/run-lifecycle.ts";
import {
  isTerminalRunState,
  NON_TERMINAL_RUN_STATES,
  type RunState,
  toDurableStatus,
} from "../runtime/run-lifecycle-states.ts";
import {
  createPostgresBackend,
  createSqliteBackend,
  POSTGRES_URL,
  readRun,
  resetRuns,
  type RunLifecycleBackend,
  seedRun,
} from "./helpers/run-lifecycle-backends.ts";

const RETIRED_EPOCH = "epoch-retired-2026-08-20T00:00:00.000Z";
const SUCCESSOR_EPOCH = "epoch-successor-2026-08-21T00:00:00.000Z";

const NON_TERMINAL: readonly RunState[] = [...NON_TERMINAL_RUN_STATES];

/**
 * Admission, expressed the way the machine expresses it: a new run may be
 * admitted only when no non-terminal run holds the instance. This is the
 * durable replacement for the in-process `activeRuns` Set whose leak caused
 * the wedge.
 */
async function admissionBlocked(
  backend: RunLifecycleBackend,
  connectorInstanceId: string
): Promise<boolean> {
  const sql =
    backend.name === "postgres"
      ? "SELECT COUNT(*)::int AS blockers FROM run_history WHERE connector_instance_id = $1 AND status = 'running'"
      : "SELECT COUNT(*) AS blockers FROM run_history WHERE connector_instance_id = ? AND status = 'running'";
  const rows = await backend.query<{ blockers: number }>(sql, [connectorInstanceId]);
  return Number(rows[0]?.blockers ?? 0) > 0;
}

async function wedgeCase(backend: RunLifecycleBackend, state: RunState, index: number): Promise<void> {
  await resetRuns(backend);
  const runId = `run_wedge_${index}`;
  const instance = `cin_wedge_${index}`;

  // A run left mid-flight by an epoch that never comes back.
  await seedRun(backend, {
    connectorInstanceId: instance,
    ownerEpoch: RETIRED_EPOCH,
    runId,
    status: toDurableStatus(state),
  });

  // The wedge precondition: while it sits there, the instance is blocked.
  // `pending` does not project onto `running`, so it does not block by this
  // predicate -- assert the blocked state only where the projection says so.
  const blockedBefore = await admissionBlocked(backend, instance);
  assert.equal(
    blockedBefore,
    toDurableStatus(state) === "running",
    `case ${index} (${state}): admission-blocked must follow the durable projection`
  );

  // A successor boots and adjudicates.
  const statement = buildAdjudicationStatement(
    {
      completedAt: "2026-08-21T04:00:00.000Z",
      connectorInstanceId: instance,
      expectedState: state,
      myEpoch: SUCCESSOR_EPOCH,
      runId,
      terminalReason:
        state === "awaiting_interaction"
          ? "controller_terminated_while_awaiting_owner_interaction"
          : "controller_terminated",
    },
    backend.name === "postgres" ? "postgres" : "sqlite"
  );
  const changes = await backend.exec(statement.sql, statement.params);
  assert.equal(changes, 1, `case ${index} (${state}): the orphan must be adjudicable`);

  // 1. It is terminal.
  const after = await readRun(backend, runId, instance);
  assert.equal(after?.status, "abandoned", `case ${index} (${state}): the run must be terminal`);

  // 2. And -- the assertion that actually matters -- the instance can work
  //    again. Terminalizing the run while leaving the instance unable to
  //    admit would pass a naive terminality check and still reproduce the
  //    outage.
  assert.equal(
    await admissionBlocked(backend, instance),
    false,
    `case ${index} (${state}): the instance must admit a new run after adjudication`
  );
}

function defineCases(makeBackend: () => Promise<RunLifecycleBackend>, label: string): void {
  test(`run lifecycle: no permanent wedge [${label}]`, async (t) => {
    const backend = await makeBackend();
    try {
      await t.test("a run whose owner epoch never returns becomes terminal", async () => {
        // Every non-terminal state, not just `running`. A run wedged in
        // `awaiting_interaction` is the case that costs the owner a real OTP.
        assert.ok(NON_TERMINAL.length >= 4, "every non-terminal state must be covered");
        await NON_TERMINAL.reduce(
          (previous, state, index) => previous.then(() => wedgeCase(backend, state, index)),
          Promise.resolve()
        );
      });

      await t.test("the connector instance admits a new run after adjudication", async () => {
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_admit",
          ownerEpoch: RETIRED_EPOCH,
          runId: "run_admit_old",
          status: "running",
        });
        assert.equal(await admissionBlocked(backend, "cin_admit"), true, "precondition: the instance is wedged");

        const statement = buildAdjudicationStatement(
          {
            completedAt: "2026-08-21T04:00:00.000Z",
            connectorInstanceId: "cin_admit",
            expectedState: "running",
            myEpoch: SUCCESSOR_EPOCH,
            runId: "run_admit_old",
            terminalReason: "controller_terminated",
          },
          backend.name === "postgres" ? "postgres" : "sqlite"
        );
        await backend.exec(statement.sql, statement.params);

        // The 409 `active_run_exists` path must be gone, and a real new run
        // must then be admissible on the same instance.
        assert.equal(await admissionBlocked(backend, "cin_admit"), false);
        await seedRun(backend, {
          connectorInstanceId: "cin_admit",
          ownerEpoch: SUCCESSOR_EPOCH,
          runId: "run_admit_new",
          status: "running",
        });
        const fresh = await readRun(backend, "run_admit_new", "cin_admit");
        assert.equal(fresh?.status, "running", "a new run must be admissible after adjudication");
      });

      await t.test("the durable projection never claims running against a terminal event log", async () => {
        // The zombie-row condition measured on UAT: 7 of 8 rows claiming
        // `running` while each already carried a `run.abandoned` event. The
        // adjudication statement moves the projection in the same statement
        // that claims the row, so the two cannot disagree by construction.
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_zombie",
          ownerEpoch: RETIRED_EPOCH,
          runId: "run_zombie",
          status: "running",
        });

        const statement = buildAdjudicationStatement(
          {
            completedAt: "2026-08-21T04:00:00.000Z",
            connectorInstanceId: "cin_zombie",
            expectedState: "running",
            myEpoch: SUCCESSOR_EPOCH,
            runId: "run_zombie",
            terminalReason: "controller_terminated",
          },
          backend.name === "postgres" ? "postgres" : "sqlite"
        );
        // One statement writes both the status and the claiming epoch, so
        // there is no window in which the projection says `running` while the
        // run has been adjudicated.
        assert.match(statement.sql, /SET status =/u);
        assert.match(statement.sql, /owner_epoch =/u);

        await backend.exec(statement.sql, statement.params);
        const after = await readRun(backend, "run_zombie", "cin_zombie");
        assert.equal(after?.status, "abandoned");
        assert.equal(after?.owner_epoch, SUCCESSOR_EPOCH, "the adjudicator must stamp its own epoch");
      });

      await t.test("a terminal state is reachable from every non-terminal state", () => {
        // F6 as a reachability property of the table itself: "wedged forever"
        // must be unrepresentable, so every non-terminal state needs at least
        // one outgoing edge to a terminal one.
        for (const state of NON_TERMINAL) {
          const targets = [
            ...legalTargetsFrom(state, "executor"),
            ...legalTargetsFrom(state, "boot_adjudicator"),
          ];
          const terminalTargets = targets.filter((target) => isTerminalRunState(target));
          assert.ok(
            terminalTargets.length > 0,
            `${state} has no legal transition to any terminal state; a run there could wedge forever`
          );
          // And `abandoned` specifically must always be reachable, because it
          // is the one the boot adjudicator can reach without the owner.
          assert.equal(
            evaluateTransition({ actor: "boot_adjudicator", from: state, to: "abandoned" }).legal,
            true,
            `${state} must be adjudicable to abandoned by a successor`
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
  test("run lifecycle: no permanent wedge [postgres]", { skip: "PDPP_TEST_POSTGRES_URL not configured" }, () => {
    // Skipped rather than absent: a single-backend pass is a failure.
  });
}
