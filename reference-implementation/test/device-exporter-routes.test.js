import assert from 'node:assert/strict';
import test from 'node:test';

import { getDb } from '../server/db.js';
import { startServer } from '../server/index.js';

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
  try {
    parsed = await resp.json();
  } catch {}
  return { body: parsed, status: resp.status };
}

async function enrollDevice(asUrl, localBindingName) {
  const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: 'codex',
    local_binding_name: localBindingName,
  });
  assert.equal(codeResp.status, 201);
  assert.equal(codeResp.body.object, 'device_exporter_enrollment_code');

  const enrollResp = await postJson(`${asUrl}/_ref/device-exporters/enroll`, {
    enrollment_code: codeResp.body.enrollment_code,
  });
  assert.equal(enrollResp.status, 201);
  assert.equal(enrollResp.body.object, 'device_exporter_enrollment');
  return enrollResp.body;
}

function authHeaders(deviceToken) {
  return { Authorization: `Bearer ${deviceToken}` };
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
        data: { id: 'same-key', value },
        emitted_at: '2026-04-30T12:00:00.000Z',
        record_key: 'same-key',
        stream: 'messages',
      },
    ],
    source_instance_id: device.source_instance_id,
  };
}

function internalStorageConnectorId(connectorId, sourceInstanceId) {
  return `local-device:${encodeURIComponent(connectorId)}:${encodeURIComponent(sourceInstanceId)}`;
}

test('device exporter routes enroll, heartbeat, ingest idempotently, isolate source instances, and revoke', async () => {
  await withServer(async ({ asUrl }) => {
    const missingAuth = await postJson(`${asUrl}/_ref/device-exporters/dev_missing/heartbeat`, {});
    assert.equal(missingAuth.status, 401);
    assert.equal(missingAuth.body.error.code, 'authentication_error');

    const first = await enrollDevice(asUrl, 'laptop-a');
    const second = await enrollDevice(asUrl, 'laptop-b');
    assert.notEqual(first.source_instance_id, second.source_instance_id);

    getDb().prepare(
      `INSERT INTO tokens(token_id, grant_id, subject_id, client_id, token_kind, expires_at)
       VALUES(?, NULL, ?, NULL, 'owner', ?)`,
    ).run('owner-token-for-device-route-test', 'owner_ref', '2999-01-01T00:00:00.000Z');
    const ownerTokenRejected = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/heartbeat`,
      { source_instances: [{ source_instance_id: first.source_instance_id }] },
      authHeaders('owner-token-for-device-route-test'),
    );
    assert.equal(ownerTokenRejected.status, 403);
    assert.equal(ownerTokenRejected.body.error.code, 'permission_error');

    const heartbeat = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/heartbeat`,
      {
        connector_id: 'codex',
        records_pending: 0,
        source_instance_id: first.source_instance_id,
        status: 'healthy',
      },
      authHeaders(first.device_token),
    );
    assert.equal(heartbeat.status, 200);
    assert.equal(heartbeat.body.status, 'accepted');

    const firstBatch = makeBatch(first, 'batch-1', 'first');
    const ingest = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/ingest-batches`,
      firstBatch,
      authHeaders(first.device_token),
    );
    assert.equal(ingest.status, 201);
    assert.equal(ingest.body.accepted_record_count, 1);

    const replay = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/ingest-batches`,
      firstBatch,
      authHeaders(first.device_token),
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.status, 'replayed');

    const conflict = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/ingest-batches`,
      { ...firstBatch, body_hash: 'different-hash' },
      authHeaders(first.device_token),
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'device_batch_conflict');

    const secondBatch = makeBatch(second, 'batch-2', 'second');
    const secondIngest = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(second.device_id)}/ingest-batches`,
      secondBatch,
      authHeaders(second.device_token),
    );
    assert.equal(secondIngest.status, 201);

    const db = getDb();
    const firstRow = db.prepare('SELECT record_json FROM records WHERE connector_id = ? AND stream = ? AND record_key = ?').get(
      internalStorageConnectorId('codex', first.source_instance_id),
      'messages',
      'same-key',
    );
    const secondRow = db.prepare('SELECT record_json FROM records WHERE connector_id = ? AND stream = ? AND record_key = ?').get(
      internalStorageConnectorId('codex', second.source_instance_id),
      'messages',
      'same-key',
    );
    assert.equal(JSON.parse(firstRow.record_json).value, 'first');
    assert.equal(JSON.parse(secondRow.record_json).value, 'second');

    const diagnosticsResp = await fetch(`${asUrl}/_ref/device-exporters/diagnostics`, {
      headers: { Accept: 'application/json' },
    });
    assert.equal(diagnosticsResp.status, 200);
    const diagnostics = await diagnosticsResp.json();
    assert.equal(diagnostics.data.length, 2);
    const firstDiagnostics = diagnostics.data.find((device) => device.device_id === first.device_id);
    assert.ok(Number.isFinite(Date.parse(firstDiagnostics.last_heartbeat_at)));
    assert.equal(firstDiagnostics.source_instances[0].accepted_record_count, 1);

    const revokeResp = await postJson(`${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/revoke`, {});
    assert.equal(revokeResp.status, 200);

    const revokedHeartbeat = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/heartbeat`,
      { source_instances: [{ source_instance_id: first.source_instance_id }] },
      authHeaders(first.device_token),
    );
    assert.equal(revokedHeartbeat.status, 401);
  });
});
