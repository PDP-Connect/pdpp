// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Spine-layer enforcement of the boot-epoch reconciliation invariant.
 *
 * `emitSpineEvent` rejects `run.started` events whose `data` lacks
 * `boot_epoch` (string uuid) or `seq` (positive integer). The rejection
 * is loud — a test fixture, import script, or future code path that
 * tries to emit `run.started` without going through the runtime's
 * stamping wrapper gets a clear error pointing at the design brief.
 *
 * The unique partial index `spine_run_abandoned_cause_unique` is the
 * other half of Stage 3; tested via direct INSERT to keep the surface
 * narrow (the runtime's idempotent retry behavior on the named
 * constraint is covered in Stage 6's reconciler tests).
 *
 * Design contract: docs/run-reconciliation-design-brief.md §3.3, §3.5.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';

import { initDb, closeDb, getDb } from '../server/db.js';
import { makeTemporaryDbPath } from './helpers/temp-dir.js';
import { emitSpineEvent } from '../lib/spine.ts';

function tempDbPath() {
  return makeTemporaryDbPath('pdpp-stamping-');
}

test('emitSpineEvent rejects run.started without boot_epoch', async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    await assert.rejects(
      () => emitSpineEvent({
        event_type: 'run.started',
        actor_type: 'runtime',
        actor_id: 'test_connector',
        run_id: 'run_test_unstamped',
        data: { source: { kind: 'connector', id: 'test_connector' } },
      }),
      (err) => {
        assert.match(err.message, /run\.started requires data\.boot_epoch/);
        assert.match(err.message, /run-reconciliation-design-brief/);
        return true;
      },
      'emitSpineEvent must reject run.started with no boot_epoch',
    );
  } finally {
    closeDb();
  }
});

test('emitSpineEvent rejects run.started with non-string boot_epoch', async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    await assert.rejects(
      () => emitSpineEvent({
        event_type: 'run.started',
        actor_type: 'runtime',
        actor_id: 'c',
        run_id: 'run_1',
        data: { boot_epoch: 12345, seq: 1 },
      }),
      /run\.started requires data\.boot_epoch \(string uuid\)/,
    );
  } finally {
    closeDb();
  }
});

test('emitSpineEvent rejects run.started without seq', async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    await assert.rejects(
      () => emitSpineEvent({
        event_type: 'run.started',
        actor_type: 'runtime',
        actor_id: 'c',
        run_id: 'run_1',
        data: { boot_epoch: 'abc-123' },
      }),
      /run\.started requires data\.seq/,
    );
  } finally {
    closeDb();
  }
});

test('emitSpineEvent rejects run.started with seq=0 (must be positive)', async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    await assert.rejects(
      () => emitSpineEvent({
        event_type: 'run.started',
        actor_type: 'runtime',
        actor_id: 'c',
        run_id: 'run_1',
        data: { boot_epoch: 'abc-123', seq: 0 },
      }),
      /run\.started requires data\.seq/,
    );
  } finally {
    closeDb();
  }
});

test('emitSpineEvent accepts run.started with valid boot_epoch + seq', async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    const ev = await emitSpineEvent({
      event_type: 'run.started',
      actor_type: 'runtime',
      actor_id: 'c',
      run_id: 'run_1',
      data: { boot_epoch: 'abc-uuid-123', seq: 1 },
    });
    assert.ok(ev, 'event should be emitted');
    assert.equal(ev.event_type, 'run.started');
    assert.equal(ev.data.boot_epoch, 'abc-uuid-123');
    assert.equal(ev.data.seq, 1);
  } finally {
    closeDb();
  }
});

test('emitSpineEvent does NOT check stamping on non-run.started events', async () => {
  // Stamping is required only on run.started. Other event types
  // (controller.booted, run.completed, etc.) have their own shape
  // constraints elsewhere.
  const dbPath = tempDbPath();
  initDb(dbPath);
  try {
    const ev = await emitSpineEvent({
      event_type: 'controller.booted',
      actor_type: 'runtime',
      actor_id: 'controller',
      data: { epoch: 'epoch-uuid', seq: 1, controller_id: 'host-a' },
    });
    assert.ok(ev, 'controller.booted should emit without boot_epoch on its data');

    const ev2 = await emitSpineEvent({
      event_type: 'run.completed',
      actor_type: 'runtime',
      actor_id: 'c',
      run_id: 'run_1',
      data: {},
    });
    assert.ok(ev2, 'run.completed should emit without boot_epoch stamping');
  } finally {
    closeDb();
  }
});

test('spine_run_abandoned_cause_unique index exists and rejects duplicate caused_by_event_id', async () => {
  const dbPath = tempDbPath();
  initDb(dbPath);
  closeDb();

  const raw = new Database(dbPath);
  try {
    // Confirm the index was created at initDb.
    const idx = raw.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='spine_run_abandoned_cause_unique'"
    ).get();
    assert.ok(idx, 'spine_run_abandoned_cause_unique index missing');

    // Insert two `run.abandoned` events with the same caused_by_event_id;
    // second must fail with a unique-constraint violation naming the index.
    const ts = '2026-05-11T20:00:00.000Z';
    const insertOk = raw.prepare(`
      INSERT INTO spine_events
        (event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
         actor_type, actor_id, object_type, object_id, status, data_json, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertOk.run(
      'evt_a', 'run.abandoned', ts, ts, 's', 't',
      'runtime', 'c', 'run', 'run_x', 'abandoned',
      JSON.stringify({ caused_by_event_id: 'orphan_evt_1' }), 'v1',
    );

    assert.throws(
      () => insertOk.run(
        'evt_b', 'run.abandoned', ts, ts, 's', 't',
        'runtime', 'c', 'run', 'run_x', 'abandoned',
        JSON.stringify({ caused_by_event_id: 'orphan_evt_1' }), 'v1',
      ),
      /UNIQUE constraint failed|spine_run_abandoned_cause_unique/,
      'second run.abandoned with same caused_by_event_id must fail',
    );

    // Different caused_by_event_id: must succeed.
    insertOk.run(
      'evt_c', 'run.abandoned', ts, ts, 's', 't',
      'runtime', 'c', 'run', 'run_y', 'abandoned',
      JSON.stringify({ caused_by_event_id: 'orphan_evt_2' }), 'v1',
    );

    // The index is partial — only `run.abandoned` is constrained. Other
    // event types may carry caused_by_event_id without conflict.
    insertOk.run(
      'evt_d', 'some.other', ts, ts, 's', 't',
      'runtime', 'c', 'misc', 'x', 'unknown',
      JSON.stringify({ caused_by_event_id: 'orphan_evt_1' }), 'v1',
    );

    const count = raw.prepare("SELECT count(*) AS n FROM spine_events WHERE event_type = 'run.abandoned'").get().n;
    assert.equal(count, 2, 'expect exactly 2 run.abandoned rows');
  } finally {
    raw.close();
  }
});
