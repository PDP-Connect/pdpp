// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `run.started` must stamp `run_history.owner_epoch`.
 *
 * Why this is the FIRST writer cutover, and why nothing else can precede it
 * -----------------------------------------------------------------------
 * `run_history.owner_epoch` shipped as a column on both backends, and
 * `runtime/run-lifecycle.ts` builds every CAS around it. But no production
 * writer ever set it, so in the live database the column is uniformly NULL —
 * on live runs as much as on orphans.
 *
 * That makes the adjudication fence a no-op in exactly the wrong direction.
 * `buildAdjudicationStatement`'s predicate is
 *
 *     (owner_epoch IS NULL OR owner_epoch <> $myEpoch)
 *
 * and the `IS NULL` arm is correct by design: a legacy row written before the
 * column existed has no claimant, so any epoch may adjudicate it. Against an
 * all-NULL column, though, that arm matches EVERY row, including runs a live
 * process started seconds ago. Cutting adjudication over before this commit
 * would declare live work abandoned and free its connection for a competing
 * run — the duplicate-execution hazard the fence exists to prevent, delivered
 * by the fence itself.
 *
 * Measured directly against the shipped statement builder before this change:
 * a `running` row with `owner_epoch IS NULL` was adjudicated (changes=1).
 * After stamping, the same statement adjudicates a retired-epoch row
 * (changes=1) and spares a current-epoch row (changes=0). Both cases are
 * asserted below, so the ordering constraint is enforced by a test rather
 * than remembered by a person.
 *
 * The stamp source is not invented here. Every `run.started` already carries
 * `data.boot_epoch`, and `lib/spine.ts`'s `assertRunStartedIsStamped` rejects
 * emissions that lack it — so the writer has a guaranteed, spine-enforced
 * value to persist rather than a best-effort one.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildAdjudicationStatement } from "../runtime/run-lifecycle.ts";
import {
  createPostgresBackend,
  createSqliteBackend,
  POSTGRES_URL,
  type RunLifecycleBackend,
} from "./helpers/run-lifecycle-backends.ts";

const BOOT_EPOCH = "epoch-current-2026-08-21T12:00:00.000Z";
const RETIRED_EPOCH = "epoch-retired-2026-08-20T00:00:00.000Z";

async function readEpoch(
  backend: RunLifecycleBackend,
  runId: string,
  connectorInstanceId: string
): Promise<string | null> {
  const sql =
    backend.name === "postgres"
      ? "SELECT owner_epoch FROM run_history WHERE run_id = $1 AND connector_instance_id = $2"
      : "SELECT owner_epoch FROM run_history WHERE run_id = ? AND connector_instance_id = ?";
  const rows = await backend.query<{ owner_epoch: string | null }>(sql, [runId, connectorInstanceId]);
  return rows[0]?.owner_epoch ?? null;
}

function defineCases(makeBackend: () => Promise<RunLifecycleBackend>, label: string): void {
  test(`run.started stamps owner_epoch [${label}]`, async (t) => {
    const backend = await makeBackend();
    const dialect = backend.name === "postgres" ? "postgres" : "sqlite";
    try {
      await t.test("a started run carries the emitting process's epoch", async () => {
        await backend.exec("DELETE FROM run_history", []);
        const { writeRunHistoryForTest } = await import("./helpers/run-history-write.ts");
        await writeRunHistoryForTest(backend, {
          connectorId: "c_stamp",
          connectorInstanceId: "cin_stamp",
          data: { boot_epoch: BOOT_EPOCH, connector_instance_id: "cin_stamp", seq: 1 },
          eventType: "run.started",
          occurredAt: "2026-08-21T12:00:00.000Z",
          runId: "run_stamp",
          status: "started",
        });

        assert.equal(
          await readEpoch(backend, "run_stamp", "cin_stamp"),
          BOOT_EPOCH,
          "run.started must persist data.boot_epoch into run_history.owner_epoch"
        );
      });

      await t.test("adjudication SPARES a run stamped with the current epoch", async () => {
        // The case that was broken before stamping. This is live work.
        const statement = buildAdjudicationStatement(
          {
            completedAt: "2026-08-21T13:00:00.000Z",
            connectorInstanceId: "cin_stamp",
            expectedState: "running",
            myEpoch: BOOT_EPOCH,
            runId: "run_stamp",
            terminalReason: "controller_terminated_before_run_finished",
          },
          dialect
        );
        assert.equal(
          await backend.exec(statement.sql, statement.params),
          0,
          "a run owned by the CURRENT epoch is live work and must never be adjudicated"
        );
      });

      await t.test("adjudication CLAIMS a run stamped with a retired epoch", async () => {
        // The companion direction. Without it, a fence that spared
        // everything would pass the assertion above by doing nothing.
        await backend.exec("DELETE FROM run_history", []);
        const { writeRunHistoryForTest } = await import("./helpers/run-history-write.ts");
        await writeRunHistoryForTest(backend, {
          connectorId: "c_orphan",
          connectorInstanceId: "cin_orphan",
          data: { boot_epoch: RETIRED_EPOCH, connector_instance_id: "cin_orphan", seq: 1 },
          eventType: "run.started",
          occurredAt: "2026-08-20T00:00:00.000Z",
          runId: "run_orphan",
          status: "started",
        });

        const statement = buildAdjudicationStatement(
          {
            completedAt: "2026-08-21T13:00:00.000Z",
            connectorInstanceId: "cin_orphan",
            expectedState: "running",
            myEpoch: BOOT_EPOCH,
            runId: "run_orphan",
            terminalReason: "controller_terminated_before_run_finished",
          },
          dialect
        );
        assert.equal(
          await backend.exec(statement.sql, statement.params),
          1,
          "a run owned by a RETIRED epoch is an orphan and must be adjudicated"
        );
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
  test("run.started stamps owner_epoch [postgres]", { skip: "PDPP_TEST_POSTGRES_URL not configured" }, () => {
    // Skipped rather than absent: a single-backend pass is a failure.
  });
}
