import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emitSpineEvent,
  listSpineEventsPage,
  searchSpine,
} from '../lib/spine.ts';
import { initDb, closeDb } from '../server/db.js';
import {
  postgresPersistContentAddressedBlob,
} from '../server/postgres-records.js';
import {
  postgresLexicalIndexUpsert,
  postgresLexicalSearch,
  postgresSemanticIndexUpsertMany,
  postgresSemanticSearch,
} from '../server/postgres-search.js';
import {
  closePostgresStorage,
  getStorageBackendKind,
  initPostgresStorage,
  postgresQuery,
  resolveStorageBackend,
} from '../server/postgres-storage.js';
import { startServer } from '../server/index.js';
import {
  deleteRecord,
  getDatasetBlobBytes,
  getDatasetRecordChangesBytes,
  getDatasetRecordTimeBounds,
  getDatasetRecordsAggregate,
  getRecord,
  ingestRecord,
  listDatasetTopConnectorCandidates,
  queryRecords,
} from '../server/records.js';
import { createSqliteBlobStore } from '../server/stores/blob-store.js';

async function closeStartedServer(server) {
  if (!server) return;
  const closeOne = (httpServer) =>
    new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve();
        }
      }, 2000);
      httpServer.closeAllConnections?.();
      httpServer.close(() => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });
    });

  await Promise.allSettled([
    closeOne(server.asServer),
    closeOne(server.rsServer),
  ]);
}

test('Postgres runtime storage config fails fast without PDPP_DATABASE_URL', () => {
  assert.throws(
    () =>
      resolveStorageBackend({
        env: { PDPP_STORAGE_BACKEND: 'postgres' },
      }),
    /requires PDPP_DATABASE_URL/,
  );
});

const POSTGRES_URL = process.env.PDPP_TEST_POSTGRES_URL;

if (!POSTGRES_URL) {
  test('postgres runtime storage behavior (skipped: PDPP_TEST_POSTGRES_URL unset)', {
    skip: true,
  }, () => {});
} else {
  test('postgres runtime storage initializes through startServer config', async () => {
    let server = null;
    try {
      server = await startServer({
        quiet: true,
        asPort: 0,
        rsPort: 0,
        dbPath: ':memory:',
        storageBackend: 'postgres',
        databaseUrl: POSTGRES_URL,
        reconcilePolyfillManifests: false,
      });
      assert.equal(getStorageBackendKind(), 'postgres');
    } finally {
      await closeStartedServer(server);
      await closePostgresStorage();
      closeDb();
    }
  });

  test('postgres runtime storage covers records, blobs, spine, lexical, and semantic fallback', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_runtime_${suffix}`;
    const stream = 'events';
    const traceId = `trace_${suffix}`;
    const grant = {
      streams: [
        {
          name: stream,
          fields: ['id', 'title', 'body', 'created_at'],
        },
      ],
    };
    const manifest = {
      connector_id: connectorId,
      streams: [
        {
          name: stream,
          primary_key: ['id'],
          cursor_field: 'created_at',
          schema: {
            required: ['id'],
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              body: { type: 'string' },
              created_at: { type: 'string', format: 'date-time' },
            },
          },
          query: {
            search: {
              lexical_fields: ['title', 'body'],
              semantic_fields: ['body'],
            },
          },
        },
      ],
    };

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    try {
      await ingestRecord(connectorId, {
        stream,
        key: 'a',
        data: {
          id: 'a',
          title: 'Alpha launch',
          body: 'postgres runtime storage covers alpha',
          created_at: '2026-04-01T00:00:00.000Z',
        },
      });
      await ingestRecord(connectorId, {
        stream,
        key: 'b',
        data: {
          id: 'b',
          title: 'Beta proof',
          body: 'semantic fallback vector row',
          created_at: '2026-04-02T00:00:00.000Z',
        },
      });

      const page = await queryRecords(connectorId, stream, grant, { limit: 1, order: 'asc' }, manifest);
      assert.deepEqual(page.data.map((row) => row.id), ['a']);
      assert.equal(page.has_more, true);
      assert.ok(page.next_cursor);

      const second = await queryRecords(connectorId, stream, grant, {
        limit: 1,
        order: 'asc',
        cursor: page.next_cursor,
      }, manifest);
      assert.deepEqual(second.data.map((row) => row.id), ['b']);

      const got = await getRecord(connectorId, stream, 'a', grant, manifest);
      assert.equal(got.data.title, 'Alpha launch');

      const blob = await postgresPersistContentAddressedBlob({
        connectorId,
        stream,
        recordKey: 'a',
        mimeType: 'text/plain',
        data: Buffer.from('postgres blob bytes'),
      });
      const blobStore = createSqliteBlobStore();
      const blobRow = await blobStore.loadContentAddressedBlob(blob.blob_id);
      assert.equal(blobRow.sha256, blob.sha256);
      const bindings = await blobStore.listBlobBindings(blob.blob_id);
      assert.ok(bindings.some((binding) => binding.connector_id === connectorId && binding.record_key === 'a'));

      const datasetAggregate = await getDatasetRecordsAggregate();
      assert.ok(datasetAggregate.record_count >= 2);
      assert.ok(datasetAggregate.connector_count >= 1);
      assert.ok(datasetAggregate.stream_count >= 1);
      assert.ok(datasetAggregate.record_json_bytes > 0);
      assert.ok((await getDatasetRecordChangesBytes()) > 0);
      assert.ok((await getDatasetBlobBytes()) >= Buffer.byteLength('postgres blob bytes'));
      assert.deepEqual(await getDatasetRecordTimeBounds(), { earliest: null, latest: null });
      const topConnectorCandidates = await listDatasetTopConnectorCandidates();
      assert.ok(
        topConnectorCandidates.some(
          (candidate) => candidate.connector_id === connectorId && candidate.record_count >= 2,
        ),
      );

      await emitSpineEvent({
        trace_id: traceId,
        event_type: 'record.read',
        actor_type: 'client',
        actor_id: 'client-a',
        object_type: 'record',
        object_id: 'a',
        status: 'ok',
        data: { connector_id: connectorId },
      });
      const spinePage = await listSpineEventsPage('trace', traceId, { limit: 10 });
      assert.equal(spinePage.events.length, 1);
      assert.equal(spinePage.events[0].trace_id, traceId);
      const spineSearch = await searchSpine(traceId);
      assert.deepEqual(spineSearch.exact, { kind: 'trace', id: traceId });

      await postgresLexicalIndexUpsert({
        connectorId,
        stream,
        recordKey: 'a',
        fields: { title: 'Alpha launch', body: 'postgres runtime storage covers alpha' },
      });
      const lexicalHits = await postgresLexicalSearch({
        connectorId,
        stream,
        searchableFields: ['title', 'body'],
        q: 'alpha',
      });
      assert.equal(lexicalHits[0].record_key, 'a');

      await postgresSemanticIndexUpsertMany({
        connectorId,
        stream,
        recordKey: 'a',
        entries: [
          {
            connectorId,
            scopeKey: JSON.stringify([stream, 'body']),
            recordKey: 'a',
            vector: [1, 0, 0],
          },
        ],
      });
      const semanticHits = await postgresSemanticSearch({
        connectorId,
        scopeKeys: [JSON.stringify([stream, 'body'])],
        queryVector: [1, 0, 0],
        limit: 10,
      });
      assert.equal(semanticHits[0].recordKey, 'a');

      const deleted = await deleteRecord(connectorId, stream, 'a');
      assert.equal(deleted.changed, true);
      await assert.rejects(
        () => getRecord(connectorId, stream, 'a', grant, manifest),
        /Record not found/,
      );
    } finally {
      await postgresQuery('DELETE FROM spine_events WHERE trace_id = $1', [traceId]);
      await postgresQuery('DELETE FROM blob_bindings WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM blobs WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM record_changes WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM records WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM version_counter WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM lexical_search_index WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM lexical_search_meta WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM semantic_search_blob WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM semantic_search_meta WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM semantic_search_backfill_progress WHERE connector_id = $1', [connectorId]);
      await closePostgresStorage();
      closeDb();
    }
  });
}
