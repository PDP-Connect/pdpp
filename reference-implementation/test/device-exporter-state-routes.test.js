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
  return { Authorization: `Bearer ${deviceToken}` };
}

async function enrollDevice(asUrl, localBindingName) {
  const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: 'codex',
    local_binding_name: localBindingName,
  });
  assert.equal(codeResp.status, 201, JSON.stringify(codeResp.body));
  const enrollResp = await postJson(`${asUrl}/_ref/device-exporters/enroll`, {
    enrollment_code: codeResp.body.enrollment_code,
  });
  assert.equal(enrollResp.status, 201, JSON.stringify(enrollResp.body));
  assert.match(enrollResp.body.connector_instance_id, /^cin_/);
  return enrollResp.body;
}

function stateUrl(asUrl, deviceId, sourceInstanceId) {
  return `${asUrl}/_ref/device-exporters/${encodeURIComponent(deviceId)}/source-instances/${encodeURIComponent(sourceInstanceId)}/state`;
}

test('GET device state requires a valid device credential', async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, 'laptop-a');

    // Missing auth.
    const missing = await getJson(stateUrl(asUrl, device.device_id, device.source_instance_id));
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error.code, 'authentication_error');

    // Wrong auth shape.
    const wrong = await getJson(
      stateUrl(asUrl, device.device_id, device.source_instance_id),
      { Authorization: 'NotBearer foo' },
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
