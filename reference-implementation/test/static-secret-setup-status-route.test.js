import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { emitSpineEvent } from '../lib/spine.ts';
import { getDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { CREDENTIAL_ENCRYPTION_KEY_ENV } from '../server/stores/credential-encryption.js';

// Integration coverage for the owner-session static-secret SETUP-STATUS route —
// the durable surface that makes an in-flight static-secret setup visible to the
// owner before its first ingest accepts records, so a submitted Gmail/GitHub
// account never disappears behind the invisible draft. See
// complete-self-service-connection-onboarding design Decision 12 / Phase 2.

const OWNER_PASSWORD = 'static-secret-status-owner-password';
const OWNER_SUBJECT_ID = 'owner_local';
const TEST_KEY = 'static-secret-status-test-key';
const SECRET = 'status app password synthetic';

async function closeServer(server) {
  server.schedulerManager?.stop?.();
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function withCredentialKey(value, fn) {
  const old = process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  if (value === null) {
    delete process.env[CREDENTIAL_ENCRYPTION_KEY_ENV];
  } else {
    process.env[CREDENTIAL_ENCRYPTION_KEY_ENV] = value;
  }
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

// Permissive deterministic prober so capturing gmail in these setup-status
// projection tests does not trigger a real network probe.
function permissiveProber() {
  return async ({ context }) => ({
    ok: true,
    identity: context?.setupFields?.account_email ?? 'synthetic@example.com',
    detail: null,
  });
}

async function withServer(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: OWNER_PASSWORD,
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    autoEnrollEligibleSchedules: false,
    staticSecretAutoResume: false,
    staticSecretCredentialProber: permissiveProber(),
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl, server });
  } finally {
    await closeServer(server);
  }
}

// Owner-auth-disabled harness for the activation test, which needs an owner
// BEARER token (device flow) to ingest. With an empty owner password the default
// owner session is active (so `/_ref/...` cookie routes need no login) and
// `/device/approve` issues a bearer token without a CSRF-gated owner session.
// Mirrors static-secret-draft-connection-route.test.js.
async function withOpenServer(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: '',
    ownerAuthSubjectId: OWNER_SUBJECT_ID,
    autoEnrollEligibleSchedules: false,
    staticSecretAutoResume: false,
    staticSecretCredentialProber: permissiveProber(),
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl, server });
  } finally {
    await closeServer(server);
  }
}

function getRawSetCookieList(resp) {
  if (typeof resp.headers.getSetCookie === 'function') {
    return resp.headers.getSetCookie();
  }
  const single = resp.headers.get('set-cookie');
  return single ? [single] : [];
}

function findSetCookiePair(setCookies, name) {
  for (const header of setCookies) {
    const firstPair = header.split(';')[0];
    if (firstPair.startsWith(`${name}=`)) {
      return firstPair;
    }
  }
  return null;
}

function extractCsrfFieldValue(html) {
  const match = html.match(/<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/);
  return match ? match[1] : null;
}

async function login(asUrl) {
  const getLogin = await fetch(`${asUrl}/owner/login`, {
    headers: { Accept: 'text/html' },
    redirect: 'manual',
  });
  const csrfCookie = findSetCookiePair(getRawSetCookieList(getLogin), 'pdpp_owner_csrf');
  const csrfField = extractCsrfFieldValue(await getLogin.text());
  const resp = await fetch(`${asUrl}/owner/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
      Cookie: csrfCookie || '',
    },
    body: new URLSearchParams({ password: OWNER_PASSWORD, return_to: '/', _csrf: csrfField || '' }).toString(),
    redirect: 'manual',
  });
  const sessionCookie = findSetCookiePair(getRawSetCookieList(resp), 'pdpp_owner_session');
  assert.ok(sessionCookie, `expected owner session cookie, got status ${resp.status}`);
  return sessionCookie;
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
  return { body, resp, status: resp.status, text };
}

function loadManifest(name) {
  return JSON.parse(
    readFileSync(new URL(`../../packages/polyfill-connectors/manifests/${name}.json`, import.meta.url), 'utf8'),
  );
}

const VALID_TIMELINE_BODY = JSON.stringify({
  locations: [
    {
      timestampMs: '1717595122000',
      latitudeE7: 377_749_000,
      longitudeE7: -1_224_194_000,
    },
  ],
});

async function registerConnector(asUrl, name) {
  const resp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(loadManifest(name)),
  });
  assert.equal(resp.status, 201, `register ${name} failed: ${resp.status}`);
}

async function createDraft(asUrl, cookie, connectorId, setupFields = { account_email: 'owner@example.com' }) {
  return fetchJson(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/draft-connection`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ setup_fields: setupFields }),
  });
}

async function createManualUploadDraft(asUrl, cookie, connectorId) {
  const url = new URL(`${asUrl}/_ref/connectors/${encodeURIComponent(connectorId)}/manual-upload-draft-connection`);
  url.searchParams.set('file_name', 'Timeline.json');
  return fetchJson(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/octet-stream', Cookie: cookie },
    body: VALID_TIMELINE_BODY,
  });
}

async function capture(asUrl, cookie, connectionId) {
  return fetchJson(`${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/static-secret-credential`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ credential_kind: 'app_password', secret: SECRET }),
  });
}

async function getStatus(asUrl, cookie, connectionId, runId = null) {
  const suffix = runId ? `?run_id=${encodeURIComponent(runId)}` : '';
  return fetchJson(`${asUrl}/_ref/connections/${encodeURIComponent(connectionId)}/setup-status${suffix}`, {
    headers: { Accept: 'application/json', Cookie: cookie },
  });
}

async function listRefConnectors(asUrl, cookie) {
  return fetchJson(`${asUrl}/_ref/connectors`, {
    headers: { Accept: 'application/json', Cookie: cookie },
  });
}

async function ingest(rsUrl, ownerToken, connectorId, connectionId, stream, records) {
  const lines = records
    .map((record) => JSON.stringify({ key: record.id, data: record, emitted_at: record.emitted_at }))
    .join('\n');
  const url =
    `${rsUrl}/v1/ingest/${encodeURIComponent(stream)}` +
    `?connector_id=${encodeURIComponent(connectorId)}` +
    `&connector_instance_id=${encodeURIComponent(connectionId)}`;
  return fetchJson(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/x-ndjson' },
    body: lines,
  });
}

async function issueOwnerToken(asUrl, subjectId = OWNER_SUBJECT_ID) {
  const clientId = 'cli_longview';
  const { body: device } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
  });
  await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ user_code: device.user_code, subject_id: subjectId }).toString(),
  });
  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }).toString(),
  });
  return tokenBody.access_token;
}

// Seed a controller_active_runs row directly: the setup-status route reads this
// table (keyed on connector_instance_id) to report an in-flight first sync. In a
// live deployment the controller writes it on run start; the harness has no
// real collector, so we seed it deterministically.
function seedActiveRun(connectorInstanceId, connectorId, runId) {
  getDb()
    .prepare(
      `INSERT INTO controller_active_runs(connector_instance_id, connector_id, run_id, trace_id, scenario_id, started_at)
       VALUES(?, ?, ?, 'trc_status', 'default', '2026-06-10T00:00:00.000Z')`,
    )
    .run(connectorInstanceId, connectorId, runId);
}

function clearActiveRun(connectorInstanceId) {
  getDb().prepare('DELETE FROM controller_active_runs WHERE connector_instance_id = ?').run(connectorInstanceId);
}

async function emitTerminalRunEvent(connectorId, runId, status) {
  await emitSpineEvent({
    event_type: status === 'failed' ? 'run.failed' : 'run.completed',
    trace_id: 'trc_status_terminal',
    scenario_id: 'default',
    actor_type: 'runtime',
    actor_id: connectorId,
    object_type: 'run',
    object_id: runId,
    status: status === 'failed' ? 'failed' : 'succeeded',
    run_id: runId,
    source_kind: 'connector',
    source_id: connectorId,
    data: { source: { kind: 'connector', id: connectorId } },
  });
}

test('pending static-secret setup is visible before any records are accepted', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = await login(asUrl);

      const created = await createDraft(asUrl, cookie, 'gmail', { account_email: 'pending@example.com' });
      assert.equal(created.status, 201);
      const connectionId = created.body.connection_id;

      // Immediately after draft creation (no credential, no run): visible,
      // pending, awaiting credential, account identity surfaced.
      const awaiting = await getStatus(asUrl, cookie, connectionId);
      assert.equal(awaiting.status, 200, awaiting.text);
      assert.equal(awaiting.body.object, 'connection_setup_status');
      assert.equal(awaiting.body.connection_id, connectionId);
      assert.equal(awaiting.body.connector_id, 'gmail');
      assert.equal(awaiting.body.status, 'draft');
      assert.equal(awaiting.body.setup_kind, 'static_secret');
      assert.equal(awaiting.body.setup_material.label, 'Provider credential');
      assert.equal(awaiting.body.setup_material.present, false);
      assert.equal(awaiting.body.setup_state, 'awaiting_credential');
      assert.equal(awaiting.body.health_state, 'idle');
      assert.equal(awaiting.body.pending, true);
      assert.equal(awaiting.body.running, false);
      assert.equal(awaiting.body.account_identity, 'pending@example.com');
      assert.equal(awaiting.body.credential.present, false);

      // After capture but before ingest: still pending; first sync pending.
      const captured = await capture(asUrl, cookie, connectionId);
      assert.equal(captured.status, 201, captured.text);
      const afterCapture = await getStatus(asUrl, cookie, connectionId);
      assert.equal(afterCapture.body.credential.present, true);
      assert.equal(afterCapture.body.setup_material.present, true);
      assert.equal(afterCapture.body.credential.credential_kind, 'app_password');
      assert.equal(afterCapture.body.setup_state, 'first_sync_pending');
      assert.equal(afterCapture.body.pending, true);

      // With an in-flight run row: running is visible, run id surfaced.
      seedActiveRun(connectionId, 'gmail', 'run_status_inflight');
      const running = await getStatus(asUrl, cookie, connectionId);
      assert.equal(running.body.setup_state, 'first_sync_running');
      assert.equal(running.body.running, true);
      assert.equal(running.body.run.run_id, 'run_status_inflight');
      assert.equal(running.body.run.status, 'in_progress');

      // No secret ever appears in any status response.
      assert.ok(!running.text.includes(SECRET), 'status must not echo the secret');
      assert.ok(!afterCapture.text.includes(SECRET), 'status must not echo the secret');
      clearActiveRun(connectionId);
    });
  });
});

test('pending manual/upload setup is visible without credential semantics', async () => {
  await withServer(async ({ asUrl }) => {
    await registerConnector(asUrl, 'google_maps');
    const cookie = await login(asUrl);

    const created = await createManualUploadDraft(asUrl, cookie, 'google-maps');
    assert.equal(created.status, 201, created.text);
    const connectionId = created.body.connection_id;

    const pending = await getStatus(asUrl, cookie, connectionId);
    assert.equal(pending.status, 200, pending.text);
    assert.equal(pending.body.object, 'connection_setup_status');
    assert.equal(pending.body.connector_id, 'google-maps');
    assert.equal(pending.body.status, 'draft');
    assert.equal(pending.body.setup_kind, 'manual_upload');
    assert.equal(pending.body.setup_state, 'first_sync_pending');
    assert.equal(pending.body.setup_material.label, 'Import file (Timeline.json)');
    assert.equal(pending.body.setup_material.present, true);
    assert.equal(pending.body.credential.present, false);
    assert.match(pending.body.import_receipt.batch_id, /^ab_/);
    assert.equal(pending.body.import_receipt.status, 'validated');
    assert.equal(pending.body.import_receipt.detected_format, 'legacy_records');
    assert.equal(pending.body.import_receipt.parsed_count, 1);
    assert.equal(pending.body.import_receipt.accepted_count, 0);
    assert.equal(pending.body.import_receipt.duplicate_count, 0);
    assert.equal(pending.body.import_receipt.skipped_count, 0);
    assert.equal(pending.body.import_receipt.failed_count, 0);
    assert.equal(pending.body.import_receipt.estimated_points, 1);
    assert.equal(pending.body.import_receipt.estimated_segments, 0);
    assert.equal(pending.body.import_receipt.date_range.start, '2024-06-05T13:45:22.000Z');
    assert.equal(pending.body.import_receipt.date_range.end, '2024-06-05T13:45:22.000Z');
    assert.equal(pending.body.import_receipt.uploaded_file_name, 'Timeline.json');
    assert.equal(pending.body.import_receipt.acquisition_method, 'owner_artifact');
    assert.ok(!pending.text.includes('locations'), 'status must not echo uploaded file contents');
    assert.ok(!pending.text.includes('import_dir'), 'status must not leak import_dir');
    assert.ok(!pending.text.includes('GOOGLE_MAPS_TIMELINE_DIR'), 'status must not expose env-var plumbing');
    assert.ok(!pending.text.includes('file_sha256'), 'status must not expose artifact hashes');
  });
});

test('a failed first sync is visible with an actionable error and no secret leak', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = await login(asUrl);

      const created = await createDraft(asUrl, cookie, 'gmail');
      const connectionId = created.body.connection_id;
      await capture(asUrl, cookie, connectionId);

      // The run terminated as failed (no active-run row remains). The owner
      // surface holds the run id; the route resolves its terminal status.
      const runId = 'run_status_failed';
      await emitTerminalRunEvent('gmail', runId, 'failed');

      const failed = await getStatus(asUrl, cookie, connectionId, runId);
      assert.equal(failed.status, 200, failed.text);
      assert.equal(failed.body.status, 'draft');
      assert.equal(failed.body.setup_state, 'first_sync_failed');
      assert.equal(failed.body.health_state, 'needs_attention');
      assert.equal(failed.body.pending, true);
      assert.equal(failed.body.running, false);
      assert.ok(failed.body.last_error, 'failed first sync must carry last_error');
      assert.equal(typeof failed.body.last_error.reason, 'string');
      assert.equal(typeof failed.body.last_error.remediation, 'string');
      assert.ok(failed.body.last_error.remediation.length > 0, 'remediation copy must be present');
      assert.ok(!failed.text.includes(SECRET), 'failure status must not echo the secret');
    });
  });
});

test('setup status flips to active once first ingest accepts records', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withOpenServer(async ({ asUrl, rsUrl, server }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = '';
      const ownerToken = await issueOwnerToken(asUrl);

      const created = await createDraft(asUrl, cookie, 'gmail');
      const connectionId = created.body.connection_id;
      await capture(asUrl, cookie, connectionId);

      // First ingest with records flips the draft to active.
      const ingested = await ingest(rsUrl, ownerToken, 'gmail', connectionId, 'messages', [
        { id: 'm1', emitted_at: '2026-06-10T00:00:00.000Z', subject: 'hello' },
      ]);
      assert.equal(ingested.status, 200, ingested.text);

      const active = await getStatus(asUrl, cookie, connectionId);
      assert.equal(active.status, 200, active.text);
      assert.equal(active.body.status, 'active');
      assert.equal(active.body.setup_state, 'active');
      assert.equal(active.body.health_state, 'healthy');
      assert.equal(active.body.pending, false);

      const rotated = await capture(asUrl, cookie, connectionId);
      assert.equal(rotated.status, 200, rotated.text);
      assert.equal(typeof rotated.body.credential.rotated_at, 'string');
      assert.notEqual(rotated.body.credential.rotated_at, null);
      seedActiveRun(connectionId, 'gmail', 'run_status_credential_rotation');
      const verifying = await getStatus(asUrl, cookie, connectionId, 'run_status_credential_rotation');
      assert.equal(verifying.status, 200, verifying.text);
      assert.equal(verifying.body.status, 'active');
      assert.equal(verifying.body.setup_state, 'active');
      assert.equal(verifying.body.running, true);
      assert.equal(verifying.body.run.run_id, 'run_status_credential_rotation');
      assert.equal(verifying.body.credential.captured_at, active.body.credential.captured_at);
      assert.equal(verifying.body.credential.rotated_at, rotated.body.credential.rotated_at);
      assert.equal(verifying.body.setup_material.captured_at, rotated.body.credential.rotated_at);
      clearActiveRun(connectionId);

      const schedule = await server.controller.getSchedule('gmail', {
        connectorInstanceId: connectionId,
      });
      assert.ok(schedule, 'automatic static-secret activation must attach a schedule');
      assert.equal(schedule.connector_instance_id, connectionId);
      assert.equal(schedule.interval_seconds, 900);
      assert.equal(schedule.enabled, true);
    });
  });
});

test('active static-secret source without draft binding still surfaces credential repair state', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withOpenServer(async ({ asUrl, rsUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = '';
      const ownerToken = await issueOwnerToken(asUrl);

      const created = await createDraft(asUrl, cookie, 'gmail');
      const connectionId = created.body.connection_id;
      await capture(asUrl, cookie, connectionId);

      const ingested = await ingest(rsUrl, ownerToken, 'gmail', connectionId, 'messages', [
        { id: 'm1', emitted_at: '2026-06-10T00:00:00.000Z', subject: 'hello' },
      ]);
      assert.equal(ingested.status, 200, ingested.text);

      getDb()
        .prepare(`UPDATE connector_instances SET source_binding_json = '{}' WHERE connector_instance_id = ?`)
        .run(connectionId);

      const rotated = await capture(asUrl, cookie, connectionId);
      assert.equal(rotated.status, 200, rotated.text);
      seedActiveRun(connectionId, 'gmail', 'run_status_legacy_rotation');

      const status = await getStatus(asUrl, cookie, connectionId, 'run_status_legacy_rotation');
      assert.equal(status.status, 200, status.text);
      assert.equal(status.body.status, 'active');
      assert.equal(status.body.setup_kind, 'static_secret');
      assert.equal(status.body.setup_state, 'active');
      assert.equal(status.body.running, true);
      assert.equal(status.body.credential.present, true);
      assert.equal(status.body.credential.rotated_at, rotated.body.credential.rotated_at);
      assert.equal(status.body.setup_material.kind, 'static_secret');
      assert.equal(status.body.setup_material.present, true);
      assert.equal(status.body.setup_material.captured_at, rotated.body.credential.rotated_at);
      clearActiveRun(connectionId);
    });
  });
});

test('manual/upload setup status shows committed acquisition-batch counts after ingest', async () => {
  await withOpenServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, 'google_maps');
    const cookie = '';
    const ownerToken = await issueOwnerToken(asUrl);

    const created = await createManualUploadDraft(asUrl, cookie, 'google-maps');
    assert.equal(created.status, 201, created.text);
    const connectionId = created.body.connection_id;

    const ingested = await ingest(rsUrl, ownerToken, 'google-maps', connectionId, 'timeline_points', [
      {
        id: 'point_1',
        emitted_at: '2024-06-05T13:45:22.000Z',
        timestamp: '2024-06-05T13:45:22.000Z',
        latitude: 37.7749,
        longitude: -122.4194,
        source_format: 'legacy_records',
        source_kind: 'raw_location',
      },
    ]);
    assert.equal(ingested.status, 200, ingested.text);

    const active = await getStatus(asUrl, cookie, connectionId);
    assert.equal(active.status, 200, active.text);
    assert.equal(active.body.status, 'active');
    assert.equal(active.body.setup_state, 'active');
    assert.equal(active.body.import_receipt.status, 'committed');
    assert.equal(active.body.import_receipt.parsed_count, 1);
    assert.equal(active.body.import_receipt.accepted_count, 1);
    assert.equal(active.body.import_receipt.duplicate_count, 0);
    assert.equal(active.body.import_receipt.failed_count, 0);
    assert.equal(active.body.import_receipt.acquisition_method, 'owner_artifact');

    const summaries = await listRefConnectors(asUrl, cookie);
    assert.equal(summaries.status, 200, summaries.text);
    const summary = summaries.body.data.find((item) => item.connection_id === connectionId);
    assert.ok(summary, 'manual upload connection summary should be visible after ingest');
    assert.equal(summary.acquisition_coverage.latest_batch.status, 'committed');
    assert.equal(summary.acquisition_coverage.latest_batch.acquisition_method, 'owner_artifact');
    assert.equal(summary.acquisition_coverage.latest_batch.accepted_count, 1);
    assert.equal(summary.acquisition_coverage.latest_batch.detected_format, 'legacy_records');
    assert.equal(summary.acquisition_coverage.latest_batch.uploaded_file_name, 'Timeline.json');
    assert.equal(Object.hasOwn(summary.acquisition_coverage.latest_batch, 'artifact_sha256'), false);

    const provenance = getDb()
      .prepare(
        `SELECT batch_id, acquisition_method, connector_instance_id, stream, record_key
           FROM record_acquisition_provenance
          WHERE connector_instance_id = ?
            AND stream = 'timeline_points'
            AND record_key = 'point_1'`,
      )
      .get(connectionId);
    assert.equal(provenance.batch_id, active.body.import_receipt.batch_id);
    assert.equal(provenance.acquisition_method, 'owner_artifact');
    assert.equal(provenance.connector_instance_id, connectionId);

    const publicRead = await fetch(
      `${rsUrl}/v1/streams/timeline_points/records?connector_id=${encodeURIComponent('google-maps')}&connection_id=${encodeURIComponent(connectionId)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    const publicReadText = await publicRead.text();
    assert.equal(publicRead.status, 200, publicReadText);
    assert.match(publicReadText, /"point_1"/, 'public read should still expose the accepted record');
    for (const forbidden of ['acquisition_coverage', 'import_receipt', 'artifact_sha256', 'media_coverage']) {
      assert.ok(!publicReadText.includes(forbidden), `${forbidden} must not leak onto public /v1 records reads`);
    }

    const providerBatchId = 'ab_provider_api_same_stream';
    getDb()
      .prepare(
        `INSERT INTO acquisition_batches(
           batch_id, owner_subject_id, connector_id, connector_instance_id,
           acquisition_method, source_format, parser_version, artifact_sha256,
           uploaded_file_name, status, event_time_start, event_time_end,
           parsed_count, accepted_count, duplicate_count, skipped_count, failed_count,
           media_coverage_json, warnings_json, receipt_json, created_at, updated_at
         )
         VALUES(?, ?, ?, ?, 'provider_api', 'data_portability', 'test-provider-v1', NULL,
           NULL, 'validated', '2024-06-05T13:45:22.000Z', '2024-06-06T00:00:00.000Z',
           1, 0, 0, 0, 0, NULL, '[]', NULL, '9999-01-01T00:00:00.000Z', '9999-01-01T00:00:00.000Z')`,
      )
      .run(providerBatchId, OWNER_SUBJECT_ID, 'google-maps', connectionId);

    const apiIngest = await ingest(rsUrl, ownerToken, 'google-maps', connectionId, 'timeline_points', [
      {
        id: 'point_1',
        emitted_at: '2024-06-05T13:45:22.000Z',
        timestamp: '2024-06-05T13:45:22.000Z',
        latitude: 37.7749,
        longitude: -122.4194,
        source_format: 'data_portability',
        source_kind: 'raw_location',
      },
    ]);
    assert.equal(apiIngest.status, 200, apiIngest.text);

    const provenanceMethods = getDb()
      .prepare(
        `SELECT acquisition_method
           FROM record_acquisition_provenance
          WHERE connector_instance_id = ?
            AND stream = 'timeline_points'
            AND record_key = 'point_1'
          ORDER BY acquisition_method`,
      )
      .all(connectionId)
      .map((row) => row.acquisition_method);
    assert.deepEqual(provenanceMethods, ['owner_artifact', 'provider_api']);

    const batchCounts = getDb()
      .prepare(
        `SELECT batch_id, accepted_count
           FROM acquisition_batches
          WHERE connector_instance_id = ?
          ORDER BY created_at ASC, batch_id ASC`,
      )
      .all(connectionId);
    assert.deepEqual(
      batchCounts.map((row) => [row.batch_id, row.accepted_count]),
      [
        [active.body.import_receipt.batch_id, 1],
        [providerBatchId, 1],
      ],
    );
  });
});

test('setup status requires an owner session and 404s an unknown connection', async () => {
  await withCredentialKey(TEST_KEY, async () => {
    await withServer(async ({ asUrl }) => {
      await registerConnector(asUrl, 'gmail');
      const cookie = await login(asUrl);

      // Unauthenticated read is rejected (no owner session cookie).
      const anon = await getStatus(asUrl, '', 'cin_does_not_exist');
      assert.ok(anon.status === 401 || anon.status === 403, `expected auth rejection, got ${anon.status}`);

      // Unknown connection id is a clean 404, not a fabricated status.
      const missing = await getStatus(asUrl, cookie, 'cin_does_not_exist');
      assert.equal(missing.status, 404, missing.text);
    });
  });
});
