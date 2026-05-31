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

async function enrollDevice(asUrl, localBindingName, connectorId = 'codex') {
  const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
    connector_id: connectorId,
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

// Local-device records are stored under the bare canonical connector key,
// the same key API/browser records use; connection isolation is carried by
// connector_instance_id, not a `local-device:` storage prefix. See
// canonicalize-connector-keys design Decision 7.
function internalStorageConnectorId(connectorId) {
  return connectorId;
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

test('two claude-code source homes ingest the same connector-local key without overwriting each other', async () => {
  // complete-local-agent-collectors task 3.4 (Claude Code half). Two Claude
  // Code source homes for the same owner legitimately share connector-local
  // record keys (e.g. a skill named `demo-skill` → record key
  // `skills:demo-skill`). Each source home enrolls under its own
  // local_binding_name, resolving to a distinct connector_instance_id, so the
  // store's (connector_instance_id, stream, record_key) unique key keeps both
  // rows. The connector_id is canonicalized to `claude-code` on enrollment.
  await withServer(async ({ asUrl }) => {
    const homeA = await enrollDevice(asUrl, 'laptop-claude-a', 'claude-code');
    const homeB = await enrollDevice(asUrl, 'desktop-claude-b', 'claude-code');
    assert.equal(homeA.connector_id, 'claude-code');
    assert.equal(homeB.connector_id, 'claude-code');
    assert.notEqual(homeA.source_instance_id, homeB.source_instance_id);
    assert.notEqual(homeA.connector_instance_id, homeB.connector_instance_id);

    // Both homes ingest a record under the identical connector-local key
    // `skills:demo-skill`, mirroring what the Claude Code connector emits for
    // a skill of the same name present on both machines.
    const makeSkillBatch = (device, batchId, body) => ({
      batch_id: batchId,
      batch_seq: 1,
      body_hash: `hash-${batchId}`,
      connector_id: device.connector_id,
      device_id: device.device_id,
      records: [
        {
          data: { id: 'skills:demo-skill', name: 'Demo Skill', content: body },
          emitted_at: '2026-05-31T12:00:00.000Z',
          record_key: 'skills:demo-skill',
          stream: 'skills',
        },
      ],
      source_instance_id: device.source_instance_id,
    });

    const ingestA = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(homeA.device_id)}/ingest-batches`,
      makeSkillBatch(homeA, 'claude-batch-a', 'Device A skill body'),
      authHeaders(homeA.device_token),
    );
    assert.equal(ingestA.status, 201);
    assert.equal(ingestA.body.connector_instance_id, homeA.connector_instance_id);

    const ingestB = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(homeB.device_id)}/ingest-batches`,
      makeSkillBatch(homeB, 'claude-batch-b', 'Device B skill body'),
      authHeaders(homeB.device_token),
    );
    assert.equal(ingestB.status, 201);
    assert.equal(ingestB.body.connector_instance_id, homeB.connector_instance_id);

    // Both source homes' records coexist under the canonical claude-code
    // storage key, keyed apart by connector_instance_id.
    const rows = getDb().prepare(
      `SELECT connector_instance_id, record_json
         FROM records
        WHERE connector_id = ? AND stream = ? AND record_key = ?
        ORDER BY connector_instance_id`,
    ).all('claude-code', 'skills', 'skills:demo-skill');
    assert.equal(rows.length, 2, 'both source homes must persist their own skills:demo-skill row');
    assert.deepEqual(
      new Map(rows.map((row) => [row.connector_instance_id, JSON.parse(row.record_json).content])),
      new Map([
        [homeA.connector_instance_id, 'Device A skill body'],
        [homeB.connector_instance_id, 'Device B skill body'],
      ]),
      'neither source home may overwrite the other',
    );
  });
});

test('re-enrolling the same connector + local_binding_name resumes one stable connector_instance', async () => {
  // Regression: source_binding_key for local-device instances used to
  // include the per-enrollment device_id and source_instance_id, so a
  // second enroll for the same owner-chosen binding forked a brand new
  // connector_instances row instead of upserting/resuming the existing
  // one. The stable identity is (owner, connector, local_device,
  // local_binding_name).
  await withServer(async ({ asUrl }) => {
    const first = await enrollDevice(asUrl, 'laptop-stable');
    const second = await enrollDevice(asUrl, 'laptop-stable');
    assert.equal(
      second.connector_instance_id,
      first.connector_instance_id,
      're-enrollment must resume the same connector_instance_id',
    );
    assert.notEqual(
      second.device_id,
      first.device_id,
      'each enroll still mints a fresh device_id',
    );
    assert.notEqual(
      second.source_instance_id,
      first.source_instance_id,
      'each enroll still mints a fresh source_instance_id',
    );

    const activeRows = getDb()
      .prepare(
        `SELECT connector_instance_id, source_kind, status, source_binding_json
           FROM connector_instances
          WHERE connector_id = ? AND source_kind = 'local_device'`,
      )
      .all('codex');
    assert.equal(
      activeRows.length,
      1,
      're-enrollment must not fork a second connector_instances row',
    );
    assert.equal(activeRows[0].connector_instance_id, first.connector_instance_id);
    assert.equal(activeRows[0].status, 'active');
    // Debugging payload retains the most recent device/source identifiers
    // for inspection, even though they no longer participate in identity.
    const binding = JSON.parse(activeRows[0].source_binding_json);
    assert.equal(binding.kind, 'local_device');
    assert.equal(binding.local_binding_name, 'laptop-stable');
    assert.equal(binding.device_id, second.device_id);
    assert.equal(binding.source_instance_id, second.source_instance_id);

    // A re-enrollment with a different local_binding_name DOES fork a
    // separate connector_instance, as expected.
    const other = await enrollDevice(asUrl, 'laptop-other');
    assert.notEqual(other.connector_instance_id, first.connector_instance_id);
    const distinctRows = getDb()
      .prepare(
        `SELECT connector_instance_id FROM connector_instances
          WHERE connector_id = ? AND source_kind = 'local_device'
          ORDER BY connector_instance_id`,
      )
      .all('codex');
    assert.equal(distinctRows.length, 2);
  });
});

test('device exporter enrollment keeps connector type display names separate from device labels', async () => {
  await withServer(async ({ asUrl }) => {
    const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: 'claude_code',
      display_name: 'simon@192.168.1.7 Claude Code',
      local_binding_name: 'simon-laptop',
    });
    assert.equal(codeResp.status, 201);

    const enrollResp = await postJson(
      `${asUrl}/_ref/device-exporters/enroll`,
      {
        device_label: 'simon@192.168.1.7 Claude Code',
        enrollment_code: codeResp.body.enrollment_code,
      },
      PROTOCOL_HEADERS,
    );
    assert.equal(enrollResp.status, 201);

    // The owner may enroll with the legacy snake_case alias (`claude_code`),
    // but the catalog row, instance row, and storage key are canonicalized to
    // `claude-code` so the connector type has one identity. The enroll
    // response echoes the canonical key. See canonicalize-connector-keys
    // design Decision 7.
    assert.equal(enrollResp.body.connector_id, 'claude-code');
    const legacyAliasRow = getDb()
      .prepare('SELECT 1 FROM connectors WHERE connector_id = ?')
      .get('claude_code');
    assert.equal(legacyAliasRow, undefined, 'legacy alias MUST NOT be registered as a connector row');

    const connectorRow = getDb()
      .prepare('SELECT manifest FROM connectors WHERE connector_id = ?')
      .get('claude-code');
    assert.ok(connectorRow);
    const connectorManifest = JSON.parse(connectorRow.manifest);
    assert.equal(connectorManifest.connector_id, 'claude-code');
    assert.equal(connectorManifest.display_name, 'Claude Code');
    assert.ok(connectorManifest.streams.some((stream) => stream.name === 'sessions'));

    const instanceRow = getDb()
      .prepare('SELECT display_name FROM connector_instances WHERE connector_instance_id = ?')
      .get(enrollResp.body.connector_instance_id);
    assert.equal(instanceRow.display_name, 'simon@192.168.1.7 Claude Code');
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

test('device-exporter diagnostics scope heartbeat, ingest, and local-collector gaps to the source instance', async () => {
  await withServer(async ({ asUrl }) => {
    const first = await enrollDevice(asUrl, 'laptop-diag-1');
    const second = await enrollDevice(asUrl, 'laptop-diag-2');

    // First device reports a healthy heartbeat with a small backlog; the
    // second device reports a blocked heartbeat. Per-source heartbeat
    // state must not bleed across instances even though they share the
    // `codex` connector type.
    const firstHeartbeat = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/heartbeat`,
      {
        connector_id: 'codex',
        last_error: {
          message: 'top-level token=top-secret-token otp=654321 path=/home/user owner/.codex/auth.json',
          cookie: 'session-cookie',
        },
        records_pending: 3,
        source_instances: [
          {
            source_instance_id: first.source_instance_id,
            last_error: {
              message: 'source token=source-secret path=/Users/user owner/.claude.json opaque=abcdefghijklmnopqrstuvwxyz123456',
              nested: { api_key: 'raw-api-key' },
            },
            outbox: {
              backlog_open: 1,
              dead_letter: 0,
              leased: 0,
              oldest_pending_at: '2026-05-19T12:00:00.000Z',
              pending: 2,
              retrying: 1,
              secret_path: '/home/user owner/.codex/auth.json',
              stale_leases: 0,
              succeeded: 4,
              token: 'raw-outbox-token',
              total: 7,
            },
            records_pending: 3,
            status: 'healthy',
          },
        ],
        source_instance_id: first.source_instance_id,
        status: 'healthy',
      },
      authHeaders(first.device_token),
    );
    assert.equal(firstHeartbeat.status, 200);

    const secondHeartbeat = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(second.device_id)}/heartbeat`,
      {
        connector_id: 'codex',
        outbox: {
          cookie: 'raw-cookie',
          dead_letter: 1,
          oldest_pending_at: 'not-a-date',
          pending: 9,
          retrying: 2,
          stale_leases: 3,
          total: 15,
        },
        records_pending: 17,
        source_instance_id: second.source_instance_id,
        status: 'blocked',
      },
      authHeaders(second.device_token),
    );
    assert.equal(secondHeartbeat.status, 200);

    // Only the first device ingests a batch; the second has none. The
    // diagnostics projection must show the ingest count under the right
    // source instance, not against the connector type.
    const ingestFirst = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/ingest-batches`,
      makeBatch(first, 'diag-batch-1', 'first-only'),
      authHeaders(first.device_token),
    );
    assert.equal(ingestFirst.status, 201);

    // Only the second device reports a local-collector gap. The first
    // device must show zero pending local-collector gaps even though
    // both devices share the `codex` connector type.
    const gapSecond = await postLocalCollectorGap(asUrl, second, localCollectorGapBody(second, {
      stream: 'messages',
    }));
    assert.equal(gapSecond.status, 201, JSON.stringify(gapSecond.body));

    const diagnosticsResp = await fetch(`${asUrl}/_ref/device-exporters/diagnostics`, {
      headers: { Accept: 'application/json' },
    });
    assert.equal(diagnosticsResp.status, 200);
    const diagnostics = await diagnosticsResp.json();

    const firstDevice = diagnostics.data.find((device) => device.device_id === first.device_id);
    const secondDevice = diagnostics.data.find((device) => device.device_id === second.device_id);
    assert.ok(firstDevice && secondDevice);

    const firstSource = firstDevice.source_instances.find(
      (source) => source.source_instance_id === first.source_instance_id,
    );
    const secondSource = secondDevice.source_instances.find(
      (source) => source.source_instance_id === second.source_instance_id,
    );
    assert.ok(firstSource && secondSource);

    // Identity is preserved.
    assert.equal(firstSource.connector_id, 'codex');
    assert.equal(firstSource.connector_instance_id, first.connector_instance_id);
    assert.equal(firstSource.device_id, first.device_id);
    assert.equal(firstSource.local_binding_name, 'laptop-diag-1');
    assert.equal(secondSource.connector_id, 'codex');
    assert.equal(secondSource.connector_instance_id, second.connector_instance_id);
    assert.equal(secondSource.device_id, second.device_id);
    assert.equal(secondSource.local_binding_name, 'laptop-diag-2');
    assert.notEqual(firstSource.connector_instance_id, secondSource.connector_instance_id);

    // Heartbeat status / backlog scoped per source instance.
    assert.equal(firstSource.last_heartbeat_status, 'healthy');
    assert.equal(firstSource.records_pending, 3);
    assert.equal(firstSource.outbox_state, 'retrying');
    assert.deepEqual(firstSource.outbox_diagnostics, {
      backlog_open: 1,
      dead_letter: 0,
      leased: 0,
      oldest_pending_at: '2026-05-19T12:00:00.000Z',
      pending: 2,
      retrying: 1,
      stale_leases: 0,
      succeeded: 4,
      total: 7,
    });
    assert.equal(secondSource.last_heartbeat_status, 'blocked');
    assert.equal(secondSource.records_pending, 17);
    assert.equal(secondSource.outbox_state, 'dead_letter');
    assert.equal(secondSource.outbox_diagnostics.dead_letter, 1);
    assert.equal(secondSource.outbox_diagnostics.oldest_pending_at, undefined);
    const diagnosticsJson = JSON.stringify(diagnostics);
    assert.equal(diagnosticsJson.includes('top-secret-token'), false);
    assert.equal(diagnosticsJson.includes('source-secret'), false);
    assert.equal(diagnosticsJson.includes('session-cookie'), false);
    assert.equal(diagnosticsJson.includes('raw-api-key'), false);
    assert.equal(diagnosticsJson.includes('raw-cookie'), false);
    assert.equal(diagnosticsJson.includes('raw-outbox-token'), false);
    assert.equal(diagnosticsJson.includes('654321'), false);
    assert.equal(diagnosticsJson.includes('/home/user owner'), false);
    assert.equal(diagnosticsJson.includes('/Users/user owner'), false);
    assert.ok(diagnosticsJson.includes('[REDACTED'));

    // Ingest counts scoped per source instance.
    assert.equal(firstSource.accepted_record_count, 1);
    assert.ok(firstSource.last_ingest_at);
    assert.equal(secondSource.accepted_record_count, 0);
    assert.equal(secondSource.last_ingest_at, null);

    const scopedSourcesResp = await fetch(
      `${asUrl}/_ref/device-exporters/source-instances?connector_instance_id=${encodeURIComponent(first.connector_instance_id)}`,
      { headers: { Accept: 'application/json' } },
    );
    assert.equal(scopedSourcesResp.status, 200);
    const scopedSources = await scopedSourcesResp.json();
    assert.deepEqual(
      scopedSources.data.map((source) => source.connector_instance_id),
      [first.connector_instance_id],
    );

    // Local-collector gap counts scoped per source instance.
    assert.equal(firstSource.local_collector_gaps.pending_count, 0);
    assert.deepEqual(firstSource.local_collector_gaps.reasons, []);
    assert.equal(firstSource.local_collector_gaps.unreliable, false);
    assert.equal(secondSource.local_collector_gaps.pending_count, 1);
    assert.deepEqual(secondSource.local_collector_gaps.reasons, ['policy_budget']);
    assert.equal(secondSource.local_collector_gaps.unreliable, false);
    assert.ok(secondSource.local_collector_gaps.last_updated_at);

    // Recovering the second device's gap clears its per-source backlog
    // without disturbing the first device.
    const recovered = await postLocalCollectorGapRecovered(asUrl, second, {
      connector_id: 'codex',
      source_instance_id: second.source_instance_id,
      reason: 'policy_budget',
      stream: 'messages',
      recovered_run_id: 'run-diag-recovery',
    });
    assert.equal(recovered.status, 200, JSON.stringify(recovered.body));

    const refreshed = await fetch(`${asUrl}/_ref/device-exporters/diagnostics`, {
      headers: { Accept: 'application/json' },
    });
    const refreshedJson = await refreshed.json();
    const refreshedFirst = refreshedJson.data
      .find((device) => device.device_id === first.device_id)
      .source_instances.find((source) => source.source_instance_id === first.source_instance_id);
    const refreshedSecond = refreshedJson.data
      .find((device) => device.device_id === second.device_id)
      .source_instances.find((source) => source.source_instance_id === second.source_instance_id);
    assert.equal(refreshedFirst.local_collector_gaps.pending_count, 0);
    assert.equal(refreshedSecond.local_collector_gaps.pending_count, 0);
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
