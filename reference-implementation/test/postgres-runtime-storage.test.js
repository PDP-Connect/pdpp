// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emitSpineEvent,
  listSpineCorrelations,
  listSpineEventsPage,
  searchSpine,
} from '../lib/spine.ts';
import {
  approveGrant,
  approveOwnerDeviceAuthorization,
  deleteRegisteredClient,
  exchangeOwnerDeviceCode,
  getConnectorManifest,
  getOwnerDeviceAuthorizationByUserCode,
  getPendingConsent,
  initiateGrant,
  initiateOwnerDeviceAuthorization,
  introspect,
  listOwnerIssuedClients,
  parsePendingConsentRequestUri,
  registerConnector,
  registerDynamicClient,
  revokeGrant,
  seedPreRegisteredClients,
} from '../server/auth.js';
import { initDb, closeDb, getDb } from '../server/db.js';
import {
  postgresPersistContentAddressedBlob,
} from '../server/postgres-records.js';
import {
  postgresCountIndexableSemanticValues,
  postgresLexicalCountIndexableTextValues,
  postgresLexicalIndexUpsert,
  postgresLexicalSearch,
  postgresSemanticIndexInsertMany,
  postgresSemanticIndexUpsertMany,
  postgresSemanticSearch,
} from '../server/postgres-search.js';
import { listPendingApprovals } from '../server/ref-control.ts';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from '../server/owner-auth.ts';
import { lexicalIndexBackfillForManifest, runLexicalSearch } from '../server/search.js';
import {
  configureSemanticBackend,
  makeStubBackend,
  runSemanticSearch,
  semanticIndexBackfillForManifest,
  semanticIndexUpsert,
} from '../server/search-semantic.js';
import {
  closePostgresStorage,
  getStorageBackendKind,
  initPostgresStorage,
  postgresQuery,
  resolveStorageBackend,
} from '../server/postgres-storage.js';
import {
  createPostgresConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from '../server/stores/connector-instance-store.js';
import {
  shouldAutoReconcilePolyfillManifests,
  startServer,
} from '../server/index.js';
import {
  aggregateRecords,
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
import {
  getRetainedSizeGlobal,
  listRetainedSizeConnections,
  rebuildRetainedSize,
} from '../server/retained-size-read-model.js';
import { createBlobStore } from '../server/stores/blob-store.ts';
import { createConnectorStateStore } from '../server/stores/connector-state-store.ts';
import { createSchedulerStore } from '../server/stores/scheduler-store.ts';

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

test('Postgres runtime storage config fails fast without a database URL', () => {
  assert.throws(
    () =>
      resolveStorageBackend({
        env: { PDPP_STORAGE_BACKEND: 'postgres' },
      }),
    /requires PDPP_DATABASE_URL or DATABASE_URL/,
  );
});

test('Postgres runtime storage auto-selects Postgres when PDPP_DATABASE_URL is present', () => {
  assert.deepEqual(
    resolveStorageBackend({
      env: { PDPP_DATABASE_URL: 'postgres://user:pass@localhost:5432/pdpp' },
    }),
    { backend: 'postgres', databaseUrl: 'postgres://user:pass@localhost:5432/pdpp' },
  );
  assert.deepEqual(
    resolveStorageBackend({
      env: {
        PDPP_STORAGE_BACKEND: 'sqlite',
        PDPP_DATABASE_URL: 'postgres://user:pass@localhost:5432/pdpp',
      },
    }),
    { backend: 'sqlite' },
  );
});

test('Postgres runtime storage accepts standard DATABASE_URL when PDPP_DATABASE_URL is absent', () => {
  assert.deepEqual(
    resolveStorageBackend({
      env: { DATABASE_URL: 'postgres://user:pass@localhost:5432/pdpp' },
    }),
    { backend: 'postgres', databaseUrl: 'postgres://user:pass@localhost:5432/pdpp' },
  );
  assert.deepEqual(
    resolveStorageBackend({
      env: {
        PDPP_DATABASE_URL: 'postgres://explicit:pass@localhost:5432/pdpp',
        DATABASE_URL: 'postgres://standard:pass@localhost:5432/pdpp',
      },
    }),
    { backend: 'postgres', databaseUrl: 'postgres://explicit:pass@localhost:5432/pdpp' },
  );
});

test('polyfill manifest reconciliation defaults on for Postgres deployments', () => {
  assert.equal(
    shouldAutoReconcilePolyfillManifests({
      dbPath: ':memory:',
      storageBackendKind: 'postgres',
    }),
    true,
    'Postgres deployments do not have the canonical SQLite path sentinel but still need persisted manifest refresh',
  );
  assert.equal(
    shouldAutoReconcilePolyfillManifests({
      dbPath: ':memory:',
      storageBackendKind: 'sqlite',
    }),
    false,
    'SQLite tests and ad-hoc in-memory DBs keep reconciliation opt-in',
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
      const cimdTable = await postgresQuery(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_name = 'cimd_client_documents'
         ORDER BY ordinal_position`,
      );
      assert.deepEqual(
        cimdTable.rows.map((row) => row.column_name),
        ['document_id', 'client_name', 'redirect_uris', 'logo_uri', 'created_at', 'updated_at'],
      );
      const scopedLexicalIndex = await postgresQuery(
        `SELECT 1
           FROM pg_extension e
           JOIN pg_indexes i
             ON i.schemaname = current_schema()
            AND i.tablename = 'lexical_search_index'
            AND i.indexname = 'idx_pg_lexical_search_scope_document'
          WHERE e.extname = 'btree_gin'
          LIMIT 1`,
      );
      assert.equal(scopedLexicalIndex.rowCount, 1);
    } finally {
      await closeStartedServer(server);
      await closePostgresStorage();
      closeDb();
    }
  });

  test('postgres lexical search returns ranked rows through the scoped candidate window', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_lexical_window_${suffix}`;
    const connectorInstanceId = `cin_pg_lexical_window_${suffix}`;
    const stream = 'messages';
    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      await postgresQuery(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES
           ($1, $2, $3, 'low', $4::jsonb, $6, 1, FALSE, 'low'),
           ($1, $2, $3, 'high', $5::jsonb, $6, 2, FALSE, 'high')`,
        [
          connectorId,
          connectorInstanceId,
          stream,
          JSON.stringify({ id: 'low', body: 'error once' }),
          JSON.stringify({ id: 'high', body: 'error error error important' }),
          '2026-06-01T00:00:00.000Z',
        ],
      );
      await postgresLexicalIndexUpsert({
        connectorId,
        connectorInstanceId,
        stream,
        recordKey: 'low',
        fields: { body: 'error once' },
      });
      await postgresLexicalIndexUpsert({
        connectorId,
        connectorInstanceId,
        stream,
        recordKey: 'high',
        fields: { body: 'error error error important' },
      });

      const rows = await postgresLexicalSearch({
        connectorId,
        connectorInstanceId,
        stream,
        searchableFields: ['body'],
        q: 'error',
        limit: 2,
      });

      assert.deepEqual(rows.map((row) => row.record_key), ['high', 'low']);
    } finally {
      await postgresQuery('DELETE FROM lexical_search_index WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM records WHERE connector_id = $1', [connectorId]);
      await closePostgresStorage();
      closeDb();
    }
  });

  test('postgres semantic startup backfill writes Postgres index without touching SQLite vector index', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_semantic_backfill_${suffix}`;
    const connectorInstanceId = `cin_pg_semantic_backfill_${suffix}`;
    const stream = 'messages';
    const manifest = {
      connector_id: connectorId,
      streams: [
        {
          name: stream,
          query: {
            search: {
              semantic_fields: ['subject', 'body'],
            },
          },
        },
      ],
    };

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    configureSemanticBackend(makeStubBackend({ dimensions: 8 }));

    try {
      getDb().exec(`
        CREATE TABLE IF NOT EXISTS semantic_search_vec(
          connector_id TEXT,
          scope_key TEXT,
          record_key TEXT,
          embedding BLOB
        )
      `);
      await postgresQuery(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES
           ($1, $2, $3, 'gmail-1', $4::jsonb, $5, 1, FALSE, 'gmail-1'),
           ($1, $2, $3, 'gmail-2', $6::jsonb, $5, 1, FALSE, 'gmail-2')`,
        [
          connectorId,
          connectorInstanceId,
          stream,
          JSON.stringify({ id: 'gmail-1', subject: 'Gmail backfill alpha', body: 'Postgres semantic startup path' }),
          '2026-04-01T00:00:00.000Z',
          JSON.stringify({ id: 'gmail-2', subject: '', body: 'Second indexed body' }),
        ],
      );

      await semanticIndexBackfillForManifest({ manifest });

      const pgRows = await postgresQuery(
        'SELECT scope_key, record_key FROM semantic_search_blob WHERE connector_instance_id = $1 ORDER BY scope_key, record_key',
        [connectorInstanceId],
      );
      assert.deepEqual(
        pgRows.rows.map((row) => [row.scope_key, row.record_key]),
        [
          ['["messages","body"]', 'gmail-1'],
          ['["messages","body"]', 'gmail-2'],
          ['["messages","subject"]', 'gmail-1'],
        ],
      );

      const pgMeta = await postgresQuery(
        'SELECT fields_fingerprint, model_id, dimensions, distance_metric FROM semantic_search_meta WHERE connector_instance_id = $1 AND stream = $2',
        [connectorInstanceId, stream],
      );
      assert.equal(pgMeta.rows.length, 1);
      assert.equal(pgMeta.rows[0].fields_fingerprint, '["body","subject"]');
      assert.equal(Number(pgMeta.rows[0].dimensions), 8);

      const progressColumns = await postgresQuery(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_name = 'semantic_search_backfill_progress'
           AND column_name = 'fields_fingerprint'`,
        [],
      );
      assert.equal(progressColumns.rows.length, 1, 'Postgres progress rows carry the same semantic identity as SQLite');

      assert.equal(
        getDb().prepare('SELECT COUNT(*) AS n FROM semantic_search_blob').get().n,
        0,
        'SQLite blob-flat semantic index remains unused during Postgres backfill',
      );
      assert.equal(
        getDb().prepare('SELECT COUNT(*) AS n FROM semantic_search_vec').get().n,
        0,
        'SQLite vec semantic index remains unused during Postgres backfill',
      );
    } finally {
      await postgresQuery('DELETE FROM semantic_search_blob WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM semantic_search_meta WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM semantic_search_backfill_progress WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM records WHERE connector_id = $1', [connectorId]);
      configureSemanticBackend(null);
      await closePostgresStorage();
      closeDb();
    }
  });

  test('postgres lexical backfill rebuilds partial historical indexes', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_lexical_backfill_${suffix}`;
    const connectorInstanceId = `cin_pg_lexical_backfill_${suffix}`;
    const stream = 'messages';
    const manifest = {
      protocol_version: '0.1.0',
      connector_id: connectorId,
      version: '1.0.0',
      display_name: 'Postgres Lexical Backfill Test',
      streams: [
        {
          name: stream,
          primary_key: ['id'],
          cursor_field: 'created_at',
          consent_time_field: 'created_at',
          schema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              created_at: { type: 'string', format: 'date-time' },
            },
          },
          query: {
            search: {
              lexical_fields: ['text'],
            },
          },
        },
      ],
    };
    const grant = {
      source: { kind: 'connector', id: connectorId },
      streams: [{ name: stream, fields: ['id', 'text'] }],
    };
    const tokenInfo = {
      pdpp_token_kind: 'client',
      subject_id: OWNER_AUTH_DEFAULT_SUBJECT_ID,
      client_id: 'cl_pg_lexical_backfill',
      grant_id: 'grt_pg_lexical_backfill',
      grant,
    };

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    try {
      await registerConnector(manifest);
      const instanceStore = createPostgresConnectorInstanceStore();
      const now = new Date().toISOString();
      await instanceStore.upsert({
        connectorInstanceId,
        ownerSubjectId: OWNER_AUTH_DEFAULT_SUBJECT_ID,
        connectorId,
        displayName: 'Postgres lexical backfill account',
        status: 'active',
        sourceKind: 'account',
        sourceBindingKey: `account_${suffix}`,
        sourceBinding: { account: `account_${suffix}` },
        createdAt: now,
        updatedAt: now,
      });
      await postgresQuery(
        `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
         VALUES
           ($1, $2, $3, 'msg-1', $4::jsonb, $6, 1, FALSE, 'msg-1'),
           ($1, $2, $3, 'msg-2', $5::jsonb, $6, 2, FALSE, 'msg-2')`,
        [
          connectorId,
          connectorInstanceId,
          stream,
          JSON.stringify({ id: 'msg-1', text: 'Redactable alpha historical row' }),
          JSON.stringify({ id: 'msg-2', text: 'Redactable beta historical row' }),
          '2026-06-01T00:00:00.000Z',
        ],
      );
      await postgresLexicalIndexUpsert({
        connectorId,
        connectorInstanceId,
        stream,
        recordKey: 'msg-1',
        fields: { text: 'Redactable alpha historical row' },
      });
      await postgresQuery(
        `INSERT INTO lexical_search_meta(connector_id, connector_instance_id, stream, fields_fingerprint, updated_at)
         VALUES($1, $2, $3, $4, $5)
         ON CONFLICT(connector_instance_id, stream) DO UPDATE SET
           connector_id = EXCLUDED.connector_id,
           fields_fingerprint = EXCLUDED.fields_fingerprint,
           updated_at = EXCLUDED.updated_at`,
        [connectorId, connectorInstanceId, stream, '["text"]', new Date().toISOString()],
      );

      const before = await postgresQuery(
        'SELECT COUNT(*)::int AS count FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2',
        [connectorInstanceId, stream],
      );
      assert.equal(Number(before.rows[0].count), 1);

      await lexicalIndexBackfillForManifest({ manifest });

      const after = await postgresQuery(
        'SELECT COUNT(*)::int AS count FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2',
        [connectorInstanceId, stream],
      );
      assert.equal(Number(after.rows[0].count), 2);

      const page = await runLexicalSearch({
        req: { query: { q: 'Redactable' } },
        opts: {},
        tokenInfo,
        resolveOwnerVisibleConnectorIds: () => [connectorId],
        resolveOwnerScopeForConnector: () => ({ connectorId }),
        resolveOwnerManifestFromScope: async () => ({ manifest }),
        buildOwnerReadGrantForManifest: () => grant,
        resolveGrantManifest: async () => ({ manifest, storageBinding: { connector_id: connectorId } }),
      });
      assert.deepEqual(page.envelope.data.map((hit) => hit.record_key).sort(), ['msg-1', 'msg-2']);
    } finally {
      await postgresQuery('DELETE FROM lexical_search_index WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM lexical_search_meta WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM lexical_search_snapshots WHERE query = $1', ['Redactable']);
      await postgresQuery('DELETE FROM records WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM connector_instances WHERE connector_id = $1', [connectorId]);
      await closePostgresStorage();
      closeDb();
    }
  });

  test('postgres public reads enforce grant visibility and aggregate over active storage', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_visibility_${suffix}`;
    const stream = 'events';
    const manifest = {
      protocol_version: '0.1.0',
      connector_id: connectorId,
      version: '1.0.0',
      display_name: 'Postgres Visibility Test',
      streams: [
        {
          name: stream,
          primary_key: ['id'],
          cursor_field: 'created_at',
          consent_time_field: 'created_at',
          schema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              created_at: { type: 'string', format: 'date-time' },
            },
          },
          query: {
            aggregations: { count: true },
          },
        },
      ],
    };
    const fields = ['id', 'title', 'created_at'];
    const fullGrant = { streams: [{ name: stream, fields }] };
    const resourceGrant = { streams: [{ name: stream, fields, resources: ['a'] }] };
    const timeGrant = {
      streams: [
        {
          name: stream,
          fields,
          time_range: {
            since: '2026-04-02T00:00:00.000Z',
            until: '2026-04-03T00:00:00.000Z',
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
          created_at: '2026-04-01T00:00:00.000Z',
        },
      });
      await ingestRecord(connectorId, {
        stream,
        key: 'b',
        data: {
          id: 'b',
          title: 'Beta proof',
          created_at: '2026-04-02T00:00:00.000Z',
        },
      });

      const filteredAggregate = await aggregateRecords(
        connectorId,
        stream,
        fullGrant,
        { metric: 'count', filter: { title: 'Alpha launch' } },
        manifest,
      );
      assert.equal(filteredAggregate.value, 1);
      assert.equal(filteredAggregate.filtered_record_count, 1);

      const wrongAggregate = await aggregateRecords(
        connectorId,
        stream,
        fullGrant,
        { metric: 'count', filter: { title: 'Missing title' } },
        manifest,
      );
      assert.equal(wrongAggregate.value, 0);
      assert.equal(wrongAggregate.filtered_record_count, 0);

      const resourcePage = await queryRecords(connectorId, stream, resourceGrant, { limit: 10 }, manifest);
      assert.deepEqual(resourcePage.data.map((row) => row.id), ['a']);
      await assert.rejects(
        () => getRecord(connectorId, stream, 'b', resourceGrant, manifest),
        { code: 'not_found' },
      );
      const resourceChanges = await queryRecords(
        connectorId,
        stream,
        resourceGrant,
        { changes_since: 'beginning' },
        manifest,
      );
      assert.deepEqual(resourceChanges.data.map((row) => row.id), ['a']);

      const timePage = await queryRecords(connectorId, stream, timeGrant, { limit: 10 }, manifest);
      assert.deepEqual(timePage.data.map((row) => row.id), ['b']);
      await assert.rejects(
        () => getRecord(connectorId, stream, 'a', timeGrant, manifest),
        { code: 'not_found' },
      );
      const timeChanges = await queryRecords(
        connectorId,
        stream,
        timeGrant,
        { changes_since: 'beginning' },
        manifest,
      );
      assert.deepEqual(timeChanges.data.map((row) => row.id), ['b']);

      await postgresQuery(
        'DELETE FROM record_changes WHERE connector_id = $1 AND stream = $2 AND version = 1',
        [connectorId, stream],
      );
      await assert.rejects(
        () => queryRecords(connectorId, stream, fullGrant, { changes_since: 'beginning' }, manifest),
        { code: 'cursor_expired' },
      );
    } finally {
      await postgresQuery('DELETE FROM record_changes WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM records WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM version_counter WHERE connector_id = $1', [connectorId]);
      await closePostgresStorage();
      closeDb();
    }
  });

  test('postgres run summaries include terminal events beyond the prefix sample', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_large_run_${suffix}`;
    const connectionId = `cin_pg_large_run_${suffix}`;
    const runId = `run_pg_large_${suffix}`;
    const traceId = `trc_pg_large_${suffix}`;
    const sourceData = {
      source: { kind: 'connector', id: connectorId },
      connection_id: connectionId,
      connector_instance_id: connectionId,
    };

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    async function insertRunEvent(eventType, status, occurredAt, extraData = {}) {
      await postgresQuery(
        `INSERT INTO spine_events (
           event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, subject_type, subject_id, object_type, object_id,
           status, request_id, grant_id, run_id, source_kind, source_id, client_id, stream_id,
           token_id, interaction_id, data_json, version
         )
         VALUES (
           $1, $2, $3, $3, 'scn_pg_large_summary', $4,
           'runtime', $5, NULL, NULL, 'run', $6,
           $7, NULL, NULL, $6, 'connector', $5, NULL, NULL,
           NULL, NULL, $8::jsonb, 'reference.spine.v1'
         )`,
        [
          `evt_${eventType.replaceAll('.', '_')}_${suffix}`,
          eventType,
          occurredAt,
          traceId,
          connectorId,
          runId,
          status,
          JSON.stringify({ ...sourceData, ...extraData }),
        ],
      );
    }

    try {
      await insertRunEvent('run.started', 'started', '2026-06-02T00:00:00.000Z');
      await postgresQuery(
        `INSERT INTO spine_events (
           event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
           actor_type, actor_id, subject_type, subject_id, object_type, object_id,
           status, request_id, grant_id, run_id, source_kind, source_id, client_id, stream_id,
           token_id, interaction_id, data_json, version
         )
         SELECT
           'evt_pg_large_progress_${suffix}_' || g,
           'run.progress_reported',
           '2026-06-02T00:00:01.000Z',
           '2026-06-02T00:00:01.000Z',
           'scn_pg_large_summary',
           $1,
           'runtime',
           $2,
           NULL,
           NULL,
           'run',
           $3,
           'in_progress',
           NULL,
           NULL,
           $3,
           'connector',
           $2,
           NULL,
           NULL,
           NULL,
           NULL,
           $4::jsonb,
           'reference.spine.v1'
         FROM generate_series(1, 5100) AS g`,
        [traceId, connectorId, runId, JSON.stringify(sourceData)],
      );
      await insertRunEvent('run.failed', 'failed', '2026-06-02T00:00:02.000Z', {
        reason: 'connector_exit_without_done',
      });
      await insertRunEvent('run.browser_surface_released', 'released', '2026-06-02T00:00:03.000Z');

      const page = await listSpineCorrelations('run', {
        sourceKind: 'connector',
        sourceId: connectorId,
        limit: 5,
      });
      const summary = page.summaries.find((row) => row.run_id === runId || row.id === runId);

      assert.ok(summary, 'expected a summary for the large Postgres run');
      assert.equal(summary.status, 'failed');
      assert.equal(summary.connection_id, connectionId);
      assert.equal(summary.connector_instance_id, connectionId);
      assert.equal(summary.event_count, 5103);
      assert.equal(summary.last_at, '2026-06-02T00:00:03.000Z');
      assert.equal(summary.failure?.reason, 'connector_exit_without_done');

      const search = await searchSpine(runId);
      const searchSummary = search.runs.find((row) => row.run_id === runId || row.id === runId);
      assert.ok(searchSummary, 'expected search to return the large run summary');
      assert.equal(searchSummary.status, 'failed');
      assert.equal(searchSummary.connection_id, connectionId);
      assert.equal(searchSummary.connector_instance_id, connectionId);
      assert.equal(searchSummary.event_count, 5103);
    } finally {
      await postgresQuery('DELETE FROM spine_events WHERE run_id = $1', [runId]);
      await closePostgresStorage();
      closeDb();
    }
  });

  test('postgres runtime storage covers records, blobs, spine, lexical, and semantic fallback', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_runtime_${suffix}`;
    const clientId = `pg_client_${suffix}`;
    const ownerSubjectId = `pg_owner_${suffix}`;
    const stream = 'events';
    const traceId = `trace_${suffix}`;
    const recordTraceId = `record_trace_${suffix}`;
    const runTraceId = `run_trace_${suffix}`;
    let issuedGrantId = null;
    let dynamicClientId = null;
    const grant = {
      streams: [
        {
          name: stream,
          fields: ['id', 'title', 'body', 'created_at'],
        },
      ],
    };
    const manifest = {
      protocol_version: '0.1.0',
      connector_id: connectorId,
      version: '1.0.0',
      display_name: 'Postgres Runtime Test',
      capabilities: { human_interaction: [] },
      streams: [
        {
          name: stream,
          primary_key: ['id'],
          cursor_field: 'created_at',
          consent_time_field: 'created_at',
          selection: { fields: true, resources: false },
          schema: {
            type: 'object',
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
    getDb()
      .prepare(
        `INSERT INTO retained_size_global(
           projection_key,
           current_record_json_bytes,
           record_history_json_bytes,
           blob_bytes,
           record_count,
           record_history_count,
           blob_count,
           dirty,
           computed_at,
           metadata_json
         )
         VALUES('global', 999999, 999999, 999999, 999999, 0, 0, 0, '2000-01-01T00:00:00.000Z', '{}')`,
      )
      .run();
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    configureSemanticBackend(makeStubBackend());

    try {
      await seedPreRegisteredClients([
        {
          client_id: clientId,
          registration_mode: 'pre_registered_public',
          metadata: {
            client_name: 'Postgres Runtime Test Client',
            token_endpoint_auth_method: 'none',
          },
        },
      ]);
      await registerConnector(manifest);
      const persistedManifest = await getConnectorManifest(connectorId);
      assert.equal(persistedManifest.connector_id, connectorId);

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
          body: 'postgres semantic fallback vector row',
          created_at: '2026-04-02T00:00:00.000Z',
        },
      });

      const accountA = {
        connector_id: connectorId,
        connector_instance_id: `cin_${suffix}_account_a`,
      };
      const accountB = {
        connector_id: connectorId,
        connector_instance_id: `cin_${suffix}_account_b`,
      };
      await ingestRecord(accountA, {
        stream,
        key: 'shared',
        data: {
          id: 'shared',
          title: 'Account A only',
          body: 'postgres instance namespace account a',
          created_at: '2026-04-03T00:00:00.000Z',
        },
      });
      await ingestRecord(accountB, {
        stream,
        key: 'shared',
        data: {
          id: 'shared',
          title: 'Account B only',
          body: 'postgres instance namespace account b',
          created_at: '2026-04-04T00:00:00.000Z',
        },
      });
      assert.equal((await getRecord(accountA, stream, 'shared', grant, manifest)).data.title, 'Account A only');
      assert.equal((await getRecord(accountB, stream, 'shared', grant, manifest)).data.title, 'Account B only');
      const instanceRows = await postgresQuery(
        `SELECT connector_instance_id, record_json->>'title' AS title
           FROM records
          WHERE connector_id = $1 AND stream = $2 AND record_key = 'shared'
          ORDER BY connector_instance_id`,
        [connectorId, stream],
      );
      assert.deepEqual(
        instanceRows.rows.map((row) => [row.connector_instance_id, row.title]),
        [
          [accountA.connector_instance_id, 'Account A only'],
          [accountB.connector_instance_id, 'Account B only'],
        ],
      );

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
      const blobStore = createBlobStore();
      const blobRow = await blobStore.loadContentAddressedBlob(blob.blob_id);
      assert.equal(blobRow.sha256, blob.sha256);
      const bindings = await blobStore.listBlobBindings(blob.blob_id);
      assert.ok(bindings.some((binding) => binding.connector_id === connectorId && binding.record_key === 'a'));
      const accountBlob = await postgresPersistContentAddressedBlob({
        connectorId,
        connectorInstanceId: accountA.connector_instance_id,
        stream,
        recordKey: 'shared',
        mimeType: 'text/plain',
        data: Buffer.from('postgres account a blob bytes'),
      });
      const accountBindings = await blobStore.listBlobBindings(accountBlob.blob_id);
      assert.ok(
        accountBindings.some(
          (binding) =>
            binding.connector_id === connectorId &&
            binding.connector_instance_id === accountA.connector_instance_id &&
            binding.record_key === 'shared',
        ),
      );

      const datasetAggregate = await getDatasetRecordsAggregate();
      assert.ok(datasetAggregate.record_count >= 2);
      assert.ok(datasetAggregate.connector_count >= 1);
      assert.ok(datasetAggregate.stream_count >= 1);
      assert.ok(datasetAggregate.record_json_bytes > 0);
      assert.ok((await getDatasetRecordChangesBytes()) > 0);
      assert.ok((await getDatasetBlobBytes()) >= Buffer.byteLength('postgres blob bytes'));
      const datasetBounds = await getDatasetRecordTimeBounds();
      assert.ok(
        datasetBounds.earliest <= '2026-04-01T00:00:00.000Z',
        `expected dataset earliest bound to include fixture records, got ${datasetBounds.earliest}`,
      );
      assert.ok(
        datasetBounds.latest >= '2026-04-04T00:00:00.000Z',
        `expected dataset latest bound to include fixture records, got ${datasetBounds.latest}`,
      );
      const topConnectorCandidates = await listDatasetTopConnectorCandidates();
      assert.ok(
        topConnectorCandidates.some(
          (candidate) => candidate.connector_id === connectorId && candidate.record_count >= 2,
        ),
      );

      await rebuildRetainedSize();
      const retainedGlobal = await getRetainedSizeGlobal();
      assert.notEqual(retainedGlobal.current_record_json_bytes, 999999);
      assert.ok(retainedGlobal.record_count >= 4);
      assert.equal(retainedGlobal.metadata.state, 'fresh');
      const retainedConnections = await listRetainedSizeConnections({
        connectorInstanceId: accountA.connector_instance_id,
      });
      assert.equal(retainedConnections.length, 1);
      assert.ok(retainedConnections[0].total_retained_bytes > 0);

      const grantInit = await initiateGrant({
        client_id: clientId,
        authorization_details: [
          {
            type: 'https://pdpp.org/data-access',
            source: { kind: 'connector', id: connectorId },
            purpose_code: 'https://pdpp.org/purpose/personalization',
            purpose_description: 'Postgres runtime storage coverage',
            access_mode: 'continuous',
            streams: [{ name: stream, fields: ['id', 'title', 'body', 'created_at'] }],
          },
        ],
      });
      const deviceCode = parsePendingConsentRequestUri(grantInit.request_uri);
      const pendingConsent = await getPendingConsent(deviceCode);
      assert.equal(pendingConsent.userCode.length > 0, true);
      const pendingApprovals = await listPendingApprovals();
      assert.ok(
        pendingApprovals.some(
          (approval) =>
            approval.kind === 'consent' &&
            approval.client_id === clientId &&
            approval.grant_preview?.source?.kind === 'connector' &&
            approval.grant_preview?.source?.id === connectorId,
        ),
      );

      const approved = await approveGrant(deviceCode, ownerSubjectId);
      issuedGrantId = approved.grant.grant_id;
      assert.deepEqual(approved.grant.source, { kind: 'connector', id: connectorId });
      const tokenInfo = await introspect(approved.token);
      assert.equal(tokenInfo.active, true);
      assert.equal(tokenInfo.grant_id, approved.grant.grant_id);

      const stateStore = createConnectorStateStore();
      const connectorInstanceId = `cin_${connectorId}`;
      await stateStore.putState({ connectorId, connectorInstanceId }, { [stream]: { cursor: '2026-04-02T00:00:00.000Z' } });
      const connectorState = await stateStore.getState({ connectorId, connectorInstanceId });
      assert.deepEqual(connectorState.state[stream], { cursor: '2026-04-02T00:00:00.000Z' });
      await stateStore.putState(
        { connectorId, connectorInstanceId, grantId: approved.grant.grant_id },
        { [stream]: { cursor: 'grant-scoped' } },
      );
      const grantState = await stateStore.getState({ connectorId, connectorInstanceId, grantId: approved.grant.grant_id });
      assert.deepEqual(grantState.state[stream], { cursor: 'grant-scoped' });

      const schedulerStore = createSchedulerStore();
      const scheduleCreatedAt = new Date().toISOString();
      await schedulerStore.createSchedule({
        connector_id: connectorId,
        interval_seconds: 60,
        jitter_seconds: 5,
        enabled: true,
        created_at: scheduleCreatedAt,
        updated_at: scheduleCreatedAt,
      });
      const schedule = await schedulerStore.getSchedule(connectorId);
      assert.equal(schedule.interval_seconds, 60);
      await schedulerStore.setScheduleEnabled(connectorId, false, new Date().toISOString());
      assert.equal((await schedulerStore.getSchedule(connectorId)).enabled, false);
      await schedulerStore.upsertActiveRun({
        connector_id: connectorId,
        run_id: `run_${suffix}`,
        trace_id: runTraceId,
        scenario_id: `scenario_${suffix}`,
        started_at: new Date().toISOString(),
        run_generation: 1,
      });
      const activeRuns = await schedulerStore.listActiveRuns();
      assert.ok(activeRuns.some((run) => run.connector_id === connectorId && run.trace_id === runTraceId));

      const ownerDevice = await initiateOwnerDeviceAuthorization(clientId, {
        baseUrl: 'http://localhost:7662',
        interval: 1,
      });
      const ownerPending = await getOwnerDeviceAuthorizationByUserCode(ownerDevice.user_code);
      assert.equal(ownerPending.client_id, clientId);
      const ownerApproved = await approveOwnerDeviceAuthorization(ownerDevice.user_code, ownerSubjectId);
      const exchangedOwner = await exchangeOwnerDeviceCode({
        clientId,
        deviceCode: ownerDevice.device_code,
      });
      assert.equal(exchangedOwner.access_token, ownerApproved.access_token);
      const ownerTokenInfo = await introspect(ownerApproved.access_token);
      assert.equal(ownerTokenInfo.active, true);
      assert.equal(ownerTokenInfo.pdpp_token_kind, 'owner');
      assert.equal(ownerTokenInfo.client_id, clientId);

      const dynamicClient = await registerDynamicClient(
        {
          client_name: 'Postgres Runtime Dynamic Client',
          token_endpoint_auth_method: 'none',
        },
        { issuer_subject_id: ownerSubjectId },
      );
      dynamicClientId = dynamicClient.client_id;
      const dynamicOwnerDevice = await initiateOwnerDeviceAuthorization(dynamicClientId, {
        baseUrl: 'http://localhost:7662',
        interval: 1,
      });
      const dynamicOwnerApproved = await approveOwnerDeviceAuthorization(
        dynamicOwnerDevice.user_code,
        ownerSubjectId,
      );
      const ownerClients = await listOwnerIssuedClients(ownerSubjectId);
      assert.ok(
        ownerClients.some(
          (client) => client.client_id === dynamicClientId && client.active_token_count >= 1,
        ),
      );
      const deletedClient = await deleteRegisteredClient(dynamicClientId, {
        actingSubjectId: ownerSubjectId,
        requestId: `delete_req_${suffix}`,
        traceId,
      });
      assert.ok(deletedClient.revokedOwnerTokenCount >= 1);
      assert.equal((await introspect(dynamicOwnerApproved.access_token)).active, false);

      await emitSpineEvent({
        trace_id: recordTraceId,
        event_type: 'record.read',
        actor_type: 'client',
        actor_id: 'client-a',
        object_type: 'record',
        object_id: 'a',
        status: 'ok',
        data: { connector_id: connectorId },
      });
      const spinePage = await listSpineEventsPage('trace', recordTraceId, { limit: 10 });
      assert.equal(spinePage.events.length, 1);
      assert.equal(spinePage.events[0].trace_id, recordTraceId);
      const spineSearch = await searchSpine(recordTraceId);
      assert.deepEqual(spineSearch.exact, { kind: 'trace', id: recordTraceId });

      await postgresLexicalIndexUpsert({
        connectorId,
        stream,
        recordKey: 'a',
        fields: { title: 'Alpha launch', body: 'postgres runtime storage covers alpha' },
      });
      await postgresLexicalIndexUpsert({
        connectorId,
        stream,
        recordKey: 'b',
        fields: { title: 'Beta proof', body: 'postgres runtime storage covers beta' },
      });
      await postgresLexicalIndexUpsert({
        connectorId,
        connectorInstanceId: accountA.connector_instance_id,
        stream,
        recordKey: 'shared',
        fields: { title: 'Account A only', body: 'postgres instance namespace account a' },
      });
      await postgresLexicalIndexUpsert({
        connectorId,
        connectorInstanceId: accountB.connector_instance_id,
        stream,
        recordKey: 'shared',
        fields: { title: 'Account B only', body: 'postgres instance namespace account b' },
      });
      const lexicalHits = await postgresLexicalSearch({
        connectorId,
        stream,
        searchableFields: ['title', 'body'],
        q: 'alpha',
      });
      assert.equal(lexicalHits[0].record_key, 'a');
      const accountALexicalHits = await postgresLexicalSearch({
        connectorId,
        connectorInstanceId: accountA.connector_instance_id,
        stream,
        searchableFields: ['title', 'body'],
        q: 'account',
      });
      assert.deepEqual([...new Set(accountALexicalHits.map((row) => row.record_key))], ['shared']);

      // Register the default connector instance for this owner so the client-mode
      // search fan-in (resolveClientBindings -> resolveFanInBindings ->
      // listActiveBindingsForGrant) can discover an active binding.  ingestRecord
      // writes to the records table using makeDefaultAccountConnectorInstanceId
      // but never inserts a connector_instances row; that registration belongs here
      // in the test setup, not in the ingest path.
      const defaultConnectorInstanceId = makeDefaultAccountConnectorInstanceId(
        OWNER_AUTH_DEFAULT_SUBJECT_ID,
        connectorId,
      );
      const instanceStore = createPostgresConnectorInstanceStore();
      const instanceNow = new Date().toISOString();
      await instanceStore.upsert({
        connectorInstanceId: defaultConnectorInstanceId,
        ownerSubjectId,
        connectorId,
        displayName: connectorId,
        status: 'active',
        sourceKind: 'account',
        sourceBinding: {},
        createdAt: instanceNow,
        updatedAt: instanceNow,
      });

      const searchDeps = {
        resolveOwnerVisibleConnectorIds: () => [connectorId],
        resolveOwnerScopeForConnector: () => ({ connectorId }),
        resolveOwnerManifestFromScope: async () => ({ manifest }),
        buildOwnerReadGrantForManifest: () => grant,
        resolveGrantManifest: async () => ({ manifest }),
      };
      const lexicalPage = await runLexicalSearch({
        req: { query: { q: 'postgres', limit: '1' } },
        opts: {},
        tokenInfo,
        ...searchDeps,
      });
      assert.equal(lexicalPage.envelope.has_more, true);
      assert.ok(lexicalPage.envelope.next_cursor);
      const lexicalNextPage = await runLexicalSearch({
        req: { query: { q: 'postgres', limit: '1', cursor: lexicalPage.envelope.next_cursor } },
        opts: {},
        tokenInfo,
        ...searchDeps,
      });
      assert.equal(lexicalNextPage.envelope.data.length, 1);
      assert.notEqual(
        lexicalNextPage.envelope.data[0].record_key,
        lexicalPage.envelope.data[0].record_key,
      );
      const lexicalSnapshot = await postgresQuery(
        'SELECT COUNT(*)::int AS count FROM lexical_search_snapshots',
      );
      assert.ok(Number(lexicalSnapshot.rows[0].count) > 0);

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
      await postgresSemanticIndexUpsertMany({
        connectorId,
        connectorInstanceId: accountA.connector_instance_id,
        stream,
        recordKey: 'shared',
        entries: [
          {
            connectorId,
            connectorInstanceId: accountA.connector_instance_id,
            scopeKey: JSON.stringify([stream, 'body']),
            recordKey: 'shared',
            vector: [0, 1, 0],
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
      const accountASemanticHits = await postgresSemanticSearch({
        connectorId,
        connectorInstanceId: accountA.connector_instance_id,
        scopeKeys: [JSON.stringify([stream, 'body'])],
        queryVector: [0, 1, 0],
        limit: 10,
      });
      assert.deepEqual(accountASemanticHits.map((row) => row.recordKey), ['shared']);

      await semanticIndexUpsert({
        connectorId,
        stream,
        recordKey: 'a',
        data: {
          id: 'a',
          title: 'Alpha launch',
          body: 'postgres runtime storage covers alpha',
          created_at: '2026-04-01T00:00:00.000Z',
        },
      });
      await semanticIndexUpsert({
        connectorId,
        stream,
        recordKey: 'b',
        data: {
          id: 'b',
          title: 'Beta proof',
          body: 'postgres runtime storage covers beta',
          created_at: '2026-04-02T00:00:00.000Z',
        },
      });
      const semanticPage = await runSemanticSearch({
        req: { query: { q: 'postgres runtime storage', limit: '1' } },
        opts: {},
        tokenInfo,
        ...searchDeps,
      });
      assert.equal(semanticPage.envelope.has_more, true);
      assert.ok(semanticPage.envelope.next_cursor);
      const semanticNextPage = await runSemanticSearch({
        req: { query: { q: 'postgres runtime storage', limit: '1', cursor: semanticPage.envelope.next_cursor } },
        opts: {},
        tokenInfo,
        ...searchDeps,
      });
      assert.equal(semanticNextPage.envelope.data.length, 1);
      assert.notEqual(
        semanticNextPage.envelope.data[0].record_key,
        semanticPage.envelope.data[0].record_key,
      );
      const semanticSnapshot = await postgresQuery(
        'SELECT COUNT(*)::int AS count FROM semantic_search_snapshots',
      );
      assert.ok(Number(semanticSnapshot.rows[0].count) > 0);

      // Postgres record-retrieval (hydration) seam coverage: emitted_at and the
      // verbatim snippet on each hit are produced ONLY by the migrated
      // hydrateSemanticSearchResult records-table read (getSemanticSearchStore
      // .getRecordRow on the Postgres adapter). Pin them against the canonical
      // records row for the hit so a broken Postgres record-retrieval adapter
      // (null record -> null emitted_at, no snippet) fails this test.
      for (const page of [semanticPage, semanticNextPage]) {
        const hit = page.envelope.data[0];
        const stored = await postgresQuery(
          `SELECT emitted_at, record_json->>'body' AS body
             FROM records
            WHERE connector_id = $1 AND stream = $2 AND record_key = $3 AND deleted = FALSE`,
          [connectorId, stream, hit.record_key],
        );
        const storedRow = stored.rows[0];
        assert.ok(storedRow, `expected a stored records row for ${hit.record_key}`);
        assert.equal(
          hit.emitted_at,
          storedRow.emitted_at,
          'hydration must populate emitted_at from the records table on the Postgres path',
        );
        assert.ok(hit.snippet, 'hydration must produce a grant-safe snippet on the Postgres path');
        assert.equal(hit.snippet.field, 'body');
        const snippetText = hit.snippet.text.replace(/…$/, '');
        assert.ok(
          storedRow.body.includes(snippetText),
          `snippet "${hit.snippet.text}" must be a verbatim substring of the stored body`,
        );
      }

      await revokeGrant(approved.grant.grant_id, {
        request_id: `req_${suffix}`,
        trace_id: traceId,
      });
      const revokedTokenInfo = await introspect(approved.token);
      assert.equal(revokedTokenInfo.active, false);

      const deleted = await deleteRecord(connectorId, stream, 'a');
      assert.equal(deleted.changed, true);
      await assert.rejects(
        () => getRecord(connectorId, stream, 'a', grant, manifest),
        /Record not found/,
      );
    } finally {
      const cleanupClientIds = [clientId, dynamicClientId].filter(Boolean);
      await postgresQuery(
        "DELETE FROM spine_events WHERE trace_id = ANY($1::text[]) OR client_id = ANY($2::text[]) OR subject_id = $3 OR actor_id = ANY($2::text[]) OR actor_id = $3",
        [[traceId, recordTraceId, runTraceId], cleanupClientIds, ownerSubjectId],
      );
      await postgresQuery("DELETE FROM lexical_search_snapshots WHERE query = 'postgres'");
      await postgresQuery("DELETE FROM semantic_search_snapshots WHERE query = 'postgres runtime storage'");
      await postgresQuery('DELETE FROM controller_active_runs WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM connector_schedules WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM grant_connector_state WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM connector_state WHERE connector_id = $1', [connectorId]);
      await postgresQuery("DELETE FROM pending_consents WHERE params_json->'client'->>'client_id' = $1", [clientId]);
      await postgresQuery('DELETE FROM owner_device_auth WHERE client_id = ANY($1::text[])', [cleanupClientIds]);
      await postgresQuery('DELETE FROM tokens WHERE client_id = ANY($1::text[]) OR subject_id = $2 OR grant_id = $3', [
        cleanupClientIds,
        ownerSubjectId,
        issuedGrantId,
      ]);
      await postgresQuery('DELETE FROM grants WHERE client_id = ANY($1::text[]) OR grant_id = $2', [
        cleanupClientIds,
        issuedGrantId,
      ]);
      await postgresQuery('DELETE FROM oauth_clients WHERE client_id = ANY($1::text[])', [cleanupClientIds]);
      await postgresQuery('DELETE FROM connector_instances WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', [connectorId]);
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
      configureSemanticBackend(null);
      await closePostgresStorage();
      closeDb();
    }
  });

  test('postgres grouped indexable field counts match per-field loop semantics', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_index_counts_${suffix}`;
    const connectorInstanceId = `cin_pg_index_counts_${suffix}`;
    const stream = 'messages';
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      const rows = [
        ['a', { title: 'Alpha', body: '  ', summary: 'One' }, false],
        ['b', { title: '', body: 'Beta', summary: null }, false],
        ['c', { title: 'Gamma', body: 'Delta', summary: 42 }, false],
        ['deleted', { title: 'Hidden', body: 'Hidden', summary: 'Hidden' }, true],
      ];
      for (const [recordKey, recordJson, deleted] of rows) {
        await postgresQuery(
          `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, primary_key_text)
           VALUES($1, $2, $3, $4, $5::jsonb, $6, 1, $7, $8)`,
          [connectorId, connectorInstanceId, stream, recordKey, JSON.stringify(recordJson), new Date().toISOString(), deleted, recordKey],
        );
      }

      assert.equal(
        await postgresLexicalCountIndexableTextValues({
          connectorInstanceId,
          stream,
          declaredFields: ['title', 'body', 'missing', 'title'],
        }),
        7,
      );
      assert.equal(
        await postgresCountIndexableSemanticValues({
          connectorInstanceId,
          stream,
          declaredFields: ['title', 'body', 'missing', 'title'],
        }),
        6,
      );
    } finally {
      await postgresQuery('DELETE FROM records WHERE connector_id = $1', [connectorId]);
      await closePostgresStorage();
    }
  });

  test('postgres semantic insert-many writes and updates the same indexed rows', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_semantic_batch_${suffix}`;
    const connectorInstanceId = `cin_pg_semantic_batch_${suffix}`;
    const stream = 'messages';
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });
    try {
      const titleScope = JSON.stringify([stream, 'title']);
      const bodyScope = JSON.stringify([stream, 'body']);

      assert.equal(
        await postgresSemanticIndexInsertMany({
          connectorId,
          connectorInstanceId,
          entries: [
            { connectorId, connectorInstanceId, scopeKey: titleScope, recordKey: 'a', vector: [1, 0, 0] },
            { connectorId, connectorInstanceId, scopeKey: bodyScope, recordKey: 'a', vector: [0, 1, 0] },
            { connectorId, connectorInstanceId, scopeKey: titleScope, recordKey: 'b', vector: [0, 0, 1] },
            { connectorId, connectorInstanceId, scopeKey: titleScope, recordKey: 'b', vector: [0.5, 0.5, 0] },
          ],
        }),
        3,
      );

      let indexedRows = await postgresQuery(
        `SELECT scope_key, record_key, embedding::text AS embedding
         FROM semantic_search_blob
         WHERE connector_instance_id = $1
         ORDER BY scope_key, record_key`,
        [connectorInstanceId],
      );
      assert.deepEqual(
        indexedRows.rows.map((row) => [row.scope_key, row.record_key]),
        [
          [bodyScope, 'a'],
          [titleScope, 'a'],
          [titleScope, 'b'],
        ],
      );
      assert.equal(indexedRows.rows.find((row) => row.record_key === 'b').embedding.replace(/\s+/g, ''), '[0.5,0.5,0]');

      assert.equal(
        await postgresSemanticIndexInsertMany({
          connectorId,
          connectorInstanceId,
          entries: [
            { connectorId, connectorInstanceId, scopeKey: titleScope, recordKey: 'b', vector: [0.25, 0.75, 0] },
          ],
        }),
        1,
      );
      indexedRows = await postgresQuery(
        `SELECT COUNT(*)::int AS count,
                MAX(embedding::text) FILTER (WHERE scope_key = $2 AND record_key = 'b') AS b_embedding
         FROM semantic_search_blob
         WHERE connector_instance_id = $1`,
        [connectorInstanceId, titleScope],
      );
      assert.equal(indexedRows.rows[0].count, 3);
      assert.equal(indexedRows.rows[0].b_embedding.replace(/\s+/g, ''), '[0.25,0.75,0]');
    } finally {
      await postgresQuery('DELETE FROM semantic_search_blob WHERE connector_id = $1', [connectorId]);
      await closePostgresStorage();
    }
  });

  // Postgres-backed public-read MUST honor the same canonical
  // `sort` / `count` contract as the SQLite reference path. The owner
  // flagged a footgun where postgres-records.js silently accepted these
  // params and no-oped — re-introducing exactly the "silent no-op"
  // behavior the canonical contract was written to eliminate.
  //
  // These tests fail if:
  //   - `sort=-<cursor>` is ignored and the page returns ascending order.
  //   - `count=exact` / `count=estimated` is ignored (no `meta.count`).
  //   - `sort` and `order` disagree but the runtime silently picks one.
  //   - `count` outside the canonical vocabulary is silently accepted.
  //   - `sort` on an unadvertised field is silently accepted.
  //
  // Spec: openspec/changes/canonicalize-public-read-contract/specs/
  //       reference-implementation-architecture/spec.md (#"Sort",
  //       #"Counts").
  test('postgres records list honors canonical sort and graded count', async () => {
    const suffix = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const connectorId = `pg_canonical_${suffix}`;
    const connectorInstanceId = makeDefaultAccountConnectorInstanceId('owner_local', connectorId);
    const stream = 'events';
    const grant = {
      streams: [{ name: stream, fields: ['id', 'title', 'created_at'] }],
    };
    const manifest = {
      protocol_version: '0.1.0',
      connector_id: connectorId,
      version: '1.0.0',
      display_name: 'Postgres Canonical Contract Test',
      capabilities: { human_interaction: [] },
      streams: [
        {
          name: stream,
          primary_key: ['id'],
          cursor_field: 'created_at',
          consent_time_field: 'created_at',
          selection: { fields: true, resources: false },
          schema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              created_at: { type: 'string', format: 'date-time' },
            },
          },
        },
      ],
    };

    initDb(':memory:');
    await initPostgresStorage({ backend: 'postgres', databaseUrl: POSTGRES_URL });

    try {
      await registerConnector(manifest);

      const items = [
        { id: 'a', title: 'Alpha', created_at: '2026-04-01T00:00:00.000Z' },
        { id: 'b', title: 'Beta',  created_at: '2026-04-02T00:00:00.000Z' },
        { id: 'c', title: 'Gamma', created_at: '2026-04-03T00:00:00.000Z' },
      ];
      for (const data of items) {
        await ingestRecord(connectorId, { stream, key: data.id, data });
      }

      const storedSortPositions = await postgresQuery(
        `SELECT record_key, cursor_value, primary_key_text
           FROM records
          WHERE connector_instance_id = $1
            AND stream = $2
          ORDER BY record_key ASC`,
        [connectorInstanceId, stream],
      );
      assert.deepEqual(
        storedSortPositions.rows.map((row) => [row.record_key, row.cursor_value, row.primary_key_text]),
        [
          ['a', '2026-04-01T00:00:00.000Z', 'a'],
          ['b', '2026-04-02T00:00:00.000Z', 'b'],
          ['c', '2026-04-03T00:00:00.000Z', 'c'],
        ],
        'Postgres ingest must persist manifest-derived cursor_value and primary_key_text for indexed reads',
      );

      await postgresQuery(
        `UPDATE records
            SET cursor_value = NULL
          WHERE connector_instance_id = $1
            AND stream = $2
            AND record_key = 'c'`,
        [connectorInstanceId, stream],
      );
      await registerConnector(manifest, { backfillRetrievalIndexes: false });
      const backfilledSortPosition = await postgresQuery(
        `SELECT cursor_value
           FROM records
          WHERE connector_instance_id = $1
            AND stream = $2
            AND record_key = 'c'`,
        [connectorInstanceId, stream],
      );
      assert.equal(
        backfilledSortPosition.rows[0]?.cursor_value,
        '2026-04-03T00:00:00.000Z',
        'manifest refresh must backfill missing stored cursor values before indexed reads rely on them',
      );

      await postgresQuery(
        `INSERT INTO retained_size_stream(
           connector_instance_id,
           connector_id,
           stream,
           current_record_json_bytes,
           record_history_json_bytes,
           blob_bytes,
           record_count,
           record_history_count,
           blob_count,
           dirty,
           computed_at
         )
         VALUES($1, $2, $3, 0, 0, 0, 3, 3, 0, 0, $4)
         ON CONFLICT(connector_instance_id, stream) DO UPDATE
           SET connector_id = EXCLUDED.connector_id,
               record_count = EXCLUDED.record_count,
               record_history_count = EXCLUDED.record_history_count,
               dirty = EXCLUDED.dirty,
               computed_at = EXCLUDED.computed_at`,
        [connectorInstanceId, connectorId, stream, new Date().toISOString()],
      );

      const canonicalConnection = await queryRecords(connectorId, stream, grant, {
        connection_id: connectorInstanceId,
        order: 'asc',
      }, manifest);
      assert.deepEqual(
        canonicalConnection.data.map((row) => row.id),
        ['a', 'b', 'c'],
        'Postgres records list must accept the canonical connection_id for the bound storage',
      );
      assert.equal(
        canonicalConnection.meta?.warnings,
        undefined,
        'canonical connection_id must not emit a deprecated-alias warning',
      );

      const deprecatedAlias = await queryRecords(connectorId, stream, grant, {
        connector_instance_id: connectorInstanceId,
        order: 'asc',
      }, manifest);
      assert.equal(
        deprecatedAlias.meta?.warnings?.[0]?.code,
        'deprecated_alias_used',
        'Postgres records list must warn when the deprecated alias is used',
      );

      await assert.rejects(
        () => queryRecords(connectorId, stream, grant, {
          connection_id: 'cin_other_connection',
        }, manifest),
        (err) => {
          assert.equal(err.code, 'connection_not_found');
          assert.equal(err.param, 'connection_id');
          return true;
        },
        'Postgres records list must reject a connection_id outside the grant storage binding',
      );

      const recordWithAlias = await getRecord(connectorId, stream, 'a', grant, manifest, {
        connector_instance_id: connectorInstanceId,
      });
      assert.equal(recordWithAlias.meta?.warnings?.[0]?.code, 'deprecated_alias_used');
      await assert.rejects(
        () => getRecord(connectorId, stream, 'a', grant, manifest, {
          connection_id: 'cin_other_connection',
        }),
        (err) => {
          assert.equal(err.code, 'connection_not_found');
          assert.equal(err.param, 'connection_id');
          return true;
        },
        'Postgres records detail must reject a connection_id outside the grant storage binding',
      );

      // sort=-created_at MUST return rows in DESC order.
      const desc = await queryRecords(connectorId, stream, grant, {
        sort: '-created_at',
      }, manifest);
      assert.deepEqual(
        desc.data.map((row) => row.id),
        ['c', 'b', 'a'],
        'sort=-created_at must yield DESC order on the Postgres path',
      );

      // sort=created_at MUST return rows in ASC order.
      const asc = await queryRecords(connectorId, stream, grant, {
        sort: 'created_at',
      }, manifest);
      assert.deepEqual(
        asc.data.map((row) => row.id),
        ['a', 'b', 'c'],
        'sort=created_at must yield ASC order on the Postgres path',
      );

      // sort and order disagreement must be rejected, not silently picked.
      await assert.rejects(
        () => queryRecords(connectorId, stream, grant, {
          sort: '-created_at',
          order: 'asc',
        }, manifest),
        (err) => {
          assert.equal(err.code, 'invalid_sort');
          return true;
        },
        'Postgres path must reject sort/order disagreement with typed invalid_sort',
      );

      // sort on an unadvertised field must be rejected.
      await assert.rejects(
        () => queryRecords(connectorId, stream, grant, {
          sort: 'title',
        }, manifest),
        (err) => {
          assert.equal(err.code, 'invalid_sort');
          return true;
        },
        'Postgres path must reject sort on an unadvertised field',
      );

      // count=exact must populate meta.count.kind='exact' with the value
      // matching all visible rows in the stream (3), not just the page.
      const exactPage1 = await queryRecords(connectorId, stream, grant, {
        count: 'exact',
        limit: 1,
        order: 'asc',
      }, manifest);
      assert.equal(exactPage1.data.length, 1, 'limit=1 must return one row');
      assert.equal(exactPage1.has_more, true, 'limit=1 over 3 rows must signal has_more');
      assert.equal(
        exactPage1.meta?.count?.kind,
        'exact',
        'count=exact must surface meta.count.kind=exact on the Postgres path',
      );
      assert.equal(
        exactPage1.meta?.count?.value,
        3,
        'count=exact value must reflect all matching visible rows (3), not the page size',
      );
      assert.equal(
        Array.isArray(exactPage1.meta?.warnings) && exactPage1.meta.warnings.some((w) => w.code === 'count_downgraded'),
        false,
        'count=exact on the Postgres path must NOT emit count_downgraded',
      );

      // count=estimated must silently upgrade to exact on the Postgres
      // reference path (cheap to compute the exact value via the same
      // filter clause). No count_downgraded warning — that vocabulary
      // slot is reserved for true downgrades.
      const estimated = await queryRecords(connectorId, stream, grant, {
        count: 'estimated',
        limit: 5,
        order: 'asc',
      }, manifest);
      assert.equal(
        estimated.meta?.count?.kind,
        'exact',
        'count=estimated must surface meta.count.kind=exact (silent upgrade) on the Postgres path',
      );
      assert.equal(
        estimated.meta?.count?.value,
        3,
        'count=estimated value must reflect all matching visible rows (3)',
      );
      assert.equal(
        Array.isArray(estimated.meta?.warnings) && estimated.meta.warnings.some((w) => w.code === 'count_downgraded'),
        false,
        'count=estimated upgrading to exact is not a downgrade and must NOT emit count_downgraded',
      );

      // count=none (and absent count) MUST omit meta.count.
      const none = await queryRecords(connectorId, stream, grant, {
        count: 'none',
        order: 'asc',
      }, manifest);
      assert.equal(none.meta?.count, undefined, 'count=none must omit meta.count on the Postgres path');

      // Unknown count value must be rejected, not silently treated as none.
      await assert.rejects(
        () => queryRecords(connectorId, stream, grant, {
          count: 'guessed',
        }, manifest),
        (err) => {
          assert.equal(err.code, 'invalid_request');
          return true;
        },
        'Postgres path must reject count values outside the canonical vocabulary',
      );

      // changes_since is a version-ordered change feed. List-only ordering
      // and count parameters must be rejected instead of accepted and ignored.
      for (const params of [
        { changes_since: 'beginning', sort: '-created_at' },
        { changes_since: 'beginning', count: 'exact' },
        { changes_since: 'beginning', order: 'asc' },
      ]) {
        await assert.rejects(
          () => queryRecords(connectorId, stream, grant, params, manifest),
          (err) => {
            assert.equal(err.code, 'invalid_request');
            assert.match(err.message, /not supported with changes_since/);
            return true;
          },
          'Postgres changes_since must reject list-only sort/count/order params',
        );
      }

      // Filter narrowing must be reflected in the count: a filter that
      // matches a single visible row must yield count.value === 1.
      const filtered = await queryRecords(connectorId, stream, grant, {
        count: 'exact',
        filter: { id: 'b' },
        order: 'asc',
      }, manifest);
      assert.deepEqual(
        filtered.data.map((row) => row.id),
        ['b'],
        'filter={id:b} must narrow the page to one row on the Postgres path',
      );
      assert.equal(
        filtered.meta?.count?.value,
        1,
        'count must reflect filter narrowing, not the unfiltered retained-size projection',
      );

      await postgresQuery(
        `UPDATE retained_size_stream
            SET record_count = 999,
                dirty = 1
          WHERE connector_instance_id = $1
            AND stream = $2`,
        [connectorInstanceId, stream],
      );
      const dirtyProjection = await queryRecords(connectorId, stream, grant, {
        count: 'exact',
        limit: 1,
        order: 'asc',
      }, manifest);
      assert.equal(
        dirtyProjection.meta?.count?.value,
        3,
        'dirty retained-size projections must be ignored in favor of the canonical SQL count',
      );
    } finally {
      await postgresQuery('DELETE FROM retained_size_stream WHERE connector_instance_id = $1', [connectorInstanceId]);
      await postgresQuery('DELETE FROM record_changes WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM records WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM version_counter WHERE connector_id = $1', [connectorId]);
      await postgresQuery('DELETE FROM connectors WHERE connector_id = $1', [connectorId]);
      await closePostgresStorage();
      closeDb();
    }
  });
}
