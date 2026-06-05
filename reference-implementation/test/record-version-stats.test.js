import assert from 'node:assert/strict';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import {
  buildRecordVersionStatsEnvelope,
  classifyRecordVersionChurn,
  isVersionChurnCandidate,
  listRecordVersionGroundTruthForKeys,
  listRecordVersionGroundTruthStreams,
} from '../server/record-version-stats.js';
import { ingestRecord } from '../server/records.js';
import { rebuildRetainedSize } from '../server/retained-size-read-model.js';
import { startServer } from '../server/index.js';
import {
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from '../server/stores/connector-instance-store.js';
import { REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT } from '../server/version-disposition.js';

const CONNECTOR_ID = 'https://test.pdpp.dev/connectors/version-churn';
const CONNECTOR_INSTANCE_ID = 'cin_test_version_churn';
const NOW = '2026-05-26T12:00:00.000Z';

function oneMillisecondAfter(iso) {
  return new Date(new Date(iso).getTime() + 1).toISOString();
}

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
    listGroundTruthForKeys: async () => [],
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
  // A projection with NO stream row but ground-truth streams present is, by
  // definition, not fully built — its global row is dirty, which routes the
  // unfiltered request through the full-scan fallback (the candidate path keys
  // off projection rows and cannot scan a never-seen stream). This preserves the
  // projection-missing surfacing for the cold/rebuilding projection.
  const envelope = await buildRecordVersionStatsEnvelope({}, {
    connectorInstanceStore: null,
    getProjection: async () => ({ computed_at: NOW, dirty: true, metadata: { state: 'rebuilding' } }),
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
  // Same cold-projection situation (no stream row, ground truth present) → dirty
  // global → full-scan fallback.
  const envelope = await buildRecordVersionStatsEnvelope({}, {
    connectorInstanceStore: null,
    getProjection: async () => ({ computed_at: NOW, dirty: true, metadata: { state: 'rebuilding' } }),
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
    listGroundTruthForKeys: async () => [{
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

// Inject BOTH ground-truth seams so the unfiltered candidate path (which calls
// listGroundTruthForKeys, not listGroundTruthStreams) is driven by the test
// doubles rather than the real DB. The for-keys double returns the same rows
// filtered to the requested candidate keys, exactly as the bounded helper does.
function groundTruthForKeysFromRows(groundTruthRows) {
  return async ({ keys } = {}) => {
    const wanted = new Set((keys || []).map((k) => `${k.connectorInstanceId}\n${k.stream}`));
    return groundTruthRows.filter(
      (row) => wanted.has(`${row.connector_instance_id}\n${row.stream}`),
    );
  };
}

async function envelopeFor(streamRows, groundTruthRows = []) {
  return buildRecordVersionStatsEnvelope({}, {
    connectorInstanceStore: null,
    getProjection: async () => ({ computed_at: NOW, dirty: false, metadata: { state: 'fresh' } }),
    listStreams: async () => streamRows,
    listGroundTruthStreams: async () => groundTruthRows,
    listGroundTruthForKeys: groundTruthForKeysFromRows(groundTruthRows),
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

// Projection row mirroring a ground-truth row, so the unfiltered candidate path
// scans the stream (vpr-from-current >= watch → candidate) and the ground-truth
// last_history_at drives the disposition. Models the realistic production state:
// the stream HAS a projection row; ground truth refines its distinct/timestamp
// facts.
function projectionRowFor(gt) {
  return {
    connector_id: gt.connector_id,
    connector_instance_id: gt.connector_instance_id,
    stream: gt.stream,
    record_count: gt.current_record_count,
    record_history_count: gt.record_history_count,
    dirty: false,
    computed_at: NOW,
  };
}

test('AC-4: reviewed residue re-alarms to lossless_compaction_candidate after the review timestamp', async () => {
  const reviewedAt = REVIEWED_COMPACTION_RESIDUE_REVIEWED_AT.get('usaa/accounts');
  assert.ok(reviewedAt);
  // Within window → reviewed_historical_residue.
  const withinGt = {
    connector_id: 'usaa',
    connector_instance_id: 'cin_usaa',
    stream: 'accounts',
    current_record_count: 4,
    record_history_count: 80,
    record_key_count: 4,
    last_current_at: NOW,
    last_history_at: reviewedAt,
  };
  const within = await envelopeFor([projectionRowFor(withinGt)], [withinGt]);
  assert.equal(within.data[0].version_disposition, 'reviewed_historical_residue');

  // After window → re-alarm.
  const afterGt = {
    connector_id: 'usaa',
    connector_instance_id: 'cin_usaa',
    stream: 'accounts',
    current_record_count: 4,
    record_history_count: 80,
    record_key_count: 4,
    last_current_at: NOW,
    last_history_at: oneMillisecondAfter(reviewedAt),
  };
  const after = await envelopeFor([projectionRowFor(afterGt)], [afterGt]);
  assert.equal(after.data[0].version_disposition, 'lossless_compaction_candidate');
});

test('AC-5: sessions classify recurring_point_in_time_snapshot and do not re-alarm on growth', async () => {
  for (const connector_id of ['claude-code', 'codex', 'local-device:claude-code']) {
    const gt = {
      connector_id,
      connector_instance_id: 'cin_sessions',
      stream: 'sessions',
      current_record_count: 60,
      record_history_count: 600,
      record_key_count: 60,
      last_current_at: NOW,
      // Far in the future relative to any prior review timestamp.
      last_history_at: '2027-01-01T00:00:00.000Z',
    };
    const grown = await envelopeFor([projectionRowFor(gt)], [gt]);
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

// ─── projection-backed hot path (serve-version-stats-from-projection) ─────────
//
// These tests use a REAL in-memory DB and real ingest so the candidate-narrowing
// path is exercised end-to-end against canonical state, then assert it produces
// the SAME rows the unbounded full scan would.

const GT_CONNECTOR = 'https://test.pdpp.dev/connectors/vstats-hotpath';
const GT_INSTANCE = makeDefaultAccountConnectorInstanceId('owner_local', GT_CONNECTOR);

function ingestUpsert(stream, id, payload, emittedAt) {
  return ingestRecord(GT_CONNECTOR, {
    stream,
    key: id,
    data: { id, ...payload },
    emitted_at: emittedAt,
    op: 'upsert',
  });
}

// Build a corpus with a deliberate spread of churn shapes:
//   - high-churn stream `hot`: 1 key, many versions (vpr huge → candidate)
//   - normal stream `cold`: many keys, 1 version each (vpr 1 → NOT a candidate)
async function seedHotpathCorpus() {
  // hot: one key churned 30 times → 30 history versions, 1 current, 1 distinct key.
  for (let v = 1; v <= 30; v += 1) {
    await ingestUpsert('hot', 'h1', { v }, `2026-05-01T00:00:${String(v).padStart(2, '0')}.000Z`);
  }
  // cold: 12 distinct keys, one version each → 12 history, 12 current, vpr 1.
  for (let i = 0; i < 12; i += 1) {
    await ingestUpsert('cold', `c${i}`, { i }, `2026-05-02T00:00:${String(i).padStart(2, '0')}.000Z`);
  }
  await rebuildRetainedSize();
}

function streamRow(rows, stream) {
  return rows.find((r) => r.stream === stream);
}

test('projection record_history_count is exact and clean after ingest+rebuild', async () => {
  initDb();
  try {
    await seedHotpathCorpus();
    // Ground truth straight from record_changes.
    const gt = await listRecordVersionGroundTruthStreams({});
    const hotGt = streamRow(gt, 'hot');
    assert.equal(hotGt.record_history_count, 30);
    assert.equal(hotGt.record_key_count, 1);
    assert.equal(hotGt.current_record_count, 1);

    // Projection row for the same stream matches and is clean.
    const proj = getDb()
      .prepare(
        `SELECT record_history_count, record_count, dirty
           FROM retained_size_stream
          WHERE connector_instance_id = ? AND stream = 'hot'`,
      )
      .get(GT_INSTANCE);
    assert.equal(Number(proj.record_history_count), 30, 'projection history count is exact');
    assert.equal(Number(proj.record_count), 1, 'projection current count is exact');
    assert.equal(Number(proj.dirty), 0, 'clean projection row carries dirty = 0');
  } finally {
    closeDb();
  }
});

test('candidate predicate selects hot churn and rejects flat streams', () => {
  // hot: 30 history / 1 current → candidate.
  assert.equal(
    isVersionChurnCandidate({ dirty: false, currentRecordCount: 1, recordHistoryCount: 30 }),
    true,
  );
  // cold: 12 history / 12 current → vpr 1 → NOT a candidate.
  assert.equal(
    isVersionChurnCandidate({ dirty: false, currentRecordCount: 12, recordHistoryCount: 12 }),
    false,
  );
  // dirty always wins regardless of apparent risk.
  assert.equal(
    isVersionChurnCandidate({ dirty: true, currentRecordCount: 12, recordHistoryCount: 12 }),
    true,
  );
  // Large flat streams with history >= 10k are NOT candidates when the
  // projection proves history/current is below the watch lower bound. The
  // high-history classifier arm also requires vpr >= 10, so the watch bound
  // safely covers it.
  assert.equal(
    isVersionChurnCandidate({ dirty: false, currentRecordCount: 9_000, recordHistoryCount: 10_000 }),
    false,
  );
  // High-history + high-ratio streams remain candidates.
  assert.equal(
    isVersionChurnCandidate({ dirty: false, currentRecordCount: 1_000, recordHistoryCount: 10_000 }),
    true,
  );
  // current == 0 with history → candidate (history_without_current_records).
  assert.equal(
    isVersionChurnCandidate({ dirty: false, currentRecordCount: 0, recordHistoryCount: 3 }),
    true,
  );
});

test('bounded for-keys helper returns facts identical to the full scan', async () => {
  initDb();
  try {
    await seedHotpathCorpus();
    const full = await listRecordVersionGroundTruthStreams({});
    const fullHot = streamRow(full, 'hot');
    const bounded = await listRecordVersionGroundTruthForKeys({
      keys: [{ connectorInstanceId: GT_INSTANCE, stream: 'hot' }],
    });
    assert.equal(bounded.length, 1, 'bounded helper returns only the requested key');
    assert.deepEqual(bounded[0], fullHot, 'bounded facts byte-identical to full-scan facts');
  } finally {
    closeDb();
  }
});

test('unfiltered envelope candidate path equals the full-scan envelope', async () => {
  initDb();
  try {
    await seedHotpathCorpus();
    // Candidate path (production default): listGroundTruthForKeys is the bounded
    // helper; the clean global projection enables narrowing.
    const candidate = await buildRecordVersionStatsEnvelope({});
    // Force the full-scan path by pretending the global projection is dirty.
    const fullScan = await buildRecordVersionStatsEnvelope(
      {},
      { getProjection: async () => ({ computed_at: NOW, dirty: true, metadata: { state: 'rebuilding' } }) },
    );

    // Both surface the hot stream with identical ground-truth facts.
    const candHot = streamRow(candidate.data, 'hot');
    const fullHot = streamRow(fullScan.data, 'hot');
    assert.ok(candHot, 'candidate path surfaces the hot stream');
    assert.deepEqual(
      {
        record_history_count: candHot.record_history_count,
        record_key_count: candHot.record_key_count,
        last_history_at: candHot.last_history_at,
        versions_per_record: candHot.versions_per_record,
        risk_level: candHot.risk_level,
        risk_reasons: candHot.risk_reasons,
        version_disposition: candHot.version_disposition,
        projection_authority: candHot.projection_authority,
      },
      {
        record_history_count: fullHot.record_history_count,
        record_key_count: fullHot.record_key_count,
        last_history_at: fullHot.last_history_at,
        versions_per_record: fullHot.versions_per_record,
        risk_level: fullHot.risk_level,
        risk_reasons: fullHot.risk_reasons,
        version_disposition: fullHot.version_disposition,
        projection_authority: fullHot.projection_authority,
      },
      'candidate-path hot row is identical to the full-scan hot row',
    );
    // The hot stream is high churn under both paths.
    assert.equal(candHot.record_history_count, 30);
    assert.equal(candHot.record_key_count, 1);
    assert.equal(candHot.versions_per_record, 30);

    // The cold (normal) stream is classified WITHOUT a ground-truth scan on the
    // candidate path: it keeps projection authority and null distinct/timestamp.
    const candCold = streamRow(candidate.data, 'cold');
    assert.ok(candCold, 'candidate path still lists the cold stream from the projection');
    assert.equal(candCold.risk_level, 'normal');
    assert.equal(candCold.projection_authority, 'retained_size_projection');
    assert.equal(candCold.record_key_count, null);
    assert.equal(candCold.last_history_at, null);
  } finally {
    closeDb();
  }
});

test('a dirty projection row is verified against ground truth even when it looks normal', async () => {
  initDb();
  try {
    await seedHotpathCorpus();
    // Corrupt the hot projection row to look NORMAL (history == current) but mark
    // it dirty — the candidate predicate must still scan it via ground truth and
    // recover the real high-churn facts.
    getDb()
      .prepare(
        `UPDATE retained_size_stream
            SET record_history_count = 1, record_count = 1, dirty = 1
          WHERE connector_instance_id = ? AND stream = 'hot'`,
      )
      .run(GT_INSTANCE);

    const envelope = await buildRecordVersionStatsEnvelope({});
    const hot = streamRow(envelope.data, 'hot');
    assert.ok(hot, 'dirty hot row is still surfaced');
    assert.equal(hot.record_history_count, 30, 'ground truth recovered despite stale projection count');
    assert.equal(hot.record_key_count, 1);
    assert.equal(hot.projection_authority, 'record_changes_ground_truth');
    assert.equal(hot.projection_dirty, true);
  } finally {
    closeDb();
  }
});

test('dirty global projection forces the full scan for the unfiltered request', async () => {
  initDb();
  try {
    await seedHotpathCorpus();
    // Mark the global row dirty: the candidate path must NOT be taken; the full
    // scan covers every stream including any the projection lacked.
    getDb().prepare(`UPDATE retained_size_global SET dirty = 1 WHERE projection_key = 'global'`).run();

    let forKeysCalled = false;
    const envelope = await buildRecordVersionStatsEnvelope(
      {},
      {
        listGroundTruthForKeys: async () => {
          forKeysCalled = true;
          return [];
        },
      },
    );
    assert.equal(forKeysCalled, false, 'dirty global must bypass the bounded for-keys helper');
    const hot = streamRow(envelope.data, 'hot');
    assert.equal(hot.record_history_count, 30, 'full scan still produces correct hot facts');
    assert.equal(hot.projection_authority, 'record_changes_ground_truth');
  } finally {
    closeDb();
  }
});
