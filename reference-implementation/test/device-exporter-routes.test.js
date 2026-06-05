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

async function putSourceInstanceState(asUrl, device, state) {
  return fetch(
    `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/source-instances/${encodeURIComponent(device.source_instance_id)}/state`,
    {
      method: 'PUT',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...authHeaders(device.device_token) },
      body: JSON.stringify({ state }),
    },
  ).then(async (resp) => ({ body: await resp.json(), status: resp.status }));
}

async function getSourceInstanceState(asUrl, device, tokenOverride) {
  return fetch(
    `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/source-instances/${encodeURIComponent(device.source_instance_id)}/state`,
    { headers: { Accept: 'application/json', ...authHeaders(tokenOverride ?? device.device_token) } },
  ).then(async (resp) => ({ body: await resp.json(), status: resp.status }));
}

test('two source homes keep collector state/checkpoints isolated by connector instance', async () => {
  // complete-local-agent-collectors tasks 3.1 (state gate) + 3.2 (checkpoint
  // namespace). Two source homes of the same connector type legitimately use
  // identical connector-local stream cursor keys (e.g. both track a `sessions`
  // checkpoint). The device state PUT/GET routes resolve the authorized
  // connector instance from (device, source_instance) and persist under the
  // `(connector_instance_id, stream)` namespace, so one home's checkpoint can
  // never read or clobber the other's even though the connector-local stream
  // keys collide. This proves the state/checkpoint half of the connector-
  // instance gate that the records path already proves for ingest.
  await withServer(async ({ asUrl }) => {
    const homeA = await enrollDevice(asUrl, 'laptop-state-a', 'claude-code');
    const homeB = await enrollDevice(asUrl, 'desktop-state-b', 'claude-code');
    assert.notEqual(homeA.connector_instance_id, homeB.connector_instance_id);

    // Both homes start with empty state — neither can see the other before
    // either has written anything.
    const emptyA = await getSourceInstanceState(asUrl, homeA);
    assert.equal(emptyA.status, 200);
    assert.deepEqual(emptyA.body.state, {});
    assert.equal(emptyA.body.connector_instance_id, homeA.connector_instance_id);

    // Each home checkpoints the SAME connector-local stream cursor keys with
    // its own values.
    const putA = await putSourceInstanceState(asUrl, homeA, {
      sessions: 'cursor-A-2026-05-31',
      skills: 'skills-cursor-A',
    });
    assert.equal(putA.status, 200, JSON.stringify(putA.body));
    assert.equal(putA.body.connector_instance_id, homeA.connector_instance_id);
    assert.equal(putA.body.state.sessions, 'cursor-A-2026-05-31');

    const putB = await putSourceInstanceState(asUrl, homeB, {
      sessions: 'cursor-B-2026-05-31',
      skills: 'skills-cursor-B',
    });
    assert.equal(putB.status, 200, JSON.stringify(putB.body));
    assert.equal(putB.body.connector_instance_id, homeB.connector_instance_id);
    assert.equal(putB.body.state.sessions, 'cursor-B-2026-05-31');

    // Reading each home back returns only that home's checkpoints — no bleed
    // across the shared connector type / shared stream keys.
    const readA = await getSourceInstanceState(asUrl, homeA);
    assert.equal(readA.body.state.sessions, 'cursor-A-2026-05-31');
    assert.equal(readA.body.state.skills, 'skills-cursor-A');
    const readB = await getSourceInstanceState(asUrl, homeB);
    assert.equal(readB.body.state.sessions, 'cursor-B-2026-05-31');
    assert.equal(readB.body.state.skills, 'skills-cursor-B');

    // Storage is namespaced by connector_instance_id, not connector_id: two
    // rows for the same (connector_id, stream) survive side by side.
    const sessionRows = getDb()
      .prepare(
        `SELECT connector_instance_id, state_json
           FROM connector_state
          WHERE connector_id = ? AND stream = ?
          ORDER BY connector_instance_id`,
      )
      .all('claude-code', 'sessions');
    assert.equal(sessionRows.length, 2, 'both source homes must persist their own sessions checkpoint');
    assert.deepEqual(
      new Map(sessionRows.map((row) => [row.connector_instance_id, JSON.parse(row.state_json)])),
      new Map([
        [homeA.connector_instance_id, 'cursor-A-2026-05-31'],
        [homeB.connector_instance_id, 'cursor-B-2026-05-31'],
      ]),
      'neither source home may overwrite the other\'s checkpoint',
    );

    // A device credential is scoped to its own device: home A's token cannot
    // read home B's source-instance state.
    const crossDevice = await getSourceInstanceState(asUrl, homeB, homeA.device_token);
    assert.equal(crossDevice.status, 403);
    assert.equal(crossDevice.body.error.code, 'permission_error');
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

test('healthy drained heartbeat recovers stale local policy-budget gaps for the same connector instance', async () => {
  await withServer(async ({ asUrl }) => {
    const first = await enrollDevice(asUrl, 'laptop-gap-drain-1');
    const second = await enrollDevice(asUrl, 'laptop-gap-drain-2');

    const parentGap = await postLocalCollectorGap(asUrl, first, localCollectorGapBody(first));
    assert.equal(parentGap.status, 201, JSON.stringify(parentGap.body));
    assert.equal(parentGap.body.stream, 'local-collector/policy_budget');

    const childGap = await postLocalCollectorGap(
      asUrl,
      first,
      localCollectorGapBody(first, { stream: 'messages' }),
    );
    assert.equal(childGap.status, 201, JSON.stringify(childGap.body));
    assert.equal(childGap.body.stream, 'local-collector/policy_budget/messages');

    const childFailure = await postLocalCollectorGap(
      asUrl,
      first,
      localCollectorGapBody(first, { reason: 'connector_child_failure', stream: 'messages' }),
    );
    assert.equal(childFailure.status, 201, JSON.stringify(childFailure.body));

    const otherDeviceGap = await postLocalCollectorGap(asUrl, second, localCollectorGapBody(second));
    assert.equal(otherDeviceGap.status, 201, JSON.stringify(otherDeviceGap.body));

    const heartbeat = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/heartbeat`,
      {
        source_instances: [
          {
            source_instance_id: first.source_instance_id,
            status: 'healthy',
            records_pending: 0,
            outbox: {
              backlog_open: 0,
              dead_letter: 0,
              leased: 0,
              pending: 0,
              retrying: 0,
              stale_leases: 0,
              succeeded: 10,
              total: 10,
            },
          },
        ],
      },
      authHeaders(first.device_token),
    );
    assert.equal(heartbeat.status, 200, JSON.stringify(heartbeat.body));

    const rows = getDb()
      .prepare(
        `SELECT gap_id, status
           FROM connector_detail_gaps
          WHERE gap_id IN (?, ?, ?, ?)
          ORDER BY gap_id`,
      )
      .all(parentGap.body.gap_id, childGap.body.gap_id, childFailure.body.gap_id, otherDeviceGap.body.gap_id);
    const statusByGap = new Map(rows.map((row) => [row.gap_id, row.status]));
    assert.equal(statusByGap.get(parentGap.body.gap_id), 'recovered');
    assert.equal(statusByGap.get(childGap.body.gap_id), 'recovered');
    assert.equal(statusByGap.get(childFailure.body.gap_id), 'pending');
    assert.equal(statusByGap.get(otherDeviceGap.body.gap_id), 'pending');
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

    // The first device also ingests coverage diagnostics. The records carry
    // a `reason` with a planted path+secret; the projection must surface
    // only the safe store/stream/status triple and never the reason text.
    const coverageBatch = {
      batch_id: 'diag-coverage-1',
      batch_seq: 2,
      body_hash: 'hash-diag-coverage-1',
      connector_id: first.connector_id,
      device_id: first.device_id,
      records: [
        {
          data: {
            id: 'sessions:collected',
            store: 'sessions',
            stream: 'sessions',
            status: 'collected',
            reason: 'declared stream at /home/user owner/.codex/sessions token=coverage-secret',
          },
          emitted_at: '2026-05-20T12:00:00.000Z',
          record_key: 'sessions:collected',
          stream: 'coverage_diagnostics',
        },
        {
          data: {
            id: 'auth:excluded',
            store: 'auth',
            stream: null,
            status: 'excluded',
            reason: 'auth-adjacent /home/user owner/.codex/auth.json',
          },
          emitted_at: '2026-05-20T12:00:00.000Z',
          record_key: 'auth:excluded',
          stream: 'coverage_diagnostics',
        },
        {
          data: {
            id: 'logs:deferred',
            store: 'logs',
            stream: 'logs',
            status: 'deferred',
            reason: 'redaction pending',
          },
          emitted_at: '2026-05-20T12:00:00.000Z',
          record_key: 'logs:deferred',
          stream: 'coverage_diagnostics',
        },
      ],
      source_instance_id: first.source_instance_id,
    };
    const ingestCoverage = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(first.device_id)}/ingest-batches`,
      coverageBatch,
      authHeaders(first.device_token),
    );
    assert.equal(ingestCoverage.status, 201, JSON.stringify(ingestCoverage.body));

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

    // Ingest counts scoped per source instance: 1 message record plus 3
    // coverage-diagnostic records across two batches.
    assert.equal(firstSource.accepted_record_count, 4);
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

    // Local-collector coverage (Section 5.3) surfaces per source instance,
    // scoped to the connector instance, with only safe store/stream/status.
    assert.ok(firstSource.local_collector_coverage);
    assert.equal(firstSource.local_collector_coverage.observed, true);
    assert.equal(firstSource.local_collector_coverage.store_count, 3);
    assert.equal(firstSource.local_collector_coverage.fully_accounted, true);
    assert.deepEqual(firstSource.local_collector_coverage.unaccounted_stores, []);
    assert.equal(firstSource.local_collector_coverage.counts_by_status.collected, 1);
    assert.equal(firstSource.local_collector_coverage.counts_by_status.excluded, 1);
    assert.equal(firstSource.local_collector_coverage.counts_by_status.deferred, 1);
    assert.equal(firstSource.local_collector_coverage.by_store.auth, 'excluded');
    assert.equal(firstSource.local_collector_coverage.by_store.logs, 'deferred');
    // The second device requested no coverage; absence reads as absence.
    assert.equal(secondSource.local_collector_coverage.observed, false);
    assert.equal(secondSource.local_collector_coverage.store_count, 0);
    assert.equal(secondSource.local_collector_coverage.fully_accounted, false);
    // The coverage `reason` free-text (with its planted path/secret) must
    // never reach the diagnostics surface.
    assert.equal(diagnosticsJson.includes('coverage-secret'), false);
    assert.equal(diagnosticsJson.includes('redaction pending'), false);
    assert.equal(diagnosticsJson.includes('.codex/sessions'), false);
    assert.equal(diagnosticsJson.includes('.codex/auth.json'), false);

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

// ─── Binding-aware enrollment (add-browser-collector-enrollment-primitive) ────
// The enroll/enrollment-code routes derive the connector-instance source kind
// from the connector manifest bindings rather than hardcoding `local_device`:
//   filesystem -> local_device, browser -> browser_collector, contradiction or
// no-resolvable-binding -> typed 400 reject. See design Decision 2.

async function registerAmazonConnector(asUrl) {
  const fs = await import('node:fs');
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../../packages/polyfill-connectors/manifests/amazon.json', import.meta.url), 'utf8'),
  );
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  });
  assert.ok(resp.status < 500, `register amazon: ${resp.status}`);
}

test('enrollment derives local_device for a filesystem connector', async () => {
  await withServer(async ({ asUrl }) => {
    const device = await enrollDevice(asUrl, 'laptop-fs', 'codex');
    const row = getDb()
      .prepare('SELECT source_kind, source_binding_json FROM connector_instances WHERE connector_instance_id = ?')
      .get(device.connector_instance_id);
    assert.equal(row.source_kind, 'local_device');
    assert.equal(JSON.parse(row.source_binding_json).kind, 'local_device');
  });
});

test('enrollment derives browser_collector for a browser-bound connector and never local_device', async () => {
  await withServer(async ({ asUrl }) => {
    await registerAmazonConnector(asUrl);

    const codeResp = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: 'amazon',
      local_binding_name: 'the owner-personal-amazon',
    });
    assert.equal(codeResp.status, 201, JSON.stringify(codeResp.body));

    const enrollResp = await postJson(
      `${asUrl}/_ref/device-exporters/enroll`,
      { enrollment_code: codeResp.body.enrollment_code },
      PROTOCOL_HEADERS,
    );
    assert.equal(enrollResp.status, 201, JSON.stringify(enrollResp.body));
    assert.equal(enrollResp.body.connector_id, 'amazon');

    const row = getDb()
      .prepare('SELECT source_kind, source_binding_json FROM connector_instances WHERE connector_instance_id = ?')
      .get(enrollResp.body.connector_instance_id);
    assert.equal(row.source_kind, 'browser_collector', 'browser-bound connector must enroll as browser_collector');
    assert.notEqual(row.source_kind, 'local_device');
    assert.equal(JSON.parse(row.source_binding_json).kind, 'browser_collector');
  });
});

test('a second Amazon account enrolls as a distinct browser_collector instance', async () => {
  // Multi-account is correct by construction: each browser_collector binding
  // resolves to its own connector_instance_id under the same connector_id.
  await withServer(async ({ asUrl }) => {
    await registerAmazonConnector(asUrl);

    const enrollOne = async (binding) => {
      const code = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
        connector_id: 'amazon',
        local_binding_name: binding,
      });
      assert.equal(code.status, 201, JSON.stringify(code.body));
      const enroll = await postJson(
        `${asUrl}/_ref/device-exporters/enroll`,
        { enrollment_code: code.body.enrollment_code },
        PROTOCOL_HEADERS,
      );
      assert.equal(enroll.status, 201, JSON.stringify(enroll.body));
      return enroll.body;
    };

    const personal = await enrollOne('the owner-personal-amazon');
    const shared = await enrollOne('shared-amazon');
    assert.equal(personal.connector_id, 'amazon');
    assert.equal(shared.connector_id, 'amazon');
    assert.notEqual(personal.connector_instance_id, shared.connector_instance_id);

    const rows = getDb()
      .prepare(
        `SELECT connector_instance_id, source_kind FROM connector_instances
          WHERE connector_id = 'amazon' AND source_kind = 'browser_collector'
          ORDER BY connector_instance_id`,
      )
      .all();
    assert.equal(rows.length, 2);
  });
});

test('a source_kind that contradicts the manifest is rejected with a typed 400 and persists nothing', async () => {
  await withServer(async ({ asUrl }) => {
    await registerAmazonConnector(asUrl);

    // amazon is browser-bound; asking to enroll it as local_device contradicts
    // the manifest and must be rejected before any code is minted.
    const reject = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: 'amazon',
      local_binding_name: 'amazon-wrong-kind',
      source_kind: 'local_device',
    });
    assert.equal(reject.status, 400, JSON.stringify(reject.body));
    assert.equal(reject.body.error.code, 'invalid_request');

    // No enrollment code row was minted for the contradicting request.
    const codes = getDb()
      .prepare("SELECT COUNT(*) AS n FROM device_enrollment_codes WHERE connector_id = 'amazon'")
      .get();
    assert.equal(codes.n, 0, 'a contradicting request must not mint an enrollment code');
  });
});

test('a connector with no resolvable binding is rejected with a typed 400, never defaulted', async () => {
  await withServer(async ({ asUrl }) => {
    // No manifest registered for this connector_id at all → no resolvable
    // binding → typed reject, never a defaulted source kind.
    const reject = await postJson(`${asUrl}/_ref/device-exporters/enrollment-codes`, {
      connector_id: 'totally-unregistered-connector',
      local_binding_name: 'nope',
    });
    assert.equal(reject.status, 400, JSON.stringify(reject.body));
    assert.equal(reject.body.error.code, 'invalid_request');

    const instances = getDb()
      .prepare("SELECT COUNT(*) AS n FROM connector_instances WHERE connector_id = 'totally-unregistered-connector'")
      .get();
    assert.equal(instances.n, 0);
  });
});

// Directly overwrite the stored heartbeat timestamp so the staleness badge can
// be exercised against a controlled age without sleeping. The heartbeat route
// always stamps `received_at = now`, so the only way to age a heartbeat in a
// test is to write the column.
function setDeviceLastHeartbeatAt(deviceId, isoTimestamp) {
  const result = getDb()
    .prepare('UPDATE device_exporters SET last_heartbeat_at = ? WHERE device_id = ?')
    .run(isoTimestamp, deviceId);
  assert.equal(result.changes, 1, `expected to age heartbeat for device ${deviceId}`);
}

async function diagnosticsForDevice(asUrl, deviceId) {
  const resp = await fetch(`${asUrl}/_ref/device-exporters/diagnostics`, {
    headers: { Accept: 'application/json' },
  });
  assert.equal(resp.status, 200);
  const body = await resp.json();
  const device = body.data.find((d) => d.device_id === deviceId);
  assert.ok(device, `expected diagnostics to include device ${deviceId}`);
  return device;
}

test('device staleness badge follows the connector refresh policy, not a fixed 5-minute window', async () => {
  await withServer(async ({ asUrl }) => {
    // The codex catalog manifest declares
    // capabilities.refresh_policy.maximum_staleness_seconds = 21600 (6h).
    const device = await enrollDevice(asUrl, 'codex-laptop', 'codex');

    // A heartbeat establishes an active source instance for the device. The
    // connector_id on the projected source instance is what selects the policy.
    const heartbeat = await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/heartbeat`,
      {
        connector_id: 'codex',
        records_pending: 0,
        source_instance_id: device.source_instance_id,
        status: 'healthy',
      },
      authHeaders(device.device_token),
    );
    assert.equal(heartbeat.status, 200);

    // 10 minutes old: well past the legacy hard-coded 5-minute window, but far
    // inside the connector's 6-hour policy. The policy-aware badge must NOT
    // flag this device as stale. (Under the old fixed window this was `true`,
    // which is exactly the admin-badge bug being fixed.)
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    setDeviceLastHeartbeatAt(device.device_id, tenMinutesAgo);
    const fresh = await diagnosticsForDevice(asUrl, device.device_id);
    assert.equal(fresh.last_heartbeat_at, tenMinutesAgo);
    assert.equal(
      fresh.stale,
      false,
      'a 10-minute-old heartbeat must not be stale under a 6-hour refresh policy',
    );

    // 7 hours old: past the connector's 6-hour policy window. A genuinely
    // overdue collector must still be flagged stale.
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    setDeviceLastHeartbeatAt(device.device_id, sevenHoursAgo);
    const overdue = await diagnosticsForDevice(asUrl, device.device_id);
    assert.equal(overdue.last_heartbeat_at, sevenHoursAgo);
    assert.equal(
      overdue.stale,
      true,
      'a heartbeat older than the policy window must remain stale',
    );
  });
});

test('device staleness badge stays honestly non-stale when no refresh policy resolves', async () => {
  await withServer(async ({ asUrl }) => {
    // Enroll a codex device (the only enrollable path requires a manifest with
    // a resolvable binding), then point its source instance at a connector that
    // has no resolvable manifest at all. With no manifest — and therefore no
    // declared staleness window — the badge must report `unknown` freshness,
    // i.e. not stale, rather than re-inventing a hard-coded window.
    const device = await enrollDevice(asUrl, 'no-policy-laptop', 'codex');
    await postJson(
      `${asUrl}/_ref/device-exporters/${encodeURIComponent(device.device_id)}/heartbeat`,
      {
        connector_id: 'codex',
        records_pending: 0,
        source_instance_id: device.source_instance_id,
        status: 'healthy',
      },
      authHeaders(device.device_token),
    );

    // Repoint the source instance at an unregistered connector id. The catalog
    // and registered-manifest lookups both return null for it, so the staleness
    // window resolves to null (unknown).
    const repointed = getDb()
      .prepare('UPDATE device_source_instances SET connector_id = ? WHERE source_instance_id = ?')
      .run('unregistered-policyless-connector', device.source_instance_id);
    assert.equal(repointed.changes, 1);

    // Heartbeat far older than any plausible default window. With no policy the
    // honest answer is not-stale (unknown), never a fixed-window stale.
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    setDeviceLastHeartbeatAt(device.device_id, longAgo);
    const projected = await diagnosticsForDevice(asUrl, device.device_id);
    assert.equal(projected.last_heartbeat_at, longAgo);
    assert.equal(
      projected.stale,
      false,
      'with no resolvable refresh policy the badge must stay honestly non-stale',
    );
  });
});
