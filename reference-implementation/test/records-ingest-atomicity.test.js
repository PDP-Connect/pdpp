/**
 * Record ingest atomicity tests.
 *
 * These tests pin the durable record-mutation invariants of `ingestRecord`:
 *
 *   - successive changed writes for the same (connector_id, stream) allocate
 *     unique, monotonically increasing versions
 *   - identical re-ingest does not append a `record_changes` row or advance
 *     `version_counter`
 *   - repeated delete does not append a duplicate delete change or advance
 *     `version_counter`
 *   - if any error occurs after the durable mutation begins (here, simulated
 *     between record-write and `record_changes` append via a test-only fault
 *     hook), `records`, `record_changes`, and `version_counter` are *all*
 *     rolled back together — a subsequent ingest must not collide with or
 *     skip around a partially written version
 *   - consumers reading `record_changes` directly see a contiguous version
 *     sequence after the tested writes
 *
 * Old failure mode the rollback test pins: prior to this change, the durable
 * writes ran outside an explicit SQLite transaction. If the process crashed
 * between the live `records` mutation and the `record_changes` append (or
 * between the change-log append and the `version_counter` advance), the
 * three tables drifted: live state could move while the change feed and
 * counter did not, so `changes_since` cursors could observe gaps,
 * collisions, or stale max_versions on the next ingest.
 *
 * Spec: openspec/changes/harden-record-ingest-atomicity/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  __setIngestFaultHookForTest,
  ingestRecord,
} from '../server/records.js';

const CONNECTOR_ID = 'https://test.pdpp.org/connectors/atomicity';
const STREAM = 'items';

function setup() {
  initDb();
}

function teardown() {
  __setIngestFaultHookForTest(null);
  closeDb();
}

function readChangeRows() {
  return getDb()
    .prepare(
      `SELECT version, record_key, record_json, deleted
       FROM record_changes
       WHERE connector_id = ? AND stream = ?
       ORDER BY version ASC`
    )
    .all(CONNECTOR_ID, STREAM);
}

function readVersionCounter() {
  const row = getDb()
    .prepare(
      `SELECT max_version FROM version_counter
       WHERE connector_id = ? AND stream = ?`
    )
    .get(CONNECTOR_ID, STREAM);
  return row ? row.max_version : null;
}

function readLiveRecord(recordKey) {
  return getDb()
    .prepare(
      `SELECT record_key, record_json, version, deleted
       FROM records
       WHERE connector_id = ? AND stream = ? AND record_key = ?`
    )
    .get(CONNECTOR_ID, STREAM, recordKey);
}

function makeUpsert(id, payload) {
  return {
    stream: STREAM,
    key: id,
    data: { id, ...payload },
    emitted_at: '2026-04-28T12:00:00.000Z',
    op: 'upsert',
  };
}

function makeDelete(id) {
  return {
    stream: STREAM,
    key: id,
    data: { id },
    emitted_at: '2026-04-28T12:00:00.000Z',
    op: 'delete',
  };
}

test('changed writes allocate unique monotonic versions per (connector_id, stream)', async () => {
  setup();
  try {
    const r1 = await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));
    const r2 = await ingestRecord(CONNECTOR_ID, makeUpsert('b', { v: 1 }));
    const r3 = await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 2 }));

    assert.equal(r1.changed, true);
    assert.equal(r2.changed, true);
    assert.equal(r3.changed, true);

    const changes = readChangeRows();
    const versions = changes.map((row) => row.version);
    assert.deepEqual(versions, [1, 2, 3]);

    // versions are unique and strictly increasing
    const unique = new Set(versions);
    assert.equal(unique.size, versions.length);
    for (let i = 1; i < versions.length; i++) {
      assert.ok(versions[i] > versions[i - 1], `version ${versions[i]} must exceed ${versions[i - 1]}`);
    }

    assert.equal(readVersionCounter(), 3);

    // The live row's version reflects the latest change-log version.
    const liveA = readLiveRecord('a');
    assert.equal(liveA.version, 3);
  } finally {
    teardown();
  }
});

test('identical re-ingest does not append record_changes or advance version_counter', async () => {
  setup();
  try {
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));
    const before = readChangeRows();
    const counterBefore = readVersionCounter();

    const second = await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));
    assert.equal(second.changed, false);

    const after = readChangeRows();
    assert.deepEqual(after, before, 'record_changes must not change for a no-op re-ingest');
    assert.equal(readVersionCounter(), counterBefore, 'version_counter must not advance for a no-op re-ingest');
  } finally {
    teardown();
  }
});

test('repeated delete does not append duplicate delete or advance version_counter', async () => {
  setup();
  try {
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));
    const firstDelete = await ingestRecord(CONNECTOR_ID, makeDelete('a'));
    assert.equal(firstDelete.changed, true);

    const counterAfterDelete = readVersionCounter();
    const changesAfterDelete = readChangeRows();
    assert.equal(counterAfterDelete, 2);
    assert.equal(changesAfterDelete.filter((row) => row.deleted === 1).length, 1);

    const repeatDelete = await ingestRecord(CONNECTOR_ID, makeDelete('a'));
    assert.equal(repeatDelete.changed, false);

    assert.equal(readVersionCounter(), counterAfterDelete, 'version_counter must not advance for a repeated delete');
    assert.deepEqual(readChangeRows(), changesAfterDelete, 'record_changes must not gain a duplicate delete row');

    // Delete on a record that never existed is also a no-op.
    const ghostDelete = await ingestRecord(CONNECTOR_ID, makeDelete('never-was'));
    assert.equal(ghostDelete.changed, false);
    assert.equal(readVersionCounter(), counterAfterDelete);
    assert.deepEqual(readChangeRows(), changesAfterDelete);
  } finally {
    teardown();
  }
});

test('failure between live mutation and record_changes append rolls back the whole durable unit', async () => {
  setup();
  try {
    // Seed a record so the failing ingest is an *update* on top of a known
    // baseline; this lets us assert that the live row stays at the seeded
    // version after rollback (not advanced to the would-be next version).
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));
    const baselineLive = readLiveRecord('a');
    const baselineCounter = readVersionCounter();
    const baselineChanges = readChangeRows();
    assert.equal(baselineLive.version, 1);
    assert.equal(baselineCounter, 1);

    // Inject a failure *after* the records mutation runs but *before* the
    // record_changes append. Without an explicit transaction the first exec
    // would persist; with the new atomic boundary the whole unit rolls back.
    __setIngestFaultHookForTest((point) => {
      if (point === 'after-records-mutation') {
        throw new Error('injected fault between records and record_changes');
      }
    });

    await assert.rejects(
      () => ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 2 })),
      /injected fault/
    );

    __setIngestFaultHookForTest(null);

    // Live row, change log, and counter must all be unchanged.
    const liveAfter = readLiveRecord('a');
    assert.deepEqual(liveAfter, baselineLive, 'live records row must not advance when ingest aborts');
    assert.equal(readVersionCounter(), baselineCounter, 'version_counter must not advance when ingest aborts');
    assert.deepEqual(readChangeRows(), baselineChanges, 'record_changes must not gain a row when ingest aborts');

    // A subsequent successful ingest must not collide with or skip around a
    // partially written version. It should take version = baselineCounter + 1.
    const recovered = await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 3 }));
    assert.equal(recovered.changed, true);
    assert.equal(readVersionCounter(), baselineCounter + 1);
    const recoveredChanges = readChangeRows();
    const newRow = recoveredChanges[recoveredChanges.length - 1];
    assert.equal(newRow.version, baselineCounter + 1);
    assert.equal(newRow.deleted, 0);
  } finally {
    teardown();
  }
});

test('record_changes is contiguous and matches version_counter after a sequence of writes', async () => {
  setup();
  try {
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));
    await ingestRecord(CONNECTOR_ID, makeUpsert('b', { v: 1 }));
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 })); // no-op
    await ingestRecord(CONNECTOR_ID, makeDelete('b'));
    await ingestRecord(CONNECTOR_ID, makeDelete('b')); // repeated no-op
    await ingestRecord(CONNECTOR_ID, makeUpsert('c', { v: 1 }));

    const changes = readChangeRows();
    const versions = changes.map((row) => row.version);

    // Versions are contiguous starting at 1.
    assert.deepEqual(versions, [1, 2, 3, 4]);

    // Counter matches the highest emitted change-log version.
    assert.equal(readVersionCounter(), versions[versions.length - 1]);

    // All change-log versions are unique.
    assert.equal(new Set(versions).size, versions.length);
  } finally {
    teardown();
  }
});

test('test-only fault hook is fully cleared and has no effect on subsequent ingest', async () => {
  setup();
  try {
    // Install and clear the hook; later ingests must behave as if no hook
    // ever existed. Guards against the production-path-leak risk of the hook.
    __setIngestFaultHookForTest(() => {
      throw new Error('should not run');
    });
    __setIngestFaultHookForTest(null);

    const r = await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));
    assert.equal(r.changed, true);
    assert.equal(readVersionCounter(), 1);
  } finally {
    teardown();
  }
});
