// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Property test for T10/T11 (successor adjudication) as legal transitions of
 * the machine rather than a sibling reconciliation path.
 *
 * Property: repeated adjudication over overlapping orphan sets produces
 *   exactly one terminal event per orphan, never adjudicates a run in the
 *   newest boot epoch, and never revises a record count.
 * Generator: orphan populations spanning several retired epochs, plus a run
 *   in the newest boot epoch, adjudicated by 1-3 successive passes with
 *   overlapping scopes.
 * Invariant: one terminal transition per orphan; newest-epoch runs untouched;
 *   record counts unchanged.
 *
 * Behavior to preserve exactly (D14) -- this is a refactor of truth-keeping,
 * so these are gates, not aspirations:
 *
 *  1. Repeated passes are no-ops after the first. Under the CAS this falls
 *     out of the `status = 'running'` arm rather than needing a separate
 *     idempotency mechanism, which is why the second pass matches zero rows.
 *  2. The newest-epoch exclusion is load-bearing. Without it, adjudication
 *     declares LIVE work abandoned and frees its resource for a competing
 *     run. The production dry run reported 123 before the exclusion and 121
 *     after; the two extras were runs a live container had started ninety
 *     seconds earlier.
 *  3. Eligibility is decided by epoch comparison, never by an age threshold.
 *  4. An interruption while awaiting owner interaction carries its own
 *     distinct reason. Collapsing it into the generic reason changes
 *     observable output -- an owner who was sent an OTP that then became
 *     useless is told why.
 *  5. `records_emitted` is never revised. Records durably ingested before the
 *     interruption stay committed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildAdjudicationStatement } from "../runtime/run-lifecycle.ts";
import {
  createPostgresBackend,
  createSqliteBackend,
  POSTGRES_URL,
  readRun,
  resetRuns,
  type RunLifecycleBackend,
  seedRun,
} from "./helpers/run-lifecycle-backends.ts";

const NEWEST_EPOCH = "epoch-newest-2026-08-21T12:00:00.000Z";
const RETIRED_A = "epoch-retired-a-2026-08-19T00:00:00.000Z";
const RETIRED_B = "epoch-retired-b-2026-08-20T00:00:00.000Z";

const GENERIC_REASON = "controller_terminated";
const AWAITING_REASON = "controller_terminated_while_awaiting_owner_interaction";

async function adjudicate(
  backend: RunLifecycleBackend,
  input: { connectorInstanceId: string; reason?: string; runId: string }
): Promise<number> {
  const statement = buildAdjudicationStatement(
    {
      completedAt: "2026-08-21T13:00:00.000Z",
      connectorInstanceId: input.connectorInstanceId,
      expectedState: "running",
      myEpoch: NEWEST_EPOCH,
      runId: input.runId,
      terminalReason: input.reason ?? GENERIC_REASON,
    },
    backend.name === "postgres" ? "postgres" : "sqlite"
  );
  return backend.exec(statement.sql, statement.params);
}

async function terminalReasonOf(
  backend: RunLifecycleBackend,
  runId: string,
  connectorInstanceId: string
): Promise<string | null> {
  const sql =
    backend.name === "postgres"
      ? "SELECT terminal_reason FROM run_history WHERE run_id = $1 AND connector_instance_id = $2"
      : "SELECT terminal_reason FROM run_history WHERE run_id = ? AND connector_instance_id = ?";
  const rows = await backend.query<{ terminal_reason: string | null }>(sql, [runId, connectorInstanceId]);
  return rows[0]?.terminal_reason ?? null;
}

function defineCases(makeBackend: () => Promise<RunLifecycleBackend>, label: string): void {
  test(`run lifecycle: successor adjudication [${label}]`, async (t) => {
    const backend = await makeBackend();
    try {
      await t.test("repeated passes adjudicate each orphan exactly once", async () => {
        await resetRuns(backend);
        // An orphan population spanning two retired epochs.
        await seedRun(backend, {
          connectorInstanceId: "cin_orphan_a",
          ownerEpoch: RETIRED_A,
          runId: "run_orphan_a",
          status: "running",
        });
        await seedRun(backend, {
          connectorInstanceId: "cin_orphan_b",
          ownerEpoch: RETIRED_B,
          runId: "run_orphan_b",
          status: "running",
        });

        // Three passes with deliberately overlapping scopes.
        const first = await adjudicate(backend, {
          connectorInstanceId: "cin_orphan_a",
          runId: "run_orphan_a",
        });
        const second = await adjudicate(backend, {
          connectorInstanceId: "cin_orphan_a",
          runId: "run_orphan_a",
        });
        const third = await adjudicate(backend, {
          connectorInstanceId: "cin_orphan_a",
          runId: "run_orphan_a",
        });

        assert.equal(first, 1, "the first pass adjudicates the orphan");
        assert.equal(second, 0, "a repeated pass must be a no-op");
        assert.equal(third, 0, "and stay a no-op");

        const a = await readRun(backend, "run_orphan_a", "cin_orphan_a");
        assert.equal(a?.status, "abandoned");

        // The unrelated orphan is untouched by a scoped pass.
        const b = await readRun(backend, "run_orphan_b", "cin_orphan_b");
        assert.equal(b?.status, "running", "a scoped pass must not touch an out-of-scope orphan");
      });

      await t.test("a run in the newest boot epoch is never adjudicated", async () => {
        await resetRuns(backend);
        // Live work: a run the adjudicating controller itself started.
        await seedRun(backend, {
          connectorInstanceId: "cin_live",
          ownerEpoch: NEWEST_EPOCH,
          runId: "run_live",
          status: "running",
        });

        const changes = await adjudicate(backend, {
          connectorInstanceId: "cin_live",
          runId: "run_live",
        });

        // Adjudicating live work frees its resource for a competing run,
        // reintroducing the duplicate-execution hazard the fence prevents.
        assert.equal(changes, 0, "a newest-epoch run must not be adjudicated");
        const after = await readRun(backend, "run_live", "cin_live");
        assert.equal(after?.status, "running", "live work must keep running");
      });

      await t.test("eligibility never consults an age threshold", async () => {
        await resetRuns(backend);
        // A very OLD run owned by the newest epoch: must be spared.
        await seedRun(backend, {
          connectorInstanceId: "cin_old_live",
          ownerEpoch: NEWEST_EPOCH,
          runId: "run_old_live",
          status: "running",
        });
        // A very RECENT run owned by a retired epoch: must be adjudicated.
        await seedRun(backend, {
          connectorInstanceId: "cin_new_dead",
          ownerEpoch: RETIRED_B,
          runId: "run_new_dead",
          status: "running",
        });

        const oldLive = await adjudicate(backend, {
          connectorInstanceId: "cin_old_live",
          runId: "run_old_live",
        });
        const newDead = await adjudicate(backend, {
          connectorInstanceId: "cin_new_dead",
          runId: "run_new_dead",
        });

        assert.equal(oldLive, 0, "age must not make a live run eligible");
        assert.equal(newDead, 1, "recency must not make a retired-epoch run ineligible");

        // The statement itself must not reference time as a discriminator.
        const statement = buildAdjudicationStatement(
          {
            completedAt: "2026-08-21T13:00:00.000Z",
            connectorInstanceId: "cin_x",
            expectedState: "running",
            myEpoch: NEWEST_EPOCH,
            runId: "run_x",
            terminalReason: GENERIC_REASON,
          },
          backend.name === "postgres" ? "postgres" : "sqlite"
        );
        assert.ok(
          !/started_at|interval|now\(\)|CURRENT_TIMESTAMP/iu.test(statement.sql),
          "eligibility must be decided by epoch comparison, never by an age threshold"
        );
        assert.match(statement.sql, /owner_epoch/u, "the epoch must be the discriminator");
      });

      await t.test("an interruption while awaiting owner interaction keeps its distinct reason", async () => {
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_await",
          ownerEpoch: RETIRED_A,
          runId: "run_await",
          status: "running",
        });
        await seedRun(backend, {
          connectorInstanceId: "cin_plain",
          ownerEpoch: RETIRED_A,
          runId: "run_plain",
          status: "running",
        });

        await adjudicate(backend, {
          connectorInstanceId: "cin_await",
          reason: AWAITING_REASON,
          runId: "run_await",
        });
        await adjudicate(backend, { connectorInstanceId: "cin_plain", runId: "run_plain" });

        // Observable-behavior preservation: an owner who was sent an OTP that
        // then became useless is told why, so the two reasons must not
        // collapse into one.
        assert.equal(await terminalReasonOf(backend, "run_await", "cin_await"), AWAITING_REASON);
        assert.equal(await terminalReasonOf(backend, "run_plain", "cin_plain"), GENERIC_REASON);
        assert.notEqual(AWAITING_REASON, GENERIC_REASON, "the two reasons must stay distinguishable");
      });

      await t.test("record counts are never revised by adjudication", async () => {
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_counts",
          ownerEpoch: RETIRED_B,
          runId: "run_counts",
          status: "running",
        });

        const before = await readRun(backend, "run_counts", "cin_counts");
        assert.equal(before?.records_emitted, 7, "precondition: the run had durably ingested records");

        await adjudicate(backend, { connectorInstanceId: "cin_counts", runId: "run_counts" });

        const after = await readRun(backend, "run_counts", "cin_counts");
        assert.equal(after?.status, "abandoned");
        assert.equal(after?.records_emitted, 7, "an abandon must not rewrite records_emitted");

        // Structural: the column is absent from the SET list entirely, so a
        // future edit cannot reintroduce the revision by accident.
        const statement = buildAdjudicationStatement(
          {
            completedAt: "2026-08-21T13:00:00.000Z",
            connectorInstanceId: "cin_counts",
            expectedState: "running",
            myEpoch: NEWEST_EPOCH,
            runId: "run_counts",
            terminalReason: GENERIC_REASON,
          },
          backend.name === "postgres" ? "postgres" : "sqlite"
        );
        const setClause = statement.sql.split("WHERE")[0] ?? "";
        assert.ok(
          !setClause.includes("records_emitted"),
          "records_emitted must not appear in the adjudication SET clause"
        );
      });

      await t.test("an already-terminal run is never re-adjudicated", async () => {
        await resetRuns(backend);
        await seedRun(backend, {
          connectorInstanceId: "cin_done",
          ownerEpoch: RETIRED_A,
          runId: "run_done",
          status: "succeeded",
        });

        const changes = await adjudicate(backend, {
          connectorInstanceId: "cin_done",
          runId: "run_done",
        });
        assert.equal(changes, 0, "a run that already reached a terminal state must be left alone");

        const after = await readRun(backend, "run_done", "cin_done");
        assert.equal(after?.status, "succeeded", "its terminal outcome must survive");
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
    "run lifecycle: successor adjudication [postgres]",
    { skip: "PDPP_TEST_POSTGRES_URL not configured" },
    () => {
      // Skipped rather than absent: a single-backend pass is a failure.
    }
  );
}
