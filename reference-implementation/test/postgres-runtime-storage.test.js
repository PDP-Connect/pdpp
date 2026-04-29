import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emitSpineEvent,
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
import { listPendingApprovals } from '../server/ref-control.ts';
import { runLexicalSearch } from '../server/search.js';
import {
  configureSemanticBackend,
  makeStubBackend,
  runSemanticSearch,
  semanticIndexUpsert,
} from '../server/search-semantic.js';
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
import { createBlobStore } from '../server/stores/blob-store.js';
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
      const blobStore = createBlobStore();
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
      assert.deepEqual(await getDatasetRecordTimeBounds(), {
        earliest: '2026-04-01T00:00:00.000Z',
        latest: '2026-04-02T00:00:00.000Z',
      });
      const topConnectorCandidates = await listDatasetTopConnectorCandidates();
      assert.ok(
        topConnectorCandidates.some(
          (candidate) => candidate.connector_id === connectorId && candidate.record_count >= 2,
        ),
      );

      const grantInit = await initiateGrant({
        client_id: clientId,
        authorization_details: [
          {
            type: 'https://pdpp.org/data-access',
            connector_id: connectorId,
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
            approval.grant_preview?.connector_id === connectorId,
        ),
      );

      const approved = await approveGrant(deviceCode, ownerSubjectId);
      issuedGrantId = approved.grant.grant_id;
      assert.equal(approved.grant.source.connector_id, connectorId);
      const tokenInfo = await introspect(approved.token);
      assert.equal(tokenInfo.active, true);
      assert.equal(tokenInfo.grant_id, approved.grant.grant_id);

      const stateStore = createConnectorStateStore();
      await stateStore.putState({ connectorId }, { [stream]: { cursor: '2026-04-02T00:00:00.000Z' } });
      const connectorState = await stateStore.getState({ connectorId });
      assert.deepEqual(connectorState.state[stream], { cursor: '2026-04-02T00:00:00.000Z' });
      await stateStore.putState(
        { connectorId, grantId: approved.grant.grant_id },
        { [stream]: { cursor: 'grant-scoped' } },
      );
      const grantState = await stateStore.getState({ connectorId, grantId: approved.grant.grant_id });
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
      const lexicalHits = await postgresLexicalSearch({
        connectorId,
        stream,
        searchableFields: ['title', 'body'],
        q: 'alpha',
      });
      assert.equal(lexicalHits[0].record_key, 'a');

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
      const semanticHits = await postgresSemanticSearch({
        connectorId,
        scopeKeys: [JSON.stringify([stream, 'body'])],
        queryVector: [1, 0, 0],
        limit: 10,
      });
      assert.equal(semanticHits[0].recordKey, 'a');

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
}
