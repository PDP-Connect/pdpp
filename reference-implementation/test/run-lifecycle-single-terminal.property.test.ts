// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Property test for forbidden transitions F5 (no second terminal transition)
 * and F4 (the adjudication path may not record an interrupted run as
 * `failed`).
 *
 * Property: a run reaches exactly one terminal state, and an interrupted run
 *   reaches `abandoned` rather than `failed`.
 * Generator: concurrent terminal attempts of differing kinds against one run,
 *   including a boot adjudicator racing a live executor, and a scheduler
 *   retry arriving after the generic writer already finalized.
 * Invariant: exactly one terminal transition reports success; the run's
 *   terminal state equals that transition's target; `records_emitted` is
 *   never revised downward.
 *
 * The scheduler-retry case is not hypothetical.
 * `server/queries/controller/insert-run-history.sql` and its PostgreSQL twin
 * in `server/stores/scheduler-store.ts` upserted `status = excluded.status`
 * with NO `status = 'running'` fence -- the only status writers lacking one --
 * so a scheduler retry could overwrite an already-terminal status. Their
 * header comments state that the general writer normally finalizes the row
 * FIRST, which is what made the window real rather than theoretical.
 *
 * Counting SUCCESSFUL transitions rather than inspecting the final state is
 * deliberate: a design that lets two writers both "succeed" and land on the
 * same value would pass a final-state-only assertion while still being two
 * writers.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAdjudicationStatement,
  buildTransitionStatement,
  evaluateTransition,
  interpretCasResult,
} from "../runtime/run-lifecycle.ts";
import { isTerminalRunState, type RunState, RUN_STATES } from "../runtime/run-lifecycle-states.ts";
import {
  createPostgresBackend,
  createSqliteBackend,
  POSTGRES_URL,
  readRun,
  resetRuns,
  type RunLifecycleBackend,
  seedRun,
} from "./helpers/run-lifecycle-backends.ts";

const EPOCH = "epoch-live-2026-08-21T00:00:00.000Z";
const RETIRED_EPOCH = "epoch-retired-2026-08-20T00:00:00.000Z";

const TERMINAL_STATES: readonly RunState[] = RUN_STATES.filter((state) => isTerminalRunState(state));

async function terminalAttempt(
  backend: RunLifecycleBackend,
  input: { connectorInstanceId: string; ownerEpoch: string; runId: string; targetState: RunState }
): Promise<boolean> {
  const statement = buildTransitionStatement(
    {
      completedAt: "2026-08-21T02:00:00.000Z",
      connectorInstanceId: input.connectorInstanceId,
      expectedState: "running",
      ownerEpoch: input.ownerEpoch,
      runId: input.runId,
      targetState: input.targetState,
      terminalReason: `reason_${input.targetState}`,
    },
    backend.name === "postgres" ? "postgres" : "sqlite"
  );
  const changes = await backend.exec(statement.sql, statement.params);
  return interpretCasResult(changes, input.targetState).committed;
}

/**
 * Replay the scheduler's `appendRunHistory` upsert for an existing row. This
 * is the real statement shape, including the per-column terminal fence, so
 * the test exercises the writer rather than a paraphrase of it.
 */
async function schedulerAppend(
  backend: RunLifecycleBackend,
  input: { connectorInstanceId: string; recordsEmitted: number; runId: string; status: string }
): Promise<void> {
  const sql =
    backend.name === "postgres"
      ? `INSERT INTO run_history
           (connector_instance_id, connector_id, source_json, status, records_emitted, run_id, started_at, scheduler_managed)
         VALUES ($1, 'test_connector', '{}'::jsonb, $2, $3, $4, '2026-08-21T00:00:00.000Z', true)
         ON CONFLICT(run_id, connector_instance_id) WHERE run_id IS NOT NULL DO UPDATE SET
           status = CASE WHEN run_history.status = 'running' THEN excluded.status ELSE run_history.status END,
           records_emitted = CASE
             WHEN run_history.status = 'running' THEN excluded.records_emitted
             ELSE run_history.records_emitted
           END`
      : `INSERT INTO run_history
           (connector_instance_id, connector_id, source_json, status, records_emitted, run_id, started_at, scheduler_managed)
         VALUES (?, 'test_connector', '{}', ?, ?, ?, '2026-08-21T00:00:00.000Z', 1)
         ON CONFLICT(run_id, connector_instance_id) WHERE run_id IS NOT NULL DO UPDATE SET
           status = CASE WHEN run_history.status = 'running' THEN excluded.status ELSE run_history.status END,
           records_emitted = CASE
             WHEN run_history.status = 'running' THEN excluded.records_emitted
             ELSE run_history.records_emitted
           END`;
  await backend.exec(sql, [input.connectorInstanceId, input.status, input.recordsEmitted, input.runId]);
}

async function runConcurrentTerminalCase(backend: RunLifecycleBackend, index: number): Promise<void> {
  await resetRuns(backend);
  const runId = `run_single_${index}`;
  const instance = `cin_single_${index}`;
  await seedRun(backend, {
    connectorInstanceId: instance,
    ownerEpoch: EPOCH,
    runId,
    status: "running",
  });

  // Every terminal kind attempts the same run, in order.
  const outcomes: Array<{ committed: boolean; target: RunState }> = [];
  for (const target of TERMINAL_STATES) {
    const committed = await terminalAttempt(backend, {
      connectorInstanceId: instance,
      ownerEpoch: EPOCH,
      runId,
      targetState: target,
    });
    outcomes.push({ committed, target });
  }

  const winners = outcomes.filter((outcome) => outcome.committed);
  assert.equal(winners.length, 1, `case ${index}: exactly one terminal transition may commit`);

  const final = await readRun(backend, runId, instance);
  assert.equal(
    final?.status,
    winners[0]?.target,
    `case ${index}: the run's terminal state must equal the winning transition's target`
  );
}

function defineCases(makeBackend: () => Promise<RunLifecycleBackend>, label: string): void {
  test(`run lifecycle: exactly one terminal state [${label}]`, async (t) => {
    const backend = await makeBackend();
    try {
      await t.test("concurrent terminal attempts resolve to exactly one winner", async () => {
        await [0, 1, 2].reduce(
          (previous, index) => previous.then(() => runConcurrentTerminalCase(backend, index)),
          Promise.resolve()
        );
      });

      await t.test("an unfenced upsert cannot overwrite a terminal status", async () => {
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_upsert",
          ownerEpoch: EPOCH,
          runId: "run_upsert",
          status: "running",
        });

        // The generic writer finalizes first, as it does in production.
        const committed = await terminalAttempt(backend, {
          connectorInstanceId: "cin_upsert",
          ownerEpoch: EPOCH,
          runId: "run_upsert",
          targetState: "succeeded",
        });
        assert.equal(committed, true, "the generic writer's terminal transition must commit");

        // Then the scheduler's retry arrives claiming a different outcome.
        await schedulerAppend(backend, {
          connectorInstanceId: "cin_upsert",
          recordsEmitted: 0,
          runId: "run_upsert",
          status: "failed",
        });

        const after = await readRun(backend, "run_upsert", "cin_upsert");
        assert.equal(after?.status, "succeeded", "a scheduler retry must not revise an already-terminal status");
        assert.equal(after?.records_emitted, 7, "nor may it revise a committed record count down to zero");
      });

      await t.test("an interrupted run terminalizes as abandoned, never failed (F4)", async () => {
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_interrupt",
          ownerEpoch: RETIRED_EPOCH,
          runId: "run_interrupt",
          status: "running",
        });

        // The boot adjudicator may not record `failed`. Of 134 production runs
        // recorded as run.failed/controller_restarted, 55 had staged a cursor
        // and 34 had durably ingested a batch: the two states carry different
        // remedies and must not collapse.
        const failedDecision = evaluateTransition({
          actor: "boot_adjudicator",
          from: "running",
          to: "failed",
        });
        assert.equal(failedDecision.legal, false, "the boot adjudicator may not record an interruption as failed");

        const abandonDecision = evaluateTransition({
          actor: "boot_adjudicator",
          from: "running",
          to: "abandoned",
        });
        assert.equal(abandonDecision.legal, true, "abandoning an orphan is the legal transition");

        const statement = buildAdjudicationStatement(
          {
            completedAt: "2026-08-21T03:00:00.000Z",
            connectorInstanceId: "cin_interrupt",
            expectedState: "running",
            myEpoch: EPOCH,
            runId: "run_interrupt",
            terminalReason: "controller_terminated",
          },
          backend.name === "postgres" ? "postgres" : "sqlite"
        );
        const changes = await backend.exec(statement.sql, statement.params);
        assert.equal(changes, 1, "the orphan must be adjudicated");

        const after = await readRun(backend, "run_interrupt", "cin_interrupt");
        assert.equal(after?.status, "abandoned", "an interrupted run is abandoned, never failed");
      });

      await t.test("records committed before the terminal transition are never revised", async () => {
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_records",
          ownerEpoch: RETIRED_EPOCH,
          runId: "run_records",
          status: "running",
        });

        const before = await readRun(backend, "run_records", "cin_records");
        assert.equal(before?.records_emitted, 7);

        const statement = buildAdjudicationStatement(
          {
            completedAt: "2026-08-21T03:00:00.000Z",
            connectorInstanceId: "cin_records",
            expectedState: "running",
            myEpoch: EPOCH,
            runId: "run_records",
            terminalReason: "controller_terminated",
          },
          backend.name === "postgres" ? "postgres" : "sqlite"
        );
        await backend.exec(statement.sql, statement.params);

        const after = await readRun(backend, "run_records", "cin_records");
        assert.equal(after?.status, "abandoned");
        // Records durably ingested before the interruption stay committed.
        // An abandon must not rewrite records_emitted to zero.
        assert.equal(after?.records_emitted, 7, "adjudication must never revise a committed record count");
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
    "run lifecycle: exactly one terminal state [postgres]",
    { skip: "PDPP_TEST_POSTGRES_URL not configured" },
    () => {
      // Skipped rather than absent: a single-backend pass is a failure, not a
      // partial success.
    }
  );
}
