import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { emitSpineEvent } from '../lib/spine.ts';
import { CONNECTION_CONDITION_REASONS } from '../runtime/connection-health.ts';
import { getConnectorSummaryForRoute, invalidateConnectorSummariesCache, listConnectorSummaries } from '../server/ref-control.ts';
import { rebuildRetainedSize } from '../server/retained-size-read-model.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { getDefaultConnectorDetailGapStore } from '../server/stores/connector-detail-gap-store.js';
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from '../server/stores/credential-encryption.js';
import { createSqliteConnectorInstanceCredentialStore } from '../server/stores/connector-instance-credential-store.js';
import { createSqliteSchedulerStore } from '../server/stores/scheduler-store.ts';

const CONNECTOR_ID = 'https://test.pdpp.dev/connectors/connection-first-records';
const STATIC_SECRET_CONNECTOR_ID = 'https://test.pdpp.dev/connectors/connection-first-static-secret';
const WORK_INSTANCE_ID = 'cin_test_connection_first_work';
const PERSONAL_INSTANCE_ID = 'cin_test_connection_first_personal';
const REVOKED_INSTANCE_ID = 'cin_test_connection_first_revoked';
const STATIC_SECRET_INSTANCE_ID = 'cin_test_connection_first_static_secret';
const NOW = '2026-05-20T12:00:00.000Z';
const REVOKED_AT = '2026-06-10T19:10:28.476Z';
const TEST_CREDENTIAL_KEY = 'ref-connectors-connection-projection-test-key';

function withTmpDb(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdpp-ref-connectors-connection-'));
    initDb(join(dir, 'pdpp.sqlite'));
    try {
      await fn();
    } finally {
      closeDb();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function seedConnector() {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: CONNECTOR_ID,
    version: '1.0.0',
    display_name: 'Connection First Records',
    capabilities: {
      public_listing: { listed: true, status: 'test' },
    },
    streams: [
      { name: 'messages', primary_key: ['id'] },
      { name: 'files', primary_key: ['id'] },
    ],
  };
  getDb()
    .prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(CONNECTOR_ID, JSON.stringify(manifest), NOW);
}

// A static-secret-capable connector manifest (declares `setup.credential_capture`),
// so `staticSecretCredentialCaptureFromManifest` resolves non-null and the
// connection-summary projection consults the real credential store.
function seedStaticSecretConnector() {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: STATIC_SECRET_CONNECTOR_ID,
    version: '1.0.0',
    display_name: 'Connection First Static Secret',
    capabilities: {
      public_listing: { listed: true, status: 'test' },
    },
    setup: {
      credential_capture: {
        kind: 'app_password',
        fields: [{ name: 'app_password', label: 'App password', secret: true }],
      },
    },
    streams: [{ name: 'messages', primary_key: ['id'] }],
  };
  getDb()
    .prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(STATIC_SECRET_CONNECTOR_ID, JSON.stringify(manifest), NOW);
}

async function withCredentialKey(value, fn) {
  const old = process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = value;
  try {
    return await fn();
  } finally {
    if (old === undefined) {
      delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
    } else {
      process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = old;
    }
  }
}

async function seedInstances({ sourceKind = 'local_device' } = {}) {
  await seedInstance({
    connectorInstanceId: WORK_INSTANCE_ID,
    displayName: 'Work laptop',
    sourceKind,
    sourceBindingKey: 'work',
    sourceBinding: { kind: sourceKind, device: 'work' },
  });
  await seedInstance({
    connectorInstanceId: PERSONAL_INSTANCE_ID,
    displayName: 'Personal laptop',
    sourceKind,
    sourceBindingKey: 'personal',
    sourceBinding: { kind: sourceKind, device: 'personal' },
  });
}

async function seedInstance({
  connectorInstanceId,
  connectorId = CONNECTOR_ID,
  displayName,
  sourceKind = 'local_device',
  sourceBindingKey,
  sourceBinding,
  status = 'active',
}) {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorInstanceId,
    ownerSubjectId: 'owner_local',
    connectorId,
    displayName,
    status,
    sourceKind,
    sourceBindingKey,
    sourceBinding,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function seedRecord({ connectorId = CONNECTOR_ID, connectorInstanceId, stream, key, data, emittedAt, version }) {
  getDb()
    .prepare(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(connectorId, connectorInstanceId, stream, key, JSON.stringify(data), emittedAt, version);
  getDb()
    .prepare(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(connectorId, connectorInstanceId, stream, key, version, JSON.stringify(data), emittedAt);
}

async function seedBrowserSurfaceRun({ connectorInstanceId, runId, status, occurredAt, waitReason = null }) {
  const profileKey = `${CONNECTOR_ID}:${connectorInstanceId}`;
  await emitSpineEvent({
    actor_type: 'runtime',
    actor_id: CONNECTOR_ID,
    event_type: status === 'succeeded' ? 'run.browser_surface_released' : 'run.browser_surface_failed',
    object_type: 'run',
    object_id: runId,
    occurred_at: occurredAt,
    run_id: runId,
    source_kind: 'connector',
    source_id: CONNECTOR_ID,
    status: status === 'succeeded' ? 'succeeded' : status,
    trace_id: `trc_${runId}`,
    data: {
      connector_id: CONNECTOR_ID,
      source: { kind: 'connector', id: CONNECTOR_ID },
      browser_surface: {
        pending_run_id: runId,
        browser_surface_status: status,
        browser_surface_wait_reason: waitReason ?? undefined,
        browser_surface_lease_id: `lease_${runId}`,
        browser_surface_profile_key: profileKey,
      },
    },
  });
}

async function seedSchedulerRunHistory({
  connectorInstanceId,
  runId,
  status = 'succeeded',
  startedAt,
  completedAt,
}) {
  const store = createSqliteSchedulerStore();
  await Promise.resolve(
    store.appendRunHistory({
      connectorId: CONNECTOR_ID,
      connectorInstanceId,
      source: { kind: 'connector', id: CONNECTOR_ID },
      status,
      recordsEmitted: 1,
      reportedRecordsEmitted: 1,
      checkpointSummary: { streams: 1 },
      knownGaps: [],
      connectorError: null,
      runId,
      traceId: `trc_${runId}`,
      failureReason: null,
      terminalReason: null,
      startedAt,
      completedAt,
      attempt: 1,
    }),
  );
  await Promise.resolve(store.upsertLastRunTime(connectorInstanceId, Date.parse(completedAt), completedAt, CONNECTOR_ID));
}

async function seedManualRunWithCollectionFacts({ connectorInstanceId, runId, occurredAt, streams }) {
  const profileKey = `${CONNECTOR_ID}:${connectorInstanceId}`;
  // Manual/direct runs bind to a connection through spine lifecycle facts, not
  // scheduler_run_history. This mirrors controller.runNow.
  await emitSpineEvent({
    actor_type: 'runtime',
    actor_id: CONNECTOR_ID,
    event_type: 'run.browser_surface_released',
    object_type: 'run',
    object_id: runId,
    occurred_at: occurredAt,
    run_id: runId,
    source_kind: 'connector',
    source_id: CONNECTOR_ID,
    status: 'succeeded',
    trace_id: `trc_${runId}`,
    data: {
      connector_id: CONNECTOR_ID,
      source: { kind: 'connector', id: CONNECTOR_ID },
      browser_surface: {
        browser_surface_status: 'released',
        browser_surface_lease_id: `lease_${runId}`,
        browser_surface_profile_key: profileKey,
      },
    },
  });
  await emitSpineEvent({
    actor_type: 'runtime',
    actor_id: CONNECTOR_ID,
    event_type: 'run.completed',
    object_type: 'run',
    object_id: runId,
    occurred_at: occurredAt,
    run_id: runId,
    source_kind: 'connector',
    source_id: CONNECTOR_ID,
    status: 'succeeded',
    trace_id: `trc_${runId}`,
    data: {
      connector_id: CONNECTOR_ID,
      source: { kind: 'connector', id: CONNECTOR_ID },
      collection_facts: { streams },
    },
  });
}

async function seedConnectionRunWithCollectionFacts({ connectorInstanceId, runId, occurredAt, streams }) {
  // API/static/manual connectors may have no browser-surface profile key. They
  // still need exact connection identity so a run for one account does not
  // disappear when a sibling connection of the same connector exists.
  const baseData = {
    source: { kind: 'connector', id: CONNECTOR_ID },
    connection_id: connectorInstanceId,
    connector_instance_id: connectorInstanceId,
  };
  await emitSpineEvent({
    actor_type: 'runtime',
    actor_id: CONNECTOR_ID,
    event_type: 'run.started',
    object_type: 'run',
    object_id: runId,
    occurred_at: occurredAt,
    run_id: runId,
    source_kind: 'connector',
    source_id: CONNECTOR_ID,
    status: 'started',
    trace_id: `trc_${runId}`,
    data: {
      ...baseData,
      boot_epoch: '00000000-0000-4000-8000-000000000004',
      seq: 1,
    },
  });
  await emitSpineEvent({
    actor_type: 'runtime',
    actor_id: CONNECTOR_ID,
    event_type: 'run.completed',
    object_type: 'run',
    object_id: runId,
    occurred_at: occurredAt,
    run_id: runId,
    source_kind: 'connector',
    source_id: CONNECTOR_ID,
    status: 'succeeded',
    trace_id: `trc_${runId}`,
    data: {
      ...baseData,
      collection_facts: { streams },
    },
  });
}

function collectionReportByStream(report) {
  return Object.fromEntries((report ?? []).map((entry) => [entry.stream, entry]));
}

test('a manual run with browser-profile + collection_facts on the spine (no scheduler_run_history) feeds collection_report on list and detail', withTmpDb(async () => {
  seedConnector();
  await seedInstance({
    connectorInstanceId: WORK_INSTANCE_ID,
    displayName: 'Chase (manual run)',
    sourceKind: 'browser_collector',
    sourceBindingKey: 'chase-manual',
    sourceBinding: { kind: 'browser_collector', account: 'chase' },
  });
  // A sibling connection proves the run binds to the exact profile key instead
  // of borrowing connector-wide history.
  await seedInstance({
    connectorInstanceId: PERSONAL_INSTANCE_ID,
    displayName: 'Chase (sibling, no run)',
    sourceKind: 'browser_collector',
    sourceBindingKey: 'chase-sibling',
    sourceBinding: { kind: 'browser_collector', account: 'chase-personal' },
  });

  await seedManualRunWithCollectionFacts({
    connectorInstanceId: WORK_INSTANCE_ID,
    runId: 'run_chase_manual_direct',
    occurredAt: '2026-05-20T12:05:00.000Z',
    streams: [
      { stream: 'messages', collected: 1145, considered: null, covered: null, checkpoint: 'committed', pending_detail_gaps: 0, skipped: null },
      { stream: 'files', collected: 3, considered: null, covered: null, checkpoint: 'committed', pending_detail_gaps: 0, skipped: null },
    ],
  });

  // Guard the premise: the projection below must derive collection_report purely
  // from spine facts.
  const historyRows = getDb()
    .prepare('SELECT COUNT(*) AS n FROM scheduler_run_history WHERE connector_id = ?')
    .get(CONNECTOR_ID);
  assert.equal(historyRows.n, 0, 'premise: the manual run left no scheduler_run_history row');

  const summaries = await listConnectorSummaries();
  const listWork = summaries.find(
    (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID,
  );
  assert.ok(listWork, 'the manual-run connection projects a source-list summary');
  assert.equal(listWork.last_run?.run_id, 'run_chase_manual_direct');
  assert.equal(listWork.last_run?.status, 'succeeded');
  assert.ok(listWork.last_run?.collection_facts, 'last_run carries the terminal collection_facts block');

  const listByStream = collectionReportByStream(listWork.collection_report);
  assert.deepEqual(
    Object.keys(listByStream).sort(),
    ['files', 'messages'],
    'collection_report has one entry per stream from the manual run fact block',
  );
  assert.equal(listByStream.messages.collected, 1145, 'collected count rides through from spine terminal facts');
  assert.equal(listByStream.files.collected, 3, 'second stream collected count rides through');
  assert.equal(listByStream.messages.considered, 'unknown');
  assert.equal(listByStream.messages.coverage_condition, 'unknown');
  assert.notEqual(listByStream.messages.coverage_condition, 'complete');

  const detail = await getConnectorSummaryForRoute(WORK_INSTANCE_ID);
  assert.ok(detail, 'the manual-run connection resolves a source-detail summary');
  assert.equal(detail.last_run?.run_id, 'run_chase_manual_direct');
  const detailByStream = collectionReportByStream(detail.collection_report);
  assert.equal(detailByStream.messages.collected, 1145, 'detail surface derives the same collected count from the spine');
  assert.equal(detailByStream.messages.coverage_condition, 'unknown');
  assert.deepEqual(
    detailByStream.messages,
    listByStream.messages,
    'detail and list derive an identical collection_report entry from the spine terminal facts',
  );

  const sibling = summaries.find(
    (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === PERSONAL_INSTANCE_ID,
  );
  assert.ok(sibling, 'the sibling connection projects a summary');
  assert.equal(sibling.last_run, null, 'the sibling has no run of its own to borrow');
  const siblingByStream = collectionReportByStream(sibling.collection_report);
  const siblingMessages = siblingByStream.messages;
  assert.notEqual(siblingMessages?.collected, 1145, 'sibling must not inherit the manual run collected count');
}));

test('a connection-id run without browser profile feeds only the addressed account summary', withTmpDb(async () => {
  seedConnector();
  await seedInstances({ sourceKind: 'manual' });

  await seedConnectionRunWithCollectionFacts({
    connectorInstanceId: WORK_INSTANCE_ID,
    runId: 'run_api_direct_work',
    occurredAt: '2026-05-20T12:08:00.000Z',
    streams: [
      { stream: 'messages', collected: 7, considered: 7, covered: 7, checkpoint: 'committed', pending_detail_gaps: 0, skipped: null },
      { stream: 'files', collected: 0, considered: 0, covered: 0, checkpoint: 'committed', pending_detail_gaps: 0, skipped: null },
    ],
  });

  const summaries = await listConnectorSummaries();
  const work = summaries.find(
    (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID,
  );
  const personal = summaries.find(
    (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === PERSONAL_INSTANCE_ID,
  );
  assert.ok(work);
  assert.ok(personal);
  assert.equal(work.last_run?.run_id, 'run_api_direct_work');
  assert.equal(work.last_run?.status, 'succeeded');
  assert.equal(collectionReportByStream(work.collection_report).messages.coverage_condition, 'complete');
  assert.equal(personal.last_run, null, 'sibling connection must not borrow the connection-id run');
}));

test('a succeeded run with partial stream coverage does not render the connection healthy', withTmpDb(async () => {
  seedConnector();
  await seedInstance({
    connectorInstanceId: WORK_INSTANCE_ID,
    displayName: 'GitHub-shaped partial coverage',
    sourceKind: 'browser_collector',
    sourceBindingKey: 'github-partial',
    sourceBinding: { kind: 'browser_collector', account: 'github' },
  });

  await seedManualRunWithCollectionFacts({
    connectorInstanceId: WORK_INSTANCE_ID,
    runId: 'run_partial_stream_success',
    occurredAt: '2026-05-20T12:10:00.000Z',
    streams: [
      { stream: 'messages', collected: 2, considered: 10, covered: null, checkpoint: 'committed', pending_detail_gaps: 0, skipped: null },
      { stream: 'files', collected: 3, considered: 3, covered: null, checkpoint: 'committed', pending_detail_gaps: 0, skipped: null },
    ],
  });

  const summaries = await listConnectorSummaries();
  const summary = summaries.find(
    (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID,
  );
  assert.ok(summary, 'the partial-coverage connection projects a source-list summary');
  const reportByStream = collectionReportByStream(summary.collection_report);
  assert.equal(reportByStream.messages.coverage_condition, 'partial');
  assert.equal(reportByStream.messages.forward_disposition, 'resumable');
  assert.equal(summary.connection_health.axes.coverage, 'partial');
  assert.equal(summary.connection_health.state, 'degraded');
  assert.equal(summary.rendered_verdict.pill.label, 'Degraded');

  const detail = await getConnectorSummaryForRoute(WORK_INSTANCE_ID);
  assert.ok(detail, 'the partial-coverage connection resolves a source-detail summary');
  assert.equal(detail.connection_health.axes.coverage, 'partial');
  assert.equal(detail.rendered_verdict.pill.label, 'Degraded');
}));

test('terminal detail gaps downgrade the connection verdict and stream coverage', withTmpDb(async () => {
  seedConnector();
  await seedInstance({
    connectorInstanceId: WORK_INSTANCE_ID,
    displayName: 'Amazon-shaped terminal detail gaps',
    sourceKind: 'browser_collector',
    sourceBindingKey: 'amazon-terminal',
    sourceBinding: { kind: 'browser_collector', account: 'amazon' },
  });

  const gapStore = getDefaultConnectorDetailGapStore();
  const terminalGap = await gapStore.upsertPendingGap({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: WORK_INSTANCE_ID,
    grantId: 'grant_1',
    stream: 'files',
    parentStream: 'messages',
    recordKey: 'file_never_loaded',
    reason: 'temporary_unavailable',
  });
  await gapStore.markGapStatus(terminalGap.gap_id, 'terminal', {
    runId: 'run_terminal_detail_gap',
    error: { class: 'quarantined' },
  });

  await seedManualRunWithCollectionFacts({
    connectorInstanceId: WORK_INSTANCE_ID,
    runId: 'run_terminal_detail_gap',
    occurredAt: '2026-05-20T12:11:00.000Z',
    streams: [
      { stream: 'messages', collected: 2, considered: null, covered: null, checkpoint: 'not_staged', pending_detail_gaps: 0, skipped: null },
      { stream: 'files', collected: 1, considered: null, covered: null, checkpoint: 'not_staged', pending_detail_gaps: 0, skipped: null },
    ],
  });

  const summaries = await listConnectorSummaries();
  const summary = summaries.find(
    (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID,
  );
  assert.ok(summary, 'the terminal-gap connection projects a source-list summary');
  const reportByStream = collectionReportByStream(summary.collection_report);
  assert.equal(reportByStream.messages.coverage_condition, 'unknown');
  assert.equal(reportByStream.files.coverage_condition, 'terminal_gap');
  assert.equal(reportByStream.files.forward_disposition, 'terminal');
  assert.equal(summary.connection_health.axes.coverage, 'terminal_gap');
  assert.notEqual(summary.connection_health.state, 'healthy');
  assert.notEqual(summary.rendered_verdict.pill.label, 'Healthy');

  const detail = await getConnectorSummaryForRoute(WORK_INSTANCE_ID);
  assert.ok(detail, 'the terminal-gap connection resolves a source-detail summary');
  assert.equal(detail.connection_health.axes.coverage, 'terminal_gap');
  assert.equal(collectionReportByStream(detail.collection_report).files.coverage_condition, 'terminal_gap');
  assert.notEqual(detail.rendered_verdict.pill.label, 'Healthy');
}));

test('reference connector summaries project concrete connection rows with instance-scoped records', withTmpDb(async () => {
  seedConnector();
  await seedInstances({ sourceKind: 'manual' });

  seedRecord({
    connectorInstanceId: WORK_INSTANCE_ID,
    stream: 'messages',
    key: 'msg_1',
    data: { id: 'msg_1', text: 'work message' },
    emittedAt: '2026-05-20T12:01:00.000Z',
    version: 1,
  });
  seedRecord({
    connectorInstanceId: WORK_INSTANCE_ID,
    stream: 'files',
    key: 'file_1',
    data: { id: 'file_1', name: 'brief.pdf' },
    emittedAt: '2026-05-20T12:02:00.000Z',
    version: 1,
  });
  seedRecord({
    connectorInstanceId: PERSONAL_INSTANCE_ID,
    stream: 'messages',
    key: 'msg_2',
    data: { id: 'msg_2', text: 'personal message' },
    emittedAt: '2026-05-20T12:03:00.000Z',
    version: 1,
  });
  getDb()
    .prepare(
      `INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run('blob_work_1', CONNECTOR_ID, WORK_INSTANCE_ID, 'files', 'file_1', 'application/pdf', 4096, 'abc123');
  getDb()
    .prepare(
      `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES (?, ?, ?, ?, ?, '@record')`,
    )
    .run('blob_work_1', CONNECTOR_ID, WORK_INSTANCE_ID, 'files', 'file_1');
  await rebuildRetainedSize();

  const summaries = await listConnectorSummaries();
  const rows = summaries.filter((row) => row.connector_id === CONNECTOR_ID);
  assert.equal(rows.length, 2);

  const work = rows.find((row) => row.connector_instance_id === WORK_INSTANCE_ID);
  const personal = rows.find((row) => row.connector_instance_id === PERSONAL_INSTANCE_ID);
  assert.ok(work);
  assert.ok(personal);

  assert.equal(work.connection_id, WORK_INSTANCE_ID);
  assert.equal(work.connector_id, CONNECTOR_ID);
  assert.equal(work.display_name, 'Work laptop');
  assert.equal(work.connector_display_name, 'Connection First Records');
  assert.equal(work.total_records, 2);
  assert.equal(work.stream_count, 2);
  assert.ok(work.total_retained_bytes >= 4096);

  assert.equal(personal.connection_id, PERSONAL_INSTANCE_ID);
  assert.equal(personal.total_records, 1);
  assert.equal(personal.stream_count, 1);
  assert.ok(personal.total_retained_bytes > 0);
  assert.ok(personal.total_retained_bytes < work.total_retained_bytes);
}));

test('reference connector summaries project local-device storage records under public connection rows', withTmpDb(async () => {
  seedConnector();
  await seedInstances();

  // Local-device records are stored under the bare connector key (the live
  // ingest path writes `recordStorageConnectorIdForConnection(instance)` ===
  // instance.connectorId), with connection isolation carried by
  // connector_instance_id. See canonicalize-connector-keys design Decision 7.
  const storageConnectorId = CONNECTOR_ID;
  seedRecord({
    connectorId: storageConnectorId,
    connectorInstanceId: WORK_INSTANCE_ID,
    stream: 'messages',
    key: 'local_msg_1',
    data: { id: 'local_msg_1', text: 'stored through local-device namespace' },
    emittedAt: '2026-05-20T12:04:00.000Z',
    version: 1,
  });
  getDb()
    .prepare(
      `INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run('blob_local_device_1', storageConnectorId, WORK_INSTANCE_ID, 'messages', 'local_msg_1', 'text/plain', 2048, 'def456');
  getDb()
    .prepare(
      `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES (?, ?, ?, ?, ?, '@record')`,
    )
    .run('blob_local_device_1', storageConnectorId, WORK_INSTANCE_ID, 'messages', 'local_msg_1');
  await rebuildRetainedSize();

  const summaries = await listConnectorSummaries();
  const work = summaries.find(
    (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID,
  );
  const personal = summaries.find(
    (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === PERSONAL_INSTANCE_ID,
  );
  assert.ok(work);
  assert.ok(personal);

  assert.equal(work.connector_id, CONNECTOR_ID);
  assert.equal(work.connector_instance_id, WORK_INSTANCE_ID);
  assert.equal(work.total_records, 1);
  assert.equal(work.stream_count, 1);
  assert.ok(work.total_retained_bytes >= 2048);

  assert.equal(personal.total_records, 0);
  assert.equal(personal.stream_count, 0);
}));

test('connection summaries do not smear browser-surface runs across sibling connections', withTmpDb(async () => {
  seedConnector();
  await seedInstances({ sourceKind: 'browser_collector' });

  await seedBrowserSurfaceRun({
    connectorInstanceId: WORK_INSTANCE_ID,
    runId: 'run_work_surface_failed',
    status: 'surface_failed',
    occurredAt: '2026-05-20T12:01:00.000Z',
    waitReason: 'surface_unhealthy',
  });
  await seedBrowserSurfaceRun({
    connectorInstanceId: PERSONAL_INSTANCE_ID,
    runId: 'run_personal_surface_failed',
    status: 'surface_failed',
    occurredAt: '2026-05-20T12:02:00.000Z',
    waitReason: 'capacity_full',
  });

  const summaries = await listConnectorSummaries();
  const work = summaries.find(
    (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID,
  );
  const personal = summaries.find(
    (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === PERSONAL_INSTANCE_ID,
  );
  assert.ok(work);
  assert.ok(personal);

  assert.equal(work.last_run?.run_id, 'run_work_surface_failed');
  assert.equal(work.last_run?.failure_reason, 'surface_unhealthy');
  assert.equal(personal.last_run?.run_id, 'run_personal_surface_failed');
  assert.equal(personal.last_run?.failure_reason, 'capacity_full');
}));

test('full-list shallow option omits run history while scoped summaries keep it', withTmpDb(async () => {
  seedConnector();
  await seedInstances({ sourceKind: 'browser_collector' });

  await seedBrowserSurfaceRun({
    connectorInstanceId: WORK_INSTANCE_ID,
    runId: 'run_work_surface_failed',
    status: 'surface_failed',
    occurredAt: '2026-05-20T12:01:00.000Z',
    waitReason: 'surface_unhealthy',
  });

  const shallowSummaries = await listConnectorSummaries(null, { includeRunSummaries: false });
  const shallowWork = shallowSummaries.find(
    (row) => row.connector_id === CONNECTOR_ID && row.connector_instance_id === WORK_INSTANCE_ID,
  );
  assert.ok(shallowWork);
  assert.equal(shallowWork.last_run, null);
  assert.equal(shallowWork.last_successful_run, null);
  assert.ok(shallowWork.rendered_verdict, 'shallow overview still carries the rendered verdict');

  const scopedWork = await getConnectorSummaryForRoute(WORK_INSTANCE_ID);
  assert.ok(scopedWork);
  assert.equal(scopedWork.last_run?.run_id, 'run_work_surface_failed');
  assert.equal(scopedWork.last_run?.failure_reason, 'surface_unhealthy');
}));

test('singleton-active overview hydrates only unambiguous active source run history', withTmpDb(async () => {
  seedConnector();
  await seedInstance({
    connectorInstanceId: WORK_INSTANCE_ID,
    displayName: 'Work laptop',
    sourceKind: 'browser_collector',
    sourceBindingKey: 'work',
    sourceBinding: { kind: 'browser_collector', device: 'work' },
  });
  await seedBrowserSurfaceRun({
    connectorInstanceId: WORK_INSTANCE_ID,
    runId: 'run_work_surface_failed',
    status: 'surface_failed',
    occurredAt: '2026-05-20T12:01:00.000Z',
    waitReason: 'surface_unhealthy',
  });

  const singleton = await listConnectorSummaries(null, { includeRunSummaries: 'singleton-active' });
  const singletonWork = singleton.find((row) => row.connector_instance_id === WORK_INSTANCE_ID);
  assert.ok(singletonWork);
  assert.equal(
    singletonWork.last_run?.run_id,
    'run_work_surface_failed',
    'singleton active source keeps enough evidence to avoid false Checking',
  );

  await seedInstance({
    connectorInstanceId: PERSONAL_INSTANCE_ID,
    displayName: 'Personal laptop',
    sourceKind: 'browser_collector',
    sourceBindingKey: 'personal',
    sourceBinding: { kind: 'browser_collector', device: 'personal' },
  });
  invalidateConnectorSummariesCache();
  const ambiguous = await listConnectorSummaries(null, { includeRunSummaries: 'singleton-active' });
  const ambiguousWork = ambiguous.find((row) => row.connector_instance_id === WORK_INSTANCE_ID);
  assert.ok(ambiguousWork);
  assert.equal(
    ambiguousWork.last_run?.run_id,
    'run_work_surface_failed',
    'duplicate active sources keep exact scoped run history without borrowing connector-wide runs',
  );
}));

test('multi-account overview hydrates exact scheduler run history per connection', withTmpDb(async () => {
  seedConnector();
  await seedInstances({ sourceKind: 'manual' });
  await seedSchedulerRunHistory({
    connectorInstanceId: WORK_INSTANCE_ID,
    runId: 'run_work_scheduler_history',
    startedAt: '2026-05-20T12:01:00.000Z',
    completedAt: '2026-05-20T12:02:00.000Z',
  });
  await seedSchedulerRunHistory({
    connectorInstanceId: PERSONAL_INSTANCE_ID,
    runId: 'run_personal_scheduler_history',
    startedAt: '2026-05-20T12:03:00.000Z',
    completedAt: '2026-05-20T12:04:00.000Z',
  });

  const summaries = await listConnectorSummaries(null, { includeRunSummaries: 'singleton-active' });
  const work = summaries.find((row) => row.connector_instance_id === WORK_INSTANCE_ID);
  const personal = summaries.find((row) => row.connector_instance_id === PERSONAL_INSTANCE_ID);

  assert.ok(work);
  assert.ok(personal);
  assert.equal(
    work.last_run?.run_id,
    'run_work_scheduler_history',
    'duplicate active sources use exact scheduler history instead of rendering unknown',
  );
  assert.equal(work.last_successful_run?.run_id, 'run_work_scheduler_history');
  assert.equal(
    personal.last_run?.run_id,
    'run_personal_scheduler_history',
    'sibling source keeps its own latest scheduler evidence',
  );
  assert.equal(personal.last_successful_run?.run_id, 'run_personal_scheduler_history');
}));

test('reference connector summaries keep revoked connections visible for owner manageability', withTmpDb(async () => {
  seedConnector();
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorInstanceId: REVOKED_INSTANCE_ID,
    ownerSubjectId: 'owner_local',
    connectorId: CONNECTOR_ID,
    displayName: 'Revoked account',
    status: 'revoked',
    revokedAt: REVOKED_AT,
    sourceKind: 'manual',
    sourceBindingKey: 'revoked',
    sourceBinding: { kind: 'manual', account: 'revoked' },
    createdAt: NOW,
    updatedAt: REVOKED_AT,
  });

  const summaries = await listConnectorSummaries();
  const revoked = summaries.find((row) => row.connector_instance_id === REVOKED_INSTANCE_ID);
  assert.ok(revoked, 'revoked connection remains in the owner connector summary list');
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revoked_at, REVOKED_AT);
  assert.equal(revoked.connection_id, REVOKED_INSTANCE_ID);

  const scoped = await getConnectorSummaryForRoute(REVOKED_INSTANCE_ID);
  assert.ok(scoped, 'revoked connection remains resolvable by its detail/list route id');
  assert.equal(scoped.status, 'revoked');
  assert.equal(scoped.revoked_at, REVOKED_AT);
}));

test('reference connector summaries hide retired setup shells from sources', withTmpDb(async () => {
  seedConnector();
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorInstanceId: REVOKED_INSTANCE_ID,
    ownerSubjectId: 'owner_local',
    connectorId: CONNECTOR_ID,
    displayName: 'Expired browser setup',
    status: 'revoked',
    revokedAt: REVOKED_AT,
    sourceKind: 'browser_collector',
    sourceBindingKey: 'expired-browser-shell',
    sourceBinding: {
      kind: 'browser_enrollment_shell',
      enrollment_expires_at: '2026-06-10T10:00:00.000Z',
    },
    createdAt: NOW,
    updatedAt: REVOKED_AT,
  });

  const summaries = await listConnectorSummaries();
  assert.equal(
    summaries.some((row) => row.connector_instance_id === REVOKED_INSTANCE_ID),
    false,
    'retired setup shells must not appear as revoked configured sources',
  );

  const scoped = await getConnectorSummaryForRoute(REVOKED_INSTANCE_ID);
  assert.equal(scoped, null, 'retired setup shells are not resolvable as source detail rows');
}));

// `observed_at` on connection-health condition rows is stamped at projection
// call time, so two projections of the same connection taken a millisecond apart
// differ only in that timestamp. Normalize it before asserting structural
// equality so the drift check compares the load-bearing projection, not the wall
// clock.
function withoutObservedAt(summary) {
  return stripObservedAt(summary);
}

function stripObservedAt(value) {
  if (Array.isArray(value)) {
    return value.map(stripObservedAt);
  }
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      if (key === 'observed_at') {
        continue;
      }
      output[key] = stripObservedAt(nested);
    }
    return output;
  }
  return value;
}

test('getConnectorSummaryForRoute resolves one connection by stable identity and matches its list entry', withTmpDb(async () => {
  // Two connections share CONNECTOR_ID. A record subpage routed to the WORK
  // connection must get exactly that connection's summary — and it must be
  // structurally identical (modulo the projection timestamp) to the entry the
  // all-connector list produces, since both go through the same per-connection
  // projection (no drift).
  seedConnector();
  await seedInstances({ sourceKind: 'manual' });
  seedRecord({
    connectorInstanceId: WORK_INSTANCE_ID,
    stream: 'messages',
    key: 'msg_1',
    data: { id: 'msg_1', text: 'work message' },
    emittedAt: '2026-05-20T12:01:00.000Z',
    version: 1,
  });
  await rebuildRetainedSize();

  const scoped = await getConnectorSummaryForRoute(WORK_INSTANCE_ID);
  assert.ok(scoped, 'a known connection id resolves to a summary');
  assert.equal(scoped.connector_instance_id, WORK_INSTANCE_ID);
  assert.equal(scoped.connection_id, WORK_INSTANCE_ID);
  assert.equal(scoped.total_records, 1);

  const summaries = await listConnectorSummaries();
  const listEntry = summaries.find((row) => row.connector_instance_id === WORK_INSTANCE_ID);
  assert.deepEqual(
    withoutObservedAt(scoped),
    withoutObservedAt(listEntry),
    'scoped summary is identical to the connection list entry (shared projection, no drift)',
  );
}));

test('getConnectorSummaryForRoute scopes retained records to the resolved connection', withTmpDb(async () => {
  seedConnector();
  await seedInstances({ sourceKind: 'manual' });
  seedRecord({
    connectorInstanceId: WORK_INSTANCE_ID,
    stream: 'messages',
    key: 'work_msg',
    data: { id: 'work_msg', text: 'work scoped message' },
    emittedAt: '2026-05-20T12:10:00.000Z',
    version: 1,
  });
  seedRecord({
    connectorInstanceId: PERSONAL_INSTANCE_ID,
    stream: 'messages',
    key: 'personal_msg',
    data: { id: 'personal_msg', text: 'personal sibling message' },
    emittedAt: '2026-05-20T12:11:00.000Z',
    version: 1,
  });
  await rebuildRetainedSize();

  const scoped = await getConnectorSummaryForRoute(WORK_INSTANCE_ID);

  assert.ok(scoped, 'a known connection id resolves to a summary');
  assert.equal(scoped.connection_id, WORK_INSTANCE_ID);
  assert.equal(scoped.connector_instance_id, WORK_INSTANCE_ID);
  assert.equal(scoped.connector_id, CONNECTOR_ID);
  assert.equal(scoped.total_records, 1, 'scoped route must not include sibling connection records');
  assert.deepEqual(scoped.stream_records, [
    {
      stream: 'messages',
      record_count: 1,
      last_updated: null,
    },
  ]);
}));

test('getConnectorSummaryForRoute allows connector_id fallback only when unambiguous', withTmpDb(async () => {
  seedConnector();
  await seedInstance({
    connectorInstanceId: WORK_INSTANCE_ID,
    displayName: 'Work laptop',
    sourceKind: 'manual',
    sourceBindingKey: 'work',
    sourceBinding: { kind: 'manual', device: 'work' },
  });

  const scoped = await getConnectorSummaryForRoute(CONNECTOR_ID);
  assert.ok(scoped, 'a connector_id-only route resolves when there is exactly one configured source');
  assert.equal(scoped.connector_id, CONNECTOR_ID);
  assert.equal(scoped.connector_instance_id, WORK_INSTANCE_ID);
}));

test('getConnectorSummaryForRoute refuses ambiguous connector_id fallback', withTmpDb(async () => {
  // Connector-type route fallback must not pick the first configured source
  // when several accounts/devices share a connector. Otherwise a source detail
  // page can attach sibling run evidence to the wrong source.
  seedConnector();
  await seedInstances({ sourceKind: 'manual' });

  const scoped = await getConnectorSummaryForRoute(CONNECTOR_ID);
  assert.equal(scoped, null);
}));

test('getConnectorSummaryForRoute returns null when nothing resolves', withTmpDb(async () => {
  seedConnector();
  await seedInstances({ sourceKind: 'manual' });
  const scoped = await getConnectorSummaryForRoute('cin_does_not_exist');
  assert.equal(scoped, null);
}));

// End-to-end proof for `surface-source-pressure-detail-gap-backlog` task 2.3:
// the snapshot's `detail_gap_backlog.recovered` is populated from the store's
// reason-scoped count-by-status aggregate (not fabricated, not aliased to
// pending). This drives the REAL default detail-gap store through
// `getConnectorDetailGapProjection`, so it proves the store → projection →
// snapshot wiring, not just the pure derivation (covered separately in
// connection-health-source-pressure-backlog.test.js).
test('connection summary surfaces a recovered count from the durable count-by-status aggregate', withTmpDb(async () => {
  seedConnector();
  await seedInstances({ sourceKind: 'manual' });

  const gapStore = getDefaultConnectorDetailGapStore();
  // Two still-pending source-pressure gaps on the WORK connection...
  await gapStore.upsertPendingGap({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: WORK_INSTANCE_ID,
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'pending_conv',
    reason: 'upstream_pressure',
  });
  await gapStore.upsertPendingGap({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: WORK_INSTANCE_ID,
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'pending_conv_2',
    reason: 'rate_limited',
  });
  // ...two recovered source-pressure gaps across sibling connections. The WORK
  // summary must count only the WORK row.
  for (const [instanceId, recordKey] of [
    [WORK_INSTANCE_ID, 'recovered_conv_1'],
    [PERSONAL_INSTANCE_ID, 'recovered_conv_2'],
  ]) {
    const gap = await gapStore.upsertPendingGap({
      connectorId: CONNECTOR_ID,
      connectorInstanceId: instanceId,
      grantId: 'grant_1',
      stream: 'messages',
      recordKey,
      reason: 'rate_limited',
    });
    await gapStore.markGapStatus(gap.gap_id, 'recovered', { runId: 'run_recovery' });
  }
  // ...and a recovered NON-source-pressure gap that must NOT inflate the count.
  const offReason = await gapStore.upsertPendingGap({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: WORK_INSTANCE_ID,
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'off_reason_conv',
    reason: 'temporary_unavailable',
  });
  await gapStore.markGapStatus(offReason.gap_id, 'recovered', { runId: 'run_recovery' });

  const summaries = await listConnectorSummaries();
  const work = summaries.find((row) => row.connector_instance_id === WORK_INSTANCE_ID);
  assert.ok(work, 'work connection projects a summary');

  const backlog = work.connection_health.detail_gap_backlog;
  assert.notEqual(backlog, null, 'a readable store yields a non-null backlog rollup');
  assert.equal(backlog.recovered, 1, 'recovered counts only source-pressure gaps for the projected connection');
  assert.equal(backlog.pending, 2, 'pending is the still-pending source-pressure gap count, distinct from recovered');
  // recovered must be a real count, never aliased to pending.
  assert.notEqual(backlog.recovered, backlog.pending);

  assert.ok(work.rendered_verdict, 'owner wire summary carries the synthesized rendered_verdict');
  assert.equal(
    work.rendered_verdict.detail.detail_gap_backlog.recovered,
    1,
    'owner-only rendered_verdict detail carries the recovered backlog count',
  );
  assert.equal(
    work.rendered_verdict.progress.gaps_drained_last_run,
    null,
    'all-time recovered count is not mislabeled as last-run progress',
  );
}));

// Proves the credential-evidence WIRING (not just the pure projection, which
// `connection-health.test.js` already covers): a static-secret-capable
// connection with no stored credential row must project `credential_required`
// through the real `listConnectorSummaries` / `getConnectorSummaryForRoute`
// read model, which reads non-secret metadata from the real credential store
// (`getConnectorCredentialStore().getMetadata`) inside
// `projectConnectorSummaryForInstance`.
test('connection summary projects credential_required for a static-secret connection with no stored credential', withTmpDb(async () => {
  seedStaticSecretConnector();
  await seedInstance({
    connectorInstanceId: STATIC_SECRET_INSTANCE_ID,
    connectorId: STATIC_SECRET_CONNECTOR_ID,
    displayName: 'Static secret account',
    sourceKind: 'account',
    sourceBindingKey: 'static-secret',
    sourceBinding: { kind: 'account' },
  });

  const summaries = await listConnectorSummaries();
  const work = summaries.find((row) => row.connector_instance_id === STATIC_SECRET_INSTANCE_ID);
  assert.ok(work, 'static-secret connection projects a summary');

  const credentials = work.connection_health.conditions?.find(
    (c) => c.type === 'CredentialsValid' && c.status === 'false',
  );
  assert.ok(credentials, 'a CredentialsValid=false condition is projected');
  assert.equal(credentials.reason, CONNECTION_CONDITION_REASONS.CREDENTIAL_REQUIRED);
  assert.equal(credentials.remediation?.action, 'refresh_credentials');

  // The scoped route resolves through the same projection and must agree.
  const scoped = await getConnectorSummaryForRoute(STATIC_SECRET_INSTANCE_ID);
  assert.ok(scoped);
  const scopedCredentials = scoped.connection_health.conditions?.find(
    (c) => c.type === 'CredentialsValid' && c.status === 'false',
  );
  assert.equal(scopedCredentials?.reason, CONNECTION_CONDITION_REASONS.CREDENTIAL_REQUIRED);
}));

// ChatGPT-shaped case (Tim's live symptom): a connector that is BOTH
// static-secret-capable AND browser-bound, enrolled with a `browser_collector`
// binding, with no stored credential. The steady-state repair the owner is
// routed to MUST be a durable credential reauth/capture action — NOT a
// browser-stream action. (The one-off browser stream was a *runtime* behavior,
// fixed in auto-login/chatgpt.ts; the projection here proves the owner-facing
// CTA is credential capture, and that no browser-session action kind exists to
// be selected instead.)
const CHATGPT_SHAPED_CONNECTOR_ID = 'connection_first_browser_static_secret';
const CHATGPT_SHAPED_INSTANCE_ID = 'cin_browser_static_secret';

function seedBrowserBoundStaticSecretConnector() {
  const manifest = {
    protocol_version: '0.1.0',
    connector_id: CHATGPT_SHAPED_CONNECTOR_ID,
    version: '1.0.0',
    display_name: 'Browser + Static Secret',
    capabilities: { public_listing: { listed: true, status: 'test' } },
    // Static-secret-capable: has a credential_capture surface.
    setup: {
      modality: 'static_secret',
      credential_capture: {
        kind: 'username_password',
        fields: [
          { name: 'username', label: 'Email', secret: true },
          { name: 'password', label: 'Password', secret: true },
        ],
      },
    },
    // Browser-bound: requires a browser runtime binding (like chatgpt.json).
    runtime_requirements: { bindings: { network: { required: true }, browser: { required: true } } },
    streams: [{ name: 'messages', primary_key: ['id'] }],
  };
  getDb()
    .prepare('INSERT INTO connectors(connector_id, manifest, created_at) VALUES (?, ?, ?)')
    .run(CHATGPT_SHAPED_CONNECTOR_ID, JSON.stringify(manifest), NOW);
}

test('ChatGPT-shaped browser_collector connection with no credential does NOT project credential_required (binding-first: session repair, not static-secret capture)', withTmpDb(async () => {
  seedBrowserBoundStaticSecretConnector();
  // Mirror the live dondochaka shape exactly: source_kind is `account`, and the
  // browser_collector fact lives in source_binding.kind (not source_kind). This
  // connection logs in via the browser session (e.g. Google SSO), so an absent
  // credential row is normal — NOT a "capture a username/password" repair need.
  await seedInstance({
    connectorInstanceId: CHATGPT_SHAPED_INSTANCE_ID,
    connectorId: CHATGPT_SHAPED_CONNECTOR_ID,
    displayName: 'ChatGPT - dondochaka-like',
    sourceKind: 'account',
    sourceBindingKey: 'browser-static-secret',
    sourceBinding: { kind: 'browser_collector', device: 'personal' },
  });

  const scoped = await getConnectorSummaryForRoute(CHATGPT_SHAPED_INSTANCE_ID);
  assert.ok(scoped, 'the browser_collector connection projects a summary');

  // Binding-first: the connection is browser-session-bound, so credential-store
  // absence MUST NOT project credential_required (that would route the owner to
  // static-secret credential capture for a connection with no stored credential
  // to capture — the SSO case). Its repair is browser/session repair.
  const credentialRequired = scoped.connection_health.conditions?.find(
    (c) => c.type === 'CredentialsValid' && c.reason === CONNECTION_CONDITION_REASONS.CREDENTIAL_REQUIRED,
  );
  assert.equal(credentialRequired, undefined, 'browser-session connection must not project credential_required');

  // The connection carries its browser-session binding so owner surfaces route
  // repair binding-first (browser/session repair, not static-secret capture).
  assert.equal(scoped.source_binding_kind, 'browser_collector');
}));

test('static-secret-BOUND connection with no credential DOES project credential_required (capture path preserved)', withTmpDb(async () => {
  // Same static-secret-capable + browser-bound connector, but this connection is
  // bound as `account` (NOT browser_collector) — the static-secret path, like
  // ChatGPT - everyone@ (default_account). Here credential capture IS the repair.
  seedBrowserBoundStaticSecretConnector();
  await seedInstance({
    connectorInstanceId: 'cin_account_static_secret',
    connectorId: CHATGPT_SHAPED_CONNECTOR_ID,
    displayName: 'ChatGPT - account static secret',
    sourceKind: 'account',
    sourceBindingKey: 'account-static-secret',
    sourceBinding: { kind: 'account' },
  });

  const scoped = await getConnectorSummaryForRoute('cin_account_static_secret');
  assert.ok(scoped);
  const credentials = scoped.connection_health.conditions?.find(
    (c) => c.type === 'CredentialsValid' && c.status === 'false',
  );
  assert.ok(credentials, 'a CredentialsValid=false condition is projected');
  assert.equal(credentials.reason, CONNECTION_CONDITION_REASONS.CREDENTIAL_REQUIRED);
  assert.equal(scoped.source_binding_kind, 'account');
}));

// False-positive guard: a credential-store READ FAILURE must NOT be read as
// "no stored credential". Only a successful getMetadata returning null means
// no row. A transient store/DB error must fall back to prior run-reason-derived
// behavior (evidence unavailable), never a false owner "reconnect" prompt.
test('credential-store read failure does NOT project credential_required (evidence unavailable, not "no credential")', withTmpDb(async () => {
  seedBrowserBoundStaticSecretConnector();
  await seedInstance({
    connectorInstanceId: CHATGPT_SHAPED_INSTANCE_ID,
    connectorId: CHATGPT_SHAPED_CONNECTOR_ID,
    displayName: 'ChatGPT - store read failure',
    sourceKind: 'account',
    sourceBindingKey: 'browser-static-secret',
    sourceBinding: { kind: 'browser_collector', device: 'personal' },
  });

  // Force the credential-store read to throw: drop the credential table so
  // `getMetadata`'s SELECT fails. This is the read-failure path, distinct from
  // "no row" (an empty-but-present table).
  getDb().prepare('DROP TABLE connector_instance_credentials').run();
  invalidateConnectorSummariesCache();

  const scoped = await getConnectorSummaryForRoute(CHATGPT_SHAPED_INSTANCE_ID);
  assert.ok(scoped, 'the summary still projects (store failure is non-fatal)');

  // The credential axis must NOT be projected as blocked/credential_required on
  // a mere read failure. With no credential-shaped run evidence either, the
  // honest projection is unknown (not-probed) — never a false reconnect prompt.
  const credentialRequired = scoped.connection_health.conditions?.find(
    (c) => c.type === 'CredentialsValid' && c.reason === CONNECTION_CONDITION_REASONS.CREDENTIAL_REQUIRED,
  );
  assert.equal(credentialRequired, undefined, 'a store read failure must not surface credential_required');

  const credentialsFalse = scoped.connection_health.conditions?.find(
    (c) => c.type === 'CredentialsValid' && c.status === 'false',
  );
  assert.equal(credentialsFalse, undefined, 'no CredentialsValid=false condition from a read failure alone');

  // And no owner reauth CTA is fabricated from the read failure.
  for (const action of scoped.rendered_verdict?.required_actions ?? []) {
    assert.notEqual(action.kind, 'reauth');
  }
}));

// Same wiring, the rejected-credential branch: a captured-then-rejected
// credential must project `credential_rejected`, distinct from
// `credential_required`, proving the projection reads the store's `rejected`
// status rather than only presence.
test('connection summary projects credential_rejected for a static-secret connection whose stored credential was rejected', withTmpDb(async () => {
  seedStaticSecretConnector();
  await seedInstance({
    connectorInstanceId: STATIC_SECRET_INSTANCE_ID,
    connectorId: STATIC_SECRET_CONNECTOR_ID,
    displayName: 'Static secret account',
    sourceKind: 'account',
    sourceBindingKey: 'static-secret',
    sourceBinding: { kind: 'account' },
  });

  await withCredentialKey(TEST_CREDENTIAL_KEY, async () => {
    const credentialStore = createSqliteConnectorInstanceCredentialStore({
      env: { [CREDENTIAL_ENCRYPTION_KEY_ENV]: TEST_CREDENTIAL_KEY },
    });
    await credentialStore.capture({
      connectorInstanceId: STATIC_SECRET_INSTANCE_ID,
      ownerSubjectId: 'owner_local',
      credentialKind: 'app_password',
      secret: 'synthetic-app-password',
      now: NOW,
    });
    await credentialStore.markRejected({
      connectorInstanceId: STATIC_SECRET_INSTANCE_ID,
      rejectedAt: '2026-05-20T12:05:00.000Z',
      reason: 'provider_rejected_synthetic',
    });

    const summaries = await listConnectorSummaries();
    const work = summaries.find((row) => row.connector_instance_id === STATIC_SECRET_INSTANCE_ID);
    assert.ok(work, 'static-secret connection projects a summary');

    const credentials = work.connection_health.conditions?.find(
      (c) => c.type === 'CredentialsValid' && c.status === 'false',
    );
    assert.ok(credentials, 'a CredentialsValid=false condition is projected');
    assert.equal(credentials.reason, CONNECTION_CONDITION_REASONS.CREDENTIAL_REJECTED);
    assert.equal(credentials.remediation?.action, 'refresh_credentials');
  });
}));
