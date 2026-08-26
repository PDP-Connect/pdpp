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
import { makeTemporaryDbPath } from "./helpers/temp-dir.ts";

function tempDbPath() {
  return makeTemporaryDbPath("pdpp-boot-recon-");
}

/**
 * Seed a `run.started` row directly into spine_events to simulate a
 * legacy orphan (e.g., from a prior process incarnation).
 */
function seedOrphan(
  dbPath: string,
  {
    event_id,
    run_id,
    actor_id,
    boot_epoch = null,
    controller_id = null,
  }: { event_id: string; run_id: string; actor_id: string; boot_epoch?: string | null; controller_id?: string | null }
) {
  const raw = new Database(dbPath);
  try {
    const ts = "2026-05-10T12:00:00.000Z";
    const data: { boot_epoch?: string; controller_id?: string; seq?: number } = {};
    if (boot_epoch) {
      data.boot_epoch = boot_epoch;
    }
    if (controller_id) {
      data.controller_id = controller_id;
    }
    if (boot_epoch) {
      data.seq = 1;
    }
    raw
      .prepare(
        `
      INSERT INTO spine_events
        (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
      VALUES (?, 'run.started', ?, ?, 'default', 'trc_seed', 'runtime', ?, 'run', ?, 'started', ?, ?, 'v1')
      `
      )
      .run(event_id, ts, ts, actor_id, run_id, run_id, JSON.stringify(data));
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

// ─── Interaction-aware terminal reason ───────────────────────────────────────
//
// A run that died while the connector was WAITING ON THE OWNER is reported
// with a distinct reason. The owner has already paid a real-world cost by
// then: an OTP is single-use and is sent to a real phone, so "we asked you
// for a code and then crashed" must be distinguishable from "the run was cut
// short". Observed in production as run_1787330303633 (usaa), which was
// abandoned 49 seconds after USAA texted the owner a code.

/** Seed an interaction lifecycle event for an existing orphaned run. */
function seedInteractionEvent(
  dbPath: string,
  {
    event_id,
    run_id,
    event_type,
    interaction_id,
  }: { event_id: string; event_type: string; interaction_id: string; run_id: string }
) {
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
      VALUES (?, ?, ?, ?, 'default', 'trc_seed', 'runtime', 'conn_a', 'run', ?, 'started', ?, ?, '{}', 'v1')
      `
      )
      .run(event_id, event_type, ts, ts, run_id, run_id, interaction_id);
  } finally {
    raw.close();
  }
}

function abandonReasonFor(dbPath: string, runId: string): string {
  const raw = new Database(dbPath);
  try {
    const row = raw
      .prepare("SELECT data_json FROM spine_events WHERE event_type = 'run.abandoned' AND run_id = ?")
      .get(runId) as { data_json: string } | undefined;
    assert.ok(row, `expected a run.abandoned event for ${runId}`);
    return JSON.parse(row.data_json).reason as string;
  } finally {
    raw.close();
  }
}

test("reconciler reports a distinct reason for a run abandoned while awaiting owner interaction", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    seedOrphan(dbPath, { actor_id: "conn_a", event_id: "evt_otp_orphan", run_id: "run_awaiting_otp" });
    // The connector asked the owner for a code and never got an answer.
    seedInteractionEvent(dbPath, {
      event_id: "evt_int_req",
      event_type: "run.interaction_required",
      interaction_id: "int_pending_1",
      run_id: "run_awaiting_otp",
    });

    const epoch = await emitControllerBootedAndStashEpoch({ bootEpoch: "boot-otp", controllerId: "host-test" });
    await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(
      abandonReasonFor(dbPath, "run_awaiting_otp"),
      "controller_terminated_while_awaiting_owner_interaction",
      "a run waiting on the owner must say so"
    );
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("reconciler treats an assistance request with no resolution as awaiting the owner", async () => {
  // `run.assistance_requested` is the sibling event the runtime emits
  // alongside `run.interaction_required`; both must count.
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    seedOrphan(dbPath, { actor_id: "conn_a", event_id: "evt_assist_orphan", run_id: "run_awaiting_assist" });
    seedInteractionEvent(dbPath, {
      event_id: "evt_assist_req",
      event_type: "run.assistance_requested",
      interaction_id: "int_pending_2",
      run_id: "run_awaiting_assist",
    });

    const epoch = await emitControllerBootedAndStashEpoch({ bootEpoch: "boot-assist", controllerId: "host-test" });
    await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(
      abandonReasonFor(dbPath, "run_awaiting_assist"),
      "controller_terminated_while_awaiting_owner_interaction",
      "an unresolved assistance request must count as awaiting the owner"
    );
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("reconciler keeps the generic reason once the interaction was answered", async () => {
  // The load-bearing negative: a RESOLVED interaction means the owner was no
  // longer being waited on, so this is an ordinary mid-flight death. Without
  // this case, the new reason could degenerate into "any run that ever asked
  // for input", which would over-report burned OTPs.
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    seedOrphan(dbPath, { actor_id: "conn_a", event_id: "evt_done_orphan", run_id: "run_answered_otp" });
    seedInteractionEvent(dbPath, {
      event_id: "evt_int_req_2",
      event_type: "run.interaction_required",
      interaction_id: "int_answered_1",
      run_id: "run_answered_otp",
    });
    seedInteractionEvent(dbPath, {
      event_id: "evt_int_done_2",
      event_type: "run.interaction_completed",
      interaction_id: "int_answered_1",
      run_id: "run_answered_otp",
    });

    const epoch = await emitControllerBootedAndStashEpoch({ bootEpoch: "boot-answered", controllerId: "host-test" });
    await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(
      abandonReasonFor(dbPath, "run_answered_otp"),
      "controller_terminated_before_run_finished",
      "an answered interaction must not be reported as awaiting the owner"
    );
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test("reconciler keeps the generic reason for a run that never asked for input", async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    seedOrphan(dbPath, { actor_id: "conn_a", event_id: "evt_plain_orphan", run_id: "run_no_interaction" });

    const epoch = await emitControllerBootedAndStashEpoch({ bootEpoch: "boot-plain", controllerId: "host-test" });
    await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(
      abandonReasonFor(dbPath, "run_no_interaction"),
      "controller_terminated_before_run_finished",
      "a run that never asked for input keeps the generic reason"
    );
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});
