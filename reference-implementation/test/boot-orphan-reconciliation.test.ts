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
  event_id: string;
  run_id: string;
  actor_id: string;
  boot_epoch?: string | null;
  controller_id?: string | null;
  /** When set, also seeds a matching connector_instance_id + a `running` run_history row (Slice A shape). */
  connector_instance_id?: string | null;
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
      .run(
        event_id,
        ts,
        ts,
        actor_id,
        run_id,
        run_id,
        JSON.stringify(data),
        connector_instance_id,
        actor_id
      );
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

function readRunHistoryStatus(dbPath: string, runId: string): { status: string; completed_at: string | null } | undefined {
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

test(
  "Postgres parity: boot reconciliation converges run_history to terminal status=abandoned",
  { skip: !POSTGRES_URL },
  async () => {
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
          JSON.stringify({ connector_instance_id: "cin_pg_orphan_a", connection_id: "cin_pg_orphan_a" }),
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
  }
);
