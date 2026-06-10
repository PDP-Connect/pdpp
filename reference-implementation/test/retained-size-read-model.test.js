import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { ingestRecord } from '../server/records.js';
import {
  getRetainedSizeGlobal,
  listRetainedSizeConnections,
  listRetainedSizeRecordFamilies,
  listRetainedSizeStreams,
  listRetainedSizeTop,
  rebuildRetainedSize,
  reconcileDirtyRetainedSize,
} from '../server/retained-size-read-model.js';

async function withTempDb(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pdpp-retained-size-'));
  try {
    initDb(join(dir, 'pdpp.sqlite'));
    return await fn();
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

const storage = {
  connector_id: 'test.connector',
  connector_instance_id: 'cin_test_retained_size',
};

function jsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value));
}

test('retained-size rebuild derives global, connection, stream, and top rows from canonical state', () =>
  withTempDb(async () => {
    const one = { id: 'one', body: 'hello' };
    const two = { id: 'two', body: 'hello world' };
    await ingestRecord(storage, {
      stream: 'messages',
      key: 'one',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: one,
    });
    await ingestRecord(storage, {
      stream: 'files',
      key: 'two',
      emitted_at: '2026-01-02T00:00:00.000Z',
      data: two,
    });

    await rebuildRetainedSize();

    const expectedBytes = jsonBytes(one) + jsonBytes(two);
    const global = await getRetainedSizeGlobal();
    assert.equal(global.record_count, 2);
    assert.equal(global.current_record_json_bytes, expectedBytes);
    assert.equal(global.record_history_count, 2);
    assert.equal(global.record_history_json_bytes, expectedBytes);
    assert.equal(global.dirty, false);
    assert.equal(global.metadata.state, 'fresh');

    const connections = await listRetainedSizeConnections({ connectorInstanceId: storage.connector_instance_id });
    assert.equal(connections.length, 1);
    assert.equal(connections[0].total_retained_bytes, expectedBytes * 2);

    const streams = await listRetainedSizeStreams({ connectorInstanceId: storage.connector_instance_id });
    assert.deepEqual(streams.map((row) => row.stream).sort(), ['files', 'messages']);

    const topConnections = await listRetainedSizeTop({
      scope: 'connection',
      measure: 'total_retained_bytes',
      limit: 5,
    });
    assert.equal(topConnections[0].connector_instance_id, storage.connector_instance_id);
    assert.equal(topConnections[0].dirty, false);

    const topRecords = await listRetainedSizeTop({
      scope: 'record',
      measure: 'current_record_json_bytes',
      limit: 1,
    });
    assert.equal(topRecords.length, 1);
    assert.equal(topRecords[0].record_key, 'two');
  }));

test('retained-size record deltas update exact rows and mark top-N rows stale', () =>
  withTempDb(async () => {
    await ingestRecord(storage, {
      stream: 'messages',
      key: 'one',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'one', body: 'hello' },
    });
    await rebuildRetainedSize();

    await ingestRecord(storage, {
      stream: 'messages',
      key: 'one',
      emitted_at: '2026-01-03T00:00:00.000Z',
      data: { id: 'one', body: 'hello again' },
    });

    const global = await getRetainedSizeGlobal();
    assert.equal(global.record_count, 1);
    assert.equal(global.record_history_count, 2);
    assert.equal(global.dirty, false);

    const streams = await listRetainedSizeStreams({ connectorInstanceId: storage.connector_instance_id });
    assert.equal(streams[0].record_count, 1);
    assert.equal(streams[0].record_history_count, 2);

    const staleTop = await listRetainedSizeTop({
      scope: 'connection',
      measure: 'total_retained_bytes',
      limit: 1,
    });
    assert.equal(staleTop[0].dirty, true);
    assert.equal(staleTop[0].metadata.state, 'stale');

    await reconcileDirtyRetainedSize();
    const freshTop = await listRetainedSizeTop({
      scope: 'connection',
      measure: 'total_retained_bytes',
      limit: 1,
    });
    assert.equal(freshTop[0].dirty, false);
  }));

test('retained-size rebuild attributes blob bytes through blob bindings', () =>
  withTempDb(async () => {
    const db = getDb();
    db.prepare(
      `INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('blob_sha256_x', 'other.connector', 'cin_other', 'other', 'r0', 'text/plain', 7, 'x', Buffer.from('payload'));
    db.prepare(
      `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES(?, ?, ?, ?, ?, '@record')`,
    ).run('blob_sha256_x', storage.connector_id, storage.connector_instance_id, 'messages', 'one');

    await rebuildRetainedSize();

    const connection = (await listRetainedSizeConnections({ connectorInstanceId: storage.connector_instance_id }))[0];
    assert.equal(connection.blob_count, 1);
    assert.equal(connection.blob_bytes, 7);

    const blobTop = await listRetainedSizeTop({ scope: 'blob', measure: 'blob_bytes', limit: 1 });
    assert.equal(blobTop[0].blob_id, 'blob_sha256_x');
    assert.equal(blobTop[0].connector_instance_id, storage.connector_instance_id);
  }));

test('retained-size record total top rows include current, history, and blobs', () =>
  withTempDb(async () => {
    const first = { id: 'one', body: 'small' };
    const second = { id: 'one', body: 'larger body' };
    await ingestRecord(storage, {
      stream: 'messages',
      key: 'one',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: first,
    });
    await ingestRecord(storage, {
      stream: 'messages',
      key: 'one',
      emitted_at: '2026-01-02T00:00:00.000Z',
      data: second,
    });
    getDb().prepare(
      `INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('blob_sha256_record_total', storage.connector_id, storage.connector_instance_id, 'messages', 'one', 'text/plain', 37, 'record_total', Buffer.from('payload'));
    getDb().prepare(
      `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES(?, ?, ?, ?, ?, '@record')`,
    ).run('blob_sha256_record_total', storage.connector_id, storage.connector_instance_id, 'messages', 'one');

    await rebuildRetainedSize();

    const [topRecord] = await listRetainedSizeTop({
      scope: 'record',
      measure: 'total_retained_bytes',
      limit: 1,
    });
    const currentBytes = jsonBytes(second);
    const historyBytes = jsonBytes(first) + jsonBytes(second);
    assert.equal(topRecord.record_key, 'one');
    assert.equal(topRecord.current_record_json_bytes, currentBytes);
    assert.equal(topRecord.record_history_json_bytes, historyBytes);
    assert.equal(topRecord.blob_bytes, 37);
    assert.equal(topRecord.total_retained_bytes, currentBytes + historyBytes + 37);
  }));

test('retained-size record-family grain reads authored projection rows', () =>
  withTempDb(async () => {
    getDb().prepare(
      `INSERT INTO retained_size_record_family(
         connector_instance_id, connector_id, stream, record_family,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    ).run(
      storage.connector_instance_id,
      storage.connector_id,
      'messages',
      'thread',
      11,
      13,
      17,
      2,
      3,
      4,
      '2026-01-01T00:00:00.000Z',
    );

    const [row] = await listRetainedSizeRecordFamilies({
      connectorInstanceId: storage.connector_instance_id,
      stream: 'messages',
      recordFamily: 'thread',
    });
    assert.equal(row.grain, 'record_family');
    assert.equal(row.record_family, 'thread');
    assert.equal(row.total_retained_bytes, 41);
    assert.equal(row.record_count, 2);
    assert.equal(row.record_history_count, 3);
    assert.equal(row.blob_count, 4);
  }));

// Regression tests for the `connector_id` filter on listRetainedSizeStreams.
//
// `/_ref/dataset/summary/streams` accepts an optional `?connector_id=...`
// query parameter and forwards it as `{ connectorId }` to this helper.
// An earlier draft of that route incorrectly forwarded the value as
// `{ connectorInstanceId }`, which produced empty or wrong-connector
// results whenever the connector had more than one instance. These
// tests pin the helper's `connector_id` semantics so a future drive-by
// edit (or a future Postgres-only refactor) cannot silently regress.
test('listRetainedSizeStreams: connectorId filter narrows by connector_id, not by connector_instance_id', () =>
  withTempDb(async () => {
    const alpha = {
      connector_id: 'alpha.connector',
      connector_instance_id: 'cin_alpha_a',
    };
    const beta = {
      connector_id: 'beta.connector',
      connector_instance_id: 'cin_beta_b',
    };
    await ingestRecord(alpha, {
      stream: 'messages',
      key: 'a-msg',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'a-msg' },
    });
    await ingestRecord(beta, {
      stream: 'messages',
      key: 'b-msg',
      emitted_at: '2026-01-01T00:00:00.000Z',
      data: { id: 'b-msg' },
    });
    await rebuildRetainedSize();

    // Both helpers respect the new connectorId filter — neither test
    // pre-supposes Postgres backend selection.
    const alphaRows = await listRetainedSizeStreams({ connectorId: alpha.connector_id });
    assert.equal(alphaRows.length, 1, 'connectorId filter should narrow to exactly one connector');
    assert.equal(alphaRows[0].connector_id, alpha.connector_id);
    assert.equal(alphaRows[0].connector_instance_id, alpha.connector_instance_id);
    assert.equal(alphaRows[0].stream, 'messages');

    const betaRows = await listRetainedSizeStreams({ connectorId: beta.connector_id });
    assert.equal(betaRows.length, 1);
    assert.equal(betaRows[0].connector_id, beta.connector_id);

    // Bug-catch: passing alpha's `connector_id` value through the
    // `connectorInstanceId` slot must NOT silently match alpha. The two
    // connectors here have *different* connector_instance_ids than
    // connector_ids, so a route that confuses the slots would either
    // return zero rows or match the wrong connector.
    const wrongSlot = await listRetainedSizeStreams({
      connectorInstanceId: alpha.connector_id,
    });
    assert.deepEqual(
      wrongSlot,
      [],
      'connectorInstanceId filter must NOT match a connector_id value',
    );
  }));

test('listRetainedSizeStreams: connectorId and stream filters compose', () =>
  withTempDb(async () => {
    const alpha = {
      connector_id: 'alpha.connector',
      connector_instance_id: 'cin_alpha_a',
    };
    const beta = {
      connector_id: 'beta.connector',
      connector_instance_id: 'cin_beta_b',
    };
    for (const account of [alpha, beta]) {
      const msgKey = `${account.connector_id}-msg`;
      const fileKey = `${account.connector_id}-file`;
      await ingestRecord(account, {
        stream: 'messages',
        key: msgKey,
        emitted_at: '2026-01-01T00:00:00.000Z',
        data: { id: msgKey },
      });
      await ingestRecord(account, {
        stream: 'files',
        key: fileKey,
        emitted_at: '2026-01-02T00:00:00.000Z',
        data: { id: fileKey },
      });
    }
    await rebuildRetainedSize();

    const alphaMessages = await listRetainedSizeStreams({
      connectorId: alpha.connector_id,
      stream: 'messages',
    });
    assert.equal(alphaMessages.length, 1);
    assert.equal(alphaMessages[0].connector_id, alpha.connector_id);
    assert.equal(alphaMessages[0].stream, 'messages');
  }));

// Route-shape regression: this proves the public `connector_id` query
// parameter flows through `executeRefDatasetSummaryStreams` and the
// SQLite-host `listStreams` capability as a `connector_id` filter, not
// as a `connector_instance_id` filter. The host adapter in
// `server/index.js` calls `listRetainedSizeStreams({ connectorId })`
// (Postgres) or `listStreamProjections({ connectorId })` (SQLite); both
// helpers reach the same canonical `connector_id` column. If a future
// edit re-routes that to the `connectorInstanceId` slot, this test will
// fail at the boundary the route uses.
test('ref.dataset.summary.streams: connector_id query forwards as connectorId filter, not connectorInstanceId', async () => {
  const { executeRefDatasetSummaryStreams } = await import(
    '../operations/ref-dataset-summary-streams/index.ts'
  );

  const seenInputs = [];
  const allRows = [
    {
      connector_id: 'gmail',
      stream: 'messages',
      record_count: 3,
      record_json_bytes: 120,
      earliest_ingested_at: null,
      latest_ingested_at: null,
      earliest_record_time: null,
      latest_record_time: null,
      consent_time_field: null,
      dirty_record_time_bounds: false,
      computed_at: '2026-05-19T12:00:00.000Z',
    },
    {
      connector_id: 'claude_code',
      stream: 'sessions',
      record_count: 2,
      record_json_bytes: 90,
      earliest_ingested_at: null,
      latest_ingested_at: null,
      earliest_record_time: null,
      latest_record_time: null,
      consent_time_field: null,
      dirty_record_time_bounds: false,
      computed_at: '2026-05-19T12:00:00.000Z',
    },
  ];

  const envelope = await executeRefDatasetSummaryStreams(
    { connector_id: 'gmail' },
    {
      listStreams: (input) => {
        seenInputs.push(input);
        // Simulate the host's `listRetainedSizeStreams({ connectorId })`
        // / `listStreamProjections({ connectorId })` semantics: filter
        // the projection by connector_id when present, otherwise return
        // every row.
        return typeof input?.connectorId === 'string' && input.connectorId.length > 0
          ? allRows.filter((row) => row.connector_id === input.connectorId)
          : allRows.slice();
      },
      getProjectionMetadata: () => ({
        computed_at: '2026-05-19T12:00:00.000Z',
        state: 'fresh',
        stale_since: null,
        rebuild_status: 'idle',
        last_error: null,
      }),
    },
  );

  assert.equal(seenInputs.length, 1);
  assert.equal(
    seenInputs[0].connectorId,
    'gmail',
    'route MUST forward connector_id query as connectorId, not as connectorInstanceId',
  );
  // The host capability accepts `connectorId` — if a future edit
  // renames the dependency slot to `connectorInstanceId`, the host
  // adapter MUST be updated in lockstep. This assertion documents the
  // current dependency shape.
  assert.equal(
    'connectorInstanceId' in seenInputs[0],
    false,
    'operation must NOT pass connectorInstanceId; the dependency contract is { connectorId }',
  );
  assert.equal(envelope.filters.connector_id, 'gmail');
  assert.equal(envelope.streams.length, 1);
  assert.equal(envelope.streams[0].connector_id, 'gmail');
});
