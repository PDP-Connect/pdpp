import assert from 'node:assert/strict';
import test from 'node:test';

import { COLLECTOR_PROTOCOL_VERSION } from '../server/collector-protocol.ts';
import { getDb } from '../server/db.js';
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

  const enrollResp = await postJson(
    `${asUrl}/_ref/device-exporters/enroll`,
    { enrollment_code: codeResp.body.enrollment_code },
    PROTOCOL_HEADERS,
  );
  assert.equal(enrollResp.status, 201);
  assert.equal(enrollResp.body.object, 'device_exporter_enrollment');
  assert.match(enrollResp.body.connector_instance_id, /^cin_/);
  return enrollResp.body;
}

function authHeaders(deviceToken) {
  return { Authorization: `Bearer ${deviceToken}`, ...PROTOCOL_HEADERS };
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

function internalStorageConnectorId(connectorId) {
  return `local-device:${encodeURIComponent(connectorId)}`;
}

test('device exporter routes enroll, heartbeat, ingest idempotently, isolate source instances, and revoke', async () => {
  await withServer(async ({ asUrl }) => {
    const missingAuth = await postJson(
      `${asUrl}/_ref/device-exporters/dev_missing/heartbeat`,
      {},
      PROTOCOL_HEADERS,
    );
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
    assert.equal(ingest.body.connector_instance_id, first.connector_instance_id);
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
    assert.equal(secondIngest.body.connector_instance_id, second.connector_instance_id);

    const db = getDb();
    const instanceRows = db.prepare(
      `SELECT connector_instance_id, record_json
         FROM records
        WHERE connector_id = ? AND stream = ? AND record_key = ?
        ORDER BY connector_instance_id`,
    ).all(internalStorageConnectorId('codex'), 'messages', 'same-key');
    assert.equal(instanceRows.length, 2);
    assert.deepEqual(
      new Map(instanceRows.map((row) => [row.connector_instance_id, JSON.parse(row.record_json).value])),
      new Map([
        [first.connector_instance_id, 'first'],
        [second.connector_instance_id, 'second'],
      ]),
    );

    const diagnosticsResp = await fetch(`${asUrl}/_ref/device-exporters/diagnostics`, {
      headers: { Accept: 'application/json' },
    });
    assert.equal(diagnosticsResp.status, 200);
    const diagnostics = await diagnosticsResp.json();
    assert.equal(diagnostics.data.length, 2);
    const firstDiagnostics = diagnostics.data.find((device) => device.device_id === first.device_id);
    assert.ok(Number.isFinite(Date.parse(firstDiagnostics.last_heartbeat_at)));
    assert.equal(firstDiagnostics.source_instances[0].connector_instance_id, first.connector_instance_id);
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

test('enroll rejects missing collector protocol header with 409 collector_protocol_mismatch and persists nothing', async () => {
  await withServer(async ({ asUrl }) => {
    const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: 'codex',
      local_binding_name: 'laptop-c',
    });
    assert.equal(codeResp.status, 201);

    // No X-PDPP-Collector-Protocol header — must fail before any device row
    // is created.
    const enrollResp = await postJson(`${asUrl}/_ref/device-exporters/enroll`, {
      enrollment_code: codeResp.body.enrollment_code,
    });
    assert.equal(enrollResp.status, 409);
    assert.equal(enrollResp.body.error.code, 'collector_protocol_mismatch');
    assert.ok(Array.isArray(enrollResp.body.error.accepted_versions));
    assert.ok(enrollResp.body.error.accepted_versions.length > 0);
    assert.equal(enrollResp.body.error.received_version, null);

    // The enrollment code should still be pending — the rejected enroll
    // must not have consumed it.
    const retry = await postJson(
      `${asUrl}/_ref/device-exporters/enroll`,
      { enrollment_code: codeResp.body.enrollment_code },
      PROTOCOL_HEADERS,
    );
    assert.equal(retry.status, 201);

    // And no devices should exist beyond the one we just enrolled — the
    // earlier mismatch must not have leaked a device row.
    const rows = getDb()
      .prepare('SELECT COUNT(*) as n FROM device_exporters')
      .get();
    assert.equal(rows.n, 1);
  });
});

test('enroll persists collector_protocol_version on the device row', async () => {
  await withServer(async ({ asUrl }) => {
    const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: 'codex',
      local_binding_name: 'laptop-d',
    });
    assert.equal(codeResp.status, 201);
    const enrollResp = await postJson(
      `${asUrl}/_ref/device-exporters/enroll`,
      { enrollment_code: codeResp.body.enrollment_code },
      PROTOCOL_HEADERS,
    );
    assert.equal(enrollResp.status, 201);

    const row = getDb()
      .prepare('SELECT collector_protocol_version FROM device_exporters WHERE device_id = ?')
      .get(enrollResp.body.device_id);
    assert.equal(row.collector_protocol_version, COLLECTOR_PROTOCOL_VERSION);
  });
});

async function postLocalCollectorGap(asUrl, device, body, tokenOverride) {
  return postJson(
    `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/source-instances/${encodeURIComponent(device.source_instance_id)}/local-collector-gaps`,
    body,
    authHeaders(tokenOverride ?? device.device_token),
  );
}

async function postLocalCollectorGapRecovered(asUrl, device, body, tokenOverride) {
  return postJson(
    `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/source-instances/${encodeURIComponent(device.source_instance_id)}/local-collector-gaps/recovered`,
    body,
    authHeaders(tokenOverride ?? device.device_token),
  );
}

function localCollectorGapBody(device, overrides = {}) {
  return {
    connector_id: device.connector_id,
    source_instance_id: device.source_instance_id,
    reason: 'policy_budget',
    retryable: true,
    first_seen_at: '2026-05-19T12:00:00.000Z',
    first_seen_run_id: 'run-1',
    last_run_id: 'run-1',
    next_attempt_backoff_ms: 900000,
    ...overrides,
  };
}

test('local-collector-gaps route authorizes device, derives connector binding, and idempotently upserts', async () => {
  await withServer(async ({ asUrl }) => {
    const first = await enrollDevice(asUrl, 'laptop-gap-1');
    const second = await enrollDevice(asUrl, 'laptop-gap-2');

    // Missing auth.
    const missingAuth = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/source-instances/${encodeURIComponent(first.source_instance_id)}/local-collector-gaps`,
      localCollectorGapBody(first),
      PROTOCOL_HEADERS,
    );
    assert.equal(missingAuth.status, 401);

    // Token belonging to a different device.
    const wrongToken = await postLocalCollectorGap(asUrl, first, localCollectorGapBody(first), second.device_token);
    assert.equal(wrongToken.status, 403);

    // Connector id mismatch.
    const mismatch = await postLocalCollectorGap(asUrl, first, localCollectorGapBody(first, { connector_id: 'not-codex' }));
    assert.equal(mismatch.status, 400);
    assert.equal(mismatch.body.error.code, 'invalid_request');

    // Source instance mismatch between body and path.
    const sourceMismatch = await postLocalCollectorGap(
      asUrl,
      first,
      localCollectorGapBody(first, { source_instance_id: second.source_instance_id }),
    );
    assert.equal(sourceMismatch.status, 400);

    // Happy path.
    const ack = await postLocalCollectorGap(asUrl, first, localCollectorGapBody(first, {
      details: 'child failed token=super-secret-value otp=123456 opaque=abcdefghijklmnopqrstuvwxyz123456',
      stream: 'messages',
    }));
    assert.equal(ack.status, 201, JSON.stringify(ack.body));
    assert.equal(ack.body.object, 'device_local_collector_gap');
    assert.equal(ack.body.connector_id, first.connector_id);
    assert.equal(ack.body.connector_instance_id, first.connector_instance_id);
    assert.equal(ack.body.source_instance_id, first.source_instance_id);
    assert.equal(ack.body.reason, 'policy_budget');
    assert.equal(ack.body.retryable, true);
    assert.equal(ack.body.stream, 'local-collector/policy_budget/messages');
    assert.equal(ack.body.status, 'pending');
    assert.equal(ack.body.first_seen_run_id, 'run-1');
    assert.equal(ack.body.last_run_id, 'run-1');
    const firstGapId = ack.body.gap_id;
    assert.ok(firstGapId);

    // Idempotent replay with current run.
    const ackReplay = await postLocalCollectorGap(
      asUrl,
      first,
      localCollectorGapBody(first, {
        details: 'child failed token=super-secret-value otp=123456 opaque=abcdefghijklmnopqrstuvwxyz123456',
        stream: 'messages',
        last_run_id: 'run-2',
      }),
    );
    assert.equal(ackReplay.status, 201);
    assert.equal(ackReplay.body.gap_id, firstGapId);
    assert.equal(ackReplay.body.last_run_id, 'run-2');

    // Verify storage has exactly one row (idempotent) and is scoped to
    // the authorized connector instance.
    const dbRows = getDb()
      .prepare(
        `SELECT gap_id, connector_id, connector_instance_id, stream, reason, status, source_json, detail_locator_json, last_error_json
           FROM connector_detail_gaps
          WHERE gap_id = ?`,
      )
      .all(firstGapId);
    assert.equal(dbRows.length, 1);
    assert.equal(dbRows[0].connector_id, first.connector_id);
    assert.equal(dbRows[0].connector_instance_id, first.connector_instance_id);
    assert.equal(dbRows[0].reason, 'policy_budget');
    assert.equal(dbRows[0].stream, 'local-collector/policy_budget/messages');
    assert.equal(dbRows[0].status, 'pending');
    const source = JSON.parse(dbRows[0].source_json);
    assert.equal(source.kind, 'local_device');
    assert.equal(source.device_id, first.device_id);
    assert.equal(source.source_instance_id, first.source_instance_id);
    const persistedDiagnostics = JSON.stringify({
      detail_locator: JSON.parse(dbRows[0].detail_locator_json),
      last_error: JSON.parse(dbRows[0].last_error_json),
    });
    assert.equal(persistedDiagnostics.includes('super-secret-value'), false);
    assert.equal(persistedDiagnostics.includes('123456'), false);
    assert.equal(persistedDiagnostics.includes('abcdefghijklmnopqrstuvwxyz123456'), false);
    assert.ok(persistedDiagnostics.includes('[REDACTED'));

    const recovered = await postLocalCollectorGapRecovered(
      asUrl,
      first,
      {
        connector_id: first.connector_id,
        source_instance_id: first.source_instance_id,
        reason: 'policy_budget',
        stream: 'messages',
        recovered_run_id: 'run-3',
      },
    );
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
    assert.equal(recovered.body.gap_id, firstGapId);
    assert.equal(recovered.body.status, 'recovered');
    assert.equal(recovered.body.last_run_id, 'run-3');
    const recoveredRow = getDb()
      .prepare('SELECT status, recovered_run_id FROM connector_detail_gaps WHERE gap_id = ?')
      .get(firstGapId);
    assert.equal(recoveredRow.status, 'recovered');
    assert.equal(recoveredRow.recovered_run_id, 'run-3');

    // A second device cannot observe or upsert into the first device's gap.
    const crossDevice = await postLocalCollectorGap(
      asUrl,
      second,
      localCollectorGapBody(first, { stream: 'messages' }),
    );
    assert.equal(crossDevice.status, 400);
    assert.equal(crossDevice.body.error.code, 'invalid_request');

    // Invalid reason rejected with 400.
    const badReason = await postLocalCollectorGap(asUrl, first, localCollectorGapBody(first, { reason: 'nope' }));
    assert.equal(badReason.status, 400);

    // Missing retryable rejected.
    const missingRetryable = await postLocalCollectorGap(asUrl, first, {
      ...localCollectorGapBody(first),
      retryable: 'truthy',
    });
    assert.equal(missingRetryable.status, 400);
  });
});

test('local-collector-gaps route rejects unaccepted collector protocol version', async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, 'laptop-gap-proto');
    const reject = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/source-instances/${encodeURIComponent(device.source_instance_id)}/local-collector-gaps`,
      localCollectorGapBody(device),
      { Authorization: `Bearer ${device.device_token}`, 'X-PDPP-Collector-Protocol': '999' },
    );
    assert.equal(reject.status, 409);
    assert.equal(reject.body.error.code, 'collector_protocol_mismatch');
  });
});

test('ingest rejects unaccepted collector protocol version with 409 before any record persists', async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, 'laptop-e');
    const batch = makeBatch(device, 'batch-mismatch', 'will-not-persist');
    const reject = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/ingest-batches`,
      batch,
      { Authorization: `Bearer ${device.device_token}`, 'X-PDPP-Collector-Protocol': '999' },
    );
    assert.equal(reject.status, 409);
    assert.equal(reject.body.error.code, 'collector_protocol_mismatch');
    assert.equal(reject.body.error.received_version, '999');

    const outcomes = getDb()
      .prepare('SELECT COUNT(*) as n FROM device_ingest_batch_outcomes WHERE device_id = ?')
      .get(device.device_id);
    assert.equal(outcomes.n, 0);
    const recordRows = getDb()
      .prepare(
        `SELECT COUNT(*) as n FROM records WHERE connector_id = ?`,
      )
      .get(internalStorageConnectorId('codex'));
    assert.equal(recordRows.n, 0);
  });
});
