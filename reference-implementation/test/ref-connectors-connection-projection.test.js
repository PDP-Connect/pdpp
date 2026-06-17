import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { closeDb, getDb, initDb } from '../server/db.js';
import { emitSpineEvent } from '../lib/spine.ts';
import { getConnectorSummaryForRoute, invalidateConnectorSummariesCache, listConnectorSummaries } from '../server/ref-control.ts';
import { rebuildRetainedSize } from '../server/retained-size-read-model.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { getDefaultConnectorDetailGapStore } from '../server/stores/connector-detail-gap-store.js';

const CONNECTOR_ID = 'https://test.pdpp.dev/connectors/connection-first-records';
const WORK_INSTANCE_ID = 'cin_test_connection_first_work';
const PERSONAL_INSTANCE_ID = 'cin_test_connection_first_personal';
const REVOKED_INSTANCE_ID = 'cin_test_connection_first_revoked';
const NOW = '2026-05-20T12:00:00.000Z';
const REVOKED_AT = '2026-06-10T19:10:28.476Z';

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
    connectorId: CONNECTOR_ID,
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
    ambiguousWork.last_run,
    null,
    'duplicate active sources must not borrow connector-wide run history on the overview',
  );
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
  // One still-pending source-pressure gap on the WORK connection...
  await gapStore.upsertPendingGap({
    connectorId: CONNECTOR_ID,
    connectorInstanceId: WORK_INSTANCE_ID,
    grantId: 'grant_1',
    stream: 'messages',
    recordKey: 'pending_conv',
    reason: 'upstream_pressure',
  });
  // ...two recovered source-pressure gaps (across both connections — the count
  // is connector-wide, matching the pending read's scope)...
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
  assert.equal(backlog.recovered, 2, 'recovered counts only recovered source-pressure gaps, connector-wide');
  assert.equal(backlog.pending, 1, 'pending is the still-pending source-pressure gap, distinct from recovered');
  // recovered must be a real count, never aliased to pending.
  assert.notEqual(backlog.recovered, backlog.pending);

  assert.ok(work.rendered_verdict, 'owner wire summary carries the synthesized rendered_verdict');
  assert.equal(
    work.rendered_verdict.detail.detail_gap_backlog.recovered,
    2,
    'owner-only rendered_verdict detail carries the recovered backlog count',
  );
  assert.equal(
    work.rendered_verdict.progress.gaps_drained_last_run,
    null,
    'all-time recovered count is not mislabeled as last-run progress',
  );
}));
