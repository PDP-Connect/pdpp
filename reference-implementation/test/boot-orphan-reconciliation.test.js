/**
 * Boot-time orphan reconciliation — end-to-end SQLite tests.
 *
 * Verifies the boot sequence emits `run.abandoned` for orphaned
 * `run.started` events from prior incarnations, idempotently, with
 * correct provenance fields.
 *
 * Design contract: docs/run-reconciliation-design-brief.md §3.4 / Stage 6.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { initDb, closeDb } from '../server/db.js';
import { makeTemporaryDbPath } from './helpers/temp-dir.js';
import {
  emitControllerBootedAndStashEpoch,
  reconcileOrphanedRunsAtBoot,
} from '../lib/controller-boot.ts';
import { clearCurrentBootEpoch } from '../lib/spine.ts';

function tempDbPath() {
  return makeTemporaryDbPath('pdpp-boot-recon-');
}

/**
 * Seed a `run.started` row directly into spine_events to simulate a
 * legacy orphan (e.g., from a prior process incarnation).
 */
function seedOrphan(dbPath, { event_id, run_id, actor_id, boot_epoch = null, controller_id = null }) {
  const raw = new Database(dbPath);
  try {
    const ts = '2026-05-10T12:00:00.000Z';
    const data = {};
    if (boot_epoch) data.boot_epoch = boot_epoch;
    if (controller_id) data.controller_id = controller_id;
    data.seq = boot_epoch ? 1 : undefined;
    raw.prepare(
      `
      INSERT INTO spine_events
        (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, run_id, data_json, version)
      VALUES (?, 'run.started', ?, ?, 'default', 'trc_seed', 'runtime', ?, 'run', ?, 'started', ?, ?, 'v1')
      `,
    ).run(event_id, ts, ts, actor_id, run_id, run_id, JSON.stringify(data));
  } finally {
    raw.close();
  }
}

test('reconciler emits run.abandoned for legacy orphans with no boot_epoch', async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    seedOrphan(dbPath, { event_id: 'evt_orphan_1', run_id: 'run_legacy_1', actor_id: 'conn_a' });
    seedOrphan(dbPath, { event_id: 'evt_orphan_2', run_id: 'run_legacy_2', actor_id: 'conn_b' });

    const epoch = await emitControllerBootedAndStashEpoch({
      controllerId: 'host-test',
      bootEpoch: 'boot-epoch-1',
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(result.selected, 2);
    assert.equal(result.abandoned, 2);

    const raw = new Database(dbPath);
    try {
      const abandons = raw.prepare(
        "SELECT run_id, data_json FROM spine_events WHERE event_type = 'run.abandoned' ORDER BY run_id"
      ).all();
      assert.equal(abandons.length, 2);
      assert.deepEqual(
        abandons.map(r => r.run_id),
        ['run_legacy_1', 'run_legacy_2'],
      );
      for (const r of abandons) {
        const d = JSON.parse(r.data_json);
        assert.equal(d.reconciled_by_boot_epoch, 'boot-epoch-1');
        assert.equal(d.reconciled_by_controller_id, 'host-test');
        assert.equal(d.source, 'recovery_worker');
        assert.equal(d.reason, 'controller_terminated_before_run_finished');
        assert.ok(d.caused_by_event_id.startsWith('evt_orphan_'));
      }
    } finally {
      raw.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test('reconciler does NOT abandon current-epoch runs', async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    const epoch = await emitControllerBootedAndStashEpoch({
      controllerId: 'host-test',
      bootEpoch: 'boot-epoch-now',
    });

    // Seed a run.started carrying THIS boot's epoch — an active run.
    seedOrphan(dbPath, {
      event_id: 'evt_current',
      run_id: 'run_current_1',
      actor_id: 'conn_x',
      boot_epoch: 'boot-epoch-now',
      controller_id: 'host-test',
    });

    const result = await reconcileOrphanedRunsAtBoot(epoch);
    assert.equal(result.selected, 0);
    assert.equal(result.abandoned, 0);
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test('reconciler is idempotent: second call emits no additional events', async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    seedOrphan(dbPath, { event_id: 'evt_orphan_idem', run_id: 'run_idem', actor_id: 'c' });

    const epoch = await emitControllerBootedAndStashEpoch({
      controllerId: 'host-test',
      bootEpoch: 'boot-epoch-i',
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
      const count = raw.prepare("SELECT count(*) AS n FROM spine_events WHERE event_type = 'run.abandoned'").get().n;
      assert.equal(count, 1, 'expect exactly one run.abandoned despite two reconcile calls');
    } finally {
      raw.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test('reconciler preserves the orphan event (append-only invariant)', async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    seedOrphan(dbPath, { event_id: 'evt_orphan_preserve', run_id: 'run_p', actor_id: 'c' });

    const epoch = await emitControllerBootedAndStashEpoch({
      controllerId: 'host-test',
      bootEpoch: 'boot-epoch-p',
    });
    await reconcileOrphanedRunsAtBoot(epoch);

    const raw = new Database(dbPath);
    try {
      const orphan = raw.prepare(
        "SELECT * FROM spine_events WHERE event_id = ?"
      ).get('evt_orphan_preserve');
      assert.ok(orphan, 'orphan run.started must still exist');
      assert.equal(orphan.event_type, 'run.started');
    } finally {
      raw.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test('multi-controller isolation: controller B does NOT abandon controller A orphans', async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    // Orphan owned by controller A.
    seedOrphan(dbPath, {
      event_id: 'evt_a_orphan',
      run_id: 'run_a',
      actor_id: 'c',
      boot_epoch: 'boot-epoch-A',
      controller_id: 'host-A',
    });

    // Boot as controller B.
    const epoch = await emitControllerBootedAndStashEpoch({
      controllerId: 'host-B',
      bootEpoch: 'boot-epoch-B',
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    assert.equal(result.selected, 0, 'controller B must not see controller A orphans');
    assert.equal(result.abandoned, 0);

    const raw = new Database(dbPath);
    try {
      const count = raw.prepare("SELECT count(*) AS n FROM spine_events WHERE event_type = 'run.abandoned'").get().n;
      assert.equal(count, 0);
    } finally {
      raw.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test('run_id collision: two orphans with same run_id produce two run.abandoned events', async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    seedOrphan(dbPath, { event_id: 'evt_collide_1', run_id: 'run_shared', actor_id: 'c' });
    seedOrphan(dbPath, { event_id: 'evt_collide_2', run_id: 'run_shared', actor_id: 'c' });

    const epoch = await emitControllerBootedAndStashEpoch({
      controllerId: 'host-test',
      bootEpoch: 'boot-epoch-c',
    });
    const result = await reconcileOrphanedRunsAtBoot(epoch);

    // Two distinct orphans by event_id, both selected before any insert
    // (single SELECT-then-INSERT semantics from §3.4). Both get abandoned.
    assert.equal(result.selected, 2);
    assert.equal(result.abandoned, 2);

    const raw = new Database(dbPath);
    try {
      const causes = raw.prepare(
        "SELECT json_extract(data_json, '$.caused_by_event_id') AS cause FROM spine_events WHERE event_type = 'run.abandoned' ORDER BY cause"
      ).all().map(r => r.cause);
      assert.deepEqual(causes, ['evt_collide_1', 'evt_collide_2']);
    } finally {
      raw.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});

test('cross-boot: reconciler picks up orphans from earlier emission', async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    // First boot: emit controller.booted but no run.started.
    const epoch1 = await emitControllerBootedAndStashEpoch({
      controllerId: 'host-test',
      bootEpoch: 'epoch-1',
    });
    assert.equal(epoch1.seq, 1);
    // Simulate a run.started emitted under epoch-1 that never terminates.
    seedOrphan(dbPath, {
      event_id: 'evt_cross_boot',
      run_id: 'run_cross',
      actor_id: 'conn',
      boot_epoch: 'epoch-1',
      controller_id: 'host-test',
    });
    clearCurrentBootEpoch();

    // Second boot.
    const epoch2 = await emitControllerBootedAndStashEpoch({
      controllerId: 'host-test',
      bootEpoch: 'epoch-2',
    });
    assert.equal(epoch2.seq, 2, 'seq must increment monotonically per controller_id');

    const result = await reconcileOrphanedRunsAtBoot(epoch2);
    assert.equal(result.selected, 1);
    assert.equal(result.abandoned, 1);

    const raw = new Database(dbPath);
    try {
      const abandon = raw.prepare(
        "SELECT data_json FROM spine_events WHERE event_type = 'run.abandoned'"
      ).get();
      const d = JSON.parse(abandon.data_json);
      assert.equal(d.original_boot_epoch, 'epoch-1');
      assert.equal(d.reconciled_by_boot_epoch, 'epoch-2');
      assert.equal(d.original_controller_id, 'host-test');
    } finally {
      raw.close();
    }
  } finally {
    clearCurrentBootEpoch();
    closeDb();
  }
});
