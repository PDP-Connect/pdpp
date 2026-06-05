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

// ─── version_disposition derivation (OpenSpec add-version-disposition-…) ─────

function dispositionRow(overrides = {}) {
  return {
    connector_id: overrides.connector_id ?? 'github',
    connector_instance_id: overrides.connector_instance_id ?? 'cin_disp',
    stream: overrides.stream ?? 'user',
    record_count: overrides.record_count ?? 2,
    record_history_count: overrides.record_history_count ?? 20_000,
    dirty: false,
    computed_at: NOW,
  };
}

async function envelopeFor(streamRows, groundTruthRows = []) {
  return buildRecordVersionStatsEnvelope({}, {
    connectorInstanceStore: null,
    getProjection: async () => ({ computed_at: NOW, dirty: false, metadata: { state: 'fresh' } }),
    listStreams: async () => streamRows,
    listGroundTruthStreams: async () => groundTruthRows,
  });
}

test('AC-1: every version-stats row carries a version_disposition enum value', async () => {
  const envelope = await envelopeFor([
    dispositionRow({ connector_id: 'github', stream: 'user', connector_instance_id: 'cin_gh' }),
    dispositionRow({ connector_id: 'gmail', stream: 'labels', connector_instance_id: 'cin_gm' }),
    dispositionRow({ connector_id: 'mystery', stream: 'widgets', connector_instance_id: 'cin_my' }),
  ]);
  const allowed = new Set([
    'active_defect_or_unclassified',
    'reviewed_historical_residue',
    'point_in_time_retained_history',
    'lossless_compaction_candidate',
    'recurring_point_in_time_snapshot',
  ]);
  assert.equal(envelope.data.length, 3);
  for (const row of envelope.data) {
    assert.ok('version_disposition' in row, 'each row must carry version_disposition');
    assert.ok(allowed.has(row.version_disposition), `unexpected disposition ${row.version_disposition}`);
  }
  // No payloads leak alongside the new field.
  for (const row of envelope.data) {
    assert.equal('record_json' in row, false);
    assert.equal('record_changes' in row, false);
  }
});

test('AC-2: disposition does not change risk_thresholds and the meta asserts independence', async () => {
  const envelope = await envelopeFor([dispositionRow()]);
  // Byte-identical thresholds to the documented contract.
  assert.deepEqual(envelope.meta.risk_thresholds, {
    watch_versions_per_record: 5,
    high_versions_per_record: 50,
    high_history_count: 10_000,
    high_history_versions_per_record: 10,
  });
  assert.equal(envelope.meta.disposition_affects_thresholds, false);
  // risk_level/risk_reasons computed exactly as the numeric classifier would,
  // independent of the derived disposition.
  const row = envelope.data[0];
  const numeric = classifyRecordVersionChurn({ currentRecordCount: 2, recordHistoryCount: 20_000 });
  assert.equal(row.risk_level, numeric.riskLevel);
  assert.deepEqual(row.risk_reasons, numeric.riskReasons);
});

test('AC-3: an unknown high/watch stream classifies active_defect_or_unclassified', async () => {
  const envelope = await envelopeFor([dispositionRow({ connector_id: 'mystery', stream: 'widgets' })]);
  assert.equal(envelope.data[0].version_disposition, 'active_defect_or_unclassified');
});

test('AC-4: reviewed residue re-alarms to lossless_compaction_candidate after the review timestamp', async () => {
  // Within window → reviewed_historical_residue.
  const within = await envelopeFor([], [{
    connector_id: 'usaa',
    connector_instance_id: 'cin_usaa',
    stream: 'accounts',
    current_record_count: 4,
    record_history_count: 80,
    record_key_count: 4,
    last_current_at: NOW,
    last_history_at: '2026-06-03T12:00:00.000Z',
  }]);
  assert.equal(within.data[0].version_disposition, 'reviewed_historical_residue');

  // After window → re-alarm.
  const after = await envelopeFor([], [{
    connector_id: 'usaa',
    connector_instance_id: 'cin_usaa',
    stream: 'accounts',
    current_record_count: 4,
    record_history_count: 80,
    record_key_count: 4,
    last_current_at: NOW,
    last_history_at: '2026-06-03T19:19:53.634Z',
  }]);
  assert.equal(after.data[0].version_disposition, 'lossless_compaction_candidate');
});

test('AC-5: sessions classify recurring_point_in_time_snapshot and do not re-alarm on growth', async () => {
  for (const connector_id of ['claude-code', 'codex', 'local-device:claude-code']) {
    const grown = await envelopeFor([], [{
      connector_id,
      connector_instance_id: 'cin_sessions',
      stream: 'sessions',
      current_record_count: 60,
      record_history_count: 600,
      record_key_count: 60,
      last_current_at: NOW,
      // Far in the future relative to any prior review timestamp.
      last_history_at: '2027-01-01T00:00:00.000Z',
    }]);
    assert.equal(
      grown.data[0].version_disposition,
      'recurring_point_in_time_snapshot',
      `${connector_id}/sessions must stay #5 even after history grows`,
    );
  }
});

test('AC-6: split residual entity streams classify point_in_time_retained_history (no compaction offered)', async () => {
  for (const [connector_id, stream] of [['github', 'user'], ['slack', 'channels'], ['ynab', 'accounts']]) {
    const envelope = await envelopeFor([dispositionRow({ connector_id, stream, connector_instance_id: `cin_${connector_id}` })]);
    assert.equal(
      envelope.data[0].version_disposition,
      'point_in_time_retained_history',
      `${connector_id}/${stream} must be point_in_time_retained_history`,
    );
  }
});

test('AC-7: a connector-authored field in the source row cannot alter version_disposition', async () => {
  // The stream row carries a hostile self-declared disposition; the server must
  // ignore it and derive from reference signals only (unknown stream → #1).
  const envelope = await envelopeFor([{
    ...dispositionRow({ connector_id: 'mystery', stream: 'widgets' }),
    version_disposition: 'point_in_time_retained_history',
    semantics: 'append',
  }]);
  assert.equal(envelope.data[0].version_disposition, 'active_defect_or_unclassified');
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
