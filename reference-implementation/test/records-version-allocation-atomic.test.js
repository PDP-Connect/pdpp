/**
 * Atomic record-version allocation tests.
 *
 * These tests pin the *atomic* version-allocation contract introduced in
 * `harden-record-version-allocation-atomicity`. They are sibling to the
 * broader `records-ingest-atomicity.test.js` /
 * `records-delete-atomicity.test.js` / record mutation conformance suites:
 * those suites pin the durable-mutation-as-a-unit invariants, this suite
 * pins specifically that
 *
 *   - the next stream version is allocated by a single atomic store
 *     operation that simultaneously upserts `version_counter` and returns
 *     the freshly-allocated `max_version` (no read-then-write window),
 *   - successive changed writes for the same `(connector_id, stream)` always
 *     receive distinct, monotonically increasing versions even when the
 *     counter is the only durable state seeded from a prior run,
 *   - no-op re-ingest and repeated-delete still do not call the allocator
 *     (so the counter is unchanged and `record_changes` stays contiguous),
 *   - `changes_since` consumers observe a contiguous version sequence.
 *
 * Falsifiability note: prior to this change, allocation was a
 * read-then-write sequence:
 *
 *   const vcRow = getOne(referenceQueries.recordsIngestGetVersionCounter, …);
 *   const nextVersion = vcRow ? vcRow.max_version + 1 : 1;
 *   …
 *   exec(referenceQueries.recordsIngestUpsertVersionCounter,
 *        [connectorId, stream, nextVersion]);
 *
 * A reviewer can confirm the new test fails by sabotaging the allocator to
 * stale-read by reverting the SQL artifact to the old pair of
 * `recordsIngestGetVersionCounter` + `recordsIngestUpsertVersionCounter` and
 * deliberately *skipping* the upsert; the "allocator advances version_counter
 * in one statement" assertion below detects that drift because the counter
 * row would not exist after the first allocation.
 *
 * Spec: openspec/changes/harden-record-version-allocation-atomicity/specs/
 *       reference-implementation-architecture/spec.md
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { closeDb, getDb, initDb } from '../server/db.js';
import { execReturningOne, referenceQueries } from '../lib/db.ts';
import { deleteRecord, ingestRecord } from '../server/records.js';
import { makeDefaultAccountConnectorInstanceId } from '../server/stores/connector-instance-store.js';

const CONNECTOR_ID = 'https://test.pdpp.org/connectors/version-allocation';
const CONNECTOR_INSTANCE_ID = 'cin_test_version_allocation';
const DEFAULT_ACCOUNT_CONNECTOR_INSTANCE_ID = makeDefaultAccountConnectorInstanceId('owner_local', CONNECTOR_ID);
const STREAM = 'items';

function setup() {
  initDb();
}

function teardown() {
  closeDb();
}

function readVersionCounter(connectorInstanceId = DEFAULT_ACCOUNT_CONNECTOR_INSTANCE_ID) {
  const row = getDb()
    .prepare(
      `SELECT max_version FROM version_counter
       WHERE connector_id = ? AND connector_instance_id = ? AND stream = ?`,
    )
    .get(CONNECTOR_ID, connectorInstanceId, STREAM);
  return row ? row.max_version : null;
}

function readChangeVersions() {
  return getDb()
    .prepare(
      `SELECT version FROM record_changes
       WHERE connector_id = ? AND stream = ?
       ORDER BY version ASC`,
    )
    .all(CONNECTOR_ID, STREAM)
    .map((row) => row.version);
}

function makeUpsert(id, payload) {
  return {
    stream: STREAM,
    key: id,
    data: { id, ...payload },
    emitted_at: '2026-04-29T00:00:00.000Z',
    op: 'upsert',
  };
}

test('atomic allocator returns 1 on first call and bumps counter in one statement', () => {
  setup();
  try {
    // Counter is absent before any allocation.
    assert.equal(readVersionCounter(CONNECTOR_INSTANCE_ID), null);

    const first = execReturningOne(
      referenceQueries.recordsIngestAllocateNextVersion,
      [CONNECTOR_ID, CONNECTOR_INSTANCE_ID, STREAM],
    );
    assert.equal(first.max_version, 1, 'first allocation returns 1');
    assert.equal(
      readVersionCounter(CONNECTOR_INSTANCE_ID),
      1,
      'allocator must persist the new max_version in the same statement',
    );

    const second = execReturningOne(
      referenceQueries.recordsIngestAllocateNextVersion,
      [CONNECTOR_ID, CONNECTOR_INSTANCE_ID, STREAM],
    );
    assert.equal(second.max_version, 2, 'second allocation returns counter + 1');
    assert.equal(readVersionCounter(CONNECTOR_INSTANCE_ID), 2);

    const third = execReturningOne(
      referenceQueries.recordsIngestAllocateNextVersion,
      [CONNECTOR_ID, CONNECTOR_INSTANCE_ID, STREAM],
    );
    assert.equal(third.max_version, 3);
    assert.equal(readVersionCounter(CONNECTOR_INSTANCE_ID), 3);
  } finally {
    teardown();
  }
});

test('changed writes for the same (connector_id, stream) allocate distinct increasing versions', async () => {
  setup();
  try {
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));
    await ingestRecord(CONNECTOR_ID, makeUpsert('b', { v: 1 }));
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 2 }));
    await deleteRecord(CONNECTOR_ID, STREAM, 'b');

    const versions = readChangeVersions();
    assert.deepEqual(
      versions,
      [1, 2, 3, 4],
      'each changed write must allocate a distinct, contiguous, increasing version',
    );
    assert.equal(new Set(versions).size, versions.length, 'allocator must not re-issue a version');
    for (let i = 1; i < versions.length; i++) {
      assert.ok(
        versions[i] > versions[i - 1],
        `version ${versions[i]} must exceed ${versions[i - 1]}`,
      );
    }
    assert.equal(readVersionCounter(), versions[versions.length - 1]);
  } finally {
    teardown();
  }
});

test('no-op re-ingest does not call the allocator (counter unchanged)', async () => {
  setup();
  try {
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));
    const counterBefore = readVersionCounter();
    const versionsBefore = readChangeVersions();

    const second = await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));
    assert.equal(second.changed, false);

    assert.equal(readVersionCounter(), counterBefore, 'counter must not advance for a no-op re-ingest');
    assert.deepEqual(readChangeVersions(), versionsBefore);
  } finally {
    teardown();
  }
});

test('repeated direct delete does not call the allocator (counter unchanged)', async () => {
  setup();
  try {
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));
    await deleteRecord(CONNECTOR_ID, STREAM, 'a');
    const counterAfterDelete = readVersionCounter();
    const versionsAfterDelete = readChangeVersions();

    const repeat = await deleteRecord(CONNECTOR_ID, STREAM, 'a');
    assert.equal(repeat, 0);

    assert.equal(
      readVersionCounter(),
      counterAfterDelete,
      'counter must not advance for a repeated direct delete',
    );
    assert.deepEqual(readChangeVersions(), versionsAfterDelete);
  } finally {
    teardown();
  }
});

test('changes_since change-log sequence is contiguous across mixed writes', async () => {
  setup();
  try {
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));        // v=1
    await ingestRecord(CONNECTOR_ID, makeUpsert('b', { v: 1 }));        // v=2
    await ingestRecord(CONNECTOR_ID, makeUpsert('a', { v: 1 }));        // no-op
    await ingestRecord(CONNECTOR_ID, {                                  // v=3 (ingest delete)
      stream: STREAM,
      key: 'b',
      data: { id: 'b' },
      emitted_at: '2026-04-29T00:00:00.000Z',
      op: 'delete',
    });
    await deleteRecord(CONNECTOR_ID, STREAM, 'b');                      // already-deleted no-op
    await ingestRecord(CONNECTOR_ID, makeUpsert('c', { v: 1 }));        // v=4

    const versions = readChangeVersions();
    assert.deepEqual(versions, [1, 2, 3, 4], 'change-log version sequence must be contiguous');
    assert.equal(readVersionCounter(), 4);
  } finally {
    teardown();
  }
});
