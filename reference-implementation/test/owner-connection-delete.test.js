/**
 * Integration suite for the bearer-authed owner-agent connection-DELETE control
 * routes (mounted from `server/routes/owner-connection-delete.ts`):
 *
 *   DELETE /v1/owner/connections/:connectionId
 *   DELETE /v1/owner/connectors/:connectorId
 *
 * This is the implementation lane for `add-owner-connection-delete-contract`. It
 * proves the destructive cascade against each invariant the contract specifies:
 *
 *   - cascade completeness: a connection's records, record_changes, version
 *     counters, blobs, blob bindings, lexical search index, attention records,
 *     and schedule are all erased, the connector_instances row is gone, and a
 *     device source-instance back-ref is cleared (set null) while the device row
 *     itself survives (the controller_active_runs lease is never erased — an
 *     in-flight run is refused, not deleted);
 *   - no-sibling-overreach (I1): a sibling connection of the same connector type
 *     and a sibling connection on the same device keep their row + records +
 *     collectability;
 *   - records unreadable after delete (revoke != delete contrast): the deleted
 *     connection's records are physically gone, not merely status-flipped;
 *   - audit preserved (I3): prior spine events survive and a non-secret
 *     owner_agent.connection.delete event is appended with the deletion summary;
 *   - idempotency (I4): first delete 200, second 404 connector_instance_not_found;
 *   - foreign / unknown (I5): foreign-owner and unknown ids → 404, no
 *     cross-owner deletion, no existence leak;
 *   - default-account no-resurrection (I6 / Decision 1 fallback): a
 *     default-account connection is refused with default_account_delete_unsupported
 *     so its deterministic id cannot silently re-materialize;
 *   - active-run refusal (I7): delete under an active-run lease → 409
 *     connection_run_active, no rows erased;
 *   - grants untouched (I10): a disclosure grant for the connector type is
 *     unchanged after delete;
 *   - auth: missing bearer 401, client grant 403 (audited), revoked owner-agent
 *     credential 401, owner bearer on /mcp 403 (re-pin);
 *   - connector-only ambiguity / auto-select;
 *   - the control surface advertises delete_connection as supported with the
 *     DELETE URL.
 *
 * Spec: openspec/changes/add-owner-connection-delete-contract
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { exec, referenceQueries } from '../lib/db.ts';
import { listSpineEventsPage } from '../lib/spine.ts';
import { canonicalConnectorKey } from '../server/connector-key.js';
import { getDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { ingestRecord } from '../server/records.js';
import {
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from '../server/stores/connector-instance-store.js';
import { createSqliteSchedulerStore } from '../server/stores/scheduler-store.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const OWNER_SUBJECT_ID = 'owner_local';
const OTHER_SUBJECT_ID = 'owner_other';
const OWNER_CLIENT_ID = 'cli_longview';
const NOW = '2026-05-31T00:00:00.000Z';

async function closeServer(server) {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const text = await resp.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, resp, status: resp.status };
}

async function withServer(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: '',
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl, server });
  } finally {
    await closeServer(server);
  }
}

async function issueOwnerToken(asUrl, subjectId = OWNER_SUBJECT_ID) {
  const device = (await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: OWNER_CLIENT_ID }).toString(),
  })).body;
  await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
  });
  const tok = (await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: OWNER_CLIENT_ID,
    }).toString(),
  })).body;
  assert.ok(tok.access_token, 'device exchange should issue an owner token');
  return tok.access_token;
}

async function approveClientGrant(asUrl, connectorId, streamName) {
  const par = (await fetchJson(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: 'longview',
      authorization_details: [{
        type: 'https://pdpp.org/data-access',
        source: { kind: 'connector', id: connectorId },
        purpose_code: 'https://pdpp.org/purpose/analytics',
        purpose_description: 'owner-connection delete boundary test',
        access_mode: 'continuous',
        streams: [{ name: streamName, fields: ['id'] }],
      }],
    }),
  })).body;
  const approved = (await fetchJson(`${asUrl}/consent/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ request_uri: par.request_uri, subject_id: OWNER_SUBJECT_ID }),
  })).body;
  assert.ok(approved.token, 'consent approval should issue a client grant token');
  return approved.token;
}

function loadReferenceManifest(name) {
  return JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, 'manifests', `${name}.json`), 'utf8'));
}

async function registerConnector(asUrl, manifest) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.equal(resp.status, 201, `register ${manifest.connector_id} failed: ${resp.status}`);
  return manifest;
}

async function seedInstance({
  connectorInstanceId,
  connectorId,
  displayName,
  sourceBindingKey,
  sourceKind = 'account',
  sourceBinding,
  ownerSubjectId = OWNER_SUBJECT_ID,
}) {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorInstanceId,
    ownerSubjectId,
    connectorId,
    displayName,
    status: 'active',
    sourceKind,
    sourceBindingKey,
    sourceBinding: sourceBinding ?? { account_hint: sourceBindingKey },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function getInstance(connectorInstanceId) {
  return createSqliteConnectorInstanceStore().get(connectorInstanceId);
}

// ─── Direct table reads/writes for cascade assertions ──────────────────────
// A connection-delete erases rows the high-level ingest path does not let us
// observe through projections; counting them directly is the honest proof.

function countRows(table, connectorInstanceId) {
  return getDb()
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE connector_instance_id = ?`)
    .get(connectorInstanceId).n;
}

function countLexical(connectorInstanceId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM lexical_search_index WHERE connector_instance_id = ?')
    .get(connectorInstanceId).n;
}

// Seed a lexical search-index row for a connection directly. The ingest path
// only indexes fields a registered search config declares searchable (a
// separate backfill step), so seeding the row directly gives the cascade a
// deterministic lexical row to prove it tears down — matching the FTS columns.
function seedLexical({ connectorId, connectorInstanceId, stream, recordKey }) {
  getDb()
    .prepare(
      `INSERT INTO lexical_search_index(connector_id, connector_instance_id, stream, record_key, field, text)
       VALUES(?, ?, ?, ?, 'name', 'alpha track')`,
    )
    .run(connectorId, connectorInstanceId, stream, recordKey);
}

// Seed a blob + binding for a connection so the cascade has blob rows to erase.
function seedBlob({ connectorId, connectorInstanceId, stream, recordKey, blobId }) {
  getDb()
    .prepare(
      `INSERT INTO blobs(blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(blobId, connectorId, connectorInstanceId, stream, recordKey, 'text/plain', 3, 'deadbeef', Buffer.from('abc'));
  getDb()
    .prepare(
      `INSERT INTO blob_bindings(blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES(?, ?, ?, ?, ?, '@record')`,
    )
    .run(blobId, connectorId, connectorInstanceId, stream, recordKey);
}

// Seed an open attention record for a connection.
function seedAttention({ connectorId, connectorInstanceId, attentionId }) {
  getDb()
    .prepare(
      `INSERT INTO connector_attention_records(
        attention_id, dedupe_key, connector_id, connector_instance_id, connection_id,
        run_id, reason_code, lifecycle, sensitivity, expires_at, record_json, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, NULL, 'auth_expired', 'open', 'non_secret', NULL, '{}', ?, ?)`,
    )
    .run(attentionId, attentionId, connectorId, connectorInstanceId, connectorInstanceId, NOW, NOW);
}

// Seed a device + source-instance back-reference at one connection.
function seedDeviceSourceInstance({ deviceId, connectorId, connectorInstanceId, sourceInstanceId, localBindingId }) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
       VALUES(?, ?, ?, 'active', ?, ?)`,
    )
    .run(deviceId, OWNER_SUBJECT_ID, deviceId, NOW, NOW);
  getDb()
    .prepare(
      `INSERT INTO device_source_instances(
        source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id,
        display_name, status, created_at, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    )
    .run(sourceInstanceId, deviceId, connectorId, connectorInstanceId, localBindingId, sourceInstanceId, NOW, NOW);
}

function getSourceInstance(sourceInstanceId) {
  return getDb()
    .prepare('SELECT * FROM device_source_instances WHERE source_instance_id = ?')
    .get(sourceInstanceId);
}

function seedSchedule(connectorInstanceId, connectorId) {
  createSqliteSchedulerStore().createSchedule({
    connector_instance_id: connectorInstanceId,
    connector_id: connectorId,
    interval_seconds: 3600,
    jitter_seconds: 0,
    enabled: true,
    created_at: NOW,
    updated_at: NOW,
  });
}

function seedActiveRun(connectorInstanceId, connectorId) {
  createSqliteSchedulerStore().upsertActiveRun({
    connector_instance_id: connectorInstanceId,
    connector_id: connectorId,
    run_id: `run_${connectorInstanceId}`,
    trace_id: 'trc_test',
    scenario_id: 'default',
    started_at: NOW,
    run_generation: 1,
  });
}

function scheduleRowCount(connectorInstanceId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM connector_schedules WHERE connector_instance_id = ?')
    .get(connectorInstanceId).n;
}

function activeRunRowCount(connectorInstanceId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM controller_active_runs WHERE connector_instance_id = ?')
    .get(connectorInstanceId).n;
}

async function deleteConnection(rsUrl, ownerToken, path) {
  return fetchJson(`${rsUrl}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
  });
}

function findDeleteAuditEvent(resp) {
  const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
  assert.ok(traceId?.startsWith('trc_'), 'delete response should carry an audit trace id');
  const page = listSpineEventsPage('trace', traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === 'owner_agent.connection.delete');
  assert.ok(event, 'expected owner-agent delete audit event');
  assert.equal(event.request_id, resp.headers.get('Request-Id'));
  assert.equal(event.token_id, null, 'audit event must not store bearer tokens');
  const serialized = JSON.stringify(event);
  assert.ok(!/Bearer\s/i.test(serialized), 'audit must not carry a bearer token');
  assert.ok(!serialized.includes('access_token'), 'audit must not carry an access token');
  return event;
}

test('owner-agent delete erases a connection completely: records, history, blobs, search, attention, schedule, row', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const stream = manifest.streams[0].name;
    const cin = 'cin_spotify_personal';
    await seedInstance({ connectorInstanceId: cin, connectorId: connectorKey, displayName: 'My Spotify', sourceBindingKey: 'the owner@example.com' });

    const storageTarget = { connector_id: connectorKey, connector_instance_id: cin };
    await ingestRecord(storageTarget, { stream, key: 'rec_1', data: { id: 'rec_1', name: 'alpha track' } });
    await ingestRecord(storageTarget, { stream, key: 'rec_2', data: { id: 'rec_2', name: 'beta track' } });
    seedBlob({ connectorId: connectorKey, connectorInstanceId: cin, stream, recordKey: 'rec_1', blobId: 'blob_1' });
    seedAttention({ connectorId: connectorKey, connectorInstanceId: cin, attentionId: 'att_1' });
    seedLexical({ connectorId: connectorKey, connectorInstanceId: cin, stream, recordKey: 'rec_1' });
    seedSchedule(cin, connectorKey);

    // Pre-delete: every cascade table has rows for this connection.
    assert.equal(countRows('records', cin), 2, 'records before');
    assert.ok(countRows('record_changes', cin) >= 2, 'record_changes before');
    assert.equal(countRows('version_counter', cin), 1, 'version_counter before');
    assert.equal(countRows('blobs', cin), 1, 'blobs before');
    assert.equal(countRows('blob_bindings', cin), 1, 'blob_bindings before');
    assert.equal(countRows('connector_attention_records', cin), 1, 'attention before');
    assert.ok(countLexical(cin) >= 1, 'lexical index before');
    assert.equal(scheduleRowCount(cin), 1, 'schedule before');

    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, `/v1/owner/connections/${cin}`);
    assert.equal(del.status, 200);
    assert.equal(del.body?.object, 'owner_connection_delete');
    assert.equal(del.body?.connection_id, cin);
    assert.equal(del.body?.deleted, true);
    assert.equal(del.body?.deleted_record_count, 2);
    assert.equal(del.body?.deleted_stream_count, 1);
    assert.equal(del.body?.schedule_deleted, true);

    // Post-delete: every cascade table is empty for this connection, and the
    // connector_instances row is gone.
    assert.equal(countRows('records', cin), 0, 'records erased');
    assert.equal(countRows('record_changes', cin), 0, 'record_changes erased');
    assert.equal(countRows('version_counter', cin), 0, 'version_counter erased');
    assert.equal(countRows('blobs', cin), 0, 'blobs erased');
    assert.equal(countRows('blob_bindings', cin), 0, 'blob_bindings erased');
    assert.equal(countRows('connector_attention_records', cin), 0, 'attention erased');
    assert.equal(countLexical(cin), 0, 'lexical index erased');
    assert.equal(scheduleRowCount(cin), 0, 'schedule erased');
    assert.equal(getInstance(cin), null, 'connector_instances row gone');

    const audit = findDeleteAuditEvent(del.resp);
    assert.equal(audit.actor_type, 'owner_agent');
    assert.equal(audit.object_id, cin);
    assert.equal(audit.status, 'succeeded');
    assert.equal(audit.data?.operation, 'delete');
    assert.equal(audit.data?.selector, 'connection_id');
    assert.equal(audit.data?.deletion_summary?.deleted_record_count, 2);
    assert.equal(audit.data?.deletion_summary?.schedule_deleted, true);
  });
});

test('owner-agent delete does not over-reach: a sibling connection of the same connector stays intact (I1)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const stream = manifest.streams[0].name;
    await seedInstance({ connectorInstanceId: 'cin_a', connectorId: connectorKey, displayName: 'A', sourceBindingKey: 'a@example.com' });
    await seedInstance({ connectorInstanceId: 'cin_b', connectorId: connectorKey, displayName: 'B', sourceBindingKey: 'b@example.com' });
    await ingestRecord({ connector_id: connectorKey, connector_instance_id: 'cin_a' }, { stream, key: 'a1', data: { id: 'a1' } });
    await ingestRecord({ connector_id: connectorKey, connector_instance_id: 'cin_b' }, { stream, key: 'b1', data: { id: 'b1' } });

    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, '/v1/owner/connections/cin_a');
    assert.equal(del.status, 200);

    // cin_a gone; cin_b fully intact and still collectable.
    assert.equal(getInstance('cin_a'), null);
    assert.equal(countRows('records', 'cin_a'), 0);
    const sibling = getInstance('cin_b');
    assert.equal(sibling.status, 'active', 'sibling row intact');
    assert.equal(countRows('records', 'cin_b'), 1, 'sibling records intact');
    await ingestRecord({ connector_id: connectorKey, connector_instance_id: 'cin_b' }, { stream, key: 'b2', data: { id: 'b2' } });
    assert.equal(countRows('records', 'cin_b'), 2, 'sibling still collectable');
  });
});

test('owner-agent delete clears the device back-reference but preserves the device edge and sibling on the same device', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({ connectorInstanceId: 'cin_dev_a', connectorId: connectorKey, displayName: 'Dev A', sourceBindingKey: 'da', sourceKind: 'local_device' });
    await seedInstance({ connectorInstanceId: 'cin_dev_b', connectorId: connectorKey, displayName: 'Dev B', sourceBindingKey: 'db', sourceKind: 'local_device' });
    seedDeviceSourceInstance({ deviceId: 'dev_1', connectorId: connectorKey, connectorInstanceId: 'cin_dev_a', sourceInstanceId: 'dsi_a', localBindingId: 'lb_a' });
    seedDeviceSourceInstance({ deviceId: 'dev_1', connectorId: connectorKey, connectorInstanceId: 'cin_dev_b', sourceInstanceId: 'dsi_b', localBindingId: 'lb_b' });

    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, '/v1/owner/connections/cin_dev_a');
    assert.equal(del.status, 200);
    assert.equal(del.body?.device_refs_cleared, 1, 'one device back-ref cleared');

    // dsi_a's back-reference is cleared (null) but the device-edge row survives.
    const dsiA = getSourceInstance('dsi_a');
    assert.ok(dsiA, 'device source-instance row survives delete');
    assert.equal(dsiA.connector_instance_id, null, 'back-reference cleared to null');
    // The sibling on the same device is fully untouched.
    const dsiB = getSourceInstance('dsi_b');
    assert.equal(dsiB.connector_instance_id, 'cin_dev_b', 'sibling back-ref untouched');
    assert.equal(getInstance('cin_dev_b').status, 'active', 'sibling connection intact');
    // The device exporter row itself is not deleted/revoked.
    const device = getDb().prepare('SELECT status FROM device_exporters WHERE device_id = ?').get('dev_1');
    assert.equal(device.status, 'active', 'device enrollment not revoked by connection delete');
  });
});

test('owner-agent delete refuses while an active run lease exists (I7) and erases nothing', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const stream = manifest.streams[0].name;
    const cin = 'cin_running';
    await seedInstance({ connectorInstanceId: cin, connectorId: connectorKey, displayName: 'Running', sourceBindingKey: 'r@example.com' });
    await ingestRecord({ connector_id: connectorKey, connector_instance_id: cin }, { stream, key: 'r1', data: { id: 'r1' } });
    seedActiveRun(cin, connectorKey);

    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, `/v1/owner/connections/${cin}`);
    assert.equal(del.status, 409);
    assert.equal(del.body?.error?.code, 'connection_run_active');

    // Nothing erased: row, records, and the active-run lease all survive.
    assert.equal(getInstance(cin).status, 'active', 'row survives refused delete');
    assert.equal(countRows('records', cin), 1, 'records survive refused delete');
    assert.equal(activeRunRowCount(cin), 1, 'active-run lease untouched');

    const audit = findDeleteAuditEvent(del.resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.data?.error?.code, 'connection_run_active');
    assert.equal(audit.data?.error?.http_status, 409);
  });
});

test('owner-agent delete refuses a default-account connection (I6) so its deterministic id cannot re-materialize', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('github'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const store = createSqliteConnectorInstanceStore();
    const defaultId = makeDefaultAccountConnectorInstanceId(OWNER_SUBJECT_ID, connectorKey);
    await store.ensureDefaultAccountConnection({
      ownerSubjectId: OWNER_SUBJECT_ID,
      connectorId: connectorKey,
      displayName: manifest.display_name || connectorKey,
      now: NOW,
    });
    assert.equal(getInstance(defaultId).status, 'active');

    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, `/v1/owner/connections/${defaultId}`);
    assert.equal(del.status, 409);
    assert.equal(del.body?.error?.code, 'default_account_delete_unsupported');

    // The default-account row is untouched (still active) — not hard-deleted and
    // therefore not subject to silent re-materialization.
    assert.equal(getInstance(defaultId).status, 'active', 'default-account row untouched');

    const audit = findDeleteAuditEvent(del.resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.data?.error?.code, 'default_account_delete_unsupported');
  });
});

test('owner-agent delete is idempotent-by-typed-error: first 200, second 404 connector_instance_not_found (I4)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const cin = 'cin_once';
    await seedInstance({ connectorInstanceId: cin, connectorId: connectorKey, displayName: 'Once', sourceBindingKey: 'o@example.com' });
    const ownerToken = await issueOwnerToken(asUrl);

    const first = await deleteConnection(rsUrl, ownerToken, `/v1/owner/connections/${cin}`);
    assert.equal(first.status, 200);

    const second = await deleteConnection(rsUrl, ownerToken, `/v1/owner/connections/${cin}`);
    assert.equal(second.status, 404);
    assert.equal(second.body?.error?.code, 'connector_instance_not_found');
  });
});

test('owner-agent delete on an unknown connection_id returns a typed 404 (I5)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await deleteConnection(rsUrl, ownerToken, '/v1/owner/connections/cin_missing');
    assert.equal(status, 404);
    assert.equal(body?.error?.code, 'connector_instance_not_found');
    const audit = findDeleteAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.object_id, 'cin_missing');
  });
});

test('owner-agent delete cannot cross owners (foreign connection is not found and not erased) (I5)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_foreign',
      connectorId: connectorKey,
      displayName: 'Foreign',
      sourceBindingKey: 'f@example.com',
      ownerSubjectId: OTHER_SUBJECT_ID,
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await deleteConnection(rsUrl, ownerToken, '/v1/owner/connections/cin_foreign');
    assert.equal(status, 404);
    assert.equal(body?.error?.code, 'connector_instance_not_found');
    // The foreign connection still exists.
    assert.equal(getInstance('cin_foreign').status, 'active', 'foreign connection not erased');
  });
});

test('owner-agent connector-only delete auto-selects the single active connection', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({ connectorInstanceId: 'cin_solo', connectorId: connectorKey, displayName: 'Solo', sourceBindingKey: 's@example.com' });
    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, `/v1/owner/connectors/${encodeURIComponent(connectorKey)}`);
    assert.equal(del.status, 200);
    assert.equal(del.body?.connection_id, 'cin_solo');
    assert.equal(getInstance('cin_solo'), null);
    const audit = findDeleteAuditEvent(del.resp);
    assert.equal(audit.data?.selector, 'connector_id');
  });
});

test('owner-agent connector-only delete rejects two active connections with typed ambiguous_connection', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({ connectorInstanceId: 'cin_x', connectorId: connectorKey, displayName: 'X', sourceBindingKey: 'x@example.com' });
    await seedInstance({ connectorInstanceId: 'cin_y', connectorId: connectorKey, displayName: 'Y', sourceBindingKey: 'y@example.com' });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await deleteConnection(rsUrl, ownerToken, `/v1/owner/connectors/${encodeURIComponent(connectorKey)}`);
    assert.equal(status, 409);
    assert.equal(body?.error?.code, 'ambiguous_connection');
    assert.equal(body?.error?.retry_with, 'connection_id');
    // Neither connection was deleted.
    assert.equal(getInstance('cin_x').status, 'active');
    assert.equal(getInstance('cin_y').status, 'active');
  });
});

test('owner-agent delete leaves disclosure grants untouched (I10)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const stream = manifest.streams[0].name;
    // A non-default explicit account connection so delete is allowed while a
    // disclosure grant for the connector type exists.
    await seedInstance({ connectorInstanceId: 'cin_grantable', connectorId: connectorKey, displayName: 'Grantable', sourceBindingKey: 'g@example.com' });
    await approveClientGrant(asUrl, connectorKey, stream);
    // The PAR/consent flow records a row in `grants` (status + scope + members
    // live there); delete must not touch it.
    const grantsBefore = getDb().prepare("SELECT grant_id, status FROM grants WHERE status = 'active'").all();
    assert.ok(grantsBefore.length >= 1, 'an active disclosure grant should exist');

    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, '/v1/owner/connections/cin_grantable');
    assert.equal(del.status, 200);

    const grantsAfter = getDb().prepare("SELECT grant_id, status FROM grants WHERE status = 'active'").all();
    assert.deepEqual(
      grantsAfter.map((g) => g.grant_id).sort(),
      grantsBefore.map((g) => g.grant_id).sort(),
      'active disclosure grants unchanged in identity and status by connection delete',
    );
  });
});

test('owner-agent delete preserves the audit spine: prior events survive, a delete event is appended (I3)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const stream = manifest.streams[0].name;
    const cin = 'cin_audited';
    await seedInstance({ connectorInstanceId: cin, connectorId: connectorKey, displayName: 'Audited', sourceBindingKey: 'au@example.com' });
    await ingestRecord({ connector_id: connectorKey, connector_instance_id: cin }, { stream, key: 'a1', data: { id: 'a1' } });

    const spineBefore = getDb().prepare('SELECT COUNT(*) AS n FROM spine_events').get().n;
    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteConnection(rsUrl, ownerToken, `/v1/owner/connections/${cin}`);
    assert.equal(del.status, 200);

    const spineAfter = getDb().prepare('SELECT COUNT(*) AS n FROM spine_events').get().n;
    assert.ok(spineAfter > spineBefore, 'spine grew (delete event appended), never shrank');
    const deleteEvents = getDb()
      .prepare("SELECT COUNT(*) AS n FROM spine_events WHERE event_type = 'owner_agent.connection.delete'")
      .get().n;
    assert.equal(deleteEvents, 1, 'exactly one delete audit event appended');
  });
});

test('owner-agent delete rejects a client grant token with 403 and audits it', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({ connectorInstanceId: 'cin_cli', connectorId: connectorKey, displayName: 'Cli', sourceBindingKey: 'c@example.com' });
    const clientToken = await approveClientGrant(asUrl, connectorKey, manifest.streams[0].name);

    const { status, body, resp } = await deleteConnection(rsUrl, clientToken, '/v1/owner/connections/cin_cli');
    assert.equal(status, 403);
    assert.equal(body?.error?.code, 'permission_error');
    assert.equal(getInstance('cin_cli').status, 'active', 'client could not delete');

    const audit = findDeleteAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.actor_type, 'client');
    assert.equal(audit.data?.operation, 'delete');
  });
});

test('owner-agent delete rejects a request with no bearer (401)', async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections/cin_any`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    assert.equal(status, 401);
    assert.equal(body?.error?.type, 'authentication_error');
  });
});

test('a revoked owner-agent credential cannot delete a connection (401)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({ connectorInstanceId: 'cin_dead', connectorId: connectorKey, displayName: 'Dead', sourceBindingKey: 'd@example.com' });
    const ownerToken = await issueOwnerToken(asUrl);
    exec(referenceQueries.authTokensRevokeByClientId, [OWNER_CLIENT_ID]);
    const { status, body } = await deleteConnection(rsUrl, ownerToken, '/v1/owner/connections/cin_dead');
    assert.equal(status, 401);
    assert.equal(body?.error?.type, 'authentication_error');
    assert.equal(getInstance('cin_dead').status, 'active', 'dead credential could not delete');
  });
});

test('/mcp continues to reject owner-agent bearers after delete control lands (I9)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await fetchJson(`${rsUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ownerToken}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(status, 403);
    assert.equal(body?.error?.code, 'permission_error');
    assert.match(body?.error?.message ?? '', /owner-agent/i);
  });
});

test('owner-agent control document advertises delete_connection as supported with a DELETE URL', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const del = body.actions.find((a) => a.family === 'delete_connection');
    assert.ok(del, 'delete_connection must be advertised');
    assert.equal(del.status, 'supported');
    assert.equal(del.method, 'DELETE');
    assert.equal(del.url, `${rsUrl}/v1/owner/connections/{connection_id}`);
  });
});
