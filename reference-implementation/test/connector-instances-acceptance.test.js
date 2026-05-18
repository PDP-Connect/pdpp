import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { registerConnector } from '../server/auth.js';
import { closeDb, getDb, initDb } from '../server/db.js';
import { getSyncState, ingestRecord, queryRecords } from '../server/records.js';
import { createSqliteBlobStore } from '../server/stores/blob-store.js';
import { createSqliteBrowserSurfaceLeaseStore } from '../server/stores/browser-surface-lease-store.ts';
import { createSqliteConnectorInstanceStore, makeLegacyConnectorInstanceId } from '../server/stores/connector-instance-store.js';
import { createSqliteConnectorStateStore } from '../server/stores/connector-state-store.ts';
import { createSqliteDeviceExporterStore } from '../server/stores/device-exporter-store.js';
import { createSqliteSchedulerStore } from '../server/stores/scheduler-store.ts';

const NOW = '2026-05-18T12:00:00.000Z';
const GMAIL = 'https://test.pdpp.org/connectors/gmail-acceptance';
const LOCAL = 'https://test.pdpp.org/connectors/local-collector-acceptance';

function manifest(connectorId, stream = 'messages') {
  return {
    protocol_version: '0.1.0',
    connector_id: connectorId,
    version: '1.0.0',
    display_name: connectorId,
    runtime_requirements: { bindings: { network: { required: true } } },
    streams: [
      {
        name: stream,
        semantics: 'mutable_state',
        schema: {
          type: 'object',
          required: ['id', 'subject'],
          properties: {
            id: { type: 'string' },
            subject: { type: 'string' },
          },
        },
        primary_key: ['id'],
      },
    ],
  };
}

async function withDb(fn) {
  initDb();
  try {
    await registerConnector(manifest(GMAIL));
    await registerConnector(manifest(LOCAL, 'events'));
    await fn();
  } finally {
    closeDb();
  }
}

function recordTarget(connectorId, connectorInstanceId) {
  return { connector_id: connectorId, connector_instance_id: connectorInstanceId };
}

function stateTarget(connectorId, connectorInstanceId) {
  return { connectorId, connectorInstanceId };
}

function record(subject, key = 'same-key') {
  return {
    stream: 'messages',
    key,
    data: { id: key, subject },
    emitted_at: NOW,
  };
}

test('legacy connector-keyed stores migrate to one deterministic instance per owner and connector without data loss', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdpp-instance-acceptance-'));
  const dbPath = join(dir, 'reference.sqlite');
  const legacyInstanceId = makeLegacyConnectorInstanceId('owner_local', GMAIL);

  try {
    initDb(dbPath);
    await registerConnector(manifest(GMAIL));
    const db = getDb();
    db.exec(`
      DROP TABLE connector_state;
      CREATE TABLE connector_state (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(connector_id, stream)
      );
      DROP TABLE grant_connector_state;
      CREATE TABLE grant_connector_state (
        grant_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(grant_id, connector_id, stream)
      );
      DROP TABLE records;
      CREATE TABLE records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        record_json TEXT NOT NULL,
        emitted_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        deleted INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        UNIQUE(connector_id, stream, record_key)
      );
      DROP TABLE record_changes;
      CREATE TABLE record_changes (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        version INTEGER NOT NULL,
        record_json TEXT,
        emitted_at TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        deleted_at TEXT,
        PRIMARY KEY(connector_id, stream, version)
      );
      DROP TABLE version_counter;
      CREATE TABLE version_counter (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        max_version INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(connector_id, stream)
      );
      DROP TABLE blob_bindings;
      DROP TABLE blobs;
      CREATE TABLE blobs (
        blob_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        data BLOB
      );
      CREATE TABLE blob_bindings (
        blob_id TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        record_key TEXT NOT NULL,
        json_path TEXT NOT NULL DEFAULT '@record',
        PRIMARY KEY(blob_id, connector_id, stream, record_key, json_path)
      );
      DROP TABLE connector_schedules;
      CREATE TABLE connector_schedules (
        connector_id TEXT PRIMARY KEY,
        interval_seconds INTEGER NOT NULL,
        jitter_seconds INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      DROP TABLE controller_active_runs;
      CREATE TABLE controller_active_runs (
        connector_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        trace_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        started_at TEXT NOT NULL
      );
      DROP TABLE scheduler_run_history;
      CREATE TABLE scheduler_run_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        connector_id TEXT NOT NULL,
        source_json TEXT NOT NULL,
        status TEXT NOT NULL,
        records_emitted INTEGER NOT NULL DEFAULT 0,
        reported_records_emitted INTEGER,
        checkpoint_summary_json TEXT,
        known_gaps_json TEXT NOT NULL DEFAULT '[]',
        connector_error_json TEXT,
        run_id TEXT,
        trace_id TEXT,
        failure_reason TEXT,
        terminal_reason TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        error TEXT,
        attempt INTEGER NOT NULL
      );
      DROP TABLE scheduler_last_run_times;
      CREATE TABLE scheduler_last_run_times (
        connector_id TEXT PRIMARY KEY,
        last_run_time_ms INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      DROP TABLE connector_detail_gaps;
      CREATE TABLE connector_detail_gaps (
        gap_id TEXT PRIMARY KEY,
        connector_id TEXT NOT NULL,
        grant_id TEXT,
        source_json TEXT NOT NULL,
        stream TEXT NOT NULL,
        parent_stream TEXT,
        record_key TEXT,
        detail_locator_json TEXT,
        list_cursor_json TEXT,
        scope_json TEXT,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_at TEXT,
        next_attempt_after TEXT,
        last_error_json TEXT,
        discovered_run_id TEXT,
        last_run_id TEXT,
        recovered_run_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (status IN ('pending', 'in_progress', 'recovered', 'terminal'))
      );
      CREATE UNIQUE INDEX uniq_connector_detail_gaps_identity
        ON connector_detail_gaps(connector_id, ifnull(grant_id, ''), stream, ifnull(parent_stream, ''), ifnull(record_key, ''), ifnull(detail_locator_json, ''));
      CREATE INDEX idx_connector_detail_gaps_pending
        ON connector_detail_gaps(connector_id, grant_id, status, stream, next_attempt_after);
      DROP TABLE lexical_search_index;
      CREATE VIRTUAL TABLE lexical_search_index USING fts5(
        connector_id UNINDEXED,
        stream UNINDEXED,
        record_key UNINDEXED,
        field UNINDEXED,
        text,
        tokenize = 'unicode61'
      );
      DROP TABLE lexical_search_meta;
      CREATE TABLE lexical_search_meta (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        fields_fingerprint TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(connector_id, stream)
      );
      DROP TABLE semantic_search_rowid;
      CREATE TABLE semantic_search_rowid (
        connector_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        record_key TEXT NOT NULL,
        rowid INTEGER NOT NULL,
        PRIMARY KEY(connector_id, scope_key, record_key)
      );
      DROP TABLE semantic_search_blob;
      CREATE TABLE semantic_search_blob (
        connector_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        record_key TEXT NOT NULL,
        embedding BLOB NOT NULL,
        PRIMARY KEY(connector_id, scope_key, record_key)
      );
      DROP TABLE semantic_search_meta;
      CREATE TABLE semantic_search_meta (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        fields_fingerprint TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        distance_metric TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(connector_id, stream)
      );
      DROP TABLE semantic_search_backfill_progress;
      CREATE TABLE semantic_search_backfill_progress (
        connector_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        fields_fingerprint TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        distance_metric TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY(connector_id, stream)
      );
    `);
    db.prepare('INSERT INTO connector_state VALUES(?, ?, ?, ?)').run(GMAIL, 'messages', '{"cursor":"owner"}', NOW);
    db.prepare('INSERT INTO grant_connector_state VALUES(?, ?, ?, ?, ?)').run('grant_1', GMAIL, 'messages', '{"cursor":"grant"}', NOW);
    db.prepare('INSERT INTO records(connector_id, stream, record_key, record_json, emitted_at, version) VALUES(?, ?, ?, ?, ?, ?)').run(GMAIL, 'messages', 'msg_1', '{"id":"msg_1","subject":"legacy"}', NOW, 7);
    db.prepare('INSERT INTO record_changes(connector_id, stream, record_key, version, record_json, emitted_at) VALUES(?, ?, ?, ?, ?, ?)').run(GMAIL, 'messages', 'msg_1', 7, '{"id":"msg_1","subject":"legacy"}', NOW);
    db.prepare('INSERT INTO version_counter VALUES(?, ?, ?)').run(GMAIL, 'messages', 7);
    db.prepare('INSERT INTO blobs(blob_id, connector_id, stream, record_key, mime_type, size_bytes, sha256, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run('blob_sha256_acceptance', GMAIL, 'messages', 'msg_1', 'text/plain', 5, 'acceptance-sha', Buffer.from('hello'));
    db.prepare('INSERT INTO blob_bindings VALUES(?, ?, ?, ?, ?)').run('blob_sha256_acceptance', GMAIL, 'messages', 'msg_1', '/body');
    db.prepare('INSERT INTO connector_schedules VALUES(?, ?, ?, ?, ?, ?)').run(GMAIL, 900, 10, 1, NOW, NOW);
    db.prepare('INSERT INTO controller_active_runs VALUES(?, ?, ?, ?, ?)').run(GMAIL, 'run_legacy', 'trc_legacy', 'scn_legacy', NOW);
    db.prepare('INSERT INTO scheduler_run_history(connector_id, source_json, status, records_emitted, known_gaps_json, run_id, trace_id, started_at, completed_at, attempt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(GMAIL, '{}', 'succeeded', 1, '[]', 'run_history', 'trc_history', NOW, NOW, 1);
    db.prepare('INSERT INTO scheduler_last_run_times VALUES(?, ?, ?)').run(GMAIL, 1_779_120_000_000, NOW);
    db.prepare('INSERT INTO connector_detail_gaps(gap_id, connector_id, grant_id, source_json, stream, record_key, detail_locator_json, reason, status, attempt_count, discovered_run_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      'gap_legacy',
      GMAIL,
      'grant_1',
      '{"connector_id":"https://test.pdpp.org/connectors/gmail-acceptance"}',
      'messages',
      'msg_1',
      '{"path":"/thread"}',
      'detail unavailable',
      'pending',
      2,
      'run_legacy',
      NOW,
      NOW,
    );
    db.prepare('INSERT INTO lexical_search_index(connector_id, stream, record_key, field, text) VALUES(?, ?, ?, ?, ?)').run(GMAIL, 'messages', 'msg_1', 'subject', 'legacy lexical subject');
    db.prepare('INSERT INTO lexical_search_meta(connector_id, stream, fields_fingerprint, updated_at) VALUES(?, ?, ?, ?)').run(GMAIL, 'messages', 'lexical-fingerprint', NOW);
    db.prepare('INSERT INTO semantic_search_rowid(connector_id, scope_key, record_key, rowid) VALUES(?, ?, ?, ?)').run(GMAIL, '["messages","subject"]', 'msg_1', 42);
    db.prepare('INSERT INTO semantic_search_blob(connector_id, scope_key, record_key, embedding) VALUES(?, ?, ?, ?)').run(GMAIL, '["messages","subject"]', 'msg_1', Buffer.from(new Float32Array([0.1, 0.2]).buffer));
    db.prepare('INSERT INTO semantic_search_meta(connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run(GMAIL, 'messages', 'semantic-fingerprint', 'test-embedding', 2, 'cosine', NOW);
    db.prepare('INSERT INTO semantic_search_backfill_progress(connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)').run(GMAIL, 'messages', 'semantic-progress', 'test-embedding', 2, 'cosine', NOW);
    closeDb();

    initDb(dbPath);
    const legacyState = await getSyncState(GMAIL);
    assert.equal(legacyState.connector_id, GMAIL);
    assert.equal(legacyState.connector_instance_id, legacyInstanceId);
    assert.deepEqual(legacyState.state, { messages: { cursor: 'owner' } });
    assert.equal(
      getDb().prepare('SELECT connector_instance_id FROM grant_connector_state WHERE grant_id = ?').get('grant_1').connector_instance_id,
      legacyInstanceId,
    );
    assert.equal(getDb().prepare('SELECT connector_instance_id FROM records WHERE record_key = ?').get('msg_1').connector_instance_id, legacyInstanceId);
    assert.equal(getDb().prepare('SELECT connector_instance_id FROM record_changes WHERE record_key = ?').get('msg_1').connector_instance_id, legacyInstanceId);
    assert.equal(getDb().prepare('SELECT max_version FROM version_counter WHERE connector_instance_id = ?').get(legacyInstanceId).max_version, 7);
    assert.deepEqual(createSqliteBlobStore().listBlobBindings('blob_sha256_acceptance')
      .filter((row) => row.connector_instance_id)
      .map((row) => ({ connector_id: row.connector_id, stream: row.stream, record_key: row.record_key })), [
      { connector_id: GMAIL, stream: 'messages', record_key: 'msg_1' },
    ]);

    const scheduler = createSqliteSchedulerStore();
    assert.equal(scheduler.getSchedule(legacyInstanceId).interval_seconds, 900);
    assert.equal(scheduler.listActiveRuns()[0].connector_instance_id, legacyInstanceId);
    assert.equal(scheduler.listRunHistory(10)[0].connectorInstanceId, legacyInstanceId);
    assert.equal(scheduler.listLastRunTimes()[0].connector_instance_id, legacyInstanceId);
    assert.equal(getDb().prepare('SELECT connector_instance_id FROM connector_detail_gaps WHERE gap_id = ?').get('gap_legacy').connector_instance_id, legacyInstanceId);
    assert.deepEqual(
      getDb().prepare('SELECT connector_instance_id, stream, record_key, field, text FROM lexical_search_index WHERE connector_id = ?').all(GMAIL),
      [{ connector_instance_id: legacyInstanceId, stream: 'messages', record_key: 'msg_1', field: 'subject', text: 'legacy lexical subject' }],
    );
    assert.equal(getDb().prepare('SELECT connector_instance_id FROM lexical_search_meta WHERE connector_id = ? AND stream = ?').get(GMAIL, 'messages').connector_instance_id, legacyInstanceId);
    assert.equal(getDb().prepare('SELECT connector_instance_id FROM semantic_search_rowid WHERE connector_id = ?').get(GMAIL).connector_instance_id, legacyInstanceId);
    assert.equal(getDb().prepare('SELECT connector_instance_id FROM semantic_search_blob WHERE connector_id = ?').get(GMAIL).connector_instance_id, legacyInstanceId);
    assert.equal(getDb().prepare('SELECT connector_instance_id FROM semantic_search_meta WHERE connector_id = ? AND stream = ?').get(GMAIL, 'messages').connector_instance_id, legacyInstanceId);
    assert.equal(getDb().prepare('SELECT connector_instance_id FROM semantic_search_backfill_progress WHERE connector_id = ? AND stream = ?').get(GMAIL, 'messages').connector_instance_id, legacyInstanceId);
  } finally {
    closeDb();
    await rm(dir, { recursive: true, force: true });
  }
});

test('two Gmail account instances isolate state, records, schedules, leases, and diagnostics', async () => {
  await withDb(async () => {
    const instances = createSqliteConnectorInstanceStore();
    await instances.upsert({
      connectorInstanceId: 'cin_gmail_work_acceptance',
      ownerSubjectId: 'owner_local',
      connectorId: GMAIL,
      displayName: 'Gmail - work',
      sourceKind: 'account',
      sourceBindingKey: 'work',
      sourceBinding: { account_hint: 'work@example.test' },
      createdAt: NOW,
      updatedAt: NOW,
    });
    await instances.upsert({
      connectorInstanceId: 'cin_gmail_personal_acceptance',
      ownerSubjectId: 'owner_local',
      connectorId: GMAIL,
      displayName: 'Gmail - personal',
      sourceKind: 'account',
      sourceBindingKey: 'personal',
      sourceBinding: { account_hint: 'personal@example.test' },
      createdAt: NOW,
      updatedAt: NOW,
    });

    const state = createSqliteConnectorStateStore();
    await state.putState(stateTarget(GMAIL, 'cin_gmail_work_acceptance'), { messages: { cursor: 'work' } });
    await state.putState(stateTarget(GMAIL, 'cin_gmail_personal_acceptance'), { messages: { cursor: 'personal' } });
    await ingestRecord(recordTarget(GMAIL, 'cin_gmail_work_acceptance'), record('work'));
    await ingestRecord(recordTarget(GMAIL, 'cin_gmail_personal_acceptance'), record('personal'));

    const scheduler = createSqliteSchedulerStore();
    scheduler.createSchedule({ connector_instance_id: 'cin_gmail_work_acceptance', connector_id: GMAIL, interval_seconds: 600, jitter_seconds: 0, enabled: true, created_at: NOW, updated_at: NOW });
    scheduler.createSchedule({ connector_instance_id: 'cin_gmail_personal_acceptance', connector_id: GMAIL, interval_seconds: 1800, jitter_seconds: 0, enabled: false, created_at: NOW, updated_at: NOW });
    scheduler.upsertActiveRun({ connector_instance_id: 'cin_gmail_work_acceptance', connector_id: GMAIL, run_id: 'run_work_acceptance', trace_id: 'trc_work', scenario_id: 'scn_work', started_at: NOW });
    scheduler.upsertActiveRun({ connector_instance_id: 'cin_gmail_personal_acceptance', connector_id: GMAIL, run_id: 'run_personal_acceptance', trace_id: 'trc_personal', scenario_id: 'scn_personal', started_at: NOW });

    const leases = createSqliteBrowserSurfaceLeaseStore();
    await leases.upsertLease({ lease_id: 'lease_work', connector_id: GMAIL, profile_key: 'cin_gmail_work_acceptance', account_key: 'work@example.test', run_id: 'run_work_acceptance', status: 'waiting_for_browser_surface', priority_class: 'scheduled_refresh', requested_at: NOW, expires_at: '2026-05-18T12:05:00.000Z', fencing_token: 1 });
    await leases.upsertLease({ lease_id: 'lease_personal', connector_id: GMAIL, profile_key: 'cin_gmail_personal_acceptance', account_key: 'personal@example.test', run_id: 'run_personal_acceptance', status: 'waiting_for_browser_surface', priority_class: 'scheduled_refresh', requested_at: NOW, expires_at: '2026-05-18T12:05:01.000Z', fencing_token: 1 });

    getDb().prepare('INSERT INTO spine_events(event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id, actor_type, actor_id, object_type, object_id, status, run_id, source_kind, source_id, data_json, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('evt_work_diag', 'connector.run.failed', NOW, NOW, 'scn_work', 'trc_work', 'system', 'runtime', 'connector_run', 'run_work_acceptance', 'failed', 'run_work_acceptance', 'connector', 'cin_gmail_work_acceptance', '{"connector_diagnostics":{"stderr_tail":{"text":"work failure"}}}', '0.1');
    getDb().prepare('INSERT INTO spine_events(event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id, actor_type, actor_id, object_type, object_id, status, run_id, source_kind, source_id, data_json, version) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('evt_personal_diag', 'connector.run.failed', NOW, NOW, 'scn_personal', 'trc_personal', 'system', 'runtime', 'connector_run', 'run_personal_acceptance', 'failed', 'run_personal_acceptance', 'connector', 'cin_gmail_personal_acceptance', '{"connector_diagnostics":{"stderr_tail":{"text":"personal failure"}}}', '0.1');

    assert.deepEqual((await state.getState(stateTarget(GMAIL, 'cin_gmail_work_acceptance'))).state.messages, { cursor: 'work' });
    assert.deepEqual((await state.getState(stateTarget(GMAIL, 'cin_gmail_personal_acceptance'))).state.messages, { cursor: 'personal' });
    assert.deepEqual((await queryRecords(recordTarget(GMAIL, 'cin_gmail_work_acceptance'), 'messages', { streams: [{ name: 'messages', fields: ['id', 'subject'] }] }, { changes_since: 'beginning' }, manifest(GMAIL))).data.map((row) => row.data.subject), ['work']);
    assert.deepEqual((await queryRecords(recordTarget(GMAIL, 'cin_gmail_personal_acceptance'), 'messages', { streams: [{ name: 'messages', fields: ['id', 'subject'] }] }, { changes_since: 'beginning' }, manifest(GMAIL))).data.map((row) => row.data.subject), ['personal']);
    assert.equal(scheduler.getSchedule('cin_gmail_work_acceptance').interval_seconds, 600);
    assert.equal(scheduler.getSchedule('cin_gmail_personal_acceptance').interval_seconds, 1800);
    assert.deepEqual(scheduler.listActiveRuns().map((row) => row.run_id).sort(), ['run_personal_acceptance', 'run_work_acceptance']);
    assert.equal((await leases.getLease('lease_work')).profile_key, 'cin_gmail_work_acceptance');
    assert.equal((await leases.getLease('lease_personal')).profile_key, 'cin_gmail_personal_acceptance');
    assert.deepEqual(
      getDb().prepare("SELECT source_id, json_extract(data_json, '$.connector_diagnostics.stderr_tail.text') AS text FROM spine_events WHERE event_id LIKE ? ORDER BY source_id").all('evt_%_diag'),
      [
        { source_id: 'cin_gmail_personal_acceptance', text: 'personal failure' },
        { source_id: 'cin_gmail_work_acceptance', text: 'work failure' },
      ],
    );
  });
});

test('Claude and Codex collectors on two devices keep checkpoints and records separate', async () => {
  await withDb(async () => {
    const instances = createSqliteConnectorInstanceStore();
    await instances.upsert({
      connectorInstanceId: 'cin_local_claude_laptop',
      ownerSubjectId: 'owner_local',
      connectorId: LOCAL,
      displayName: 'Claude laptop',
      sourceKind: 'local_device',
      sourceBindingKey: 'dev_laptop:claude',
      sourceBinding: { device_id: 'dev_laptop', local_binding_id: 'claude' },
      createdAt: NOW,
      updatedAt: NOW,
    });
    await instances.upsert({
      connectorInstanceId: 'cin_local_codex_desktop',
      ownerSubjectId: 'owner_local',
      connectorId: LOCAL,
      displayName: 'Codex desktop',
      sourceKind: 'local_device',
      sourceBindingKey: 'dev_desktop:codex',
      sourceBinding: { device_id: 'dev_desktop', local_binding_id: 'codex' },
      createdAt: NOW,
      updatedAt: NOW,
    });

    const devices = createSqliteDeviceExporterStore();
    devices.createDevice({ deviceId: 'dev_laptop', ownerSubjectId: 'owner_local', displayName: 'Laptop', createdAt: NOW, updatedAt: NOW });
    devices.createDevice({ deviceId: 'dev_desktop', ownerSubjectId: 'owner_local', displayName: 'Desktop', createdAt: NOW, updatedAt: NOW });
    devices.upsertSourceInstance({ sourceInstanceId: 'src_claude', deviceId: 'dev_laptop', connectorId: LOCAL, localBindingId: 'claude', displayName: 'Claude', createdAt: NOW, updatedAt: NOW });
    devices.upsertSourceInstance({ sourceInstanceId: 'src_codex', deviceId: 'dev_desktop', connectorId: LOCAL, localBindingId: 'codex', displayName: 'Codex', createdAt: NOW, updatedAt: NOW });
    devices.recordBatchOutcome({ deviceId: 'dev_laptop', batchId: 'batch_1', bodyHash: 'sha256:laptop', sourceInstanceId: 'src_claude', status: 'accepted', httpStatus: 202, response: { accepted: 1 }, createdAt: NOW });
    devices.recordBatchOutcome({ deviceId: 'dev_desktop', batchId: 'batch_1', bodyHash: 'sha256:desktop', sourceInstanceId: 'src_codex', status: 'accepted', httpStatus: 202, response: { accepted: 1 }, createdAt: NOW });

    const state = createSqliteConnectorStateStore();
    await state.putState(stateTarget(LOCAL, 'cin_local_claude_laptop'), { events: { cursor: 'claude-checkpoint' } });
    await state.putState(stateTarget(LOCAL, 'cin_local_codex_desktop'), { events: { cursor: 'codex-checkpoint' } });
    await ingestRecord(recordTarget(LOCAL, 'cin_local_claude_laptop'), { ...record('claude event', 'event_1'), stream: 'events' });
    await ingestRecord(recordTarget(LOCAL, 'cin_local_codex_desktop'), { ...record('codex event', 'event_1'), stream: 'events' });

    assert.deepEqual((await state.getState(stateTarget(LOCAL, 'cin_local_claude_laptop'))).state.events, { cursor: 'claude-checkpoint' });
    assert.deepEqual((await state.getState(stateTarget(LOCAL, 'cin_local_codex_desktop'))).state.events, { cursor: 'codex-checkpoint' });
    assert.deepEqual(
      getDb().prepare("SELECT connector_instance_id, json_extract(record_json, '$.subject') AS subject FROM records WHERE connector_id = ? ORDER BY connector_instance_id").all(LOCAL),
      [
        { connector_instance_id: 'cin_local_claude_laptop', subject: 'claude event' },
        { connector_instance_id: 'cin_local_codex_desktop', subject: 'codex event' },
      ],
    );
    assert.deepEqual(
      devices.listBatchOutcomes({ limit: 10 }).map((row) => [row.deviceId, row.batchId, row.bodyHash, row.sourceInstanceId]).sort(),
      [
        ['dev_desktop', 'batch_1', 'sha256:desktop', 'src_codex'],
        ['dev_laptop', 'batch_1', 'sha256:laptop', 'src_claude'],
      ],
    );
  });
});
