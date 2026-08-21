// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-time orphan reconciliation must terminalise the `run_history`
 * projection, not only the spine.
 *
 * A run whose controller died leaves `run_history.status = 'running'`
 * forever unless the abandon is projected. That stale row is not
 * cosmetic: `getActiveRun` reads it, so a new run on the same connection
 * is refused with 409 `active_run_exists`, and the stream's coverage
 * checkpoint never leaves not_staged/not_committed.
 *
 * Design contract: docs/run-reconciliation-design-brief.md §3.4 / Stage 6.
 */

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
import Database from "better-sqlite3";
import { emitControllerBootedAndStashEpoch, reconcileOrphanedRunsAtBoot } from "../lib/controller-boot.ts";
import { clearCurrentBootEpoch } from "../lib/spine.ts";
import { closeDb, initDb } from "../server/db.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const CONNECTOR_ID = "acme";
const INSTANCE_ID = "cin_0123456789abcdef01234567";

/**
 * Seed the pair a live run actually writes: the `run.started` spine event
 * (carrying its connection identity, as `emitSpineEvent` requires) and the
 * `run_history` row that event's projection creates. `records_emitted` is
 * seeded non-zero so the retention assertion has something to lose.
 */
function seedRunningRun(
  dbPath: string,
  { event_id, run_id, records_emitted = 0 }: { event_id: string; records_emitted?: number; run_id: string }
) {
  const raw = new Database(dbPath);
  try {
    const ts = "2026-05-10T12:00:00.000Z";
    raw
      .prepare(
        `
      INSERT INTO spine_events
        (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id,
         source_kind, source_id, connector_instance_id, data_json, version)
      VALUES (?, 'run.started', ?, ?, 'default', 'trc_seed', 'runtime', ?, 'run', ?, 'started', ?,
              'connector', ?, ?, ?, 'v1')
      `
      )
      .run(
        event_id,
        ts,
        ts,
        CONNECTOR_ID,
        run_id,
        run_id,
        CONNECTOR_ID,
        INSTANCE_ID,
        JSON.stringify({ connection_id: INSTANCE_ID, connector_instance_id: INSTANCE_ID })
      );
    raw
      .prepare(
        `
      INSERT INTO run_history
        (run_id, connector_instance_id, connector_id, trigger_kind, source_json,
         status, known_gaps_json, started_at, records_emitted, attempt)
      VALUES (?, ?, ?, 'manual', '{}', 'running', '[]', ?, ?, 1)
      `
      )
      .run(run_id, INSTANCE_ID, CONNECTOR_ID, ts, records_emitted);
  } finally {
    raw.close();
  }
}

function readRunHistory(dbPath: string, runId: string) {
  const raw = new Database(dbPath);
  try {
    return raw
      .prepare("SELECT status, terminal_reason, completed_at, records_emitted FROM run_history WHERE run_id = ?")
      .get(runId) as
      | { completed_at: string | null; records_emitted: number; status: string; terminal_reason: string | null }
      | undefined;
  } finally {
    raw.close();
  }
}

test("boot reconciliation terminalises an orphaned run_history row with a typed reason", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    seedRunningRun(dbPath, { event_id: "evt_orphan_proj_1", run_id: "run_orphan_proj_1" });

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-epoch-proj-1",
      controllerId: "host-test",
    });
    await reconcileOrphanedRunsAtBoot(epoch);

    const row = readRunHistory(dbPath, "run_orphan_proj_1");
    assert.ok(row, "seeded run_history row should still exist");
    assert.equal(row.status, "abandoned", "an orphaned run must not stay 'running' after boot reconciliation");
    // Honest and typed — never silently deleted, never left running.
    assert.equal(row.terminal_reason, "controller_terminated_before_run_finished");
    assert.ok(row.completed_at, "a terminalised run must carry a completion timestamp");
  } finally {
    closeDb();
    clearCurrentBootEpoch();
  }
});

test("boot reconciliation retains records already committed by the orphaned run", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    seedRunningRun(dbPath, { event_id: "evt_orphan_proj_2", records_emitted: 42, run_id: "run_orphan_proj_2" });

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-epoch-proj-2",
      controllerId: "host-test",
    });
    await reconcileOrphanedRunsAtBoot(epoch);

    const row = readRunHistory(dbPath, "run_orphan_proj_2");
    assert.ok(row, "seeded run_history row should still exist");
    assert.equal(row.status, "abandoned");
    // Per the RI-owner ruling, valid collected records always stay committed:
    // terminalising the run must not revise its yield down to the
    // reconciler's own zero.
    assert.equal(row.records_emitted, 42, "records already committed by the run must survive reconciliation");
  } finally {
    closeDb();
    clearCurrentBootEpoch();
  }
});

test("boot reconciliation leaves a run from the CURRENT incarnation running", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-epoch-proj-3",
      controllerId: "host-test",
    });
    // Stamped with THIS boot's epoch — the counterweight. A genuinely
    // active run must survive reconciliation untouched; over-correcting
    // here would kill live runs.
    const raw = new Database(dbPath);
    try {
      const ts = "2026-05-10T12:00:00.000Z";
      raw
        .prepare(
          `
        INSERT INTO spine_events
          (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id,
           source_kind, source_id, connector_instance_id, data_json, version)
        VALUES (?, 'run.started', ?, ?, 'default', 'trc_live', 'runtime', ?, 'run', ?, 'started', ?,
                'connector', ?, ?, ?, 'v1')
        `
        )
        .run(
          "evt_live_proj_3",
          ts,
          ts,
          CONNECTOR_ID,
          "run_live_proj_3",
          "run_live_proj_3",
          CONNECTOR_ID,
          INSTANCE_ID,
          JSON.stringify({
            boot_epoch: epoch.boot_epoch,
            connection_id: INSTANCE_ID,
            connector_instance_id: INSTANCE_ID,
            controller_id: epoch.controller_id,
            seq: epoch.seq,
          })
        );
      raw
        .prepare(
          `
        INSERT INTO run_history
          (run_id, connector_instance_id, connector_id, trigger_kind, source_json,
           status, known_gaps_json, started_at, records_emitted, attempt)
        VALUES (?, ?, ?, 'manual', '{}', 'running', '[]', ?, 0, 1)
        `
        )
        .run("run_live_proj_3", INSTANCE_ID, CONNECTOR_ID, ts);
    } finally {
      raw.close();
    }

    await reconcileOrphanedRunsAtBoot(epoch);

    const row = readRunHistory(dbPath, "run_live_proj_3");
    assert.ok(row, "the live run's row should still exist");
    assert.equal(row.status, "running", "a run owned by the current incarnation must NOT be terminalised");
    assert.equal(row.terminal_reason, null);
  } finally {
    closeDb();
    clearCurrentBootEpoch();
  }
});

test("boot reconciliation repairs a run_history row left running against an already-terminal spine", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    // The live shape: a prior raw-INSERT abandon terminalised the spine but
    // never projected, so the row still claims `running`. The orphan SELECT
    // skips this run precisely BECAUSE it already has a terminal event, so
    // only the drift repair can heal it.
    seedRunningRun(dbPath, { event_id: "evt_drift_1", records_emitted: 7, run_id: "run_drift_1" });
    const raw = new Database(dbPath);
    try {
      const ts = "2026-05-10T13:00:00.000Z";
      raw
        .prepare(
          `
        INSERT INTO spine_events
          (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
        VALUES (?, 'run.abandoned', ?, ?, 'default', 'trc_seed', 'runtime', ?, 'run', ?, 'abandoned', ?, ?, 'v1')
        `
        )
        .run(
          "evt_drift_1_abandon",
          ts,
          ts,
          CONNECTOR_ID,
          "run_drift_1",
          "run_drift_1",
          JSON.stringify({ reason: "controller_terminated_before_run_finished" })
        );
    } finally {
      raw.close();
    }

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-epoch-drift-1",
      controllerId: "host-test",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(result.selected, 0, "an already-terminal run is not an orphan the SELECT can see");
    assert.equal(result.repaired, 1, "drift repair must be what heals it");

    const row = readRunHistory(dbPath, "run_drift_1");
    assert.ok(row, "the drifted row should still exist");
    assert.equal(row.status, "abandoned", "the projection must adopt the spine's terminal status");
    assert.equal(row.terminal_reason, "controller_terminated_before_run_finished");
    assert.equal(row.completed_at, "2026-05-10T13:00:00.000Z", "completion is when the run actually ended");
    assert.equal(row.records_emitted, 7, "repair must not revise a committed yield down to zero");
  } finally {
    closeDb();
    clearCurrentBootEpoch();
  }
});

test("boot reconciliation repairs BOTH connections when two share one run_id", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    // run_id is NOT unique across connections (stores/run-history-writer.ts),
    // and the live instance carried exactly this shape: two connections
    // sharing one run_id, each with its own run_history row. Repair is
    // per-row, so BOTH must be terminalised — a reader that treated run_id
    // as the identity would leave one connection stuck running forever.
    // Duplicate terminal events sharing one occurred_at are seeded too, so
    // the earliest-terminal choice cannot depend on an unstable tie-break.
    const SECOND_INSTANCE_ID = "cin_fedcba9876543210fedcba98";
    const runId = "run_shared_1";
    seedRunningRun(dbPath, { event_id: "evt_shared_1", run_id: runId });
    const raw = new Database(dbPath);
    try {
      const ts = "2026-05-10T12:00:00.000Z";
      raw
        .prepare(
          `
        INSERT INTO run_history
          (run_id, connector_instance_id, connector_id, trigger_kind, source_json,
           status, known_gaps_json, started_at, records_emitted, attempt)
        VALUES (?, ?, ?, 'manual', '{}', 'running', '[]', ?, 0, 1)
        `
        )
        .run(runId, SECOND_INSTANCE_ID, CONNECTOR_ID, ts);
      // Two terminal events sharing one occurred_at — also live-observed, and
      // what makes an unordered tie-break non-deterministic.
      const terminalTs = "2026-05-10T13:00:00.000Z";
      for (const eventId of ["evt_shared_1_abandon_a", "evt_shared_1_abandon_b"]) {
        raw
          .prepare(
            `
          INSERT INTO spine_events
            (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
             actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
          VALUES (?, 'run.abandoned', ?, ?, 'default', 'trc_seed', 'runtime', ?, 'run', ?, 'abandoned', ?, ?, 'v1')
          `
          )
          .run(
            eventId,
            terminalTs,
            terminalTs,
            CONNECTOR_ID,
            runId,
            runId,
            JSON.stringify({ reason: "controller_terminated_before_run_finished" })
          );
      }
    } finally {
      raw.close();
    }

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-epoch-shared-1",
      controllerId: "host-test",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);
    assert.equal(result.repaired, 2, "both connections' rows must be repaired, not just one");

    const rows = readRunHistoryRows(dbPath, runId);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, "abandoned");
      // The regression: one row kept a null reason when the query grouped.
      assert.equal(
        row.terminal_reason,
        "controller_terminated_before_run_finished",
        `connection ${row.connector_instance_id} must carry the terminal reason`
      );
      assert.equal(row.completed_at, "2026-05-10T13:00:00.000Z");
    }
  } finally {
    closeDb();
    clearCurrentBootEpoch();
  }
});

function readRunHistoryRows(dbPath: string, runId: string) {
  const raw = new Database(dbPath);
  try {
    return raw
      .prepare(
        "SELECT connector_instance_id, status, terminal_reason, completed_at FROM run_history WHERE run_id = ? ORDER BY connector_instance_id"
      )
      .all(runId) as {
      completed_at: string | null;
      connector_instance_id: string;
      status: string;
      terminal_reason: string | null;
    }[];
  } finally {
    raw.close();
  }
}

function tempDbPath() {
  return makeTemporaryDbPath("pdpp-boot-recon-proj-");
}

// The durable projection must tell the same story as the spine event for a
// run that died while the owner was still being asked for input. Without
// this, the console would read `controller_terminated_before_run_finished`
// for a run whose owner had already been sent a real, now-useless OTP.
test("boot reconciliation projects the awaiting-owner-interaction reason into run_history", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    seedRunningRun(dbPath, { event_id: "evt_proj_otp", records_emitted: 3, run_id: "run_proj_awaiting_otp" });
    // The connector asked the owner for a code; no terminal interaction event
    // ever followed, so the owner was still being waited on.
    const raw = new Database(dbPath);
    try {
      const ts = "2026-05-10T12:00:05.000Z";
      raw
        .prepare(
          `
        INSERT INTO spine_events
          (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id,
           interaction_id, data_json, version)
        VALUES (?, 'run.interaction_required', ?, ?, 'default', 'trc_seed', 'runtime', ?, 'run', ?, 'started', ?, ?, '{}', 'v1')
        `
        )
        .run("evt_proj_int_req", ts, ts, CONNECTOR_ID, "run_proj_awaiting_otp", "run_proj_awaiting_otp", "int_proj_1");
    } finally {
      raw.close();
    }

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-proj-otp",
      controllerId: "host-test",
    });
    await reconcileOrphanedRunsAtBoot(epoch);

    const row = readRunHistory(dbPath, "run_proj_awaiting_otp");
    assert.ok(row, "run_history row must survive reconciliation");
    assert.equal(row.status, "abandoned");
    assert.equal(
      row.terminal_reason,
      "controller_terminated_while_awaiting_owner_interaction",
      "run_history must carry the same reason as the spine event"
    );
    assert.equal(row.records_emitted, 3, "reconciliation must not discard collected work");
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});
