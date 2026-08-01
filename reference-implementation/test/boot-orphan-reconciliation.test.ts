// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-time orphan reconciliation — end-to-end SQLite tests.
 *
 * Verifies the boot sequence emits `run.abandoned` for orphaned
 * `run.started` events from prior incarnations, idempotently, with
 * correct provenance fields.
 *
 * Design contract: docs/run-reconciliation-design-brief.md §3.4 / Stage 6.
 */

import assert from "node:assert/strict";
import test from "node:test";
// biome-ignore lint/correctness/noUnresolvedImports: Biome resolver lacks this runtime-supported dependency export shape.
import Database from "better-sqlite3";
import { emitControllerBootedAndStashEpoch, reconcileOrphanedRunsAtBoot } from "../lib/controller-boot.ts";
import { RUN_HISTORY_BACKFILL_LIMIT } from "../lib/run-history-terminal-backfill.ts";
import { clearCurrentBootEpoch } from "../lib/spine.ts";
import { closeDb, initDb } from "../server/db.ts";
import { closePostgresStorage, initPostgresStorage, postgresQuery } from "../server/postgres-storage.ts";
import { dedicatedPostgresTestUrl } from "./helpers/dedicated-postgres-test-url.ts";
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

const POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

function tempDbPath() {
  return makeTemporaryDbPath("pdpp-boot-recon-");
}

interface SeedOrphanOpts {
  actor_id: string;
  boot_epoch?: string | null;
  /** When set, also seeds a matching connector_instance_id + a `running` run_history row (Slice A shape). */
  connector_instance_id?: string | null;
  controller_id?: string | null;
  event_id: string;
  run_id: string;
}

/**
 * Seed a `run.started` row directly into spine_events to simulate a
 * legacy orphan (e.g., from a prior process incarnation). When
 * `connector_instance_id` is given, also seeds the run_history "running"
 * row that a real `run.started` emission would have produced via
 * `writeSqliteRunHistoryForSpineEvent` — needed to prove boot
 * reconciliation converges that projection too.
 */
function seedOrphan(
  dbPath: string,
  { event_id, run_id, actor_id, boot_epoch = null, controller_id = null, connector_instance_id = null }: SeedOrphanOpts
) {
  const raw = new Database(dbPath);
  try {
    const ts = "2026-05-10T12:00:00.000Z";
    const data: {
      boot_epoch?: string;
      controller_id?: string;
      seq?: number;
      connector_instance_id?: string;
      connection_id?: string;
    } = {};
    if (boot_epoch) {
      data.boot_epoch = boot_epoch;
    }
    if (controller_id) {
      data.controller_id = controller_id;
    }
    if (boot_epoch) {
      data.seq = 1;
    }
    if (connector_instance_id) {
      data.connector_instance_id = connector_instance_id;
      data.connection_id = connector_instance_id;
    }
    raw
      .prepare(
        `
      INSERT INTO spine_events
        (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
         connector_instance_id, source_kind, source_id)
      VALUES (?, 'run.started', ?, ?, 'default', 'trc_seed', 'runtime', ?, 'run', ?, 'started', ?, ?, 'v1', ?, 'connector', ?)
      `
      )
      .run(event_id, ts, ts, actor_id, run_id, run_id, JSON.stringify(data), connector_instance_id, actor_id);
    if (connector_instance_id) {
      raw
        .prepare(
          `
        INSERT INTO run_history
          (run_id, connector_instance_id, connector_id, trigger_kind, source_json, status, known_gaps_json, started_at, attempt)
        VALUES (?, ?, ?, NULL, '{}', 'running', '[]', ?, 1)
        `
        )
        .run(run_id, connector_instance_id, actor_id, ts);
    }
  } finally {
    raw.close();
  }
}

test("reconciler emits run.abandoned for legacy orphans with no boot_epoch", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    seedOrphan(dbPath, { actor_id: "conn_a", event_id: "evt_orphan_1", run_id: "run_legacy_1" });
    seedOrphan(dbPath, { actor_id: "conn_b", event_id: "evt_orphan_2", run_id: "run_legacy_2" });

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-epoch-1",
      controllerId: "host-test",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(result.selected, 2);
    assert.equal(result.abandoned, 2);

    const raw = new Database(dbPath);
    try {
      const abandons = raw
        .prepare("SELECT run_id, data_json FROM spine_events WHERE event_type = 'run.abandoned' ORDER BY run_id")
        .all() as { run_id: string; data_json: string }[];
      assert.equal(abandons.length, 2);
      assert.deepEqual(
        abandons.map((r) => r.run_id),
        ["run_legacy_1", "run_legacy_2"]
      );
      for (const r of abandons) {
        const d = JSON.parse(r.data_json);
        assert.equal(d.reconciled_by_boot_epoch, "boot-epoch-1");
        assert.equal(d.reconciled_by_controller_id, "host-test");
        assert.equal(d.source, "recovery_worker");
        assert.equal(d.reason, "controller_terminated_before_run_finished");
        assert.ok(d.caused_by_event_id.startsWith("evt_orphan_"));
      }
    } finally {
      raw.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("reconciler does NOT abandon current-epoch runs", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-epoch-now",
      controllerId: "host-test",
    });

    // Seed a run.started carrying THIS boot's epoch — an active run.
    seedOrphan(dbPath, {
      actor_id: "conn_x",
      boot_epoch: "boot-epoch-now",
      controller_id: "host-test",
      event_id: "evt_current",
      run_id: "run_current_1",
    });

    const result = await reconcileOrphanedRunsAtBoot(epoch);
    assert.equal(result.selected, 0);
    assert.equal(result.abandoned, 0);
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("reconciler is idempotent: second call emits no additional events", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    seedOrphan(dbPath, { actor_id: "c", event_id: "evt_orphan_idem", run_id: "run_idem" });

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-epoch-i",
      controllerId: "host-test",
    });

    const r1 = await reconcileOrphanedRunsAtBoot(epoch);
    const r2 = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(r1.abandoned, 1);
    // r2's SELECT returns 0 because the prior-run abandoned event already
    // satisfies the "terminal exists" predicate. abandoned=0.
    assert.equal(r2.selected, 0);
    assert.equal(r2.abandoned, 0);

    const raw = new Database(dbPath);
    try {
      const count = (
        raw.prepare("SELECT count(*) AS n FROM spine_events WHERE event_type = 'run.abandoned'").get() as { n: number }
      ).n;
      assert.equal(count, 1, "expect exactly one run.abandoned despite two reconcile calls");
    } finally {
      raw.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("reconciler preserves the orphan event (append-only invariant)", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    seedOrphan(dbPath, { actor_id: "c", event_id: "evt_orphan_preserve", run_id: "run_p" });

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-epoch-p",
      controllerId: "host-test",
    });
    await reconcileOrphanedRunsAtBoot(epoch);

    const raw = new Database(dbPath);
    try {
      const orphan = raw.prepare("SELECT * FROM spine_events WHERE event_id = ?").get("evt_orphan_preserve") as
        | { event_type: string }
        | undefined;
      assert.ok(orphan, "orphan run.started must still exist");
      assert.equal(orphan.event_type, "run.started");
    } finally {
      raw.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("multi-controller isolation: controller B does NOT abandon controller A orphans", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    // Orphan owned by controller A.
    seedOrphan(dbPath, {
      actor_id: "c",
      boot_epoch: "boot-epoch-A",
      controller_id: "host-A",
      event_id: "evt_a_orphan",
      run_id: "run_a",
    });

    // Boot as controller B.
    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-epoch-B",
      controllerId: "host-B",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(result.selected, 0, "controller B must not see controller A orphans");
    assert.equal(result.abandoned, 0);

    const raw = new Database(dbPath);
    try {
      const count = (
        raw.prepare("SELECT count(*) AS n FROM spine_events WHERE event_type = 'run.abandoned'").get() as { n: number }
      ).n;
      assert.equal(count, 0);
    } finally {
      raw.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("run_id collision: two orphans with same run_id produce two run.abandoned events", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    seedOrphan(dbPath, { actor_id: "c", event_id: "evt_collide_1", run_id: "run_shared" });
    seedOrphan(dbPath, { actor_id: "c", event_id: "evt_collide_2", run_id: "run_shared" });

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-epoch-c",
      controllerId: "host-test",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    // Two distinct orphans by event_id, both selected before any insert
    // (single SELECT-then-INSERT semantics from §3.4). Both get abandoned.
    assert.equal(result.selected, 2);
    assert.equal(result.abandoned, 2);

    const raw = new Database(dbPath);
    try {
      const causes = (
        raw
          .prepare(
            "SELECT json_extract(data_json, '$.caused_by_event_id') AS cause FROM spine_events WHERE event_type = 'run.abandoned' ORDER BY cause"
          )
          .all() as { cause: string }[]
      ).map((r) => r.cause);
      assert.deepEqual(causes, ["evt_collide_1", "evt_collide_2"]);
    } finally {
      raw.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("cross-boot: reconciler picks up orphans from earlier emission", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    // First boot: emit controller.booted but no run.started.
    const epoch1 = await emitControllerBootedAndStashEpoch({
      bootEpoch: "epoch-1",
      controllerId: "host-test",
    });
    assert.equal(epoch1.seq, 1);
    // Simulate a run.started emitted under epoch-1 that never terminates.
    seedOrphan(dbPath, {
      actor_id: "conn",
      boot_epoch: "epoch-1",
      controller_id: "host-test",
      event_id: "evt_cross_boot",
      run_id: "run_cross",
    });
    clearCurrentBootEpoch();

    // Second boot.
    const epoch2 = await emitControllerBootedAndStashEpoch({
      bootEpoch: "epoch-2",
      controllerId: "host-test",
    });
    assert.equal(epoch2.seq, 2, "seq must increment monotonically per controller_id");

    const result = await reconcileOrphanedRunsAtBoot(epoch2);
    assert.equal(result.selected, 1);
    assert.equal(result.abandoned, 1);

    const raw = new Database(dbPath);
    try {
      const abandon = raw.prepare("SELECT data_json FROM spine_events WHERE event_type = 'run.abandoned'").get() as {
        data_json: string;
      };
      const d = JSON.parse(abandon.data_json);
      assert.equal(d.original_boot_epoch, "epoch-1");
      assert.equal(d.reconciled_by_boot_epoch, "epoch-2");
      assert.equal(d.original_controller_id, "host-test");
    } finally {
      raw.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// run_history projection convergence at the same recovery boundary.
//
// Old-fail / new-pass: before this fix, reconcileOrphanedRunsAtBoot wrote
// the spine's `run.abandoned` terminal event but left the corresponding
// run_history row at status='running'/completed_at=NULL forever, because
// the reconciler's raw spine_events INSERT bypassed the writer authority
// (writeSqliteRunHistoryForSpineEvent / writePostgresRunHistoryForSpineEvent)
// that every other terminal event flows through. This aggregate proves the
// spine and run_history projections now converge together, idempotently,
// without disturbing already-terminal or unrelated rows.
// ─────────────────────────────────────────────────────────────────────────

function readRunHistoryStatus(
  dbPath: string,
  runId: string
): { status: string; completed_at: string | null } | undefined {
  const raw = new Database(dbPath);
  try {
    return raw.prepare("SELECT status, completed_at FROM run_history WHERE run_id = ?").get(runId) as
      | { status: string; completed_at: string | null }
      | undefined;
  } finally {
    raw.close();
  }
}

test("SQLite: boot reconciliation converges run_history to terminal status=abandoned", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    // Orphan WITH a run_history row (the bug this closes): the row must
    // flip from status=running/completed_at=NULL to status=abandoned with
    // a completed_at timestamp, at the same boundary as the spine write.
    seedOrphan(dbPath, {
      actor_id: "conn_a",
      connector_instance_id: "cin_orphan_a",
      event_id: "evt_orphan_rh_1",
      run_id: "run_rh_orphan_1",
    });
    // Already-terminal run_history row for an UNRELATED run must be left
    // untouched by the reconciler (it's not even a spine orphan).
    const rawSeed = new Database(dbPath);
    rawSeed
      .prepare(
        `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, completed_at, attempt)
         VALUES ('run_unrelated_terminal', 'cin_unrelated', 'conn_z', '{}', 'succeeded', '[]', '2026-05-10T11:00:00.000Z', '2026-05-10T11:05:00.000Z', 1)`
      )
      .run();
    rawSeed.close();

    const epoch = await emitControllerBootedAndStashEpoch({ bootEpoch: "boot-rh-1", controllerId: "host-rh" });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(result.abandoned, 1);

    const finalized = readRunHistoryStatus(dbPath, "run_rh_orphan_1");
    assert.equal(finalized?.status, "abandoned", "orphan's run_history row must converge to terminal status");
    assert.ok(finalized?.completed_at, "orphan's run_history row must gain a completed_at timestamp");

    const unrelated = readRunHistoryStatus(dbPath, "run_unrelated_terminal");
    assert.equal(unrelated?.status, "succeeded", "unrelated already-terminal row must be untouched");
    assert.equal(unrelated?.completed_at, "2026-05-10T11:05:00.000Z", "unrelated row's completed_at must be untouched");

    // Idempotent repeated boot: re-running reconciliation must not change
    // the already-converged row or throw.
    const result2 = await reconcileOrphanedRunsAtBoot(epoch);
    assert.equal(result2.abandoned, 0);
    const finalizedAgain = readRunHistoryStatus(dbPath, "run_rh_orphan_1");
    assert.equal(finalizedAgain?.status, "abandoned");
    assert.equal(finalizedAgain?.completed_at, finalized?.completed_at, "repeated boot must not perturb completed_at");
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("SQLite: orphan with no run_history row (writer identity guard) does not throw and abandons the spine event", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    // No connector_instance_id → no run_history row was ever created for
    // this orphan (mirrors legacy pre-Slice-A runs). The writer's identity
    // guard must skip silently rather than throw or fabricate a row.
    seedOrphan(dbPath, { actor_id: "conn_b", event_id: "evt_orphan_rh_2", run_id: "run_rh_orphan_2" });

    const epoch = await emitControllerBootedAndStashEpoch({ bootEpoch: "boot-rh-2", controllerId: "host-rh2" });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(result.abandoned, 1);
    assert.equal(readRunHistoryStatus(dbPath, "run_rh_orphan_2"), undefined, "no run_history row should be fabricated");
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("Postgres parity: boot reconciliation converges run_history to terminal status=abandoned", {
  skip: !POSTGRES_URL,
}, async () => {
  // biome-ignore lint/style/noNonNullAssertion: guarded by { skip: !POSTGRES_URL } above.
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL! });
  try {
    const ts = "2026-05-10T12:00:00.000Z";
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
            connector_instance_id, source_kind, source_id)
         VALUES ($1, 'run.started', $2, $2, 'default', 'trc_seed', 'runtime', $3, 'run', $4, 'started', $4, $5::jsonb, 'v1', $6, 'connector', $3)`,
      [
        "evt_orphan_pg_1",
        ts,
        "conn_pg_a",
        "run_rh_pg_orphan_1",
        JSON.stringify({ connection_id: "cin_pg_orphan_a", connector_instance_id: "cin_pg_orphan_a" }),
        "cin_pg_orphan_a",
      ]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
      ["run_rh_pg_orphan_1", "cin_pg_orphan_a", "conn_pg_a", ts]
    );

    const epoch = await emitControllerBootedAndStashEpoch({ bootEpoch: "boot-rh-pg-1", controllerId: "host-rh-pg" });
    const result = await reconcileOrphanedRunsAtBoot(epoch);
    assert.equal(result.abandoned, 1);

    const { rows } = await postgresQuery<{ status: string; completed_at: string | null }>(
      "SELECT status, completed_at FROM run_history WHERE run_id = $1",
      ["run_rh_pg_orphan_1"]
    );
    assert.equal(rows[0]?.status, "abandoned");
    assert.ok(rows[0]?.completed_at);

    // Idempotent repeated boot.
    const result2 = await reconcileOrphanedRunsAtBoot(epoch);
    assert.equal(result2.abandoned, 0);
    const { rows: rowsAgain } = await postgresQuery<{ status: string; completed_at: string | null }>(
      "SELECT status, completed_at FROM run_history WHERE run_id = $1",
      ["run_rh_pg_orphan_1"]
    );
    assert.equal(rowsAgain[0]?.completed_at, rows[0]?.completed_at, "repeated boot must not perturb completed_at");
  } finally {
    await postgresQuery("DELETE FROM run_history WHERE run_id LIKE 'run_rh_pg_%'").catch(() => undefined);
    await postgresQuery("DELETE FROM spine_events WHERE run_id LIKE 'run_rh_pg_%'").catch(() => undefined);
    clearCurrentBootEpoch();
    await closePostgresStorage();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Historical repair: terminal spine event ALREADY EXISTS (e.g. run.abandoned
// written by a prior incarnation of the reconciler, before the writer-
// authority fix existed), but run_history is stuck at status='running'
// forever because that prior write never called the run_history writer.
// The live case this closes: run_1785516896273_1 — spine already has
// run.abandoned, so the orphan SELECT's NOT EXISTS predicate correctly
// excludes it (it is not a new orphan), yet run_history was never repaired.
//
// This is the exact "terminal spine already exists + stale running
// run_history" old-fail/new-pass case the owner flagged as BLOCKING.
// ─────────────────────────────────────────────────────────────────────────

function insertTerminalSpineEvent(
  dbPath: string,
  {
    event_id,
    run_id,
    connector_instance_id,
    actor_id,
    event_type,
    status,
    occurred_at,
    recorded_at,
    data,
  }: {
    event_id: string;
    run_id: string;
    connector_instance_id: string;
    actor_id: string;
    event_type: string;
    status: string;
    occurred_at: string;
    recorded_at?: string;
    data?: Record<string, unknown>;
  }
) {
  const raw = new Database(dbPath);
  try {
    raw
      .prepare(
        `
        INSERT INTO spine_events
          (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
           connector_instance_id, source_kind, source_id)
        VALUES (@event_id, @event_type, @occurred_at, @recorded_at, 'default', 'trc_seed', 'runtime', @actor_id,
                'run', @run_id, @status, @run_id, @data_json, 'v1', @connector_instance_id, 'connector', @actor_id)
        `
      )
      .run({
        actor_id,
        connector_instance_id,
        data_json: JSON.stringify(data ?? {}),
        event_id,
        event_type,
        occurred_at,
        recorded_at: recorded_at ?? occurred_at,
        run_id,
        status,
      });
  } finally {
    raw.close();
  }
}

function insertRunningRunHistoryRow(
  dbPath: string,
  {
    run_id,
    connector_instance_id,
    connector_id,
    started_at,
  }: { run_id: string; connector_instance_id: string; connector_id: string; started_at: string }
) {
  const raw = new Database(dbPath);
  try {
    raw
      .prepare(
        `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES (?, ?, ?, '{}', 'running', '[]', ?, 1)`
      )
      .run(run_id, connector_instance_id, connector_id, started_at);
  } finally {
    raw.close();
  }
}

test("SQLite old-fail/new-pass: terminal spine already exists + stale running run_history converges without re-emitting a spine event", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    // Simulates the live historical case (run_1785516896273_1): the
    // terminal run.abandoned event ALREADY EXISTS in spine_events (written
    // by a prior boot, before the writer-authority fix), so this run is
    // NOT selected by the orphan SELECT (its NOT EXISTS predicate correctly
    // excludes runs with an existing terminal event). Only run_history is
    // still stuck at status='running'.
    insertTerminalSpineEvent(dbPath, {
      actor_id: "conn_hist",
      connector_instance_id: "cin_hist_1",
      event_id: "evt_hist_abandoned_1",
      event_type: "run.abandoned",
      occurred_at: "2026-05-10T12:30:00.000Z",
      run_id: "run_hist_stale_1",
      status: "abandoned",
    });
    insertRunningRunHistoryRow(dbPath, {
      connector_id: "conn_hist",
      connector_instance_id: "cin_hist_1",
      run_id: "run_hist_stale_1",
      started_at: "2026-05-10T12:00:00.000Z",
    });

    // Unrelated already-terminal row: must remain untouched.
    insertTerminalSpineEvent(dbPath, {
      actor_id: "conn_z",
      connector_instance_id: "cin_unrelated_terminal",
      event_id: "evt_unrelated_completed",
      event_type: "run.completed",
      occurred_at: "2026-05-10T11:05:00.000Z",
      run_id: "run_unrelated_terminal_2",
      status: "succeeded",
    });
    const rawPreTerminal = new Database(dbPath);
    rawPreTerminal
      .prepare(
        `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, completed_at, attempt)
         VALUES ('run_unrelated_terminal_2', 'cin_unrelated_terminal', 'conn_z', '{}', 'succeeded', '[]', '2026-05-10T11:00:00.000Z', '2026-05-10T11:05:00.000Z', 1)`
      )
      .run();
    rawPreTerminal.close();

    const beforeAbandonCount = new Database(dbPath);
    const spineCountBefore = (
      beforeAbandonCount.prepare("SELECT COUNT(*) AS n FROM spine_events WHERE event_type = 'run.abandoned'").get() as {
        n: number;
      }
    ).n;
    beforeAbandonCount.close();
    assert.equal(spineCountBefore, 1, "precondition: exactly one run.abandoned already in the spine");

    const epoch = await emitControllerBootedAndStashEpoch({ bootEpoch: "boot-hist-1", controllerId: "host-hist" });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    // Not a new orphan: the SELECT's NOT EXISTS predicate excludes it.
    assert.equal(result.selected, 0, "run with existing terminal spine event must NOT be re-selected as an orphan");
    assert.equal(result.abandoned, 0, "no new run.abandoned event must be emitted for an already-terminal run");
    // The historical-backfill pass is what converges it.
    assert.equal(result.backfilled, 1, "backfill pass must converge exactly the one stale run_history row");

    const raw = new Database(dbPath);
    try {
      const spineCountAfter = (
        raw.prepare("SELECT COUNT(*) AS n FROM spine_events WHERE event_type = 'run.abandoned'").get() as {
          n: number;
        }
      ).n;
      assert.equal(
        spineCountAfter,
        1,
        "must not fabricate or duplicate a spine event — same single spine row as before"
      );

      const finalized = raw
        .prepare("SELECT status, completed_at FROM run_history WHERE run_id = ?")
        .get("run_hist_stale_1") as { status: string; completed_at: string | null };
      assert.equal(finalized.status, "abandoned", "stale run_history row must converge to the spine's terminal status");
      assert.equal(
        finalized.completed_at,
        "2026-05-10T12:30:00.000Z",
        "completed_at must be stamped from the existing terminal spine event's occurred_at"
      );

      const unrelated = raw
        .prepare("SELECT status, completed_at FROM run_history WHERE run_id = ?")
        .get("run_unrelated_terminal_2") as { status: string; completed_at: string | null };
      assert.equal(unrelated.status, "succeeded", "unrelated already-terminal row must be untouched");
      assert.equal(
        unrelated.completed_at,
        "2026-05-10T11:05:00.000Z",
        "unrelated row's completed_at must be untouched"
      );
    } finally {
      raw.close();
    }

    // Idempotent repeated boot: the backfill join is fenced by
    // status='running', so a second boot finds nothing left to converge.
    const result2 = await reconcileOrphanedRunsAtBoot(epoch);
    assert.equal(result2.selected, 0);
    assert.equal(result2.abandoned, 0);
    assert.equal(result2.backfilled, 0, "repeated boot must find zero remaining stale rows (self-draining)");

    const rawAgain = new Database(dbPath);
    try {
      const finalizedAgain = rawAgain
        .prepare("SELECT status, completed_at FROM run_history WHERE run_id = ?")
        .get("run_hist_stale_1") as { status: string; completed_at: string | null };
      assert.equal(finalizedAgain.status, "abandoned");
      assert.equal(
        finalizedAgain.completed_at,
        "2026-05-10T12:30:00.000Z",
        "repeated boot must not perturb completed_at"
      );
    } finally {
      rawAgain.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// The EXACT live shape of run_1785516896273_1: its run.abandoned terminal
// spine event was written by the PRE-3614e31f9 raw INSERT, which never
// populated connector_instance_id/source_kind/source_id — those columns are
// NULL on that row, unlike every synthetic fixture above (which always sets
// connector_instance_id/source_kind/source_id to mirror a live writer-
// authority insert). run_history.connector_instance_id/connector_id are
// NOT NULL, so `s.connector_instance_id = rh.connector_instance_id` can
// never match this row — this is why the fix shipped in
// 0cd6ee9b2/ff59c5b9b still left run_1785516896273_1 unrepaired.
// ─────────────────────────────────────────────────────────────────────────

test("SQLite old-fail/new-pass: terminal spine event with NULL connector_instance_id/source_kind/source_id (the exact run_1785516896273_1 shape) still converges", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    // No connector_instance_id/source_kind/source_id passed — insertTerminalSpineEvent
    // defaults them to NULL, matching the pre-writer-authority raw INSERT's
    // column list exactly (it never named those columns at all).
    const raw = new Database(dbPath);
    try {
      raw
        .prepare(
          `INSERT INTO spine_events
             (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
              actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
           VALUES ('evt_null_ident_abandoned', 'run.abandoned', '2026-05-10T12:30:00.000Z', '2026-05-10T12:30:00.000Z',
                   'default', 'trc_seed', 'runtime', 'controller', 'run', 'run_1785516896273_1', 'abandoned',
                   'run_1785516896273_1', '{}', 'v1')`
        )
        .run();
    } finally {
      raw.close();
    }
    insertRunningRunHistoryRow(dbPath, {
      connector_id: "conn_gmail",
      connector_instance_id: "cin_live_shape_1",
      run_id: "run_1785516896273_1",
      started_at: "2026-05-10T12:00:00.000Z",
    });

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-null-ident-1",
      controllerId: "host-null-ident",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(result.selected, 0, "already has a terminal spine event — not a new orphan");
    assert.equal(result.abandoned, 0, "no new run.abandoned event must be emitted");
    assert.equal(
      result.backfilled,
      1,
      "backfill must converge the row even though the terminal event's connector_instance_id is NULL"
    );

    const finalized = new Database(dbPath);
    try {
      const row = finalized
        .prepare("SELECT status, completed_at FROM run_history WHERE run_id = ?")
        .get("run_1785516896273_1") as { status: string; completed_at: string | null };
      assert.equal(row.status, "abandoned", "must not stay stuck at status='running' forever");
      assert.ok(row.completed_at, "completed_at must be stamped");
    } finally {
      finalized.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("SQLite: a NULL-identity terminal spine event must NOT converge the wrong row when two connections share its run_id", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    const raw = new Database(dbPath);
    try {
      raw
        .prepare(
          `INSERT INTO spine_events
             (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
              actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
           VALUES ('evt_null_ident_ambiguous', 'run.abandoned', '2026-05-10T12:30:00.000Z', '2026-05-10T12:30:00.000Z',
                   'default', 'trc_seed', 'runtime', 'controller', 'run', 'run_shared_ambiguous', 'abandoned',
                   'run_shared_ambiguous', '{}', 'v1')`
        )
        .run();
    } finally {
      raw.close();
    }
    // Two DIFFERENT connections legitimately share this run_id (confirmed
    // live shape — run-history-duplicate-run-id-identity.test.ts). Both are
    // still 'running'; the NULL-identity terminal event above must not be
    // able to pick a side.
    insertRunningRunHistoryRow(dbPath, {
      connector_id: "conn_a",
      connector_instance_id: "cin_ambiguous_a",
      run_id: "run_shared_ambiguous",
      started_at: "2026-05-10T12:00:00.000Z",
    });
    insertRunningRunHistoryRow(dbPath, {
      connector_id: "conn_b",
      connector_instance_id: "cin_ambiguous_b",
      run_id: "run_shared_ambiguous",
      started_at: "2026-05-10T12:00:00.000Z",
    });

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-null-ident-ambiguous",
      controllerId: "host-null-ident-ambiguous",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(
      result.backfilled,
      0,
      "must refuse to guess which of two connections sharing this run_id the NULL-identity event belongs to"
    );

    const raw2 = new Database(dbPath);
    try {
      const rows = raw2
        .prepare(
          "SELECT connector_instance_id, status FROM run_history WHERE run_id = ? ORDER BY connector_instance_id"
        )
        .all("run_shared_ambiguous") as { connector_instance_id: string; status: string }[];
      assert.equal(rows.length, 2);
      assert.ok(
        rows.every((r) => r.status === "running"),
        "both rows must remain 'running' — neither can be safely converged"
      );
    } finally {
      raw2.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("SQLite: connection A already terminal + connection B still running, sharing a run_id — A's legacy NULL-identity event must NOT converge B's row", async () => {
  // Independent-gate reproduction: an earlier version of the fallback guard
  // only checked run_history rows with status='running', so once A's OWN
  // row had already terminalized (through any path), A's terminal sibling
  // became invisible to the disambiguation check and B's still-running row
  // was wrongly treated as the sole candidate.
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    insertTerminalSpineEvent(dbPath, {
      actor_id: "conn_a",
      connector_instance_id: "cin_collision_a",
      event_id: "evt_collision_a_completed",
      event_type: "run.completed",
      occurred_at: "2026-05-10T12:15:00.000Z",
      run_id: "run_terminal_a_running_b",
      status: "succeeded",
    });
    const raw = new Database(dbPath);
    try {
      raw
        .prepare(
          `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, completed_at, attempt)
           VALUES ('run_terminal_a_running_b', 'cin_collision_a', 'conn_a', '{}', 'succeeded', '[]', '2026-05-10T12:00:00.000Z', '2026-05-10T12:15:00.000Z', 1)`
        )
        .run();
      // Connection A's run.abandoned is a SEPARATE legacy event with NULL
      // identity and no resolvable caused_by_event_id — the exact shape
      // that must be inert here, since A already converged via run.completed
      // above and B is a DIFFERENT connection.
      raw
        .prepare(
          `INSERT INTO spine_events
             (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
              actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
           VALUES ('evt_collision_null_ident', 'run.abandoned', '2026-05-10T12:30:00.000Z', '2026-05-10T12:30:00.000Z',
                   'default', 'trc_seed', 'runtime', 'controller', 'run', 'run_terminal_a_running_b', 'abandoned',
                   'run_terminal_a_running_b', '{}', 'v1')`
        )
        .run();
    } finally {
      raw.close();
    }
    insertRunningRunHistoryRow(dbPath, {
      connector_id: "conn_b",
      connector_instance_id: "cin_collision_b",
      run_id: "run_terminal_a_running_b",
      started_at: "2026-05-10T12:05:00.000Z",
    });

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-terminal-a-running-b",
      controllerId: "host-terminal-a-running-b",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(
      result.backfilled,
      0,
      "A's legacy NULL-identity run.abandoned must not be allowed to converge B's running row"
    );

    const raw2 = new Database(dbPath);
    try {
      const rowB = raw2
        .prepare("SELECT status FROM run_history WHERE run_id = ? AND connector_instance_id = ?")
        .get("run_terminal_a_running_b", "cin_collision_b") as { status: string };
      assert.equal(rowB.status, "running", "B's row must remain running — it must not absorb A's abandon event");

      const rowA = raw2
        .prepare("SELECT status, completed_at FROM run_history WHERE run_id = ? AND connector_instance_id = ?")
        .get("run_terminal_a_running_b", "cin_collision_a") as { status: string; completed_at: string };
      assert.equal(rowA.status, "succeeded", "A's own already-terminal row must be untouched");
      assert.equal(rowA.completed_at, "2026-05-10T12:15:00.000Z");
    } finally {
      raw2.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("SQLite: multiple NULL-identity legacy terminal events across colliding run_id histories converge only the unambiguous singleton", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    const raw = new Database(dbPath);
    try {
      // Ambiguous history: two NULL-identity run.abandoned events for the
      // SAME run_id, shared by two still-running connections. Neither may
      // be safely applied to either row.
      raw
        .prepare(
          `INSERT INTO spine_events
             (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
              actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
           VALUES ('evt_multi_null_ambiguous', 'run.abandoned', '2026-05-10T12:30:00.000Z', '2026-05-10T12:30:00.000Z',
                   'default', 'trc_seed', 'runtime', 'controller', 'run', 'run_multi_ambiguous', 'abandoned',
                   'run_multi_ambiguous', '{}', 'v1')`
        )
        .run();
      // Unambiguous singleton (the true run_1785516896273_1 shape): one
      // NULL-identity run.abandoned, one running row, no collision.
      raw
        .prepare(
          `INSERT INTO spine_events
             (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
              actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
           VALUES ('evt_multi_null_singleton', 'run.abandoned', '2026-05-10T12:30:00.000Z', '2026-05-10T12:30:00.000Z',
                   'default', 'trc_seed', 'runtime', 'controller', 'run', 'run_multi_singleton', 'abandoned',
                   'run_multi_singleton', '{}', 'v1')`
        )
        .run();
    } finally {
      raw.close();
    }
    insertRunningRunHistoryRow(dbPath, {
      connector_id: "conn_x",
      connector_instance_id: "cin_multi_ambiguous_x",
      run_id: "run_multi_ambiguous",
      started_at: "2026-05-10T12:00:00.000Z",
    });
    insertRunningRunHistoryRow(dbPath, {
      connector_id: "conn_y",
      connector_instance_id: "cin_multi_ambiguous_y",
      run_id: "run_multi_ambiguous",
      started_at: "2026-05-10T12:00:00.000Z",
    });
    insertRunningRunHistoryRow(dbPath, {
      connector_id: "conn_z",
      connector_instance_id: "cin_multi_singleton_z",
      run_id: "run_multi_singleton",
      started_at: "2026-05-10T12:00:00.000Z",
    });

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-multi-null-ident",
      controllerId: "host-multi-null-ident",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(
      result.backfilled,
      1,
      "exactly the one unambiguous singleton converges; the colliding pair stays untouched"
    );

    const raw2 = new Database(dbPath);
    try {
      const ambiguousRows = raw2
        .prepare("SELECT status FROM run_history WHERE run_id = ?")
        .all("run_multi_ambiguous") as { status: string }[];
      assert.equal(ambiguousRows.length, 2);
      assert.ok(
        ambiguousRows.every((r) => r.status === "running"),
        "both colliding rows remain running — neither NULL-identity event can pick a side"
      );

      const singleton = raw2
        .prepare("SELECT status, completed_at FROM run_history WHERE run_id = ?")
        .get("run_multi_singleton") as { status: string; completed_at: string | null };
      assert.equal(singleton.status, "abandoned", "the unambiguous singleton converges");
      assert.ok(singleton.completed_at);
    } finally {
      raw2.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("SQLite: caused_by_event_id resolves true identity even when two connections collide on run_id (primary recovery path)", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    const raw = new Database(dbPath);
    try {
      // The ORIGINAL run.started for connection B — a normal writer-authority
      // event with a real connector_instance_id, exactly what caused_by_event_id
      // durably points back to.
      raw
        .prepare(
          `INSERT INTO spine_events
             (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
              actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
              connector_instance_id, source_kind, source_id)
           VALUES ('evt_caused_by_started_b', 'run.started', '2026-05-10T12:00:00.000Z', '2026-05-10T12:00:00.000Z',
                   'default', 'trc_seed', 'runtime', 'conn_b', 'run', 'run_caused_by_collision', 'running',
                   'run_caused_by_collision', '{}', 'v1', 'cin_caused_by_b', 'connector', 'conn_b')`
        )
        .run();
      // B's terminal run.abandoned: NULL identity (legacy shape), but its
      // caused_by_event_id points at the run.started row above — this must
      // resolve to B even though A collides on the same run_id.
      raw
        .prepare(
          `INSERT INTO spine_events
             (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
              actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
           VALUES ('evt_caused_by_abandoned_b', 'run.abandoned', '2026-05-10T12:30:00.000Z', '2026-05-10T12:30:00.000Z',
                   'default', 'trc_seed', 'runtime', 'controller', 'run', 'run_caused_by_collision', 'abandoned',
                   'run_caused_by_collision', '{"caused_by_event_id":"evt_caused_by_started_b"}', 'v1')`
        )
        .run();
    } finally {
      raw.close();
    }
    // Connection A collides on the same run_id and must stay untouched.
    insertRunningRunHistoryRow(dbPath, {
      connector_id: "conn_a",
      connector_instance_id: "cin_caused_by_a",
      run_id: "run_caused_by_collision",
      started_at: "2026-05-10T12:00:00.000Z",
    });
    insertRunningRunHistoryRow(dbPath, {
      connector_id: "conn_b",
      connector_instance_id: "cin_caused_by_b",
      run_id: "run_caused_by_collision",
      started_at: "2026-05-10T12:00:00.000Z",
    });

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-caused-by-collision",
      controllerId: "host-caused-by-collision",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(
      result.backfilled,
      1,
      "caused_by_event_id resolves B's true identity even though A collides on the same run_id"
    );

    const raw2 = new Database(dbPath);
    try {
      const rowB = raw2
        .prepare("SELECT status, completed_at FROM run_history WHERE run_id = ? AND connector_instance_id = ?")
        .get("run_caused_by_collision", "cin_caused_by_b") as { status: string; completed_at: string | null };
      assert.equal(rowB.status, "abandoned", "B converges via the resolved caused_by_event_id identity");
      assert.ok(rowB.completed_at);

      const rowA = raw2
        .prepare("SELECT status FROM run_history WHERE run_id = ? AND connector_instance_id = ?")
        .get("run_caused_by_collision", "cin_caused_by_a") as { status: string };
      assert.equal(rowA.status, "running", "A must remain untouched — the event durably resolves to B, not A");
    } finally {
      raw2.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Gate-2 finding: the caused_by_event_id resolution originally checked ONLY
// event_id + connector_instance_id, with no constraint tying the resolved
// row to event_type='run.started' OR to THIS event's own run_id. Neither
// schema enforces that pairing (caused_by_event_id is an untyped data_json
// field, not a foreign key), so a NULL-identity terminal for run X whose
// caused_by_event_id happens to name a DIFFERENT run Y's run.started event
// could wrongly borrow Y's connector_instance_id and apply it to a
// colliding row under X. Reproduced live by the gate in SQLite: a
// NULL-identity terminal for run X with colliding running A/B rows, with
// caused_by_event_id pointed at B's run.started for run Y (not X),
// wrongly converged B under X.
// ─────────────────────────────────────────────────────────────────────────

test("SQLite: caused_by_event_id pointing at a DIFFERENT run's run.started must NOT resolve identity or converge either colliding row", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    const raw = new Database(dbPath);
    try {
      // run.started for a COMPLETELY DIFFERENT run_id (Y), naming
      // connector_instance_id cin_wrong_run_b. Its event_id is what the
      // target run's abandon event will (wrongly, if unfixed) name as its
      // caused_by_event_id.
      raw
        .prepare(
          `INSERT INTO spine_events
             (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
              actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
              connector_instance_id, source_kind, source_id)
           VALUES ('evt_wrong_run_started_y', 'run.started', '2026-05-10T11:00:00.000Z', '2026-05-10T11:00:00.000Z',
                   'default', 'trc_seed', 'runtime', 'conn_wrong_run_b', 'run', 'run_wrong_run_Y', 'running',
                   'run_wrong_run_Y', '{}', 'v1', 'cin_wrong_run_b', 'connector', 'conn_wrong_run_b')`
        )
        .run();
      // Target run X's NULL-identity terminal: caused_by_event_id points at
      // Y's run.started above, NOT at any run.started for X itself.
      raw
        .prepare(
          `INSERT INTO spine_events
             (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
              actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
           VALUES ('evt_wrong_run_abandoned_x', 'run.abandoned', '2026-05-10T12:30:00.000Z', '2026-05-10T12:30:00.000Z',
                   'default', 'trc_seed', 'runtime', 'controller', 'run', 'run_wrong_run_X', 'abandoned',
                   'run_wrong_run_X', '{"caused_by_event_id":"evt_wrong_run_started_y"}', 'v1')`
        )
        .run();
    } finally {
      raw.close();
    }
    // Two connections collide on run X's run_id — neither is cin_wrong_run_b.
    insertRunningRunHistoryRow(dbPath, {
      connector_id: "conn_wrong_run_a",
      connector_instance_id: "cin_wrong_run_a",
      run_id: "run_wrong_run_X",
      started_at: "2026-05-10T12:00:00.000Z",
    });
    insertRunningRunHistoryRow(dbPath, {
      connector_id: "conn_wrong_run_b",
      connector_instance_id: "cin_wrong_run_b",
      run_id: "run_wrong_run_X",
      started_at: "2026-05-10T12:00:00.000Z",
    });

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-wrong-run-y",
      controllerId: "host-wrong-run-y",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(
      result.backfilled,
      0,
      "caused_by_event_id resolving to a DIFFERENT run's run.started must not borrow its identity for this run's colliding rows"
    );

    const raw2 = new Database(dbPath);
    try {
      const rows = raw2
        .prepare(
          "SELECT connector_instance_id, status FROM run_history WHERE run_id = ? ORDER BY connector_instance_id"
        )
        .all("run_wrong_run_X") as { connector_instance_id: string; status: string }[];
      assert.equal(rows.length, 2);
      assert.ok(
        rows.every((r) => r.status === "running"),
        "both colliding rows under X remain running — Y's run.started must not resolve identity for X"
      );
    } finally {
      raw2.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("Postgres parity old-fail/new-pass: terminal spine already exists + stale running run_history converges without re-emitting a spine event", {
  skip: !POSTGRES_URL,
}, async () => {
  // biome-ignore lint/style/noNonNullAssertion: guarded by { skip: !POSTGRES_URL } above.
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL! });
  try {
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
            connector_instance_id, source_kind, source_id)
         VALUES ($1, 'run.abandoned', $2, $2, 'default', 'trc_seed', 'runtime', $3, 'run', $4, 'abandoned', $4, '{}'::jsonb, 'v1', $5, 'connector', $3)`,
      ["evt_hist_pg_abandoned_1", "2026-05-10T12:30:00.000Z", "conn_hist_pg", "run_hist_pg_stale_1", "cin_hist_pg_1"]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
      ["run_hist_pg_stale_1", "cin_hist_pg_1", "conn_hist_pg", "2026-05-10T12:00:00.000Z"]
    );

    // Unrelated already-terminal row must be untouched.
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
            connector_instance_id, source_kind, source_id)
         VALUES ($1, 'run.completed', $2, $2, 'default', 'trc_seed', 'runtime', $3, 'run', $4, 'succeeded', $4, '{}'::jsonb, 'v1', $5, 'connector', $3)`,
      [
        "evt_hist_pg_unrelated",
        "2026-05-10T11:05:00.000Z",
        "conn_z_pg",
        "run_hist_pg_unrelated",
        "cin_hist_pg_unrelated",
      ]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, completed_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'succeeded', '[]'::jsonb, $4, $5, 1)`,
      [
        "run_hist_pg_unrelated",
        "cin_hist_pg_unrelated",
        "conn_z_pg",
        "2026-05-10T11:00:00.000Z",
        "2026-05-10T11:05:00.000Z",
      ]
    );

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-hist-pg-1",
      controllerId: "host-hist-pg",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(result.selected, 0, "run with existing terminal spine event must NOT be re-selected as an orphan");
    assert.equal(result.abandoned, 0, "no new run.abandoned event must be emitted for an already-terminal run");
    assert.equal(result.backfilled, 1, "backfill pass must converge exactly the one stale run_history row");

    const { rows: abandonRows } = await postgresQuery<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM spine_events WHERE event_type = 'run.abandoned' AND run_id = $1",
      ["run_hist_pg_stale_1"]
    );
    assert.equal(abandonRows[0]?.n, "1", "must not fabricate or duplicate a spine event");

    const { rows: finalized } = await postgresQuery<{ status: string; completed_at: string }>(
      "SELECT status, completed_at FROM run_history WHERE run_id = $1",
      ["run_hist_pg_stale_1"]
    );
    assert.equal(finalized[0]?.status, "abandoned");
    assert.ok(finalized[0]?.completed_at);

    const { rows: unrelated } = await postgresQuery<{ status: string; completed_at: string }>(
      "SELECT status, completed_at FROM run_history WHERE run_id = $1",
      ["run_hist_pg_unrelated"]
    );
    assert.equal(unrelated[0]?.status, "succeeded", "unrelated already-terminal row must be untouched");

    // Idempotent repeated boot.
    const result2 = await reconcileOrphanedRunsAtBoot(epoch);
    assert.equal(result2.backfilled, 0, "repeated boot must find zero remaining stale rows (self-draining)");
    const { rows: finalizedAgain } = await postgresQuery<{ completed_at: string }>(
      "SELECT completed_at FROM run_history WHERE run_id = $1",
      ["run_hist_pg_stale_1"]
    );
    assert.equal(
      finalizedAgain[0]?.completed_at,
      finalized[0]?.completed_at,
      "repeated boot must not perturb completed_at"
    );
  } finally {
    await postgresQuery("DELETE FROM run_history WHERE run_id LIKE 'run_hist_pg_%'").catch(() => undefined);
    await postgresQuery("DELETE FROM spine_events WHERE run_id LIKE 'run_hist_pg_%'").catch(() => undefined);
    clearCurrentBootEpoch();
    await closePostgresStorage();
  }
});

test("Postgres parity: terminal spine event with NULL connector_instance_id/source_kind/source_id (the exact live run_1785516896273_1 shape) still converges", {
  skip: !POSTGRES_URL,
}, async () => {
  // biome-ignore lint/style/noNonNullAssertion: guarded by { skip: !POSTGRES_URL } above.
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL! });
  try {
    // No connector_instance_id/source_kind/source_id column named at all —
    // reproduces the pre-3614e31f9 raw INSERT's exact column list, under
    // which those columns default to NULL. Every other fixture in this file
    // sets them explicitly (mirroring a live writer-authority insert), which
    // is exactly why this shape slipped through undetected.
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
         VALUES ($1, 'run.abandoned', $2, $2, 'default', 'trc_seed', 'runtime', 'controller', 'run', $3, 'abandoned', $3, '{}'::jsonb, 'v1')`,
      ["evt_null_ident_pg_abandoned", "2026-05-10T12:30:00.000Z", "run_1785516896273_1_pg"]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
      ["run_1785516896273_1_pg", "cin_null_ident_pg_1", "conn_gmail_pg", "2026-05-10T12:00:00.000Z"]
    );

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-null-ident-pg-1",
      controllerId: "host-null-ident-pg",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(result.selected, 0, "already has a terminal spine event — not a new orphan");
    assert.equal(result.abandoned, 0, "no new run.abandoned event must be emitted");
    assert.equal(
      result.backfilled,
      1,
      "backfill must converge the row even though the terminal event's connector_instance_id is NULL"
    );

    const { rows: finalized } = await postgresQuery<{ status: string; completed_at: string | null }>(
      "SELECT status, completed_at FROM run_history WHERE run_id = $1",
      ["run_1785516896273_1_pg"]
    );
    assert.equal(finalized[0]?.status, "abandoned", "must not stay stuck at status='running' forever");
    assert.ok(finalized[0]?.completed_at, "completed_at must be stamped");
  } finally {
    await postgresQuery("DELETE FROM run_history WHERE run_id LIKE 'run_1785516896273_1_pg%'").catch(() => undefined);
    await postgresQuery("DELETE FROM spine_events WHERE run_id LIKE 'run_1785516896273_1_pg%'").catch(() => undefined);
    clearCurrentBootEpoch();
    await closePostgresStorage();
  }
});

test("Postgres parity: a NULL-identity terminal spine event must NOT converge the wrong row when two connections share its run_id", {
  skip: !POSTGRES_URL,
}, async () => {
  // biome-ignore lint/style/noNonNullAssertion: guarded by { skip: !POSTGRES_URL } above.
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL! });
  try {
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
         VALUES ($1, 'run.abandoned', $2, $2, 'default', 'trc_seed', 'runtime', 'controller', 'run', $3, 'abandoned', $3, '{}'::jsonb, 'v1')`,
      ["evt_null_ident_pg_ambiguous", "2026-05-10T12:30:00.000Z", "run_shared_ambiguous_pg"]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
      ["run_shared_ambiguous_pg", "cin_ambiguous_pg_a", "conn_a_pg", "2026-05-10T12:00:00.000Z"]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
      ["run_shared_ambiguous_pg", "cin_ambiguous_pg_b", "conn_b_pg", "2026-05-10T12:00:00.000Z"]
    );

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-null-ident-pg-ambiguous",
      controllerId: "host-null-ident-pg-ambiguous",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(
      result.backfilled,
      0,
      "must refuse to guess which of two connections sharing this run_id the NULL-identity event belongs to"
    );

    const { rows } = await postgresQuery<{ connector_instance_id: string; status: string }>(
      "SELECT connector_instance_id, status FROM run_history WHERE run_id = $1 ORDER BY connector_instance_id",
      ["run_shared_ambiguous_pg"]
    );
    assert.equal(rows.length, 2);
    assert.ok(
      rows.every((r) => r.status === "running"),
      "both rows must remain 'running' — neither can be safely converged"
    );
  } finally {
    await postgresQuery("DELETE FROM run_history WHERE run_id LIKE 'run_shared_ambiguous_pg%'").catch(() => undefined);
    await postgresQuery("DELETE FROM spine_events WHERE run_id LIKE 'run_shared_ambiguous_pg%'").catch(() => undefined);
    clearCurrentBootEpoch();
    await closePostgresStorage();
  }
});

test("Postgres parity: connection A already terminal + connection B still running, sharing a run_id — A's legacy NULL-identity event must NOT converge B's row", {
  skip: !POSTGRES_URL,
}, async () => {
  // biome-ignore lint/style/noNonNullAssertion: guarded by { skip: !POSTGRES_URL } above.
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL! });
  try {
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
            connector_instance_id, source_kind, source_id)
         VALUES ($1, 'run.completed', $2, $2, 'default', 'trc_seed', 'runtime', $3, 'run', $4, 'succeeded', $4, '{}'::jsonb, 'v1', $5, 'connector', $3)`,
      [
        "evt_pg_collision_a_completed",
        "2026-05-10T12:15:00.000Z",
        "conn_a_pg",
        "run_pg_terminal_a_running_b",
        "cin_pg_collision_a",
      ]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, completed_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'succeeded', '[]'::jsonb, $4, $5, 1)`,
      [
        "run_pg_terminal_a_running_b",
        "cin_pg_collision_a",
        "conn_a_pg",
        "2026-05-10T12:00:00.000Z",
        "2026-05-10T12:15:00.000Z",
      ]
    );
    // A's legacy NULL-identity run.abandoned — must be inert now that A
    // already converged via run.completed above and B is a DIFFERENT connection.
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
         VALUES ($1, 'run.abandoned', $2, $2, 'default', 'trc_seed', 'runtime', 'controller', 'run', $3, 'abandoned', $3, '{}'::jsonb, 'v1')`,
      ["evt_pg_collision_null_ident", "2026-05-10T12:30:00.000Z", "run_pg_terminal_a_running_b"]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
      ["run_pg_terminal_a_running_b", "cin_pg_collision_b", "conn_b_pg", "2026-05-10T12:05:00.000Z"]
    );

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-pg-terminal-a-running-b",
      controllerId: "host-pg-terminal-a-running-b",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(
      result.backfilled,
      0,
      "A's legacy NULL-identity run.abandoned must not be allowed to converge B's running row"
    );

    const { rows: rowB } = await postgresQuery<{ status: string }>(
      "SELECT status FROM run_history WHERE run_id = $1 AND connector_instance_id = $2",
      ["run_pg_terminal_a_running_b", "cin_pg_collision_b"]
    );
    assert.equal(rowB[0]?.status, "running", "B's row must remain running — it must not absorb A's abandon event");

    const { rows: rowA } = await postgresQuery<{ status: string; completed_at: string }>(
      "SELECT status, completed_at FROM run_history WHERE run_id = $1 AND connector_instance_id = $2",
      ["run_pg_terminal_a_running_b", "cin_pg_collision_a"]
    );
    assert.equal(rowA[0]?.status, "succeeded", "A's own already-terminal row must be untouched");
    assert.equal(rowA[0]?.completed_at, "2026-05-10T12:15:00.000Z");
  } finally {
    await postgresQuery("DELETE FROM run_history WHERE run_id LIKE 'run_pg_terminal_a_running_b%'").catch(
      () => undefined
    );
    await postgresQuery("DELETE FROM spine_events WHERE run_id LIKE 'run_pg_terminal_a_running_b%'").catch(
      () => undefined
    );
    clearCurrentBootEpoch();
    await closePostgresStorage();
  }
});

test("Postgres parity: multiple NULL-identity legacy terminal events across colliding run_id histories converge only the unambiguous singleton", {
  skip: !POSTGRES_URL,
}, async () => {
  // biome-ignore lint/style/noNonNullAssertion: guarded by { skip: !POSTGRES_URL } above.
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL! });
  try {
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
         VALUES ($1, 'run.abandoned', $2, $2, 'default', 'trc_seed', 'runtime', 'controller', 'run', $3, 'abandoned', $3, '{}'::jsonb, 'v1')`,
      ["evt_pg_multi_null_ambiguous", "2026-05-10T12:30:00.000Z", "run_pg_multi_ambiguous"]
    );
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
         VALUES ($1, 'run.abandoned', $2, $2, 'default', 'trc_seed', 'runtime', 'controller', 'run', $3, 'abandoned', $3, '{}'::jsonb, 'v1')`,
      ["evt_pg_multi_null_singleton", "2026-05-10T12:30:00.000Z", "run_pg_multi_singleton"]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
      ["run_pg_multi_ambiguous", "cin_pg_multi_ambiguous_x", "conn_x_pg", "2026-05-10T12:00:00.000Z"]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
      ["run_pg_multi_ambiguous", "cin_pg_multi_ambiguous_y", "conn_y_pg", "2026-05-10T12:00:00.000Z"]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
      ["run_pg_multi_singleton", "cin_pg_multi_singleton_z", "conn_z_pg", "2026-05-10T12:00:00.000Z"]
    );

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-pg-multi-null-ident",
      controllerId: "host-pg-multi-null-ident",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(
      result.backfilled,
      1,
      "exactly the one unambiguous singleton converges; the colliding pair stays untouched"
    );

    const { rows: ambiguousRows } = await postgresQuery<{ status: string }>(
      "SELECT status FROM run_history WHERE run_id = $1",
      ["run_pg_multi_ambiguous"]
    );
    assert.equal(ambiguousRows.length, 2);
    assert.ok(
      ambiguousRows.every((r) => r.status === "running"),
      "both colliding rows remain running — neither NULL-identity event can pick a side"
    );

    const { rows: singleton } = await postgresQuery<{ status: string; completed_at: string | null }>(
      "SELECT status, completed_at FROM run_history WHERE run_id = $1",
      ["run_pg_multi_singleton"]
    );
    assert.equal(singleton[0]?.status, "abandoned", "the unambiguous singleton converges");
    assert.ok(singleton[0]?.completed_at);
  } finally {
    await postgresQuery(
      "DELETE FROM run_history WHERE run_id IN ('run_pg_multi_ambiguous', 'run_pg_multi_singleton')"
    ).catch(() => undefined);
    await postgresQuery(
      "DELETE FROM spine_events WHERE run_id IN ('run_pg_multi_ambiguous', 'run_pg_multi_singleton')"
    ).catch(() => undefined);
    clearCurrentBootEpoch();
    await closePostgresStorage();
  }
});

test("Postgres parity: caused_by_event_id resolves true identity even when two connections collide on run_id (primary recovery path)", {
  skip: !POSTGRES_URL,
}, async () => {
  // biome-ignore lint/style/noNonNullAssertion: guarded by { skip: !POSTGRES_URL } above.
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL! });
  try {
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
            connector_instance_id, source_kind, source_id)
         VALUES ($1, 'run.started', $2, $2, 'default', 'trc_seed', 'runtime', 'conn_b_pg', 'run', $3, 'running', $3, '{}'::jsonb, 'v1', $4, 'connector', 'conn_b_pg')`,
      ["evt_pg_caused_by_started_b", "2026-05-10T12:00:00.000Z", "run_pg_caused_by_collision", "cin_pg_caused_by_b"]
    );
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
         VALUES ($1, 'run.abandoned', $2, $2, 'default', 'trc_seed', 'runtime', 'controller', 'run', $3, 'abandoned', $3, $4::jsonb, 'v1')`,
      [
        "evt_pg_caused_by_abandoned_b",
        "2026-05-10T12:30:00.000Z",
        "run_pg_caused_by_collision",
        JSON.stringify({ caused_by_event_id: "evt_pg_caused_by_started_b" }),
      ]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
      ["run_pg_caused_by_collision", "cin_pg_caused_by_a", "conn_a_pg", "2026-05-10T12:00:00.000Z"]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
      ["run_pg_caused_by_collision", "cin_pg_caused_by_b", "conn_b_pg", "2026-05-10T12:00:00.000Z"]
    );

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-pg-caused-by-collision",
      controllerId: "host-pg-caused-by-collision",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(
      result.backfilled,
      1,
      "caused_by_event_id resolves B's true identity even though A collides on the same run_id"
    );

    const { rows: rowB } = await postgresQuery<{ status: string; completed_at: string | null }>(
      "SELECT status, completed_at FROM run_history WHERE run_id = $1 AND connector_instance_id = $2",
      ["run_pg_caused_by_collision", "cin_pg_caused_by_b"]
    );
    assert.equal(rowB[0]?.status, "abandoned", "B converges via the resolved caused_by_event_id identity");
    assert.ok(rowB[0]?.completed_at);

    const { rows: rowA } = await postgresQuery<{ status: string }>(
      "SELECT status FROM run_history WHERE run_id = $1 AND connector_instance_id = $2",
      ["run_pg_caused_by_collision", "cin_pg_caused_by_a"]
    );
    assert.equal(rowA[0]?.status, "running", "A must remain untouched — the event durably resolves to B, not A");
  } finally {
    await postgresQuery("DELETE FROM run_history WHERE run_id LIKE 'run_pg_caused_by_collision%'").catch(
      () => undefined
    );
    await postgresQuery("DELETE FROM spine_events WHERE run_id LIKE 'run_pg_caused_by_collision%'").catch(
      () => undefined
    );
    clearCurrentBootEpoch();
    await closePostgresStorage();
  }
});

test("Postgres parity: caused_by_event_id pointing at a DIFFERENT run's run.started must NOT resolve identity or converge either colliding row", {
  skip: !POSTGRES_URL,
}, async () => {
  // biome-ignore lint/style/noNonNullAssertion: guarded by { skip: !POSTGRES_URL } above.
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL! });
  try {
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
            connector_instance_id, source_kind, source_id)
         VALUES ($1, 'run.started', $2, $2, 'default', 'trc_seed', 'runtime', 'conn_wrong_run_pg_b', 'run', $3, 'running', $3, '{}'::jsonb, 'v1', $4, 'connector', 'conn_wrong_run_pg_b')`,
      ["evt_pg_wrong_run_started_y", "2026-05-10T11:00:00.000Z", "run_pg_wrong_run_Y", "cin_pg_wrong_run_b"]
    );
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
         VALUES ($1, 'run.abandoned', $2, $2, 'default', 'trc_seed', 'runtime', 'controller', 'run', $3, 'abandoned', $3, $4::jsonb, 'v1')`,
      [
        "evt_pg_wrong_run_abandoned_x",
        "2026-05-10T12:30:00.000Z",
        "run_pg_wrong_run_X",
        JSON.stringify({ caused_by_event_id: "evt_pg_wrong_run_started_y" }),
      ]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
      ["run_pg_wrong_run_X", "cin_pg_wrong_run_a", "conn_wrong_run_pg_a", "2026-05-10T12:00:00.000Z"]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
      ["run_pg_wrong_run_X", "cin_pg_wrong_run_b", "conn_wrong_run_pg_b", "2026-05-10T12:00:00.000Z"]
    );

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-pg-wrong-run-y",
      controllerId: "host-pg-wrong-run-y",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(
      result.backfilled,
      0,
      "caused_by_event_id resolving to a DIFFERENT run's run.started must not borrow its identity for this run's colliding rows"
    );

    const { rows } = await postgresQuery<{ connector_instance_id: string; status: string }>(
      "SELECT connector_instance_id, status FROM run_history WHERE run_id = $1 ORDER BY connector_instance_id",
      ["run_pg_wrong_run_X"]
    );
    assert.equal(rows.length, 2);
    assert.ok(
      rows.every((r) => r.status === "running"),
      "both colliding rows under X remain running — Y's run.started must not resolve identity for X"
    );
  } finally {
    await postgresQuery("DELETE FROM run_history WHERE run_id IN ('run_pg_wrong_run_X', 'run_pg_wrong_run_Y')").catch(
      () => undefined
    );
    await postgresQuery("DELETE FROM spine_events WHERE run_id IN ('run_pg_wrong_run_X', 'run_pg_wrong_run_Y')").catch(
      () => undefined
    );
    clearCurrentBootEpoch();
    await closePostgresStorage();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Faithful replay: the backfill must carry the terminal spine event's own
// data_json into the writer, not an abandon-shaped empty payload. A
// non-abandoned terminal event (run.failed) is the sharpest proof, since
// run.abandoned's own data legitimately has no records_emitted/
// connector_error/known_gaps — a bug that replaces `data` with `{}` would
// be invisible on the abandoned case but would silently drop every
// writer-consumed field for completed/failed/browser_surface_failed/
// cancelled runs.
// ─────────────────────────────────────────────────────────────────────────

test("SQLite: backfill replay carries the terminal event's own data_json — records_emitted, connector_error, known_gaps, checkpoint accounting all converge", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    insertTerminalSpineEvent(dbPath, {
      actor_id: "conn_facts",
      connector_instance_id: "cin_facts_1",
      data: {
        checkpoint_commit_status: "committed",
        connector_error_code: "RATE_LIMITED",
        connector_error_message: "too many requests",
        connector_error_retryable: true,
        known_gaps: [{ reason: "rate_limited", stream: "orders" }],
        reason: "connector_reported_failed",
        records_emitted: 42,
        records_flushed: 40,
        state_streams_committed: 2,
      },
      event_id: "evt_facts_failed_1",
      event_type: "run.failed",
      occurred_at: "2026-05-10T12:45:00.000Z",
      run_id: "run_facts_stale_1",
      status: "failed",
    });
    insertRunningRunHistoryRow(dbPath, {
      connector_id: "conn_facts",
      connector_instance_id: "cin_facts_1",
      run_id: "run_facts_stale_1",
      started_at: "2026-05-10T12:00:00.000Z",
    });

    const epoch = await emitControllerBootedAndStashEpoch({ bootEpoch: "boot-facts-1", controllerId: "host-facts" });
    const result = await reconcileOrphanedRunsAtBoot(epoch);
    assert.equal(result.backfilled, 1);

    const raw = new Database(dbPath);
    try {
      const row = raw
        .prepare(
          `SELECT status, completed_at, records_emitted, connector_error_json, known_gaps_json,
                  checkpoint_summary_json, terminal_reason
           FROM run_history WHERE run_id = ?`
        )
        .get("run_facts_stale_1") as {
        status: string;
        completed_at: string | null;
        records_emitted: number;
        connector_error_json: string | null;
        known_gaps_json: string;
        checkpoint_summary_json: string | null;
        terminal_reason: string | null;
      };

      assert.equal(row.status, "failed");
      assert.equal(row.records_emitted, 42, "records_emitted must be derived from the real terminal data_json");
      assert.equal(row.terminal_reason, "connector_reported_failed");

      const connectorError = JSON.parse(row.connector_error_json ?? "null");
      assert.deepEqual(connectorError, { code: "RATE_LIMITED", message: "too many requests", retryable: true });

      const knownGaps = JSON.parse(row.known_gaps_json);
      assert.deepEqual(knownGaps, [{ reason: "rate_limited", stream: "orders" }]);

      const checkpointSummary = JSON.parse(row.checkpoint_summary_json ?? "null");
      assert.equal(checkpointSummary.commit_status, "committed");
      assert.equal(checkpointSummary.records_flushed, 40);
      assert.equal(checkpointSummary.state_streams_committed, 2);
    } finally {
      raw.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("Postgres parity: backfill replay carries the terminal event's own data_json", {
  skip: !POSTGRES_URL,
}, async () => {
  // biome-ignore lint/style/noNonNullAssertion: guarded by { skip: !POSTGRES_URL } above.
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL! });
  try {
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
            connector_instance_id, source_kind, source_id)
         VALUES ($1, 'run.failed', $2, $2, 'default', 'trc_seed', 'runtime', $3, 'run', $4, 'failed', $4, $5::jsonb, 'v1', $6, 'connector', $3)`,
      [
        "evt_facts_pg_failed_1",
        "2026-05-10T12:45:00.000Z",
        "conn_facts_pg",
        "run_facts_pg_stale_1",
        JSON.stringify({
          connector_error_code: "RATE_LIMITED",
          connector_error_message: "too many requests",
          connector_error_retryable: true,
          known_gaps: [{ reason: "rate_limited", stream: "orders" }],
          reason: "connector_reported_failed",
          records_emitted: 42,
        }),
        "cin_facts_pg_1",
      ]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
      ["run_facts_pg_stale_1", "cin_facts_pg_1", "conn_facts_pg", "2026-05-10T12:00:00.000Z"]
    );

    const epoch = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-facts-pg-1",
      controllerId: "host-facts-pg",
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);
    assert.equal(result.backfilled, 1);

    const { rows } = await postgresQuery<{
      status: string;
      records_emitted: number;
      connector_error_json: { code: string; message: string; retryable: boolean };
      known_gaps_json: unknown[];
      terminal_reason: string | null;
    }>(
      "SELECT status, records_emitted, connector_error_json, known_gaps_json, terminal_reason FROM run_history WHERE run_id = $1",
      ["run_facts_pg_stale_1"]
    );
    assert.equal(rows[0]?.status, "failed");
    assert.equal(rows[0]?.records_emitted, 42, "records_emitted must be derived from the real terminal data_json");
    assert.equal(rows[0]?.terminal_reason, "connector_reported_failed");
    assert.deepEqual(rows[0]?.connector_error_json, {
      code: "RATE_LIMITED",
      message: "too many requests",
      retryable: true,
    });
    assert.deepEqual(rows[0]?.known_gaps_json, [{ reason: "rate_limited", stream: "orders" }]);
  } finally {
    await postgresQuery("DELETE FROM run_history WHERE run_id LIKE 'run_facts_pg_%'").catch(() => undefined);
    await postgresQuery("DELETE FROM spine_events WHERE run_id LIKE 'run_facts_pg_%'").catch(() => undefined);
    clearCurrentBootEpoch();
    await closePostgresStorage();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Deterministic tie-break: two terminal-shaped spine events for the same
// run sharing the exact same occurred_at must be resolved identically on
// SQLite and Postgres via recorded_at then event_id, not left to whatever
// order the database happens to return rows in.
// ─────────────────────────────────────────────────────────────────────────

test("SQLite: equal occurred_at terminal events break ties on recorded_at, then event_id, deterministically", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    const sameOccurredAt = "2026-05-10T12:45:00.000Z";
    // Two terminal-shaped events for the same run, identical occurred_at,
    // different recorded_at — the later recorded_at must win.
    insertTerminalSpineEvent(dbPath, {
      actor_id: "conn_tie",
      connector_instance_id: "cin_tie_1",
      data: { records_emitted: 1 },
      event_id: "evt_tie_a",
      event_type: "run.failed",
      occurred_at: sameOccurredAt,
      recorded_at: "2026-05-10T12:45:00.100Z",
      run_id: "run_tie_stale_1",
      status: "failed",
    });
    insertTerminalSpineEvent(dbPath, {
      actor_id: "conn_tie",
      connector_instance_id: "cin_tie_1",
      data: { records_emitted: 99 },
      event_id: "evt_tie_b",
      event_type: "run.completed",
      occurred_at: sameOccurredAt,
      recorded_at: "2026-05-10T12:45:00.200Z",
      run_id: "run_tie_stale_1",
      status: "succeeded",
    });
    insertRunningRunHistoryRow(dbPath, {
      connector_id: "conn_tie",
      connector_instance_id: "cin_tie_1",
      run_id: "run_tie_stale_1",
      started_at: "2026-05-10T12:00:00.000Z",
    });

    const epoch = await emitControllerBootedAndStashEpoch({ bootEpoch: "boot-tie-1", controllerId: "host-tie" });
    const result = await reconcileOrphanedRunsAtBoot(epoch);
    assert.equal(result.backfilled, 1);

    const raw = new Database(dbPath);
    try {
      const row = raw
        .prepare("SELECT status, records_emitted FROM run_history WHERE run_id = ?")
        .get("run_tie_stale_1") as {
        status: string;
        records_emitted: number;
      };
      assert.equal(row.status, "succeeded", "the event with the later recorded_at must win the tie");
      assert.equal(row.records_emitted, 99);
    } finally {
      raw.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("Postgres parity: equal occurred_at terminal events break ties on recorded_at deterministically", {
  skip: !POSTGRES_URL,
}, async () => {
  // biome-ignore lint/style/noNonNullAssertion: guarded by { skip: !POSTGRES_URL } above.
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL! });
  try {
    const sameOccurredAt = "2026-05-10T12:45:00.000Z";
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
            connector_instance_id, source_kind, source_id)
         VALUES ($1, 'run.failed', $2, $3, 'default', 'trc_seed', 'runtime', $4, 'run', $5, 'failed', $5, $6::jsonb, 'v1', $7, 'connector', $4)`,
      [
        "evt_tie_pg_a",
        sameOccurredAt,
        "2026-05-10T12:45:00.100Z",
        "conn_tie_pg",
        "run_tie_pg_stale_1",
        JSON.stringify({ records_emitted: 1 }),
        "cin_tie_pg_1",
      ]
    );
    await postgresQuery(
      `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
            connector_instance_id, source_kind, source_id)
         VALUES ($1, 'run.completed', $2, $3, 'default', 'trc_seed', 'runtime', $4, 'run', $5, 'succeeded', $5, $6::jsonb, 'v1', $7, 'connector', $4)`,
      [
        "evt_tie_pg_b",
        sameOccurredAt,
        "2026-05-10T12:45:00.200Z",
        "conn_tie_pg",
        "run_tie_pg_stale_1",
        JSON.stringify({ records_emitted: 99 }),
        "cin_tie_pg_1",
      ]
    );
    await postgresQuery(
      `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
      ["run_tie_pg_stale_1", "cin_tie_pg_1", "conn_tie_pg", "2026-05-10T12:00:00.000Z"]
    );

    const epoch = await emitControllerBootedAndStashEpoch({ bootEpoch: "boot-tie-pg-1", controllerId: "host-tie-pg" });
    const result = await reconcileOrphanedRunsAtBoot(epoch);
    assert.equal(result.backfilled, 1);

    const { rows } = await postgresQuery<{ status: string; records_emitted: number }>(
      "SELECT status, records_emitted FROM run_history WHERE run_id = $1",
      ["run_tie_pg_stale_1"]
    );
    assert.equal(rows[0]?.status, "succeeded", "the event with the later recorded_at must win the tie");
    assert.equal(rows[0]?.records_emitted, 99);
  } finally {
    await postgresQuery("DELETE FROM run_history WHERE run_id LIKE 'run_tie_pg_%'").catch(() => undefined);
    await postgresQuery("DELETE FROM spine_events WHERE run_id LIKE 'run_tie_pg_%'").catch(() => undefined);
    clearCurrentBootEpoch();
    await closePostgresStorage();
  }
});

// ─────────────────────────────────────────────────────────────────────────
// Gate-2 finding: source_kind='connector' does NOT guarantee source_id is
// non-NULL on either backend — no NOT NULL/check constraint enforces that
// pairing. A terminal row shaped that way selected by the NULL-instance
// identity match still had its connectorId resolve to `null` (the old
// ternary's true branch), so the writer's own `event.connectorId` guard
// silently rejected it — the row stayed 'running' and was re-selected on
// every subsequent boot forever. At RUN_HISTORY_BACKFILL_LIMIT rows of
// this exact shape, the bounded pass would never drain: every boot
// consumes the full 500-row budget re-selecting the same rows and
// converging none of them.
// ─────────────────────────────────────────────────────────────────────────

test("SQLite: a full RUN_HISTORY_BACKFILL_LIMIT cohort of source_kind='connector'+source_id=NULL rows drains to zero, not repeated forever", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    const raw = new Database(dbPath);
    try {
      const insertSpine = raw.prepare(
        `INSERT INTO spine_events
           (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
            actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
            connector_instance_id, source_kind, source_id)
         VALUES (@event_id, 'run.abandoned', @occurred_at, @occurred_at, 'default', 'trc_seed', 'runtime',
                 'controller', 'run', @run_id, 'abandoned', @run_id, '{}', 'v1', NULL, 'connector', NULL)`
      );
      const insertRunHistory = raw.prepare(
        `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
         VALUES (@run_id, @connector_instance_id, @connector_id, '{}', 'running', '[]', @started_at, 1)`
      );
      for (let i = 0; i < RUN_HISTORY_BACKFILL_LIMIT; i += 1) {
        const runId = `run_partial_source_${i}`;
        insertSpine.run({
          event_id: `evt_partial_source_${i}`,
          occurred_at: "2026-05-10T12:30:00.000Z",
          run_id: runId,
        });
        insertRunHistory.run({
          connector_id: `conn_partial_source_${i}`,
          connector_instance_id: `cin_partial_source_${i}`,
          run_id: runId,
          started_at: "2026-05-10T12:00:00.000Z",
        });
      }
    } finally {
      raw.close();
    }

    const epoch1 = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-partial-source-1",
      controllerId: "host-partial-source",
    });
    const result1 = await reconcileOrphanedRunsAtBoot(epoch1);
    assert.equal(
      result1.backfilled,
      RUN_HISTORY_BACKFILL_LIMIT,
      "the full cohort must actually convert on the first pass, not merely be selected and then rejected by the writer's connectorId guard"
    );

    const raw2 = new Database(dbPath);
    let runningAfterFirstPass: number;
    try {
      runningAfterFirstPass = (
        raw2
          .prepare(
            "SELECT COUNT(*) AS n FROM run_history WHERE run_id LIKE 'run_partial_source_%' AND status = 'running'"
          )
          .get() as { n: number }
      ).n;
    } finally {
      raw2.close();
    }
    assert.equal(
      runningAfterFirstPass,
      0,
      "zero rows remain running — the connectorId fallback must have applied to all of them"
    );

    clearCurrentBootEpoch();
    const epoch2 = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-partial-source-2",
      controllerId: "host-partial-source",
    });
    const result2 = await reconcileOrphanedRunsAtBoot(epoch2);
    assert.equal(
      result2.backfilled,
      0,
      "second pass must find nothing left — a non-draining bug would keep re-selecting and re-failing the same 500 rows forever"
    );
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("Postgres parity: a full RUN_HISTORY_BACKFILL_LIMIT cohort of source_kind='connector'+source_id=NULL rows drains to zero, not repeated forever", {
  skip: !POSTGRES_URL,
}, async () => {
  // biome-ignore lint/style/noNonNullAssertion: guarded by { skip: !POSTGRES_URL } above.
  await initPostgresStorage({ backend: "postgres", databaseUrl: POSTGRES_URL! });
  try {
    for (let i = 0; i < RUN_HISTORY_BACKFILL_LIMIT; i += 1) {
      const runId = `run_pg_partial_source_${i}`;
      // biome-ignore lint/performance/noAwaitInLoops: sequential seed setup, not perf-sensitive.
      await postgresQuery(
        `INSERT INTO spine_events
             (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
              actor_type, actor_id, object_type, object_id, status, run_id, data_json, version,
              connector_instance_id, source_kind, source_id)
           VALUES ($1, 'run.abandoned', $2, $2, 'default', 'trc_seed', 'runtime', 'controller', 'run', $3, 'abandoned', $3, '{}'::jsonb, 'v1', NULL, 'connector', NULL)`,
        [`evt_pg_partial_source_${i}`, "2026-05-10T12:30:00.000Z", runId]
      );
      await postgresQuery(
        `INSERT INTO run_history (run_id, connector_instance_id, connector_id, source_json, status, known_gaps_json, started_at, attempt)
           VALUES ($1, $2, $3, '{}'::jsonb, 'running', '[]'::jsonb, $4, 1)`,
        [runId, `cin_pg_partial_source_${i}`, `conn_pg_partial_source_${i}`, "2026-05-10T12:00:00.000Z"]
      );
    }

    const epoch1 = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-pg-partial-source-1",
      controllerId: "host-pg-partial-source",
    });
    const result1 = await reconcileOrphanedRunsAtBoot(epoch1);
    assert.equal(
      result1.backfilled,
      RUN_HISTORY_BACKFILL_LIMIT,
      "the full cohort must actually convert on the first pass, not merely be selected and then rejected by the writer's connectorId guard"
    );

    const { rows: runningAfterFirstPass } = await postgresQuery<{ n: string }>(
      "SELECT COUNT(*)::text AS n FROM run_history WHERE run_id LIKE 'run_pg_partial_source_%' AND status = 'running'"
    );
    assert.equal(
      runningAfterFirstPass[0]?.n,
      "0",
      "zero rows remain running — the connectorId fallback must have applied to all of them"
    );

    clearCurrentBootEpoch();
    const epoch2 = await emitControllerBootedAndStashEpoch({
      bootEpoch: "boot-pg-partial-source-2",
      controllerId: "host-pg-partial-source",
    });
    const result2 = await reconcileOrphanedRunsAtBoot(epoch2);
    assert.equal(
      result2.backfilled,
      0,
      "second pass must find nothing left — a non-draining bug would keep re-selecting and re-failing the same 500 rows forever"
    );
  } finally {
    await postgresQuery("DELETE FROM run_history WHERE run_id LIKE 'run_pg_partial_source_%'").catch(() => undefined);
    await postgresQuery("DELETE FROM spine_events WHERE run_id LIKE 'run_pg_partial_source_%'").catch(() => undefined);
    clearCurrentBootEpoch();
    await closePostgresStorage();
  }
});
