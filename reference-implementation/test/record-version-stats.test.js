import assert from 'node:assert/strict';
import test from 'node:test';

import { getDb } from '../server/db.js';
import {
  buildRecordVersionStatsEnvelope,
  classifyRecordVersionChurn,
} from '../server/record-version-stats.js';
import { startServer } from '../server/index.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';

const CONNECTOR_ID = 'https://test.pdpp.dev/connectors/version-churn';
const CONNECTOR_INSTANCE_ID = 'cin_test_version_churn';
const NOW = '2026-05-26T12:00:00.000Z';

async function closeServer(server) {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function fetchJson(url) {
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  const text = await resp.text();
  return { status: resp.status, body: text ? JSON.parse(text) : null };
}

function seedConnector() {
  getDb()
    .prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(CONNECTOR_ID, JSON.stringify({
      protocol_version: '0.1.0',
      connector_id: CONNECTOR_ID,
      display_name: 'Version Churn Fixture',
      streams: [{ name: 'sessions', primary_key: ['id'] }],
    }), NOW);
}

async function seedConnection() {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    ownerSubjectId: 'owner_local',
    connectorId: CONNECTOR_ID,
    displayName: 'Version churn fixture',
    sourceKind: 'manual',
    sourceBindingKey: 'fixture',
    sourceBinding: { fixture: true },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function seedRetainedSizeProjection() {
  getDb()
    .prepare(
      `INSERT INTO retained_size_global(
         projection_key, current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count, dirty, computed_at, metadata_json
       ) VALUES ('global', 10, 20000, 0, 2, 20000, 0, 0, ?, ?)`,
    )
    .run(NOW, JSON.stringify({ state: 'fresh', rebuild_status: 'idle', stale_since: null, last_error: null }));
  getDb()
    .prepare(
      `INSERT INTO retained_size_stream(
         connector_instance_id, connector_id, stream,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count, dirty, computed_at
       ) VALUES (?, ?, 'sessions', 10, 20000, 0, 2, 20000, 0, 0, ?)`,
    )
    .run(CONNECTOR_INSTANCE_ID, CONNECTOR_ID, NOW);
}

test('record version churn classifier uses simple watch/high thresholds', () => {
  assert.deepEqual(
    classifyRecordVersionChurn({ currentRecordCount: 10, recordHistoryCount: 10 }),
    { riskLevel: 'normal', riskReasons: [], versionsPerRecord: 1 },
  );
  assert.deepEqual(
    classifyRecordVersionChurn({ currentRecordCount: 10, recordHistoryCount: 50 }),
    { riskLevel: 'watch', riskReasons: ['versions_per_record_ge_5'], versionsPerRecord: 5 },
  );
  assert.deepEqual(
    classifyRecordVersionChurn({ currentRecordCount: 2, recordHistoryCount: 20_000 }),
    {
      riskLevel: 'high',
      riskReasons: ['versions_per_record_ge_50', 'history_ge_10000_and_versions_per_record_ge_10'],
      versionsPerRecord: 10_000,
    },
  );
  assert.deepEqual(
    classifyRecordVersionChurn({ currentRecordCount: 2, recordHistoryCount: 20_000, recordKeyCount: 100 }),
    {
      riskLevel: 'high',
      riskReasons: ['versions_per_record_ge_50', 'history_ge_10000_and_versions_per_record_ge_10'],
      versionsPerRecord: 200,
    },
  );
});

test('record version stats envelope returns grouped projection rows without payloads', async () => {
  const envelope = await buildRecordVersionStatsEnvelope({
    risk: 'high',
  }, {
    connectorInstanceStore: null,
    getProjection: async () => ({ computed_at: NOW, dirty: false, metadata: { state: 'fresh' } }),
    listStreams: async () => [{
      connector_id: CONNECTOR_ID,
      connector_instance_id: CONNECTOR_INSTANCE_ID,
      stream: 'sessions',
      record_count: 2,
      record_history_count: 20_000,
      dirty: false,
      computed_at: NOW,
    }],
    listGroundTruthStreams: async () => [],
  });

  assert.equal(envelope.object, 'ref_record_version_stats');
  assert.equal(envelope.data.length, 1);
  assert.equal(envelope.data[0].risk_level, 'high');
  assert.equal(envelope.data[0].last_current_at, null);
  assert.equal(envelope.data[0].last_history_at, null);
  assert.equal(envelope.data[0].record_key_count, null);
  assert.equal(envelope.data[0].projection_authority, 'retained_size_projection');
  assert.equal(envelope.data[0].projection_missing, false);
  assert.equal('record_json' in envelope.data[0], false);
  assert.equal('record_changes' in envelope.data[0], false);
});

test('record version stats envelope surfaces ground-truth rows missing from the projection', async () => {
  const envelope = await buildRecordVersionStatsEnvelope({}, {
    connectorInstanceStore: null,
    getProjection: async () => ({ computed_at: NOW, dirty: false, metadata: { state: 'fresh' } }),
    listStreams: async () => [],
    listGroundTruthStreams: async () => [{
      connector_id: CONNECTOR_ID,
      connector_instance_id: CONNECTOR_INSTANCE_ID,
      stream: 'messages',
      current_record_count: 2,
      record_history_count: 50,
      record_key_count: 10,
      last_current_at: NOW,
      last_history_at: NOW,
    }],
  });

  assert.equal(envelope.data.length, 1);
  assert.equal(envelope.data[0].stream, 'messages');
  assert.equal(envelope.data[0].current_record_count, 2);
  assert.equal(envelope.data[0].record_history_count, 50);
  assert.equal(envelope.data[0].record_key_count, 10);
  assert.equal(envelope.data[0].versions_per_record, 5);
  assert.equal(envelope.data[0].projection_authority, 'record_changes_ground_truth');
  assert.equal(envelope.data[0].projection_missing, true);
  assert.equal(envelope.data[0].projection_dirty, false);
  assert.equal(envelope.data[0].risk_level, 'watch');
  assert.deepEqual(envelope.data[0].risk_reasons, ['versions_per_record_ge_5', 'projection_missing']);
});

test('record version stats envelope keeps normal-range projection-missing rows normal', async () => {
  const envelope = await buildRecordVersionStatsEnvelope({}, {
    connectorInstanceStore: null,
    getProjection: async () => ({ computed_at: NOW, dirty: false, metadata: { state: 'fresh' } }),
    listStreams: async () => [],
    listGroundTruthStreams: async () => [{
      connector_id: CONNECTOR_ID,
      connector_instance_id: CONNECTOR_INSTANCE_ID,
      stream: 'reactions',
      current_record_count: 100,
      record_history_count: 100,
      record_key_count: 100,
      last_current_at: NOW,
      last_history_at: NOW,
    }],
  });

  assert.equal(envelope.data.length, 1);
  assert.equal(envelope.data[0].stream, 'reactions');
  assert.equal(envelope.data[0].projection_missing, true);
  assert.equal(envelope.data[0].projection_authority, 'record_changes_ground_truth');
  assert.equal(envelope.data[0].risk_level, 'normal');
  assert.ok(envelope.data[0].risk_reasons.includes('projection_missing'));
});

test('record version stats envelope keeps normal-range projection-dirty rows normal', async () => {
  const envelope = await buildRecordVersionStatsEnvelope({}, {
    connectorInstanceStore: null,
    getProjection: async () => ({ computed_at: NOW, dirty: true, metadata: { state: 'rebuilding' } }),
    listStreams: async () => [{
      connector_id: CONNECTOR_ID,
      connector_instance_id: CONNECTOR_INSTANCE_ID,
      stream: 'sessions',
      record_count: 100,
      record_history_count: 100,
      dirty: true,
      computed_at: NOW,
    }],
    listGroundTruthStreams: async () => [],
  });

  assert.equal(envelope.data.length, 1);
  assert.equal(envelope.data[0].stream, 'sessions');
  assert.equal(envelope.data[0].projection_dirty, true);
  assert.equal(envelope.data[0].projection_missing, false);
  assert.equal(envelope.data[0].projection_authority, 'retained_size_projection');
  assert.equal(envelope.data[0].risk_level, 'normal');
  assert.ok(envelope.data[0].risk_reasons.includes('projection_dirty'));
});

test('record version stats risk filter excludes projection-only normal rows', async () => {
  const envelope = await buildRecordVersionStatsEnvelope({ risk: 'watch' }, {
    connectorInstanceStore: null,
    getProjection: async () => ({ computed_at: NOW, dirty: true, metadata: { state: 'rebuilding' } }),
    listStreams: async () => [{
      connector_id: CONNECTOR_ID,
      connector_instance_id: CONNECTOR_INSTANCE_ID,
      stream: 'repositories',
      record_count: 100,
      record_history_count: 111,
      dirty: true,
      computed_at: NOW,
    }],
    listGroundTruthStreams: async () => [],
  });

  assert.equal(envelope.data.length, 0);
  assert.equal(envelope.meta.total_matching, 0);
});

test('record version stats envelope keeps high risk when projection is also dirty', async () => {
  const envelope = await buildRecordVersionStatsEnvelope({}, {
    connectorInstanceStore: null,
    getProjection: async () => ({ computed_at: NOW, dirty: true, metadata: { state: 'rebuilding' } }),
    listStreams: async () => [{
      connector_id: CONNECTOR_ID,
      connector_instance_id: CONNECTOR_INSTANCE_ID,
      stream: 'sessions',
      record_count: 2,
      record_history_count: 20_000,
      dirty: true,
      computed_at: NOW,
    }],
    listGroundTruthStreams: async () => [],
  });

  assert.equal(envelope.data.length, 1);
  assert.equal(envelope.data[0].risk_level, 'high');
  assert.equal(envelope.data[0].projection_dirty, true);
  assert.ok(envelope.data[0].risk_reasons.includes('projection_dirty'));
});

test('record version stats envelope prefers ground-truth counts over stale projection counts', async () => {
  const envelope = await buildRecordVersionStatsEnvelope({}, {
    connectorInstanceStore: null,
    getProjection: async () => ({ computed_at: NOW, dirty: false, metadata: { state: 'fresh' } }),
    listStreams: async () => [{
      connector_id: CONNECTOR_ID,
      connector_instance_id: CONNECTOR_INSTANCE_ID,
      stream: 'threads',
      record_count: 9,
      record_history_count: 468_532,
      dirty: false,
      computed_at: NOW,
    }],
    listGroundTruthStreams: async () => [{
      connector_id: CONNECTOR_ID,
      connector_instance_id: CONNECTOR_INSTANCE_ID,
      stream: 'threads',
      current_record_count: 9,
      record_history_count: 3_155_820,
      record_key_count: 12_334,
      last_current_at: NOW,
      last_history_at: NOW,
    }],
  });

  assert.equal(envelope.data.length, 1);
  assert.equal(envelope.data[0].record_history_count, 3_155_820);
  assert.equal(envelope.data[0].record_key_count, 12_334);
  assert.equal(envelope.data[0].versions_per_record, 255.863);
  assert.equal(envelope.data[0].projection_authority, 'record_changes_ground_truth');
  assert.equal(envelope.data[0].projection_missing, false);
});

test('/_ref/records/version-stats reads projection-backed high-churn rows', async () => {
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:', ownerAuthPassword: '' });
  try {
    seedConnector();
    await seedConnection();
    seedRetainedSizeProjection();

    const { status, body } = await fetchJson(
      `http://localhost:${server.asPort}/_ref/records/version-stats?risk=high&limit=1`,
    );

    assert.equal(status, 200);
    assert.equal(body.object, 'ref_record_version_stats');
    assert.equal(body.meta.source, 'retained_size_projection_with_record_changes_ground_truth');
    assert.equal(body.meta.returned, 1);
    assert.equal(body.data[0].connector_instance_id, CONNECTOR_INSTANCE_ID);
    assert.equal(body.data[0].display_name, 'Version churn fixture');
    assert.equal(body.data[0].stream, 'sessions');
    assert.equal(body.data[0].risk_level, 'high');
    assert.equal(body.data[0].current_record_count, 2);
    assert.equal(body.data[0].record_history_count, 20_000);
  } finally {
    await closeServer(server);
  }
});
