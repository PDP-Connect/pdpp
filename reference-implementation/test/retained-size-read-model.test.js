import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
} from '../server/postgres-storage.js';
import { ingestRecord } from '../server/records.js';
import {
  getRetainedSizeGlobal,
  listRetainedSizeConnections,
  listRetainedSizeRecordFamilies,
  listRetainedSizeStreams,
  listRetainedSizeTop,
  markRetainedSizeDirty,
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

// ── Postgres parity test (gated on PDPP_TEST_POSTGRES_URL) ───────────────────
//
// Seeds identical retained_size_global / _connection / _stream /
// _record_family / _top_rows fixtures onto BOTH backends and asserts the real
// production read functions (getRetainedSizeGlobal, listRetainedSizeConnections,
// listRetainedSizeStreams, listRetainedSizeRecordFamilies, listRetainedSizeTop)
// shape the same output regardless of dialect. Also exercises the
// markRetainedSizeDirty marker on Postgres and asserts the global row flips to
// dirty/state=stale. This is the conformance net for the seam-march migration:
// behaviour is preserved iff this test stays green on both backends before AND
// after the dialect branches collapse into a domain-local store.

const PG_NOW = '2026-06-18T12:00:00.000Z';
const PG_CONNECTOR_ID = 'pg_retained_size_connector';
const PG_INSTANCE_ID = 'cin_pg_retained_size_a';
const PG_INSTANCE_ID_B = 'cin_pg_retained_size_b';

// A self-contained fixture covering every read grain. The same numbers are
// written to SQLite and to Postgres so a passing assertion means the two
// dialects produced byte-identical shaped reads.
function retainedSizeFixture() {
  return {
    global: {
      current_record_json_bytes: 510,
      record_history_json_bytes: 540,
      blob_bytes: 900,
      record_count: 5,
      record_history_count: 6,
      blob_count: 2,
      dirty: 0,
      computed_at: PG_NOW,
      metadata: { state: 'fresh', stale_since: null, rebuild_status: 'idle', last_error: null },
    },
    connections: [
      {
        connector_instance_id: PG_INSTANCE_ID,
        connector_id: PG_CONNECTOR_ID,
        current_record_json_bytes: 310,
        record_history_json_bytes: 320,
        blob_bytes: 600,
        record_count: 3,
        record_history_count: 4,
        blob_count: 1,
        dirty: 0,
        computed_at: PG_NOW,
      },
      {
        connector_instance_id: PG_INSTANCE_ID_B,
        connector_id: PG_CONNECTOR_ID,
        current_record_json_bytes: 200,
        record_history_json_bytes: 220,
        blob_bytes: 300,
        record_count: 2,
        record_history_count: 2,
        blob_count: 1,
        dirty: 0,
        computed_at: PG_NOW,
      },
    ],
    streams: [
      {
        connector_instance_id: PG_INSTANCE_ID,
        connector_id: PG_CONNECTOR_ID,
        stream: 'messages',
        current_record_json_bytes: 210,
        record_history_json_bytes: 220,
        blob_bytes: 400,
        record_count: 2,
        record_history_count: 3,
        blob_count: 1,
        dirty: 0,
        computed_at: PG_NOW,
      },
      {
        connector_instance_id: PG_INSTANCE_ID,
        connector_id: PG_CONNECTOR_ID,
        stream: 'files',
        current_record_json_bytes: 100,
        record_history_json_bytes: 100,
        blob_bytes: 200,
        record_count: 1,
        record_history_count: 1,
        blob_count: 0,
        dirty: 0,
        computed_at: PG_NOW,
      },
    ],
    recordFamilies: [
      {
        connector_instance_id: PG_INSTANCE_ID,
        connector_id: PG_CONNECTOR_ID,
        stream: 'messages',
        record_family: 'thread',
        current_record_json_bytes: 210,
        record_history_json_bytes: 220,
        blob_bytes: 400,
        record_count: 2,
        record_history_count: 3,
        blob_count: 1,
        dirty: 0,
        computed_at: PG_NOW,
      },
    ],
    topRows: [
      {
        scope: 'connection',
        measure: 'total_retained_bytes',
        rank: 1,
        grain_key: PG_INSTANCE_ID,
        connector_instance_id: PG_INSTANCE_ID,
        connector_id: PG_CONNECTOR_ID,
        stream: null,
        record_key: null,
        blob_id: null,
        current_record_json_bytes: 310,
        record_history_json_bytes: 320,
        blob_bytes: 600,
        total_retained_bytes: 1230,
        record_count: 3,
        record_history_count: 4,
        blob_count: 1,
        dirty: 0,
        computed_at: PG_NOW,
        metadata: { state: 'fresh', stale_since: null, rebuild_status: 'idle', last_error: null },
      },
      {
        scope: 'connection',
        measure: 'total_retained_bytes',
        rank: 2,
        grain_key: PG_INSTANCE_ID_B,
        connector_instance_id: PG_INSTANCE_ID_B,
        connector_id: PG_CONNECTOR_ID,
        stream: null,
        record_key: null,
        blob_id: null,
        current_record_json_bytes: 200,
        record_history_json_bytes: 220,
        blob_bytes: 300,
        total_retained_bytes: 720,
        record_count: 2,
        record_history_count: 2,
        blob_count: 1,
        dirty: 0,
        computed_at: PG_NOW,
        metadata: { state: 'fresh', stale_since: null, rebuild_status: 'idle', last_error: null },
      },
    ],
  };
}

function seedRetainedSizeGlobalSqlite(row) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_global(
         projection_key, current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count, dirty, computed_at, metadata_json
       )
       VALUES('global', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
      JSON.stringify(row.metadata),
    );
}

function seedRetainedSizeConnectionSqlite(row) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_connection(
         connector_instance_id, connector_id, current_record_json_bytes,
         record_history_json_bytes, blob_bytes, record_count, record_history_count,
         blob_count, dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.connector_instance_id,
      row.connector_id,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
    );
}

function seedRetainedSizeStreamSqlite(row) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_stream(
         connector_instance_id, connector_id, stream, current_record_json_bytes,
         record_history_json_bytes, blob_bytes, record_count, record_history_count,
         blob_count, dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.connector_instance_id,
      row.connector_id,
      row.stream,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
    );
}

function seedRetainedSizeRecordFamilySqlite(row) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_record_family(
         connector_instance_id, connector_id, stream, record_family,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count, dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.connector_instance_id,
      row.connector_id,
      row.stream,
      row.record_family,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
    );
}

function seedRetainedSizeTopRowSqlite(row) {
  getDb()
    .prepare(
      `INSERT INTO retained_size_top_rows(
         scope, measure, rank, grain_key, connector_instance_id, connector_id, stream,
         record_key, blob_id, current_record_json_bytes, record_history_json_bytes,
         blob_bytes, total_retained_bytes, record_count, record_history_count, blob_count,
         dirty, computed_at, metadata_json
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.scope,
      row.measure,
      row.rank,
      row.grain_key,
      row.connector_instance_id,
      row.connector_id,
      row.stream,
      row.record_key,
      row.blob_id,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.total_retained_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
      JSON.stringify(row.metadata),
    );
}

async function seedRetainedSizeGlobalPostgres(row) {
  await postgresQuery(
    `INSERT INTO retained_size_global(
       projection_key, current_record_json_bytes, record_history_json_bytes, blob_bytes,
       record_count, record_history_count, blob_count, dirty, computed_at, metadata_json
     )
     VALUES('global', $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (projection_key) DO UPDATE SET
       current_record_json_bytes = EXCLUDED.current_record_json_bytes,
       record_history_json_bytes = EXCLUDED.record_history_json_bytes,
       blob_bytes = EXCLUDED.blob_bytes,
       record_count = EXCLUDED.record_count,
       record_history_count = EXCLUDED.record_history_count,
       blob_count = EXCLUDED.blob_count,
       dirty = EXCLUDED.dirty,
       computed_at = EXCLUDED.computed_at,
       metadata_json = EXCLUDED.metadata_json`,
    [
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
      JSON.stringify(row.metadata),
    ],
  );
}

async function seedRetainedSizeConnectionPostgres(row) {
  await postgresQuery(
    `INSERT INTO retained_size_connection(
       connector_instance_id, connector_id, current_record_json_bytes,
       record_history_json_bytes, blob_bytes, record_count, record_history_count,
       blob_count, dirty, computed_at
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      row.connector_instance_id,
      row.connector_id,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
    ],
  );
}

async function seedRetainedSizeStreamPostgres(row) {
  await postgresQuery(
    `INSERT INTO retained_size_stream(
       connector_instance_id, connector_id, stream, current_record_json_bytes,
       record_history_json_bytes, blob_bytes, record_count, record_history_count,
       blob_count, dirty, computed_at
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      row.connector_instance_id,
      row.connector_id,
      row.stream,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
    ],
  );
}

async function seedRetainedSizeRecordFamilyPostgres(row) {
  await postgresQuery(
    `INSERT INTO retained_size_record_family(
       connector_instance_id, connector_id, stream, record_family,
       current_record_json_bytes, record_history_json_bytes, blob_bytes,
       record_count, record_history_count, blob_count, dirty, computed_at
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      row.connector_instance_id,
      row.connector_id,
      row.stream,
      row.record_family,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
    ],
  );
}

async function seedRetainedSizeTopRowPostgres(row) {
  await postgresQuery(
    `INSERT INTO retained_size_top_rows(
       scope, measure, rank, grain_key, connector_instance_id, connector_id, stream,
       record_key, blob_id, current_record_json_bytes, record_history_json_bytes,
       blob_bytes, total_retained_bytes, record_count, record_history_count, blob_count,
       dirty, computed_at, metadata_json
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19::jsonb)`,
    [
      row.scope,
      row.measure,
      row.rank,
      row.grain_key,
      row.connector_instance_id,
      row.connector_id,
      row.stream,
      row.record_key,
      row.blob_id,
      row.current_record_json_bytes,
      row.record_history_json_bytes,
      row.blob_bytes,
      row.total_retained_bytes,
      row.record_count,
      row.record_history_count,
      row.blob_count,
      row.dirty,
      row.computed_at,
      JSON.stringify(row.metadata),
    ],
  );
}

async function cleanupRetainedSizePostgres() {
  await postgresQuery(`DELETE FROM retained_size_global WHERE projection_key = 'global'`);
  await postgresQuery('DELETE FROM retained_size_connection WHERE connector_id = $1', [PG_CONNECTOR_ID]);
  await postgresQuery('DELETE FROM retained_size_stream WHERE connector_id = $1', [PG_CONNECTOR_ID]);
  await postgresQuery('DELETE FROM retained_size_record_family WHERE connector_id = $1', [PG_CONNECTOR_ID]);
  await postgresQuery('DELETE FROM retained_size_top_rows WHERE connector_id = $1', [PG_CONNECTOR_ID]);
}

// Read every grain through the real production read functions. Backend is
// selected by isPostgresStorageBackend() inside those functions, so calling
// this on SQLite vs Postgres exercises both dialect arms with no test-side
// branching.
async function readAllRetainedSizeGrains() {
  const fixture = retainedSizeFixture();
  return {
    global: await getRetainedSizeGlobal(),
    connections: await listRetainedSizeConnections(),
    connectionsFiltered: await listRetainedSizeConnections({
      connectorInstanceId: PG_INSTANCE_ID,
    }),
    streams: await listRetainedSizeStreams({ connectorInstanceId: PG_INSTANCE_ID }),
    streamsByConnector: await listRetainedSizeStreams({ connectorId: PG_CONNECTOR_ID }),
    streamsComposed: await listRetainedSizeStreams({
      connectorId: PG_CONNECTOR_ID,
      stream: 'messages',
    }),
    recordFamilies: await listRetainedSizeRecordFamilies({
      connectorInstanceId: PG_INSTANCE_ID,
      stream: 'messages',
    }),
    top: await listRetainedSizeTop({
      scope: 'connection',
      measure: 'total_retained_bytes',
      limit: 5,
    }),
    fixture,
  };
}

test(
  'Postgres retained-size reads shape identically to SQLite for global/connection/stream/record-family/top grains',
  { skip: !process.env.PDPP_TEST_POSTGRES_URL },
  async () => {
    // 1. Compute the SQLite-shaped reads from a temp DB FIRST, while the
    //    backend is still SQLite.
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-retained-size-pg-parity-'));
    let sqliteReads;
    try {
      initDb(join(dir, 'pdpp.sqlite'));
      const fx = retainedSizeFixture();
      seedRetainedSizeGlobalSqlite(fx.global);
      fx.connections.forEach(seedRetainedSizeConnectionSqlite);
      fx.streams.forEach(seedRetainedSizeStreamSqlite);
      fx.recordFamilies.forEach(seedRetainedSizeRecordFamilySqlite);
      fx.topRows.forEach(seedRetainedSizeTopRowSqlite);
      sqliteReads = await readAllRetainedSizeGrains();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }

    // 2. Switch to Postgres, seed the identical fixture, read through the same
    //    production functions, and assert byte-identical shaped output.
    await initPostgresStorage({ backend: 'postgres', databaseUrl: process.env.PDPP_TEST_POSTGRES_URL });
    try {
      await cleanupRetainedSizePostgres();
      const fx = retainedSizeFixture();
      await seedRetainedSizeGlobalPostgres(fx.global);
      for (const row of fx.connections) await seedRetainedSizeConnectionPostgres(row);
      for (const row of fx.streams) await seedRetainedSizeStreamPostgres(row);
      for (const row of fx.recordFamilies) await seedRetainedSizeRecordFamilyPostgres(row);
      for (const row of fx.topRows) await seedRetainedSizeTopRowPostgres(row);

      const pgReads = await readAllRetainedSizeGrains();

      // Global grain: full shaped row including parsed metadata.
      assert.deepEqual(pgReads.global, sqliteReads.global);
      assert.equal(pgReads.global.total_retained_bytes, 510 + 540 + 900);
      assert.equal(pgReads.global.dirty, false);
      assert.equal(pgReads.global.metadata.state, 'fresh');

      // Connection grain: unfiltered list + connectorInstanceId filter.
      assert.deepEqual(pgReads.connections, sqliteReads.connections);
      assert.equal(pgReads.connections.length, 2);
      assert.deepEqual(pgReads.connectionsFiltered, sqliteReads.connectionsFiltered);
      assert.equal(pgReads.connectionsFiltered.length, 1);
      assert.equal(pgReads.connectionsFiltered[0].connector_instance_id, PG_INSTANCE_ID);

      // Stream grain: connectorInstanceId, connectorId, and composed filters
      // (the dynamic optional-WHERE construction).
      assert.deepEqual(pgReads.streams, sqliteReads.streams);
      assert.deepEqual(pgReads.streams.map((r) => r.stream).sort(), ['files', 'messages']);
      assert.deepEqual(pgReads.streamsByConnector, sqliteReads.streamsByConnector);
      assert.deepEqual(pgReads.streamsComposed, sqliteReads.streamsComposed);
      assert.equal(pgReads.streamsComposed.length, 1);
      assert.equal(pgReads.streamsComposed[0].stream, 'messages');

      // Record-family grain.
      assert.deepEqual(pgReads.recordFamilies, sqliteReads.recordFamilies);
      assert.equal(pgReads.recordFamilies.length, 1);
      assert.equal(pgReads.recordFamilies[0].record_family, 'thread');

      // Top-N grain (ORDER BY rank + LIMIT placeholder).
      assert.deepEqual(pgReads.top, sqliteReads.top);
      assert.equal(pgReads.top.length, 2);
      assert.equal(pgReads.top[0].connector_instance_id, PG_INSTANCE_ID);
      assert.equal(pgReads.top[0].total_retained_bytes, 1230);

      // 3. Exercise a marker: markRetainedSizeDirty must flip the Postgres
      //    global row to dirty + state=stale.
      await markRetainedSizeDirty('parity test bulk write');
      const dirtied = await getRetainedSizeGlobal();
      assert.equal(dirtied.dirty, true);
      assert.equal(dirtied.metadata.state, 'stale');
      assert.equal(dirtied.metadata.last_error, 'parity test bulk write');
    } finally {
      await cleanupRetainedSizePostgres();
      await closePostgresStorage();
    }
  },
);
