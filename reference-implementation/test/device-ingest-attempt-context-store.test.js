import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { fingerprintDeviceAttemptManifest } from '../server/device-ingest-attempt-context.ts';
import {
  advancePostgresDeviceIngestPrefix,
  advanceSqliteDeviceIngestPrefix,
  createPostgresDeviceExporterStore,
  createSqliteDeviceExporterStore,
} from '../server/stores/device-exporter-store.ts';
import {
  closePostgresStorage,
  initPostgresStorage,
  postgresQuery,
  withPostgresTransaction,
} from '../server/postgres-storage.js';
import { dedicatedPostgresTestUrl } from './helpers/dedicated-postgres-test-url.js';

const DEDICATED_POSTGRES_URL = dedicatedPostgresTestUrl(process.env.PDPP_TEST_POSTGRES_URL);
const NOW = '2026-07-16T00:00:00.000Z';
const OLD_MANIFEST = {
  connector_id: 'attempt-context-test',
  version: '1.0.0',
  streams: [{ name: 'records', primary_key: ['id'], cursor_field: 'updated_at', consent_time_field: 'updated_at' }],
};
const NEW_MANIFEST = {
  ...OLD_MANIFEST,
  streams: [{ name: 'records', primary_key: ['id'], cursor_field: 'changed_at', consent_time_field: 'changed_at' }],
};

function reservation(overrides = {}) {
  return {
    deviceId: 'dev_attempt_context',
    batchId: 'batch_attempt_context',
    bodyHash: 'a'.repeat(64),
    sourceInstanceId: 'src_attempt_context',
    connectorInstanceId: 'cin_attempt_context',
    connectorId: 'attempt-context-test',
    batchSeq: 1,
    recordCount: 1,
    createdAt: NOW,
    manifestFingerprint: fingerprintDeviceAttemptManifest(OLD_MANIFEST),
    semanticCapabilityIdentity: 'model=attempt-a;dimensions=3;metric=cosine',
    ...overrides,
  };
}

async function expectRetryable(fn) {
  await assert.rejects(
    async () => await fn(),
    (err) => err?.code === 'device_ingest_retryable',
  );
}

async function proveAttemptFences({ store, replaceManifest, advancePrefix }) {
  const first = reservation();
  await store.ensureProcessingBatch(first);
  await advancePrefix(first);

  await replaceManifest(NEW_MANIFEST);
  await expectRetryable(
    () => store.completeProcessingBatch({
      ...first,
      acceptedAt: NOW,
      httpStatus: 201,
      response: { accepted_record_count: 1, rejected_record_count: 0 },
      getCurrentSemanticCapabilityIdentity: () => first.semanticCapabilityIdentity,
    }),
  );
  const stale = await store.getBatchOutcome(first.deviceId, first.batchId);
  assert.equal(stale.status, 'processing');
  assert.equal(stale.durablePrefixCount, 1);

  const rebuilt = {
    ...first,
    manifestFingerprint: fingerprintDeviceAttemptManifest(NEW_MANIFEST),
  };
  await store.refreshProcessingAttemptContext(rebuilt);
  const accepted = await store.completeProcessingBatch({
    ...rebuilt,
    acceptedAt: NOW,
    httpStatus: 201,
    response: { accepted_record_count: 1, rejected_record_count: 0 },
    getCurrentSemanticCapabilityIdentity: () => rebuilt.semanticCapabilityIdentity,
  });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.durablePrefixCount, 1);
  assert.equal(accepted.recordCount, 1);

  const semantic = reservation({
    batchId: 'batch_attempt_semantic',
    manifestFingerprint: fingerprintDeviceAttemptManifest(NEW_MANIFEST),
  });
  await store.ensureProcessingBatch(semantic);
  await advancePrefix(semantic);
  await expectRetryable(
    () => store.completeProcessingBatch({
      ...semantic,
      acceptedAt: NOW,
      httpStatus: 201,
      response: { accepted_record_count: 1, rejected_record_count: 0 },
      getCurrentSemanticCapabilityIdentity: () => 'model=attempt-b;dimensions=3;metric=cosine',
    }),
  );
  const semanticRebuilt = {
    ...semantic,
    semanticCapabilityIdentity: 'model=attempt-b;dimensions=3;metric=cosine',
  };
  await store.refreshProcessingAttemptContext(semanticRebuilt);
  const semanticAccepted = await store.completeProcessingBatch({
    ...semanticRebuilt,
    acceptedAt: NOW,
    httpStatus: 201,
    response: { accepted_record_count: 1, rejected_record_count: 0 },
    getCurrentSemanticCapabilityIdentity: () => semanticRebuilt.semanticCapabilityIdentity,
  });
  assert.equal(semanticAccepted.status, 'accepted');
}

test('SQLite processing reservation acceptance is fenced by current manifest and semantic identity', async () => {
  initDb(':memory:');
  try {
    getDb().prepare('INSERT INTO connectors(connector_id, manifest) VALUES(?, ?)')
      .run('attempt-context-test', JSON.stringify(OLD_MANIFEST));
    getDb().prepare(`
      INSERT INTO device_exporters(device_id, owner_subject_id, display_name, created_at, updated_at)
      VALUES('dev_attempt_context', 'owner_attempt_context', 'Attempt context', ?, ?)
    `).run(NOW, NOW);
    await proveAttemptFences({
      store: createSqliteDeviceExporterStore(),
      replaceManifest: async (manifest) => {
        getDb().prepare('UPDATE connectors SET manifest = ? WHERE connector_id = ?')
          .run(JSON.stringify(manifest), 'attempt-context-test');
      },
      advancePrefix: async (record) => advanceSqliteDeviceIngestPrefix(record, 0),
    });
  } finally {
    closeDb();
  }
});

test(
  'dedicated Postgres processing reservation acceptance locks and fences current manifest and semantic identity',
  { skip: !DEDICATED_POSTGRES_URL },
  async () => {
    await initPostgresStorage({ backend: 'postgres', databaseUrl: DEDICATED_POSTGRES_URL });
    try {
      await postgresQuery("DELETE FROM device_ingest_batch_outcomes WHERE device_id = 'dev_attempt_context'");
      await postgresQuery("DELETE FROM device_exporters WHERE device_id = 'dev_attempt_context'");
      await postgresQuery("DELETE FROM connectors WHERE connector_id = 'attempt-context-test'");
      await postgresQuery(
        'INSERT INTO connectors(connector_id, manifest, created_at) VALUES($1, $2::jsonb, $3)',
        ['attempt-context-test', JSON.stringify(OLD_MANIFEST), NOW],
      );
      await postgresQuery(
        `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, created_at, updated_at)
         VALUES($1, $2, $3, $4, $5)`,
        ['dev_attempt_context', 'owner_attempt_context', 'Attempt context', NOW, NOW],
      );
      await proveAttemptFences({
        store: createPostgresDeviceExporterStore(),
        replaceManifest: async (manifest) => {
          await postgresQuery('UPDATE connectors SET manifest = $1::jsonb WHERE connector_id = $2', [
            JSON.stringify(manifest),
            'attempt-context-test',
          ]);
        },
        advancePrefix: async (record) => withPostgresTransaction((client) => advancePostgresDeviceIngestPrefix(client, record, 0)),
      });
    } finally {
      await postgresQuery("DELETE FROM device_ingest_batch_outcomes WHERE device_id = 'dev_attempt_context'");
      await postgresQuery("DELETE FROM device_exporters WHERE device_id = 'dev_attempt_context'");
      await postgresQuery("DELETE FROM connectors WHERE connector_id = 'attempt-context-test'");
      await closePostgresStorage();
    }
  },
);
