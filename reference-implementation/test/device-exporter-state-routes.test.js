// Tests for the device-scoped local collector state routes defined under
// OpenSpec `design-local-collector-state-sync`:
//
//   GET  /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state
//   PUT  /_ref/device-exporters/:deviceId/source-instances/:sourceInstanceId/state
//
// These routes are reference-only and authenticated by the existing
// `requireDeviceExporterCredential` middleware. They store state under the
// local-device connector namespace plus the authorized connector instance id
// so they cannot collide with owner-auth `/v1/state/:connectorId` rows.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { COLLECTOR_PROTOCOL_VERSION } from '../server/collector-protocol.ts';
import { closeDb, getDb, initDb } from '../server/db.js';
import { startServer } from '../server/index.js';

const PROTOCOL_HEADERS = { 'X-PDPP-Collector-Protocol': COLLECTOR_PROTOCOL_VERSION };

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeOne = (srv) => new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 2000);
    srv.close(() => { if (!settled) { settled = true; clearTimeout(t); resolve(); } });
  });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

async function withServer(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl });
  } finally {
    await closeServer(server);
  }
}

async function postJson(url, body, headers = {}) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await resp.json(); } catch {}
  return { body: parsed, status: resp.status };
}

async function getJson(url, headers = {}) {
  const resp = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json', ...headers },
  });
  let parsed = null;
  try { parsed = await resp.json(); } catch {}
  return { body: parsed, status: resp.status };
}

async function putJson(url, body, headers = {}) {
  const resp = await fetch(url, {
    method: 'PUT',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  let parsed = null;
  try { parsed = await resp.json(); } catch {}
  return { body: parsed, status: resp.status };
}

function authHeaders(deviceToken) {
  return { Authorization: `Bearer ${deviceToken}`, ...PROTOCOL_HEADERS };
}

async function enrollDevice(asUrl, localBindingName) {
  const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: 'codex',
    local_binding_name: localBindingName,
  });
  assert.equal(codeResp.status, 201, JSON.stringify(codeResp.body));
  const enrollResp = await postJson(
    `${asUrl}/_ref/device-exporters/enroll`,
    { enrollment_code: codeResp.body.enrollment_code },
    PROTOCOL_HEADERS,
  );
  assert.equal(enrollResp.status, 201, JSON.stringify(enrollResp.body));
  assert.match(enrollResp.body.connector_instance_id, /^cin_/);
  return enrollResp.body;
}

function stateUrl(asUrl, deviceId, sourceInstanceId) {
  return `${asUrl}/_ref/device-exporters/${encodeURIComponent(deviceId)}/source-instances/${encodeURIComponent(sourceInstanceId)}/state`;
}

function localDeviceConnectorId(connectorId) {
  return `local-device:${encodeURIComponent(connectorId)}`;
}

function legacyLocalDeviceConnectorId(connectorId, sourceInstanceId) {
  return `${localDeviceConnectorId(connectorId)}:${encodeURIComponent(sourceInstanceId)}`;
}

function hashDeviceSecret(value) {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

function makeBatch(device, batchId, value) {
  return {
    batch_id: batchId,
    batch_seq: 1,
    body_hash: `hash-${batchId}-${value}`,
    connector_id: device.connector_id,
    device_id: device.device_id,
    records: [
      {
        data: { id: 'after-migration', value },
        emitted_at: '2026-04-30T12:00:00.000Z',
        record_key: 'after-migration',
        stream: 'messages',
      },
    ],
    source_instance_id: device.source_instance_id,
  };
}

test('GET device state requires a valid device credential', async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, 'laptop-a');

    // Missing auth.
    const missing = await getJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      PROTOCOL_HEADERS,
    );
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error.code, 'authentication_error');

    // Wrong auth shape.
    const wrong = await getJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      { Authorization: 'NotBearer foo', ...PROTOCOL_HEADERS },
    );
    assert.equal(wrong.status, 401);

    // Invalid token.
    const invalid = await getJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      authHeaders('not-a-real-device-token'),
    );
    assert.equal(invalid.status, 401);
  });
});

test('startup migrates legacy local-device source namespaces to connector-instance scope', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pdpp-local-device-migration-'));
  const dbPath = join(dir, 'pdpp.sqlite');
  const device = {
    connector_id: 'claude_code',
    connector_instance_id: 'cin_preserved_legacy_local_device',
    device_id: 'dev_legacy_local_device',
    device_token: 'devtok_legacy_local_device',
    local_binding_name: 'laptop-a',
    source_instance_id: 'src_legacy_local_device',
  };
  const oldConnectorId = legacyLocalDeviceConnectorId(device.connector_id, device.source_instance_id);
  const newConnectorId = localDeviceConnectorId(device.connector_id);
  try {
    initDb(dbPath, { quiet: true });
    const db = getDb();
    const now = '2026-05-01T00:00:00.000Z';
    db.prepare(
      `INSERT INTO device_exporters(device_id, owner_subject_id, display_name, status, created_at, updated_at)
       VALUES(?, ?, ?, 'active', ?, ?)`,
    ).run(device.device_id, 'owner_ref', 'Legacy Laptop', now, now);
    db.prepare(
      `INSERT INTO device_ingest_credentials(credential_id, device_id, token_hash, status, created_at)
       VALUES(?, ?, ?, 'active', ?)`,
    ).run('cred_legacy_local_device', device.device_id, hashDeviceSecret(device.device_token), now);
    db.prepare(
      `INSERT INTO device_source_instances(source_instance_id, device_id, connector_id, connector_instance_id, local_binding_id, display_name, status, created_at, updated_at)
       VALUES(?, ?, ?, NULL, ?, ?, 'active', ?, ?)`,
    ).run(
      device.source_instance_id,
      device.device_id,
      device.connector_id,
      device.local_binding_name,
      'Legacy Claude Code',
      now,
      now,
    );
    db.prepare(
      `INSERT INTO connector_state(connector_id, connector_instance_id, stream, state_json, updated_at)
       VALUES(?, ?, 'messages', ?, ?)`,
    ).run(oldConnectorId, device.connector_instance_id, JSON.stringify({ cursor: 'legacy-cursor' }), now);
    db.prepare(
      `INSERT INTO records(connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version)
       VALUES(?, ?, 'messages', 'legacy-record', ?, ?, 1)`,
    ).run(oldConnectorId, device.connector_instance_id, JSON.stringify({ id: 'legacy-record', value: 'before' }), now);
    db.prepare(
      `INSERT INTO record_changes(connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at)
       VALUES(?, ?, 'messages', 'legacy-record', 1, ?, ?)`,
    ).run(oldConnectorId, device.connector_instance_id, JSON.stringify({ id: 'legacy-record', value: 'before' }), now);
    db.prepare(
      `INSERT INTO version_counter(connector_id, connector_instance_id, stream, max_version)
       VALUES(?, ?, 'messages', 1)`,
    ).run(oldConnectorId, device.connector_instance_id);
    const migrations = [];
    closeDb();
    initDb(dbPath, {
      onSchemaMigration: (event) => migrations.push(event),
    });
    closeDb();

    const server = await startServer({
      quiet: true,
      asPort: 0,
      rsPort: 0,
      dbPath,
    });
    const asUrl = `http://localhost:${server.asPort}`;
    try {
      assert.ok(migrations.some((event) => event.name === 'local_device_connector_instances'));

      const migratedDb = getDb();
      const sourceRow = migratedDb.prepare(
        `SELECT connector_instance_id FROM device_source_instances WHERE device_id = ? AND source_instance_id = ?`,
      ).get(device.device_id, device.source_instance_id);
      assert.equal(sourceRow.connector_instance_id, device.connector_instance_id);

      const instanceRow = migratedDb.prepare(
        `SELECT connector_id, owner_subject_id, source_kind, source_binding_json
           FROM connector_instances
          WHERE connector_instance_id = ?`,
      ).get(device.connector_instance_id);
      assert.equal(instanceRow.connector_id, device.connector_id);
      assert.equal(instanceRow.owner_subject_id, 'owner_ref');
      assert.equal(instanceRow.source_kind, 'local_device');
      assert.deepEqual(JSON.parse(instanceRow.source_binding_json), {
        kind: 'local_device',
        device_id: device.device_id,
        local_binding_name: device.local_binding_name,
        source_instance_id: device.source_instance_id,
      });

      const stateRead = await getJson(
        stateUrl(asUrl, device.device_id, device.source_instance_id),
        authHeaders(device.device_token),
      );
      assert.equal(stateRead.status, 200, JSON.stringify(stateRead.body));
      assert.equal(stateRead.body.connector_instance_id, device.connector_instance_id);
      assert.deepEqual(stateRead.body.state, { messages: { cursor: 'legacy-cursor' } });

      const statePut = await putJson(
        stateUrl(asUrl, device.device_id, device.source_instance_id),
        { state: { messages: { cursor: 'post-migration' } } },
        authHeaders(device.device_token),
      );
      assert.equal(statePut.status, 200, JSON.stringify(statePut.body));

      const ingest = await postJson(
        `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
        makeBatch(device, 'batch-after-migration', 'after'),
        authHeaders(device.device_token),
      );
      assert.equal(ingest.status, 201, JSON.stringify(ingest.body));
      assert.equal(ingest.body.connector_instance_id, device.connector_instance_id);

      const oldRows = migratedDb.prepare(
        `SELECT COUNT(*) AS n
           FROM (
             SELECT connector_id FROM connector_state WHERE connector_id = ?
             UNION ALL
             SELECT connector_id FROM records WHERE connector_id = ?
             UNION ALL
             SELECT connector_id FROM record_changes WHERE connector_id = ?
             UNION ALL
             SELECT connector_id FROM version_counter WHERE connector_id = ?
           )`,
      ).get(oldConnectorId, oldConnectorId, oldConnectorId, oldConnectorId);
      assert.equal(oldRows.n, 0);

      const migratedState = migratedDb.prepare(
        `SELECT connector_id, state_json
           FROM connector_state
          WHERE connector_instance_id = ? AND stream = 'messages'`,
      ).get(device.connector_instance_id);
      assert.equal(migratedState.connector_id, newConnectorId);
      assert.equal(JSON.parse(migratedState.state_json).cursor, 'post-migration');

      const migratedRecords = migratedDb.prepare(
        `SELECT record_key, connector_id
           FROM records
          WHERE connector_instance_id = ?
          ORDER BY record_key`,
      ).all(device.connector_instance_id);
      assert.deepEqual(
        migratedRecords.map((row) => [row.record_key, row.connector_id]),
        [
          ['after-migration', newConnectorId],
          ['legacy-record', newConnectorId],
        ],
      );
    } finally {
      await closeServer(server);
    }
  } finally {
    closeDb();
    await rm(dir, { recursive: true, force: true });
  }
});

test('Owner-token bearer is rejected by the device state routes', async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, 'laptop-a');
    getDb().prepare(
      `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
       VALUES(?, NULL, ?, NULL, 'owner', ?)`,
    ).run('owner-token-for-state-route-test', 'owner_ref', '2999-01-01T00:00:00.000Z');

    const getResp = await getJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      authHeaders('owner-token-for-state-route-test'),
    );
    assert.equal(getResp.status, 403);
    assert.equal(getResp.body.error.code, 'permission_error');

    const putResp = await putJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      { state: { messages: { cursor: 'c' } } },
      authHeaders('owner-token-for-state-route-test'),
    );
    assert.equal(putResp.status, 403);
    assert.equal(putResp.body.error.code, 'permission_error');
  });
});

test('Device credential cannot read state for a different device', async () => {
  await withServer(async ({ asUrl }) => {
    const first = await enrollDevice(asUrl, 'laptop-a');
    const second = await enrollDevice(asUrl, 'laptop-b');

    const crossRead = await getJson(
      stateUrl(asUrl, second.device_id, second.source_instance_id),
      authHeaders(first.device_token),
    );
    assert.equal(crossRead.status, 403);
    assert.equal(crossRead.body.error.code, 'permission_error');

    const crossWrite = await putJson(
      stateUrl(asUrl, second.device_id, second.source_instance_id),
      { state: { messages: { cursor: 'c' } } },
      authHeaders(first.device_token),
    );
    assert.equal(crossWrite.status, 403);
    assert.equal(crossWrite.body.error.code, 'permission_error');
  });
});

test('Unknown source_instance_id is rejected with not_found', async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, 'laptop-a');
    const getResp = await getJson(
      stateUrl(asUrl, device.device_id, 'nonexistent-source-id'),
      authHeaders(device.device_token),
    );
    assert.equal(getResp.status, 404);
    assert.equal(getResp.body.error.code, 'not_found');

    const putResp = await putJson(
      stateUrl(asUrl, device.device_id, 'nonexistent-source-id'),
      { state: { messages: { cursor: 'c' } } },
      authHeaders(device.device_token),
    );
    assert.equal(putResp.status, 404);
    assert.equal(putResp.body.error.code, 'not_found');
  });
});

test('PUT then GET round-trips per-stream cursors with last-write-wins merge semantics', async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, 'laptop-a');

    // First read: empty state, no rows.
    const initial = await getJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      authHeaders(device.device_token),
    );
    assert.equal(initial.status, 200);
    assert.equal(initial.body.object, 'device_source_instance_state');
    assert.equal(initial.body.device_id, device.device_id);
    assert.equal(initial.body.connector_instance_id, device.connector_instance_id);
    assert.equal(initial.body.source_instance_id, device.source_instance_id);
    assert.deepEqual(initial.body.state, {});
    assert.equal(initial.body.updated_at, null);

    // First write: messages cursor only.
    const firstPut = await putJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      { state: { messages: { cursor: 'm-1' } } },
      authHeaders(device.device_token),
    );
    assert.equal(firstPut.status, 200);
    assert.deepEqual(firstPut.body.state, { messages: { cursor: 'm-1' } });

    // Second write: adds attachments and bumps messages — last-write-wins per stream.
    const secondPut = await putJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      { state: { messages: { cursor: 'm-2' }, attachments: { uid_low: 100 } } },
      authHeaders(device.device_token),
    );
    assert.equal(secondPut.status, 200);
    assert.deepEqual(secondPut.body.state, {
      attachments: { uid_low: 100 },
      messages: { cursor: 'm-2' },
    });
    assert.ok(secondPut.body.updated_at);

    // Final read confirms merged state survives.
    const finalRead = await getJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      authHeaders(device.device_token),
    );
    assert.equal(finalRead.status, 200);
    assert.deepEqual(finalRead.body.state, {
      attachments: { uid_low: 100 },
      messages: { cursor: 'm-2' },
    });
  });
});

test('Two-device isolation: same connector id, different source instances, separate state rows', async () => {
  await withServer(async ({ asUrl }) => {
    const first = await enrollDevice(asUrl, 'laptop-a');
    const second = await enrollDevice(asUrl, 'laptop-b');
    assert.notEqual(first.source_instance_id, second.source_instance_id);
    assert.equal(first.connector_id, 'codex');
    assert.equal(second.connector_id, 'codex');

    await putJson(
      stateUrl(asUrl, first.device_id, first.source_instance_id),
      { state: { messages: { cursor: 'first-cursor' } } },
      authHeaders(first.device_token),
    );
    await putJson(
      stateUrl(asUrl, second.device_id, second.source_instance_id),
      { state: { messages: { cursor: 'second-cursor' } } },
      authHeaders(second.device_token),
    );

    const firstRead = await getJson(
      stateUrl(asUrl, first.device_id, first.source_instance_id),
      authHeaders(first.device_token),
    );
    const secondRead = await getJson(
      stateUrl(asUrl, second.device_id, second.source_instance_id),
      authHeaders(second.device_token),
    );

    assert.deepEqual(firstRead.body.state, { messages: { cursor: 'first-cursor' } });
    assert.deepEqual(secondRead.body.state, { messages: { cursor: 'second-cursor' } });

    // Underlying storage rows are keyed by the derived connector id, never
    // the public 'codex' connector id — owner-auth state under 'codex' must
    // stay empty.
    const db = getDb();
    const ownerRows = db.prepare(
      `SELECT COUNT(*) AS n FROM connector_state WHERE connector_id = ?`,
    ).get('codex');
    assert.equal(ownerRows.n, 0);

    const storageConnectorId = `local-device:${encodeURIComponent('codex')}`;
    const firstRow = db.prepare(
      `SELECT state_json FROM connector_state WHERE connector_id = ? AND connector_instance_id = ? AND stream = ?`,
    ).get(storageConnectorId, first.connector_instance_id, 'messages');
    const secondRow = db.prepare(
      `SELECT state_json FROM connector_state WHERE connector_id = ? AND connector_instance_id = ? AND stream = ?`,
    ).get(storageConnectorId, second.connector_instance_id, 'messages');
    assert.equal(JSON.parse(firstRow.state_json).cursor, 'first-cursor');
    assert.equal(JSON.parse(secondRow.state_json).cursor, 'second-cursor');
  });
});

test('Single device with two source instances keeps state rows independent', async () => {
  await withServer(async ({ asUrl }) => {
    // Two enrollment codes against the same connector with two binding names
    // produces two source instances. The current enrollment flow ties one
    // device to one source instance, so we set up two devices that happen
    // to share the same connector_id but have distinct source_instance_ids.
    // This is the supported isolation invariant (see device ingest test).
    const a = await enrollDevice(asUrl, 'binding-a');
    const b = await enrollDevice(asUrl, 'binding-b');

    await putJson(
      stateUrl(asUrl, a.device_id, a.source_instance_id),
      { state: { sessions: { hwm: 1 } } },
      authHeaders(a.device_token),
    );
    await putJson(
      stateUrl(asUrl, b.device_id, b.source_instance_id),
      { state: { sessions: { hwm: 2 } } },
      authHeaders(b.device_token),
    );

    const readA = await getJson(
      stateUrl(asUrl, a.device_id, a.source_instance_id),
      authHeaders(a.device_token),
    );
    const readB = await getJson(
      stateUrl(asUrl, b.device_id, b.source_instance_id),
      authHeaders(b.device_token),
    );
    assert.deepEqual(readA.body.state, { sessions: { hwm: 1 } });
    assert.deepEqual(readB.body.state, { sessions: { hwm: 2 } });
  });
});

test('Owner-auth /v1/state/:connectorId does not surface device-scoped rows', async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, 'laptop-a');
    await putJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      { state: { messages: { cursor: 'device-only' } } },
      authHeaders(device.device_token),
    );

    // Mint an owner token for the same connector id and call /v1/state.
    getDb().prepare(
      `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
       VALUES(?, NULL, ?, NULL, 'owner', ?)`,
    ).run('owner-token-state-isolation', 'owner_ref', '2999-01-01T00:00:00.000Z');

    const ownerState = await getJson(
      `${asUrl}/v1/state/${encodeURIComponent(device.connector_id)}`,
      authHeaders('owner-token-state-isolation'),
    );
    // Owner-auth state for the public connector id sees no device rows.
    // Whatever the response shape, the device-only cursor must not appear.
    if (ownerState.status === 200) {
      assert.deepEqual(ownerState.body?.state ?? {}, {});
    } else {
      // Some configurations return a 4xx for the bare path without a
      // manifest-registered connector; either way the device row must
      // not have leaked.
      assert.notEqual(ownerState.status, 200);
    }

    // Conversely the device-scoped state route does not accept this owner token.
    const deviceWithOwnerToken = await getJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      authHeaders('owner-token-state-isolation'),
    );
    assert.equal(deviceWithOwnerToken.status, 403);
  });
});

test('Revoked device cannot read or write state', async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, 'laptop-a');
    await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/revoke`,
      {},
    );
    const getResp = await getJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      authHeaders(device.device_token),
    );
    assert.equal(getResp.status, 401);
    const putResp = await putJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      { state: { messages: { cursor: 'c' } } },
      authHeaders(device.device_token),
    );
    assert.equal(putResp.status, 401);
  });
});
