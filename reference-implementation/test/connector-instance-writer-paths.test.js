import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { postgresBackfillRecordSortPositionsForManifest, postgresPersistContentAddressedBlob } from '../server/postgres-records.js';
import {
  deleteAllRecordsForConnector,
  deleteConnectionRecordRowsPostgres,
  enumerateConnectionStreams,
  ingestRecord,
  teardownConnectionSearchProjection,
} from '../server/records.js';
import { lexicalIndexBackfillForManifest } from '../server/search.js';
import { withConnectorInstanceWrite } from '../server/connector-instance-write-coordinator.ts';
import { closePostgresStorage, initPostgresStorage, postgresQuery } from '../server/postgres-storage.js';
import { createPostgresConnectorInstanceStore, createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { dedicatedPostgresTestUrl } from './helpers/dedicated-postgres-test-url.js';

const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function target(connectorId, connectorInstanceId) {
  return { connector_id: connectorId, connector_instance_id: connectorInstanceId };
}

function record(stream, key, title) {
  return {
    stream,
    key,
    data: { id: key, title },
    emitted_at: '2026-07-16T00:00:00.000Z',
  };
}

async function holdInstance(connectorInstanceId) {
  const entered = deferred();
  const release = deferred();
  const held = withConnectorInstanceWrite(connectorInstanceId, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return { held, release };
}

test('SQLite connector-wide bulk deletion serializes the actual same-instance writer, while a sibling instance overlaps', async () => {
  const connectorId = 'writer-path-bulk';
  const instanceA = 'cin_writer_path_a';
  const instanceB = 'cin_writer_path_b';
  const stream = 'messages';
  initDb(':memory:');
  let held = null;
  let bulk = null;
  let sameInstanceIngest = null;
  try {
    await ingestRecord(target(connectorId, instanceA), record(stream, 'a-before', 'before A'));
    await ingestRecord(target(connectorId, instanceB), record(stream, 'b-before', 'before B'));

    held = await holdInstance(instanceA);
    bulk = deleteAllRecordsForConnector(connectorId);
    await new Promise((resolve) => setImmediate(resolve));

    let sameInstanceFinished = false;
    sameInstanceIngest = ingestRecord(
      target(connectorId, instanceA),
      record(stream, 'a-after', 'ordered after bulk'),
    ).then(() => { sameInstanceFinished = true; });

    // `bulk` is waiting on A. It must not hold B while it waits, so this real
    // direct ingest can complete and is then included in B's stream teardown.
    await ingestRecord(target(connectorId, instanceB), record(stream, 'b-racing', 'sibling overlaps'));
    assert.equal(sameInstanceFinished, false);

    held.release.resolve();
    await held.held;
    await bulk;
    await sameInstanceIngest;

    const liveRows = getDb().prepare(
      `SELECT connector_instance_id, record_key
         FROM records
        WHERE connector_id = ? AND deleted = 0
        ORDER BY connector_instance_id, record_key`,
    ).all(connectorId);
    assert.deepEqual(liveRows, [{ connector_instance_id: instanceA, record_key: 'a-after' }]);
  } finally {
    held?.release.resolve();
    await Promise.allSettled([held?.held, bulk, sameInstanceIngest].filter(Boolean));
    closeDb();
  }
});

test('SQLite direct ingest queued before bulk deletion deterministically leaves the bulk-delete final state', async () => {
  const connectorId = 'writer-path-bulk-reverse';
  const connectorInstanceId = 'cin_writer_path_bulk_reverse';
  const stream = 'messages';
  initDb(':memory:');
  let held = null;
  let directIngest = null;
  let bulk = null;
  try {
    await ingestRecord(target(connectorId, connectorInstanceId), record(stream, 'before', 'before reverse ordering'));
    held = await holdInstance(connectorInstanceId);
    directIngest = ingestRecord(
      target(connectorId, connectorInstanceId),
      record(stream, 'direct-first', 'direct is ordered before bulk'),
    );
    await new Promise((resolve) => setImmediate(resolve));
    bulk = deleteAllRecordsForConnector(connectorId);
    await new Promise((resolve) => setImmediate(resolve));

    held.release.resolve();
    await held.held;
    await directIngest;
    await bulk;
    const remaining = getDb().prepare(
      'SELECT COUNT(*) AS count FROM records WHERE connector_instance_id = ? AND deleted = 0',
    ).get(connectorInstanceId);
    assert.equal(remaining.count, 0);
  } finally {
    held?.release.resolve();
    await Promise.allSettled([held?.held, directIngest, bulk].filter(Boolean));
    closeDb();
  }
});

test('SQLite lexical manifest backfill waits on its actual instance but does not block a sibling writer', async () => {
  const connectorId = 'writer-path-lexical';
  const instanceA = 'cin_writer_lexical_a';
  const instanceB = 'cin_writer_lexical_b';
  const stream = 'messages';
  initDb(':memory:');
  let held = null;
  let backfill = null;
  try {
    await ingestRecord(target(connectorId, instanceA), record(stream, 'a', 'alpha indexed'));
    held = await holdInstance(instanceA);
    backfill = lexicalIndexBackfillForManifest({
      manifest: {
        connector_id: connectorId,
        storage_binding: { connector_instance_id: instanceA },
        streams: [{ name: stream, query: { search: { lexical_fields: ['title'] } } }],
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    await ingestRecord(target(connectorId, instanceB), record(stream, 'b', 'sibling indexed independently'));
    held.release.resolve();
    await held.held;
    await backfill;

    const rows = getDb().prepare(
      `SELECT record_key FROM lexical_search_index
        WHERE connector_instance_id = ? AND stream = ? ORDER BY record_key`,
    ).all(instanceA, stream);
    assert.deepEqual(rows, [{ record_key: 'a' }]);
  } finally {
    held?.release.resolve();
    await Promise.allSettled([held?.held, backfill].filter(Boolean));
    closeDb();
  }
});

test('SQLite direct ingest queued before lexical backfill is indexed by the later backfill', async () => {
  const connectorId = 'writer-path-lexical-reverse';
  const connectorInstanceId = 'cin_writer_lexical_reverse';
  const stream = 'messages';
  initDb(':memory:');
  let held = null;
  let directIngest = null;
  let backfill = null;
  try {
    held = await holdInstance(connectorInstanceId);
    directIngest = ingestRecord(
      target(connectorId, connectorInstanceId),
      record(stream, 'direct-first', 'indexed after direct durable write'),
    );
    await new Promise((resolve) => setImmediate(resolve));
    backfill = lexicalIndexBackfillForManifest({
      manifest: {
        connector_id: connectorId,
        storage_binding: { connector_instance_id: connectorInstanceId },
        streams: [{ name: stream, query: { search: { lexical_fields: ['title'] } } }],
      },
    });
    held.release.resolve();
    await held.held;
    await directIngest;
    await backfill;
    const indexed = getDb().prepare(
      `SELECT record_key FROM lexical_search_index
        WHERE connector_instance_id = ? AND stream = ?`,
    ).get(connectorInstanceId, stream);
    assert.equal(indexed.record_key, 'direct-first');
  } finally {
    held?.release.resolve();
    await Promise.allSettled([held?.held, directIngest, backfill].filter(Boolean));
    closeDb();
  }
});

test('SQLite connection purge is fenced through its durable delete and post-commit search teardown', async () => {
  const connectorId = 'writer-path-connection-purge';
  const connectorInstanceId = 'cin_writer_connection_purge';
  initDb(':memory:');
  let held = null;
  let deletion = null;
  try {
    getDb().prepare('INSERT INTO connectors(connector_id, manifest) VALUES(?, ?)').run(
      connectorId,
      JSON.stringify({ connector_id: connectorId }),
    );
    const store = createSqliteConnectorInstanceStore();
    store.upsert({
      connectorInstanceId,
      ownerSubjectId: 'owner_writer_paths',
      connectorId,
      displayName: 'Writer path purge',
      status: 'active',
      sourceKind: 'manual',
      sourceBindingKey: 'writer-path-purge',
      sourceBinding: { kind: 'writer_path_test' },
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    });
    held = await holdInstance(connectorInstanceId);
    let teardownRan = false;
    deletion = store.deleteConnection(connectorInstanceId, {
      ownerSubjectId: 'owner_writer_paths',
      now: '2026-07-16T00:00:01.000Z',
      purge: {
        enumerateStreams: async () => ({ streams: ['messages'] }),
        deleteRecordRowsSqlite: () => 0,
        teardownProjection: async () => { teardownRan = true; },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(store.get(connectorInstanceId), 'durable purge cannot begin before the shared instance fence');
    held.release.resolve();
    await held.held;
    await deletion;
    assert.equal(store.get(connectorInstanceId), null);
    assert.equal(teardownRan, true, 'the held fence covers the post-commit projection teardown too');
  } finally {
    held?.release.resolve();
    await Promise.allSettled([held?.held, deletion].filter(Boolean));
    closeDb();
  }
});

test('Postgres sort repair fences all manifest streams for an instance and blob binding respects the same fence', {
  skip: !DEDICATED_POSTGRES_URL,
}, async () => {
  const suffix = `writer_path_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const connectorId = `connector_${suffix}`;
  const instanceA = `cin_${suffix}`;
  const streamA = 'first';
  const streamB = 'later';
  initDb(':memory:');
  await initPostgresStorage({ backend: 'postgres', databaseUrl: DEDICATED_POSTGRES_URL });
  let held = null;
  let blobWrite = null;
  let connectionPurge = null;
  try {
    await postgresQuery(
      `INSERT INTO connectors(connector_id, manifest, created_at)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (connector_id) DO NOTHING`,
      [connectorId, JSON.stringify({ connector_id: connectorId }), '2026-07-16T00:00:00.000Z'],
    );
    await postgresQuery(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
       VALUES
         ($1, $2, $3, 'first-record', $4::jsonb, $5, 1, FALSE, 'first-record'),
         ($1, $2, $6, 'later-record', $7::jsonb, $5, 1, FALSE, 'later-record')`,
      [
        connectorId,
        instanceA,
        streamA,
        JSON.stringify({ id: 'first-record', first_cursor: '2026-07-15T01:00:00.000Z' }),
        '2026-07-16T00:00:00.000Z',
        streamB,
        JSON.stringify({ id: 'later-record', later_cursor: '2026-07-15T02:00:00.000Z' }),
      ],
    );
    const repaired = await postgresBackfillRecordSortPositionsForManifest({
      connector_id: connectorId,
      streams: [
        { name: streamA, cursor_field: 'first_cursor' },
        { name: streamB, cursor_field: 'later_cursor' },
      ],
    });
    assert.equal(repaired.updated, 2);
    const cursors = await postgresQuery(
      `SELECT stream, cursor_value FROM records
        WHERE connector_instance_id = $1 ORDER BY stream`,
      [instanceA],
    );
    assert.deepEqual(cursors.rows, [
      { stream: streamA, cursor_value: '2026-07-15T01:00:00.000Z' },
      { stream: streamB, cursor_value: '2026-07-15T02:00:00.000Z' },
    ]);

    held = await holdInstance(instanceA);
    blobWrite = postgresPersistContentAddressedBlob({
      connectorId,
      connectorInstanceId: instanceA,
      stream: streamA,
      recordKey: 'first-record',
      mimeType: 'text/plain',
      data: Buffer.from('coordinated binding'),
    });
    await new Promise((resolve) => setImmediate(resolve));
    const beforeRelease = await postgresQuery(
      'SELECT COUNT(*)::int AS count FROM blob_bindings WHERE connector_instance_id = $1',
      [instanceA],
    );
    assert.equal(Number(beforeRelease.rows[0].count), 0);
    held.release.resolve();
    await held.held;
    await blobWrite;
    const afterRelease = await postgresQuery(
      'SELECT COUNT(*)::int AS count FROM blob_bindings WHERE connector_instance_id = $1',
      [instanceA],
    );
    assert.equal(Number(afterRelease.rows[0].count), 1);

    const purgeInstanceId = `${instanceA}_purge`;
    const store = createPostgresConnectorInstanceStore();
    await store.upsert({
      connectorInstanceId: purgeInstanceId,
      ownerSubjectId: 'owner_writer_paths',
      connectorId,
      displayName: 'Postgres writer path purge',
      status: 'active',
      sourceKind: 'manual',
      sourceBindingKey: `purge_${suffix}`,
      sourceBinding: { kind: 'writer_path_test' },
      createdAt: '2026-07-16T00:00:00.000Z',
      updatedAt: '2026-07-16T00:00:00.000Z',
    });
    await postgresQuery(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
       VALUES ($1, $2, 'messages', 'purge-record', $3::jsonb, $4, 1, FALSE, 'purge-record')`,
      [
        connectorId,
        purgeInstanceId,
        JSON.stringify({ id: 'purge-record', first_cursor: '2026-07-15T03:00:00.000Z' }),
        '2026-07-16T00:00:00.000Z',
      ],
    );
    await postgresPersistContentAddressedBlob({
      connectorId,
      connectorInstanceId: purgeInstanceId,
      stream: 'messages',
      recordKey: 'purge-record',
      mimeType: 'text/plain',
      data: Buffer.from('binding removed by real connection purge'),
    });
    held = await holdInstance(purgeInstanceId);
    let teardownRan = false;
    connectionPurge = store.deleteConnection(purgeInstanceId, {
      ownerSubjectId: 'owner_writer_paths',
      now: '2026-07-16T00:00:01.000Z',
      purge: {
        enumerateStreams: (storageTarget) => enumerateConnectionStreams(storageTarget),
        deleteRecordRowsPostgres: (client, id) => deleteConnectionRecordRowsPostgres(client, id),
        teardownProjection: async (args) => {
          teardownRan = true;
          await teardownConnectionSearchProjection(args);
        },
      },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(await store.get(purgeInstanceId), 'Postgres durable purge cannot begin before the shared instance fence');
    held.release.resolve();
    await held.held;
    await connectionPurge;
    assert.equal(await store.get(purgeInstanceId), null);
    assert.equal(teardownRan, true);
    const purgedBindings = await postgresQuery(
      'SELECT COUNT(*)::int AS count FROM blob_bindings WHERE connector_instance_id = $1',
      [purgeInstanceId],
    );
    assert.equal(Number(purgedBindings.rows[0].count), 0, 'connection purge removes its blob binding under the same fence');
  } finally {
    held?.release.resolve();
    await Promise.allSettled([held?.held, blobWrite, connectionPurge].filter(Boolean));
    await postgresQuery('DELETE FROM blob_bindings WHERE connector_id = $1', [connectorId]).catch(() => undefined);
    await postgresQuery('DELETE FROM blobs WHERE connector_id = $1', [connectorId]).catch(() => undefined);
    await postgresQuery('DELETE FROM records WHERE connector_id = $1', [connectorId]).catch(() => undefined);
    await postgresQuery('DELETE FROM connector_instances WHERE connector_id = $1', [connectorId]).catch(() => undefined);
    await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', [connectorId]).catch(() => undefined);
    await closePostgresStorage();
    closeDb();
  }
});
