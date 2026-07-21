// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Direct record delete atomicity tests.
 *
 * These tests pin the durable record-mutation invariants of `deleteRecord`,
 * the owner-authenticated direct-delete helper. The durable unit covers:
 *
 *   - current-state read
 *   - absent / already-deleted no-op decision
 *   - version allocation
 *   - live `records` delete-marker mutation
 *   - `record_changes` deleted-row append
 *   - `version_counter` advance
 *   - history pruning
 *
 * Search-index deletes are deliberately outside the durable transaction and
 * only run after a successful commit; index drift recovery is the search
 * indexer's responsibility, not the durable record store's.
 *
 * Old failure mode the rollback test pins: prior to this change, the durable
 * writes ran outside an explicit SQLite transaction. If the process crashed
 * between the live `records` mutation and the `record_changes` append (or
 * between the change-log append and the `version_counter` advance), the
 * three tables drifted: live state could move while the change feed and
 * counter did not, so `changes_since` cursors could observe gaps,
 * collisions, or stale max_versions on the next mutation.
 *
 * Spec: openspec/changes/harden-record-delete-atomicity/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  __setDeleteFaultHookForTest,
  deleteRecord,
  ingestRecord,
} from '../server/records.js';

const CONNECTOR_ID = 'https://test.pdpp.org/connectors/delete-atomicity';
const STREAM = 'items';

function setup() {
  initDb();
}

function teardown() {
  __setDeleteFaultHookForTest(null);
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

function makeIngestDelete(id) {
  return {
    stream: STREAM,
    key: id,
    data: { id },
    emitted_at: '2026-04-28T12:00:00.000Z',
    op: 'delete',
  };
}

test('successful direct delete appends exactly one delete change and advances version_counter once', async () => {
  setup();
  try {
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));
    const counterBefore = readVersionCounter();
    const changesBefore = readChangeRows();
    assert.equal(counterBefore, 1);
    assert.equal(changesBefore.length, 1);

    const result = await deleteRecord(CONNECTOR_ID, STREAM, 'a');
    assert.equal(result, 1);

    // Exactly one new change row was appended, and it is a delete row at
    // the next sequential version.
    const changesAfter = readChangeRows();
    assert.equal(changesAfter.length, changesBefore.length + 1);
    const deleteRow = changesAfter[changesAfter.length - 1];
    assert.equal(deleteRow.deleted, 1);
    assert.equal(deleteRow.record_key, 'a');
    assert.equal(deleteRow.version, counterBefore + 1);

    // version_counter advanced exactly once.
    assert.equal(readVersionCounter(), counterBefore + 1);

    // Live `records` row is marked deleted at the same version recorded by
    // the change-log row and version_counter.
    const live = readLiveRecord('a');
    assert.equal(live.deleted, 1);
    assert.equal(live.version, counterBefore + 1);
  } finally {
    teardown();
  }
});

test('direct delete on an absent record returns 0 and does not append record_changes or advance version_counter', async () => {
  setup();
  try {
    // Seed an unrelated record so version_counter exists with a non-zero value;
    // the no-op delete must leave it untouched.
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));
    const counterBefore = readVersionCounter();
    const changesBefore = readChangeRows();

    const result = await deleteRecord(CONNECTOR_ID, STREAM, 'never-was');
    assert.equal(result, 0);

    assert.deepEqual(readChangeRows(), changesBefore, 'record_changes must not change for an absent-record direct delete');
    assert.equal(readVersionCounter(), counterBefore, 'version_counter must not advance for an absent-record direct delete');
    assert.equal(readLiveRecord('never-was'), undefined);
  } finally {
    teardown();
  }
});

test('direct delete on an already-deleted record returns 0 and does not append record_changes or advance version_counter', async () => {
  setup();
  try {
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));
    const firstDelete = await deleteRecord(CONNECTOR_ID, STREAM, 'a');
    assert.equal(firstDelete, 1);

    const counterAfterDelete = readVersionCounter();
    const changesAfterDelete = readChangeRows();

    const repeat = await deleteRecord(CONNECTOR_ID, STREAM, 'a');
    assert.equal(repeat, 0);

    assert.equal(readVersionCounter(), counterAfterDelete, 'version_counter must not advance for a repeated direct delete');
    assert.deepEqual(readChangeRows(), changesAfterDelete, 'record_changes must not gain a duplicate delete row for a repeated direct delete');
  } finally {
    teardown();
  }
});

test('failure between live mutation and record_changes append rolls back the whole durable direct-delete unit', async () => {
  setup();
  try {
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));
    const baselineLive = readLiveRecord('a');
    const baselineCounter = readVersionCounter();
    const baselineChanges = readChangeRows();
    assert.equal(baselineLive.deleted, 0);
    assert.equal(baselineLive.version, 1);
    assert.equal(baselineCounter, 1);

    // Inject a failure *after* the records delete-marker mutation but
    // *before* the record_changes append. Without an explicit transaction
    // the records mutation would persist; with the new atomic boundary the
    // whole unit rolls back.
    __setDeleteFaultHookForTest((point) => {
      if (point === 'after-records-mutation') {
        throw new Error('injected fault between records and record_changes (delete)');
      }
    });

    await assert.rejects(
      () => deleteRecord(CONNECTOR_ID, STREAM, 'a'),
      /injected fault/
    );

    __setDeleteFaultHookForTest(null);

    // Live row, change log, and counter must all be unchanged.
    const liveAfter = readLiveRecord('a');
    assert.deepEqual(liveAfter, baselineLive, 'live records row must not advance when direct delete aborts');
    assert.equal(readVersionCounter(), baselineCounter, 'version_counter must not advance when direct delete aborts');
    assert.deepEqual(readChangeRows(), baselineChanges, 'record_changes must not gain a row when direct delete aborts');

    // A subsequent successful direct delete must not collide with or skip
    // around a partially written version. It should take version =
    // baselineCounter + 1.
    const recovered = await deleteRecord(CONNECTOR_ID, STREAM, 'a');
    assert.equal(recovered, 1);
    assert.equal(readVersionCounter(), baselineCounter + 1);
    const recoveredChanges = readChangeRows();
    const newRow = recoveredChanges[recoveredChanges.length - 1];
    assert.equal(newRow.version, baselineCounter + 1);
    assert.equal(newRow.deleted, 1);
  } finally {
    teardown();
  }
});

test('record_changes is contiguous across mixed ingest/delete/direct-delete writes', async () => {
  setup();
  try {
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));            // v=1
    await ingestRecord(CONNECTOR_ID, makeUpsert('b', { v: 1 }));            // v=2
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));            // no-op
    await ingestRecord(CONNECTOR_ID, makeIngestDelete('b'));                // v=3 (ingest delete)
    await ingestRecord(CONNECTOR_ID, makeIngestDelete('b'));                // no-op
    const directNoop = await deleteRecord(CONNECTOR_ID, STREAM, 'b');       // already-deleted no-op
    assert.equal(directNoop, 0);
    await ingestRecord(CONNECTOR_ID, makeUpsert('c', { v: 1 }));            // v=4
    const directDelete = await deleteRecord(CONNECTOR_ID, STREAM, 'a');     // v=5 (direct delete)
    assert.equal(directDelete, 1);

    const changes = readChangeRows();
    const versions = changes.map((row) => row.version);

    // Versions are contiguous starting at 1.
    assert.deepEqual(versions, [1, 2, 3, 4, 5]);

    // Counter matches the highest emitted change-log version.
    assert.equal(readVersionCounter(), versions[versions.length - 1]);

    // All change-log versions are unique.
    assert.equal(new Set(versions).size, versions.length);
  } finally {
    teardown();
  }
});

test('test-only delete fault hook is fully cleared and has no effect on subsequent direct deletes', async () => {
  setup();
  try {
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));

    __setDeleteFaultHookForTest(() => {
      throw new Error('should not run');
    });
    __setDeleteFaultHookForTest(null);

    const result = await deleteRecord(CONNECTOR_ID, STREAM, 'a');
    assert.equal(result, 1);
    assert.equal(readVersionCounter(), 2);
  } finally {
    teardown();
  }
});
