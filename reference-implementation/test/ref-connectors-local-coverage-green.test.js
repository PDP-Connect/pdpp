import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { deriveReferenceFreshness } from '../server/freshness.ts';
import { listConnectorSummaries, projectConnectorSummaryConnectionHealth } from '../server/ref-control.ts';
import { rebuildRetainedSize } from '../server/retained-size-read-model.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { getDefaultDeviceExporterStore } from '../server/stores/device-exporter-store.ts';

// Mirrors the live 2026-06-03 evidence: a local collector source instance that
// is healthy and fully drained (pending=0, dead_letter=0, stale_leases=0) yet
// the `/_ref/connectors` rollup projects `SourceCoverageComplete:coverage_unknown`
// because local collectors have no spine run history to derive coverage from.
//
// These tests exercise the SERVER ROLLUP PATH (`listConnectorSummaries`), not a
// pure helper, so they prove the projection the dashboard actually consumes.

const CONNECTOR_ID = 'https://test.pdpp.dev/connectors/local-coverage-collector';
const CONNECTOR_INSTANCE_ID = 'cin_local_coverage_green';
const DEVICE_ID = 'dev_local_coverage_green';
const SOURCE_INSTANCE_ID = 'src_local_coverage_green';
const OWNER = 'owner_local';
const NOW = '2026-06-03T12:00:00.000Z';
// A heartbeat well within the 30-minute stale window so a drained collector
// reads as `idle`, not `stalled` (the live evidence is freshly healthy).
const HEARTBEAT_AT = '2026-06-03T11:59:00.000Z';

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
      { name: 'messages', primary_key: ['id'] },
      { name: 'sessions', primary_key: ['id'] },
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
    displayName: 'peregrine Claude Code',
    status: 'active',
    sourceKind: 'local_device',
    sourceBindingKey: 'peregrine',
    sourceBinding: { kind: 'local_device', device: 'peregrine' },
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
function seedCoverage(rows) {
  rows.forEach((row, index) => {
    seedRecord({
      stream: 'coverage_diagnostics',
      key: `coverage:${row.store}`,
      data: { id: `coverage:${row.store}`, store: row.store, stream: row.stream ?? null, status: row.status },
      emittedAt: `2026-06-03T11:5${index}:00.000Z`,
    });
  });
}

async function seedHealthyDrainedHeartbeat() {
  const store = getDefaultDeviceExporterStore();
  await store.createDevice({
    deviceId: DEVICE_ID,
    ownerSubjectId: OWNER,
    displayName: 'peregrine',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await store.upsertSourceInstance({
    sourceInstanceId: SOURCE_INSTANCE_ID,
    deviceId: DEVICE_ID,
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    localBindingId: 'peregrine',
    displayName: 'peregrine Claude Code',
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

// A blocked heartbeat carrying failed-upload records: the outbox axis derives
// to `stalled` with cause `dead_letter_backlog`, so the verdict must not fire.
async function seedDeadLetterHeartbeat() {
  const store = getDefaultDeviceExporterStore();
  await store.createDevice({
    deviceId: DEVICE_ID,
    ownerSubjectId: OWNER,
    displayName: 'peregrine',
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
  });
  await store.upsertSourceInstance({
    sourceInstanceId: SOURCE_INSTANCE_ID,
    deviceId: DEVICE_ID,
    connectorId: CONNECTOR_ID,
    connectorInstanceId: CONNECTOR_INSTANCE_ID,
    localBindingId: 'peregrine',
    displayName: 'peregrine Claude Code',
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
    seedCoverage([
      { store: 'sessions', stream: 'sessions', status: 'collected' },
      { store: 'messages', stream: 'messages', status: 'collected' },
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
      4,
      'retained streams outside the manifest remain visible instead of collapsing into the source total',
    );
  }),
);

// A century-long staleness window so the fixed-timestamp heartbeat reads as
// `current` regardless of real wall-clock time when the test runs (the server
// rollup uses `new Date()` for `now`; no injection seam exists here).
const ALWAYS_FRESH_REFRESH_POLICY = { maximum_staleness_seconds: 100 * 365 * 24 * 60 * 60 };

test(
  'healthy drained local collector with complete coverage AND a satisfied freshness policy projects healthy',
  withTmpDb(async () => {
    // Same fully-green device evidence as the idle case above, but the manifest
    // now declares a refresh policy that the recent healthy heartbeat satisfies.
    // With trusted idle outbox + complete coverage + fresh freshness, the
    // local-device collection verdict is established and the connection projects
    // `healthy` — the device-side analog of a recent succeeded run.
    seedConnector({ refreshPolicy: ALWAYS_FRESH_REFRESH_POLICY });
    await seedInstance();
    seedRecord({
      stream: 'messages',
      key: 'msg_1',
      data: { id: 'msg_1', text: 'collected message' },
      emittedAt: '2026-06-03T11:58:00.000Z',
    });
    seedCoverage([
      { store: 'sessions', stream: 'sessions', status: 'collected' },
      { store: 'messages', stream: 'messages', status: 'collected' },
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
      { store: 'sessions', stream: 'sessions', status: 'collected' },
      { store: 'messages', stream: 'messages', status: 'collected' },
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
      { store: 'sessions', stream: 'sessions', status: 'collected' },
      { store: 'mystery_store', stream: null, status: 'unaccounted' },
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
  'local collector with malformed coverage status projects a coverage gap, not complete',
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
      { store: 'sessions', stream: 'sessions', status: 'collected' },
      { store: 'unexpected_store', stream: null, status: 'surprise_status' },
    ]);
    await seedHealthyDrainedHeartbeat();
    await rebuildRetainedSize();

    const row = await projectConnection();
    const health = row.connection_health;

    assert.equal(health.axes.coverage, 'gaps');
    const coverageCondition = health.conditions.find((c) => c.type === 'SourceCoverageComplete');
    assert.ok(coverageCondition);
    assert.equal(coverageCondition.status, 'false');
    assert.notEqual(coverageCondition.reason, 'coverage_unknown');
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
