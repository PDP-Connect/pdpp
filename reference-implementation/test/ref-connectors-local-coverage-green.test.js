import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { deriveReferenceFreshness } from '../server/freshness.ts';
import {
  deriveLocalCoverageAxis,
  getConnectorSummaryForRoute,
  listConnectorSummaries,
  projectConnectorSummaryConnectionHealth,
} from '../server/ref-control.ts';
import { rebuildRetainedSize } from '../server/retained-size-read-model.js';
import { readCommittedLocalCoverageDiagnostics } from '../server/records.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { getDefaultConnectorStateStore } from '../server/stores/connector-state-store.ts';
import { createSqliteSchedulerStore } from '../server/stores/scheduler-store.ts';
import { getDefaultDeviceExporterStore } from '../server/stores/device-exporter-store.ts';
import {
  expectedLocalCoverageStoreDescriptors,
  expectedLocalCoverageStores,
} from '../../packages/polyfill-connectors/src/local-source-inventory.ts';
import { auditStreamHealth } from '../../scripts/stream-health-audit/audit.mjs';

// Mirrors the live 2026-06-03 evidence: a local collector source instance that
// is healthy and fully drained (pending=0, dead_letter=0, stale_leases=0) yet
// the `/_ref/connectors` rollup projects `SourceCoverageComplete:coverage_unknown`
// because local collectors have no spine run history to derive coverage from.
//
// These tests exercise the SERVER ROLLUP PATH (`listConnectorSummaries`), not a
// pure helper, so they prove the projection the dashboard actually consumes.

const CONNECTOR_ID = 'claude-code';
const CONNECTOR_INSTANCE_ID = 'cin_local_coverage_green';
const DEVICE_ID = 'dev_local_coverage_green';
const SOURCE_INSTANCE_ID = 'src_local_coverage_green';
const OWNER = 'owner_local';
const NOW = '2026-06-03T12:00:00.000Z';
// A heartbeat well within the 30-minute stale window so a drained collector
// reads as `idle`, not `stalled` (the live evidence is freshly healthy).
const HEARTBEAT_AT = '2026-06-03T11:59:00.000Z';
const STALE_HISTORICAL_RUN_AT = '2026-05-22T14:31:18.319Z';
const STATE_CONNECTOR_ID = CONNECTOR_ID;

function withTmpDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-local-coverage-green-'));
    initDb(join(dir, 'pdpp.sqlite'));
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function seedConnector({ refreshPolicy = null } = {}) {
  const capabilities = { public_listing: { listed: true, status: 'test' } };
  if (refreshPolicy) {
    capabilities.refresh_policy = refreshPolicy;
  }
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: CONNECTOR_ID,
    version: '1.0.0',
    display_name: 'Local Coverage Collector',
    capabilities,
    streams: [
      { name: 'sessions', primary_key: ['id'], coverage_strategy: 'checkpoint_window' },
      { name: 'messages', primary_key: ['id'], coverage_strategy: 'checkpoint_window', state_stream: 'sessions' },
      { name: 'attachments', primary_key: ['id'], coverage_strategy: 'checkpoint_window', state_stream: 'sessions' },
      { name: 'coverage_diagnostics', primary_key: ['id'], coverage_strategy: 'snapshot_import_receipt' },
    ],
  };
  getDb()
    .prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(CONNECTOR_ID, JSON.stringify(manifest), NOW);
}

async function seedInstance() {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    ownerSubjectId: OWNER,
    connectorId: CONNECTOR_ID,
    displayName: 'laptop Claude Code',
    status: 'active',
    sourceKind: 'local_device',
    sourceBindingKey: 'laptop',
    sourceBinding: { kind: 'local_device', device: 'laptop' },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function seedRecord({ stream, key, data, emittedAt, version = 1 }) {
  getDb()
    .prepare(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(CONNECTOR_ID, CONNECTOR_INSTANCE_ID, stream, key, JSON.stringify(data), emittedAt, version);
}

// Seed one `coverage_diagnostics` record per known store. The connector emits
// these on a successful full local run; they are the durable, honest signal of
// what was and was not collected.
function seedCoverage(rows, { includeExpected = true } = {}) {
  const expected = expectedLocalCoverageStoreDescriptors(CONNECTOR_ID);
  assert.ok(expected, 'the production local connector must declare a fixed inventory');
  const supplied = new Map(rows.map((row) => [row.store, row]));
  const completeRows = includeExpected
    ? expected.map(({ store, stream }) => ({
      store,
      stream,
      status: supplied.get(store)?.status ?? 'inventory_only',
    }))
    : rows;
  const extras = includeExpected ? rows.filter((row) => !expected.some((entry) => entry.store === row.store)) : [];
  [...completeRows, ...extras].forEach((row, index) => {
    seedRecord({
      stream: 'coverage_diagnostics',
      key: `coverage:${row.store}`,
      data: { id: `coverage:${row.store}`, store: row.store, stream: row.stream ?? null, status: row.status },
      emittedAt: `2026-06-03T11:5${index}:00.000Z`,
    });
  });
  getDb()
    .prepare(
      `INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at)
       VALUES (?, ?, 'coverage_diagnostics', ?, ?)`
    )
    .run(
      STATE_CONNECTOR_ID,
      CONNECTOR_INSTANCE_ID,
      JSON.stringify({
        fetched_at: '2026-06-03T11:58:30.000Z',
        stores: [...completeRows, ...extras].map(({ store, stream, status }) => ({ store, stream: stream ?? null, status })),
      }),
      '2026-06-03T11:58:31.000Z'
    );
}

function seedHistoricalSchedulerRun({ completedAt = STALE_HISTORICAL_RUN_AT } = {}) {
  getDb()
    .prepare(
      `INSERT INTO scheduler_run_history(
         connector_instance_id, connector_id, source_json, status, records_emitted,
         known_gaps_json, run_id, started_at, completed_at, attempt
       )
       VALUES (?, ?, ?, 'succeeded', 1, '[]', 'run_stale_history', ?, ?, 1)`,
    )
    .run(CONNECTOR_INSTANCE_ID, CONNECTOR_ID, '{}', completedAt, completedAt);
}

async function seedHealthyDrainedHeartbeat() {
  const store = getDefaultDeviceExporterStore();
  await store.createDevice({
    deviceId: DEVICE_ID,
    ownerSubjectId: OWNER,
    displayName: 'laptop',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await store.upsertSourceInstance({
    sourceInstanceId: SOURCE_INSTANCE_ID,
    deviceId: DEVICE_ID,
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    localBindingId: 'laptop',
    displayName: 'laptop Claude Code',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  // Healthy + fully drained: pending=0, dead_letter=0, stale_leases=0.
  await store.markSourceInstanceHeartbeat(DEVICE_ID, SOURCE_INSTANCE_ID, {
    receivedAt: HEARTBEAT_AT,
    lastError: null,
    status: 'healthy',
    recordsPending: 0,
    outboxDiagnostics: { pending: 0, dead_letter: 0, stale_leases: 0, succeeded: 12, total: 12 },
  });
}

async function seedActiveDrainingHeartbeat({ receivedAt = new Date().toISOString() } = {}) {
  const store = getDefaultDeviceExporterStore();
  await store.createDevice({
    deviceId: DEVICE_ID,
    ownerSubjectId: OWNER,
    displayName: 'laptop',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await store.upsertSourceInstance({
    sourceInstanceId: SOURCE_INSTANCE_ID,
    deviceId: DEVICE_ID,
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    localBindingId: 'laptop',
    displayName: 'laptop Claude Code',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  // Active + making progress: pending work exists, but the collector is checking
  // in recently and has no dead letters or stale leases.
  await store.markSourceInstanceHeartbeat(DEVICE_ID, SOURCE_INSTANCE_ID, {
    receivedAt,
    lastError: null,
    status: 'retrying',
    recordsPending: 5,
    outboxDiagnostics: { pending: 5, dead_letter: 0, stale_leases: 0, succeeded: 7, total: 12 },
  });
  return receivedAt;
}

// A blocked heartbeat carrying failed-upload records: the outbox axis derives
// to `stalled` with cause `dead_letter_backlog`, so the verdict must not fire.
async function seedDeadLetterHeartbeat() {
  const store = getDefaultDeviceExporterStore();
  await store.createDevice({
    deviceId: DEVICE_ID,
    ownerSubjectId: OWNER,
    displayName: 'laptop',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await store.upsertSourceInstance({
    sourceInstanceId: SOURCE_INSTANCE_ID,
    deviceId: DEVICE_ID,
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    localBindingId: 'laptop',
    displayName: 'laptop Claude Code',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await store.markSourceInstanceHeartbeat(DEVICE_ID, SOURCE_INSTANCE_ID, {
    receivedAt: HEARTBEAT_AT,
    lastError: { kind: 'dead_letter_backlog', classes: { '400 invalid_request': 3 } },
    status: 'blocked',
    recordsPending: 3,
    outboxDiagnostics: { pending: 0, dead_letter: 3, stale_leases: 0, succeeded: 9, total: 12 },
  });
}

async function projectConnection() {
  const summaries = await listConnectorSummaries();
  const row = summaries.find((summary) => summary.connector_instance_id === CONNECTOR_INSTANCE_ID);
  assert.ok(row, 'expected the local-device connection to project a summary row');
  return row;
}

test(
  'healthy drained local collector with full coverage diagnostics projects coverage=complete (no longer unknown)',
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedRecord({
      stream: 'messages',
      key: 'msg_1',
      data: { id: 'msg_1', text: 'collected message' },
      emittedAt: '2026-06-03T11:58:00.000Z',
    });
    // Every known store is accounted for (collected / inventory-only / excluded).
    // The real local collectors emit one diagnostic for the parent project/session
    // store; co-emitted child streams inherit that coverage through `state_stream`.
    seedCoverage([
      { store: 'projects', stream: 'sessions', status: 'collected' },
      { store: 'cache', stream: null, status: 'inventory_only' },
      { store: 'auth', stream: null, status: 'excluded' },
    ]);
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    // The durable coverage evidence proves complete coverage, so the projection
    // must NOT remain coverage_unknown. This is the core fix: the live symptom
    // was `SourceCoverageComplete:coverage_unknown` on a drained collector.
    assert.equal(health.axes.coverage, 'complete');
    assert.equal(health.axes.outbox, 'idle');

    const reportByStream = Object.fromEntries(row.collection_report.map((entry) => [entry.stream, entry]));
    assert.equal(
      reportByStream.messages?.coverage_condition,
      'complete',
      'local coverage diagnostics should prove child-stream coverage through the state_stream parent',
    );
    assert.equal(
      reportByStream.attachments?.coverage_condition,
      'complete',
      'co-emitted local child streams inherit coverage from their declared parent stream',
    );
    assert.equal(
      reportByStream.coverage_diagnostics?.coverage_condition,
      'complete',
      'coverage_diagnostics proves itself complete once durable diagnostic rows exist',
    );
    assert.equal(
      reportByStream.sessions?.coverage_condition,
      'complete',
      'local coverage diagnostics should prove per-stream coverage even when the stream emitted no retained records',
    );
    assert.notEqual(reportByStream.messages?.forward_disposition, 'unmeasured');
    assert.notEqual(reportByStream.sessions?.forward_disposition, 'unmeasured');

    const coverageCondition = health.conditions.find((c) => c.type === 'SourceCoverageComplete');
    assert.ok(coverageCondition);
    assert.equal(coverageCondition.status, 'true');
    assert.notEqual(coverageCondition.reason, 'coverage_unknown');

    // Headline: this connector declares NO refresh policy, so freshness is
    // `unknown` and the local-device collection verdict is not established. The
    // honest headline is `idle` (the device-ingest-state rung from the
    // "Local-device connection without scheduler run" spec scenario), NOT
    // `unknown` and NOT a fabricated `healthy`. Coverage no longer drags the
    // projection to unknown.
    assert.equal(health.state, 'idle');
    assert.notEqual(health.state, 'unknown');

    const retainedByStream = Object.fromEntries(row.stream_records.map((entry) => [entry.stream, entry.record_count]));
    assert.equal(retainedByStream.messages, 1, 'retained per-stream counts ride on the connector summary');
    assert.equal(
      retainedByStream.coverage_diagnostics,
      expectedLocalCoverageStores(CONNECTOR_ID).length,
      'every fixed-inventory diagnostic remains visible instead of collapsing into the source total',
    );
    // `sessions` and `attachments` are manifest-declared streams with NO
    // retained records in this fixture. The retained-size projection was
    // rebuilt (proven fresh/clean) above, so the exact-zero-stream-counts join
    // synthesizes a genuine `0` for them instead of leaving them absent — the
    // console can show "0 records" for `sessions` even though its coverage is
    // proven complete purely from `coverage_diagnostics`, not retained rows.
    assert.equal(
      retainedByStream.sessions,
      0,
      'a declared stream proven covered via local diagnostics still gets an exact retained-size zero',
    );
    assert.equal(retainedByStream.attachments, 0, 'co-emitted zero-record declared streams also synthesize exact zero');
  }),
);

test('SQLite coverage reader enforces the shared production inventory exactly', withTmpDb(async () => {
  seedConnector();
  await seedInstance();
  seedCoverage([{ store: 'projects', stream: 'sessions', status: 'collected' }]);

  const proof = await readCommittedLocalCoverageDiagnostics({
    connector_id: STATE_CONNECTOR_ID,
    connector_instance_id: CONNECTOR_INSTANCE_ID,
  });
  assert.deepEqual(proof.missingStores, []);
  assert.deepEqual(proof.unexpectedStores, []);
  assert.deepEqual(proof.duplicateStores, []);
  assert.equal(proof.malformed, false);
  assert.equal(proof.hasAuthoritativeInventory, true);
  assert.equal(proof.hasCommittedSnapshot, true);

  seedRecord({
    stream: 'coverage_diagnostics',
    key: 'coverage:foreign',
    data: { id: 'coverage:foreign', store: 'foreign', stream: null, status: 'inventory_only' },
    emittedAt: '2026-06-03T11:58:59.000Z',
  });
  const foreignProof = await readCommittedLocalCoverageDiagnostics({
    connector_id: CONNECTOR_ID,
    connector_instance_id: CONNECTOR_INSTANCE_ID,
  });
  assert.deepEqual(foreignProof.unexpectedStores, []);
  assert.equal(foreignProof.hasCommittedSnapshot, true, 'retained diagnostic RECORDs cannot alter committed proof');
}));

test('manifest-generation boundary withholds old local STATE until a no-op proof commit advances it', withTmpDb(async () => {
  seedConnector();
  await seedInstance();
  seedCoverage([{ store: 'projects', stream: 'sessions', status: 'collected' }]);
  getDb().prepare(
    `INSERT INTO connector_summary_evidence(
       connector_instance_id, connector_id, display_name, manifest_generation_boundary_at
     ) VALUES (?, ?, '', ?)`
  ).run(CONNECTOR_INSTANCE_ID, CONNECTOR_ID, '2026-06-03T11:58:32.000Z');

  const target = { connector_id: CONNECTOR_ID, connector_instance_id: CONNECTOR_INSTANCE_ID };
  const before = await readCommittedLocalCoverageDiagnostics(target);
  assert.equal(deriveLocalCoverageAxis(before).axis, 'unknown', 'pre-boundary STATE is stale after manifest re-add');

  const stateStore = getDefaultConnectorStateStore();
  await stateStore.putState(
    { connectorId: CONNECTOR_ID, connectorInstanceId: CONNECTOR_INSTANCE_ID },
    { coverage_diagnostics: before.state },
  );
  const after = await readCommittedLocalCoverageDiagnostics(target);
  assert.ok(after.updatedAt > before.updatedAt, 'no-op successful STATE PUT advances durable proof time');
  assert.equal(deriveLocalCoverageAxis(after).axis, 'complete');
}));

test('unsupported local inventory cannot turn an arbitrary singleton into complete report or audit pass', withTmpDb(async () => {
  const connectorId = 'unsupported-local-proof-gate';
  const instanceId = 'cin_unsupported_local_proof';
  const deviceId = 'dev_unsupported_local_proof';
  const sourceInstanceId = 'src_unsupported_local_proof';
  const manifest = {
    protocol_version: '0.1.0', connector_id: connectorId, version: '1.0.0', display_name: 'Unsupported local proof',
    capabilities: { public_listing: { listed: true, status: 'test' } },
    streams: [
      { name: 'messages', primary_key: ['id'], coverage_strategy: 'checkpoint_window' },
      { name: 'coverage_diagnostics', primary_key: ['id'], coverage_strategy: 'snapshot_import_receipt' },
    ],
  };
  getDb().prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)').run(connectorId, JSON.stringify(manifest), NOW);
  await createSqliteConnectorInstanceStore().upsert({
    connectorInstanceId: instanceId, ownerSubjectId: OWNER, connectorId, displayName: 'unknown local', status: 'active',
    sourceKind: 'local_device', sourceBindingKey: 'unknown-local', sourceBinding: { kind: 'local_device' }, createdAt: NOW, updatedAt: NOW,
  });
  for (const [stream, key, data] of [
    ['messages', 'm1', { id: 'm1' }],
    ['coverage_diagnostics', 'coverage:any', { id: 'coverage:any', store: 'any-single-store', stream: 'messages', status: 'collected' }],
  ]) {
    getDb().prepare(`INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted) VALUES (?, ?, ?, ?, ?, ?, 1, 0)`).run(connectorId, instanceId, stream, key, JSON.stringify(data), HEARTBEAT_AT);
  }
  getDb().prepare(`INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at) VALUES (?, ?, 'coverage_diagnostics', ?, ?)`).run(connectorId, instanceId, JSON.stringify({ fetched_at: HEARTBEAT_AT }), HEARTBEAT_AT);
  const devices = getDefaultDeviceExporterStore();
  await devices.createDevice({ deviceId, ownerSubjectId: OWNER, displayName: 'unknown local', status: 'active', createdAt: NOW, updatedAt: NOW });
  await devices.upsertSourceInstance({ sourceInstanceId, deviceId, connectorId, connectorInstanceId: instanceId, localBindingId: 'unknown-local', displayName: 'unknown local', status: 'active', createdAt: NOW, updatedAt: NOW });
  await devices.markSourceInstanceHeartbeat(deviceId, sourceInstanceId, { receivedAt: HEARTBEAT_AT, lastError: null, status: 'healthy', recordsPending: 0, outboxDiagnostics: { pending: 0, dead_letter: 0, stale_leases: 0, succeeded: 0, total: 0 } });
  await rebuildRetainedSize();
  const row = (await listConnectorSummaries()).find((summary) => summary.connector_instance_id === instanceId);
  assert.ok(row);
  assert.equal(row.connection_health.axes.coverage, 'unknown');
  assert.notEqual(row.collection_report.find((entry) => entry.stream === 'messages')?.coverage_condition, 'complete');
  assert.notEqual(auditStreamHealth([row]).status, 'pass');
}));

test('shipped ChatGPT account projection keeps every required stream unmeasured after a session-required scheduler failure', withTmpDb(async () => {
  const manifest = JSON.parse(readFileSync(
    new URL('../../packages/polyfill-connectors/manifests/chatgpt.json', import.meta.url),
    'utf8',
  ));
  const connectorId = manifest.connector_id;
  const instanceId = 'cin_shipped_chatgpt_session_required';
  const requiredStreams = manifest.streams.map((stream) => stream.name).sort();

  getDb().prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(connectorId, JSON.stringify(manifest), NOW);
  await createSqliteConnectorInstanceStore().upsert({
    connectorInstanceId: instanceId,
    ownerSubjectId: OWNER,
    connectorId,
    displayName: 'ChatGPT browser account',
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey: 'chatgpt-browser-account',
    sourceBinding: { kind: 'browser_collector', device: 'laptop' },
    createdAt: NOW,
    updatedAt: NOW,
  });

  const scheduler = createSqliteSchedulerStore();
  await scheduler.appendRunHistory({
    connectorId,
    connectorInstanceId: instanceId,
    source: { kind: 'connector', id: connectorId },
    status: 'failed',
    recordsEmitted: 0,
    reportedRecordsEmitted: 0,
    checkpointSummary: null,
    knownGaps: [],
    connectorError: null,
    runId: 'run_shipped_chatgpt_session_required',
    traceId: 'trc_shipped_chatgpt_session_required',
    failureReason: 'session_required',
    terminalReason: 'session_required',
    startedAt: NOW,
    completedAt: NOW,
    attempt: 1,
  });
  await scheduler.upsertLastRunTime(instanceId, Date.parse(NOW), NOW, connectorId);

  const summary = await getConnectorSummaryForRoute(instanceId);
  assert.ok(summary, 'the production route projection resolves the persisted account instance');
  assert.equal(
    summary.connection_health.conditions?.find((condition) => condition.type === 'CredentialsValid')?.reason,
    'session_required',
    'the production projection must retain the persisted scheduler failure reason',
  );
  const reportByStream = new Map(summary.collection_report.map((entry) => [entry.stream, entry]));
  assert.deepEqual([...reportByStream.keys()].sort(), requiredStreams);
  for (const stream of requiredStreams) {
    const entry = reportByStream.get(stream);
    assert.equal(entry?.coverage_condition, 'unknown', `${stream} must remain unknown`);
    assert.equal(entry?.forward_disposition, 'unmeasured', `${stream} must remain unmeasured`);
  }

  const audit = auditStreamHealth([summary]);
  assert.equal(audit.status, 'fail');
  assert.deepEqual(
    [...(audit.failures[0]?.streams ?? [])].sort((a, b) => a.stream.localeCompare(b.stream)),
    requiredStreams.map((stream) => ({ stream, class: 'runtime_evidence_missing' })),
    'each shipped required stream is red until runtime evidence is committed',
  );
}));

// A century-long staleness window so the fixed-timestamp heartbeat reads as
// `current` regardless of real wall-clock time when the test runs (the server
// rollup uses `new Date()` for `now`; no injection seam exists here).
const ALWAYS_FRESH_REFRESH_POLICY = { maximum_staleness_seconds: 100 * 365 * 24 * 60 * 60 };

test(
  'local committed coverage supports a healthy local-device verdict',
  withTmpDb(async () => {
    // Same fully-green device evidence as the idle case above, but the manifest
    // now declares a refresh policy that the recent healthy heartbeat satisfies.
    // With trusted idle outbox + complete coverage + fresh freshness, the
    // A committed coverage STATE plus a fresh drained device proves a healthy
    // local-device result without relying on scheduler run history.
    seedConnector({ refreshPolicy: ALWAYS_FRESH_REFRESH_POLICY });
    await seedInstance();
    seedRecord({
      stream: 'messages',
      key: 'msg_1',
      data: { id: 'msg_1', text: 'collected message' },
      emittedAt: '2026-06-03T11:58:00.000Z',
    });
    seedCoverage([
      { store: 'projects', stream: 'sessions', status: 'collected' },
      { store: 'cache', stream: null, status: 'inventory_only' },
      { store: 'auth', stream: null, status: 'excluded' },
    ]);
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    assert.equal(health.axes.coverage, 'complete');
    assert.equal(health.axes.outbox, 'idle');
    assert.equal(health.axes.freshness, 'fresh');
    assert.equal(health.state, 'healthy');

    const collection = health.conditions.find((c) => c.type === 'CollectionSucceeded');
    assert.ok(collection);
    assert.equal(collection.status, 'true');
    assert.equal(collection.origin, 'local_device');
  }),
);

test(
  'healthy drained local collector uses heartbeat freshness even with stale historical scheduler history',
  withTmpDb(async () => {
    // Mirrors live local-device connections after machine restarts: the collector
    // has checked in and drained, but an old scheduler row remains on the
    // connection. Push-mode freshness must use trusted local progress rather than
    // letting stale scheduler history force a degraded headline.
    seedConnector({ refreshPolicy: ALWAYS_FRESH_REFRESH_POLICY });
    await seedInstance();
    seedRecord({
      stream: 'messages',
      key: 'msg_1',
      data: { id: 'msg_1', text: 'collected message' },
      emittedAt: '2026-06-03T11:58:00.000Z',
    });
    seedCoverage([
      { store: 'projects', stream: 'sessions', status: 'collected' },
      { store: 'cache', stream: null, status: 'inventory_only' },
      { store: 'auth', stream: null, status: 'excluded' },
    ]);
    seedHistoricalSchedulerRun();
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    assert.equal(row.last_run, null, 'local-device authority must not hydrate stale scheduler history');
    assert.equal(row.freshness.status, 'current');
    assert.equal(row.freshness.captured_at, HEARTBEAT_AT);
    assert.equal(health.axes.freshness, 'fresh');
    assert.equal(health.axes.coverage, 'complete');
    assert.equal(health.axes.outbox, 'idle');
    assert.equal(health.state, 'healthy');
  }),
);

test(
  'active local collector uses heartbeat freshness while outbox axis carries draining work',
  withTmpDb(async () => {
    // Mirrors post-crash recovery while a local collector is still uploading:
    // recent heartbeat + active outbox means the owner does not need to repair
    // the source. The outbox axis carries "still syncing"; stale historical run
    // history must not turn that into degraded/manual repair.
    seedConnector({ refreshPolicy: ALWAYS_FRESH_REFRESH_POLICY });
    await seedInstance();
    seedRecord({
      stream: 'messages',
      key: 'msg_1',
      data: { id: 'msg_1', text: 'collected message' },
      emittedAt: '2026-06-03T11:58:00.000Z',
    });
    seedCoverage([
      { store: 'projects', stream: 'sessions', status: 'collected' },
      { store: 'cache', stream: null, status: 'inventory_only' },
      { store: 'auth', stream: null, status: 'excluded' },
    ]);
    seedHistoricalSchedulerRun();
    const activeHeartbeatAt = await seedActiveDrainingHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    assert.equal(row.local_device_progress?.records_pending, 5);
    assert.equal(row.freshness.status, 'current');
    assert.equal(row.freshness.captured_at, activeHeartbeatAt);
    assert.equal(health.axes.freshness, 'fresh');
    assert.equal(health.axes.outbox, 'active');
    assert.notEqual(health.state, 'healthy');
  }),
);

test(
  'stalled local collector with a satisfied freshness policy stays degraded, never healthy',
  withTmpDb(async () => {
    // A refresh policy is satisfied and coverage is complete, but the outbox is
    // NOT idle — a dead-letter backlog. The verdict must not fire; the stalled
    // axis degrades the headline. Proves the freshness policy alone cannot green
    // a connection whose device work is stuck.
    seedConnector({ refreshPolicy: ALWAYS_FRESH_REFRESH_POLICY });
    await seedInstance();
    seedRecord({
      stream: 'messages',
      key: 'msg_1',
      data: { id: 'msg_1', text: 'collected message' },
      emittedAt: '2026-06-03T11:58:00.000Z',
    });
    seedCoverage([
      { store: 'projects', stream: 'sessions', status: 'collected' },
    ]);
    await seedDeadLetterHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    assert.equal(health.axes.outbox, 'stalled');
    assert.equal(health.state, 'degraded');
    assert.notEqual(health.state, 'healthy');
  }),
);

test(
  'local coverage stays unknown without its committed coverage STATE even when diagnostic records look complete',
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedRecord({
      stream: 'coverage_diagnostics',
      key: 'coverage:sessions',
      data: { id: 'coverage:sessions', store: 'sessions', stream: 'sessions', status: 'collected' },
      emittedAt: '2026-06-03T11:58:00.000Z',
    });
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    assert.equal(row.connection_health.axes.coverage, 'unknown');
    assert.notEqual(row.connection_health.state, 'healthy');
  }),
);

test(
  'duplicate local coverage stores and malformed committed STATE fail closed',
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedCoverage([{ store: 'projects', stream: 'sessions', status: 'collected' }]);
    seedRecord({
      stream: 'coverage_diagnostics',
      key: 'coverage:projects-duplicate',
      data: { id: 'coverage:projects-duplicate', store: 'projects', stream: 'sessions', status: 'collected' },
      emittedAt: '2026-06-03T11:58:01.000Z',
    });
    getDb()
      .prepare(`UPDATE connector_state SET state_json = ? WHERE connector_id = ? AND connector_instance_id = ? AND stream = 'coverage_diagnostics'`)
      .run(JSON.stringify({ fetched_at: 'not-a-timestamp' }), STATE_CONNECTOR_ID, CONNECTOR_INSTANCE_ID);
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    assert.equal(row.connection_health.axes.coverage, 'unknown');
    assert.notEqual(row.connection_health.state, 'healthy');
  }),
);

for (const [name, mutate] of [
  ['null STATE', () => getDb().prepare(`UPDATE connector_state SET state_json = 'null' WHERE connector_id = ? AND connector_instance_id = ? AND stream = 'coverage_diagnostics'`).run(STATE_CONNECTOR_ID, CONNECTOR_INSTANCE_ID)],
  ['malformed cursor', () => getDb().prepare(`UPDATE connector_state SET state_json = ? WHERE connector_id = ? AND connector_instance_id = ? AND stream = 'coverage_diagnostics'`).run(JSON.stringify({ fetched_at: 'not-a-date' }), STATE_CONNECTOR_ID, CONNECTOR_INSTANCE_ID)],
  ['future cursor', () => getDb().prepare(`UPDATE connector_state SET state_json = ?, updated_at = ? WHERE connector_id = ? AND connector_instance_id = ? AND stream = 'coverage_diagnostics'`).run(JSON.stringify({ fetched_at: '2100-01-01T00:00:00.000Z' }), '2100-01-01T00:00:00.000Z', STATE_CONNECTOR_ID, CONNECTOR_INSTANCE_ID)],
]) {
  test(`local ${name} cannot publish complete coverage rows`, withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedCoverage([{ store: 'projects', stream: 'sessions', status: 'collected' }]);
    mutate();
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const coverageCondition = row.connection_health.conditions.find((condition) => condition.type === 'SourceCoverageComplete');
    assert.equal(row.connection_health.axes.coverage, 'unknown');
    assert.ok(coverageCondition);
    assert.equal(coverageCondition.status, 'unknown');
    assert.notEqual(row.connection_health.state, 'healthy');
  }));
}

test('missing fixed-inventory coverage store cannot publish complete coverage rows', withTmpDb(async () => {
  seedConnector();
  await seedInstance();
  const expected = expectedLocalCoverageStores(CONNECTOR_ID);
  assert.ok(expected);
  seedCoverage(
    expected.filter((store) => store !== 'auth').map((store) => ({
      store,
      stream: store === 'projects' ? 'sessions' : null,
      status: 'inventory_only',
    })),
    { includeExpected: false },
  );
  await seedHealthyDrainedHeartbeat();
  await rebuildRetainedSize();

  const row = await projectConnection();
  assert.equal(row.connection_health.axes.coverage, 'unknown');
  assert.notEqual(row.connection_health.state, 'healthy');
}));

test('future proof bounds use injected now for both cursor and server commit time', () => {
  const base = {
    rows: [{ store: 'projects', stream: 'sessions', status: 'collected' }],
    malformed: false,
    duplicateStores: [],
    missingStores: [],
    unexpectedStores: [],
    hasAuthoritativeInventory: true,
    hasCommittedSnapshot: true,
    state: { fetched_at: '2026-06-03T12:05:01.000Z' },
    updatedAt: '2026-06-03T12:05:01.000Z',
    nowIso: '2026-06-03T12:00:00.000Z',
  };
  assert.equal(deriveLocalCoverageAxis(base).reliable, false);
  assert.equal(deriveLocalCoverageAxis({ ...base, state: { fetched_at: '2026-06-03T12:05:00.000Z' }, updatedAt: '2026-06-03T12:05:00.000Z' }).reliable, true);
});

test(
  'local collector with unaccounted stores projects coverage gaps with actionable reason, not unknown',
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedRecord({
      stream: 'messages',
      key: 'msg_1',
      data: { id: 'msg_1', text: 'collected message' },
      emittedAt: '2026-06-03T11:58:00.000Z',
    });
    // One store the collector discovered but could not classify -> unaccounted.
    seedCoverage([
      { store: 'projects', stream: 'sessions', status: 'unaccounted' },
    ]);
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    // Coverage must surface the gap honestly rather than hiding it behind green
    // or behind a generic unknown.
    assert.notEqual(health.axes.coverage, 'unknown');
    assert.notEqual(health.axes.coverage, 'complete');

    const coverageCondition = health.conditions.find((c) => c.type === 'SourceCoverageComplete');
    assert.ok(coverageCondition);
    assert.equal(coverageCondition.status, 'false');
    // Reason/remediation must be actionable and name the coverage shortfall.
    assert.ok(coverageCondition.remediation);
    assert.notEqual(coverageCondition.reason, 'coverage_unknown');

    // Degraded, not silently healthy.
    assert.equal(health.state, 'degraded');
  }),
);

test(
  'local collector with malformed coverage status fails closed, never complete',
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedRecord({
      stream: 'messages',
      key: 'msg_1',
      data: { id: 'msg_1', text: 'collected message' },
      emittedAt: '2026-06-03T11:58:00.000Z',
    });
    seedCoverage([
      { store: 'projects', stream: 'sessions', status: 'surprise_status' },
    ]);
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    assert.equal(health.axes.coverage, 'unknown');
    const coverageCondition = health.conditions.find((c) => c.type === 'SourceCoverageComplete');
    assert.ok(coverageCondition);
    assert.equal(coverageCondition.status, 'unknown');
  }),
);

test(
  'healthy drained local collector with NO coverage diagnostics stays unknown (empty outbox is not complete)',
  withTmpDb(async () => {
    seedConnector();
    await seedInstance();
    seedRecord({
      stream: 'messages',
      key: 'msg_1',
      data: { id: 'msg_1', text: 'collected message' },
      emittedAt: '2026-06-03T11:58:00.000Z',
    });
    // No coverage_diagnostics records: a run never proved its coverage.
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    // An empty/drained outbox is NOT proof of complete coverage. Without durable
    // coverage evidence, coverage stays unknown rather than being painted green.
    assert.equal(health.axes.coverage, 'unknown');
    const coverageCondition = health.conditions.find((c) => c.type === 'SourceCoverageComplete');
    assert.ok(coverageCondition);
    assert.equal(coverageCondition.status, 'unknown');
    assert.equal(coverageCondition.reason, 'coverage_unknown');
    assert.notEqual(health.state, 'healthy');
  }),
);

const FRESH_FRESHNESS = { status: 'current', captured_at: '2026-06-03T11:58:00.000Z' };

test('run-derived coverage wins over local coverage diagnostics when a spine run exists', () => {
  // A connector WITH a terminal spine-run gap must not have that gap masked by
  // stale `coverage_diagnostics` records claiming completeness. Local coverage
  // is a fallback only when the run path yields `unknown`.
  const lastRun = {
    run_id: 'run_1',
    status: 'succeeded',
    started_at: NOW,
    finished_at: NOW,
    first_at: NOW,
    last_at: NOW,
    event_count: 1,
    failure_reason: null,
    known_gaps: [{ severity: 'actionable', reason: 'owner_must_reauthorize' }],
  };
  const health = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun,
    lastSuccessfulRun: lastRun,
    localCoverage: { axis: 'complete', unaccountedStores: [] },
    manifestStreams: [{ name: 'messages' }],
    outbox: { axis: 'idle' },
    pendingDetailGaps: [],
    schedule: { enabled: true },
    nowIso: NOW,
  });
  // The actionable known gap must win: coverage is terminal_gap, not complete.
  assert.equal(health.axes.coverage, 'terminal_gap');
  assert.notEqual(health.axes.coverage, 'complete');
});

test('local coverage diagnostics fill the gap only when the run path is unknown', () => {
  // No spine run (local collector): run-derived coverage is `unknown`, so the
  // durable local coverage axis is adopted.
  const health = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun: null,
    lastSuccessfulRun: null,
    localCoverage: { axis: 'complete', unaccountedStores: [] },
    manifestStreams: [{ name: 'messages' }],
    outbox: { axis: 'idle' },
    pendingDetailGaps: [],
    schedule: { enabled: true },
    nowIso: NOW,
  });
  assert.equal(health.axes.coverage, 'complete');

  // And a null/unobserved local coverage leaves the run-derived `unknown` axis
  // untouched — an empty outbox is never silently promoted to complete.
  const unknownHealth = projectConnectorSummaryConnectionHealth({
    freshness: FRESH_FRESHNESS,
    lastRun: null,
    lastSuccessfulRun: null,
    localCoverage: { axis: 'unknown', unaccountedStores: [] },
    manifestStreams: [{ name: 'messages' }],
    outbox: { axis: 'idle' },
    pendingDetailGaps: [],
    schedule: { enabled: true },
    nowIso: NOW,
  });
  assert.equal(unknownHealth.axes.coverage, 'unknown');
});

test('local-device health quarantines foreign active-run and scheduler facts', () => {
  const health = projectConnectorSummaryConnectionHealth({
    activeRun: { run_id: 'foreign-active-run' },
    collectionRate: { state: 'backing_off' },
    freshness: FRESH_FRESHNESS,
    lastRun: {
      run_id: 'foreign-run', status: 'failed', started_at: NOW, finished_at: NOW, first_at: NOW, last_at: NOW,
      event_count: 0, failure_reason: 'foreign_failure', known_gaps: [],
    },
    lastSuccessfulRun: null,
    localCoverage: { axis: 'complete', unaccountedStores: [] },
    localDeviceBacked: true,
    manifestStreams: [{ name: 'messages' }],
    outbox: { axis: 'idle' },
    pendingDetailGaps: [],
    schedule: { enabled: true, next_run_at: NOW },
    nowIso: NOW,
  });
  assert.equal(health.badges.syncing, false);
  assert.equal(health.axes.coverage, 'complete');
  assert.notEqual(health.reason_code, 'foreign_failure');
});

// ---------------------------------------------------------------------------
// Real-manifest regression guard.
//
// The tests above synthesize an `ALWAYS_FRESH_REFRESH_POLICY` to prove the
// `idle → healthy` upgrade mechanism. That proves the projection logic but NOT
// that the *shipped* local-collector manifests actually declare a staleness
// window that greens a recently-heartbeating collector. `maximum_staleness_seconds`
// is optional at the registry validator, so a manifest edit could drop it and
// silently regress `claude_code`/`codex` from `healthy` back to `idle` with no
// other test failing. These guards pin the real manifests: they derive freshness
// from the actual declared policy (no synthetic window) and assert it greens a
// fresh heartbeat and degrades a stale one, exactly as
// `openspec/changes/add-local-device-collection-verdict/` requires.
// ---------------------------------------------------------------------------

const LOCAL_COLLECTOR_MANIFEST_NAMES = ['claude_code', 'codex'];

function readRealRefreshPolicy(name) {
  const manifest = JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), 'utf8'),
  );
  return manifest.capabilities?.refresh_policy ?? null;
}

// Derive freshness the same way the server rollup does: heartbeat timestamp as
// the freshness anchor, the manifest's declared `maximum_staleness_seconds` as
// the window, and a fixed `now`. This exercises the REAL policy value with no
// wall-clock dependency, unlike the rollup path which reads `new Date()`.
function freshnessFromRealPolicy({ name, heartbeatAt, nowIso }) {
  const policy = readRealRefreshPolicy(name);
  return deriveReferenceFreshness({
    lastAttemptedAt: null,
    lastAttemptStatus: null,
    lastSuccessfulRunAt: null,
    maximumStalenessSeconds: policy?.maximum_staleness_seconds ?? null,
    recordLastUpdatedAt: heartbeatAt,
    now: nowIso,
  });
}

function projectLocalDeviceHealth({ freshness, outboxAxis = 'idle', coverageAxis = 'complete', nowIso }) {
  return projectConnectorSummaryConnectionHealth({
    freshness,
    lastRun: null,
    lastSuccessfulRun: null,
    localCoverage: { axis: coverageAxis, unaccountedStores: [] },
    localDeviceBacked: true,
    manifestStreams: [{ name: 'messages' }],
    outbox: { axis: outboxAxis },
    pendingDetailGaps: [],
    schedule: { enabled: true },
    nowIso,
  });
}

for (const name of LOCAL_COLLECTOR_MANIFEST_NAMES) {
  test(`${name}: shipped manifest declares a refresh policy with a positive maximum_staleness_seconds`, () => {
    const policy = readRealRefreshPolicy(name);
    assert.ok(policy, `${name} manifest must declare capabilities.refresh_policy`);
    assert.equal(policy.recommended_mode, 'automatic', `${name} is a local collector and should refresh automatically`);
    assert.equal(
      typeof policy.maximum_staleness_seconds,
      'number',
      `${name} must declare maximum_staleness_seconds so a fresh heartbeat can green the collector`,
    );
    assert.ok(
      Number.isFinite(policy.maximum_staleness_seconds) && policy.maximum_staleness_seconds > 0,
      `${name}: maximum_staleness_seconds must be positive (got ${policy.maximum_staleness_seconds})`,
    );
  });

  test(`${name}: drained + complete + heartbeat inside the real staleness window projects healthy`, () => {
    const policy = readRealRefreshPolicy(name);
    const nowIso = '2026-06-03T12:00:00.000Z';
    // One second inside the declared window: still fresh.
    const heartbeatAt = new Date(
      Date.parse(nowIso) - (policy.maximum_staleness_seconds - 1) * 1000,
    ).toISOString();

    const freshness = freshnessFromRealPolicy({ name, heartbeatAt, nowIso });
    assert.equal(freshness.status, 'current', `${name}: a heartbeat inside the window must read current`);

    const health = projectLocalDeviceHealth({ freshness, nowIso });
    assert.equal(health.axes.freshness, 'fresh');
    assert.equal(health.axes.outbox, 'idle');
    assert.equal(health.axes.coverage, 'complete');
    assert.equal(health.state, 'healthy');

    const collection = health.conditions.find((c) => c.type === 'CollectionSucceeded');
    assert.ok(collection, `${name}: expected a CollectionSucceeded condition`);
    assert.equal(collection.status, 'true');
    assert.equal(collection.origin, 'local_device');
  });

  test(`${name}: heartbeat past the real staleness window goes stale and is never healthy`, () => {
    const policy = readRealRefreshPolicy(name);
    const nowIso = '2026-06-03T12:00:00.000Z';
    // One second past the declared window: stale.
    const heartbeatAt = new Date(
      Date.parse(nowIso) - (policy.maximum_staleness_seconds + 1) * 1000,
    ).toISOString();

    const freshness = freshnessFromRealPolicy({ name, heartbeatAt, nowIso });
    assert.equal(freshness.status, 'stale', `${name}: a heartbeat past the window must read stale`);

    const health = projectLocalDeviceHealth({ freshness, nowIso });
    assert.equal(health.axes.freshness, 'stale');
    // A stale collector with otherwise-green axes must NOT be greened by the
    // verdict — the freshness gate is load-bearing.
    assert.notEqual(health.state, 'healthy');

    const collection = health.conditions.find((c) => c.type === 'CollectionSucceeded');
    assert.ok(collection);
    assert.notEqual(collection.status, 'true');
  });
}
