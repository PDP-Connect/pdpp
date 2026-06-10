/**
 * Integration suite for the bearer-authed owner-agent run-now control routes
 * (mounted from `server/routes/owner-connection-run.ts`):
 *
 *   POST /v1/owner/connections/:connectionId/run
 *   POST /v1/owner/connectors/:connectorId/run
 *
 * Covers the instance-scoped owner-agent run slice (tasks 6.1-6.3) plus the
 * authorization/audit hardening (tasks 3.1-3.3, 8.1, 8.4):
 *
 *   - a trusted owner-agent bearer starts a run for an instance-scoped
 *     connection by `connection_id` and receives a 202 with the run handle;
 *   - the connector-only route auto-selects the single active connection
 *     (single-instance compatibility, task 6.3);
 *   - the connector-only route rejects a connector with two active connections
 *     using a typed `ambiguous_connection` (409) carrying the available
 *     `connection_id` values and `retry_with: connection_id` (task 6.2);
 *   - every run attempt emits non-secret `owner_agent.connection.run` audit
 *     evidence; failures are typed and audited without secrets (task 3.3);
 *   - client grant tokens (403), missing bearers (401), and `/mcp` owner
 *     bearers (403) cannot reach the routes (tasks 3.1, 3.2);
 *   - the control surface advertises run_connection as supported (task 2.3).
 *
 * The run path requires a runnable connector implementation, so these tests
 * inject a trivial echo connector via `connectorPathResolver` (the same hook
 * `run-interaction-control.test.js` uses) that completes immediately, so the
 * 202 resolves and the run drains cleanly on teardown.
 *
 * Spec: openspec/changes/add-owner-agent-control-surface
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { listSpineEventsPage } from '../lib/spine.ts';
import { canonicalConnectorKey } from '../server/connector-key.js';
import { startServer } from '../server/index.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';

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

// A connector that completes immediately on START so run-now returns a 202
// handle and the run drains without lingering on teardown.
function buildImmediateConnectorFixture(tmpDir) {
  const path = join(tmpDir, 'connector.mjs');
  writeFileSync(
    path,
    `
import { createInterface } from 'readline';
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === 'START') {
    process.stdout.write(JSON.stringify({ type: 'DONE', status: 'succeeded', records_emitted: 0 }) + '\\n');
    rl.close();
    process.exit(0);
  }
});
`,
    'utf8',
  );
  return path;
}

async function withServer(fn) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'pdpp-owner-run-'));
  const connectorPath = buildImmediateConnectorFixture(tmpDir);
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: '',
    connectorPathResolver: () => connectorPath,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Device-code exchange yields an owner-kind bearer (pdpp_token_kind: "owner").
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

// PAR + consent yields a grant-scoped client-kind bearer (pdpp_token_kind:
// "client"). These must NOT reach the owner-agent control surface.
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
        purpose_description: 'owner-connection run boundary test',
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
  ownerSubjectId = OWNER_SUBJECT_ID,
}) {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorInstanceId,
    ownerSubjectId,
    connectorId,
    displayName,
    status: 'active',
    sourceKind: 'account',
    sourceBindingKey,
    sourceBinding: { account_hint: sourceBindingKey },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function postRun(rsUrl, ownerToken, path) {
  return fetchJson(`${rsUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
  });
}

function findRunAuditEvent(resp) {
  const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
  assert.ok(traceId?.startsWith('trc_'), 'run response should carry an audit trace id');
  const page = listSpineEventsPage('trace', traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === 'owner_agent.connection.run');
  assert.ok(event, 'expected owner-agent run audit event');
  assert.equal(event.request_id, resp.headers.get('Request-Id'));
  assert.equal(event.token_id, null, 'audit event must not store bearer tokens');
  return event;
}

test('owner-agent bearer starts an instance-scoped connection run (202) and audits it', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_personal',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const run = await postRun(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_personal/run');
    assert.equal(run.status, 202);
    assert.ok(typeof run.body?.run_id === 'string' && run.body.run_id.length > 0, 'run handle must carry a run_id');

    const audit = findRunAuditEvent(run.resp);
    assert.equal(audit.actor_type, 'owner_agent');
    assert.equal(audit.actor_id, OWNER_CLIENT_ID);
    assert.equal(audit.client_id, OWNER_CLIENT_ID);
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.object_type, 'connection');
    assert.equal(audit.object_id, 'cin_spotify_personal');
    assert.equal(audit.status, 'succeeded');
    assert.equal(audit.data?.actor_kind, 'owner_agent');
    assert.equal(audit.data?.auth_token_kind, 'owner');
    assert.equal(audit.data?.operation, 'run_now');
    assert.equal(audit.data?.selector, 'connection_id');
    assert.equal(audit.data?.connection_id, 'cin_spotify_personal');
    assert.equal(audit.data?.connector_key, connectorKey);
    assert.equal(audit.data?.run_id, run.body.run_id, 'audit records the run handle id');
  });
});

test('owner-agent connector-only run auto-selects the single active connection', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_only',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const run = await postRun(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/run`,
    );
    assert.equal(run.status, 202);
    assert.ok(typeof run.body?.run_id === 'string');

    const audit = findRunAuditEvent(run.resp);
    assert.equal(audit.data?.selector, 'connector_id');
    // The auto-selected connection's concrete id is recorded for audit.
    assert.equal(audit.data?.connection_id, 'cin_spotify_only');
    assert.equal(audit.data?.operation, 'run_now');
  });
});

test('owner-agent connector-only run rejects two active connections with typed ambiguous_connection', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_personal',
      connectorId: connectorKey,
      displayName: 'the owner personal',
      sourceBindingKey: 'the owner@example.com',
    });
    await seedInstance({
      connectorInstanceId: 'cin_spotify_shared',
      connectorId: connectorKey,
      displayName: 'Shared Spotify',
      sourceBindingKey: 'shared@example.com',
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await postRun(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/run`,
    );
    assert.equal(status, 409);
    assert.equal(body?.error?.code, 'ambiguous_connection');
    // The envelope carries the available connection ids + retry guidance so the
    // agent can recover without a probe.
    assert.equal(body?.error?.retry_with, 'connection_id');
    const ids = (body?.error?.available_connections ?? []).map((c) => c.connection_id).sort();
    assert.deepEqual(ids, ['cin_spotify_personal', 'cin_spotify_shared']);
    // Owner-meaningful labels travel with the available connections.
    const labels = (body?.error?.available_connections ?? [])
      .map((c) => c.display_name)
      .filter(Boolean)
      .sort();
    assert.deepEqual(labels, ['Shared Spotify', 'the owner personal']);

    const audit = findRunAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.data?.selector, 'connector_id');
    assert.equal(audit.data?.connector_key, connectorKey);
    assert.equal(audit.data?.operation, 'run_now');
    assert.equal(audit.data?.error?.code, 'ambiguous_connection');
    assert.equal(audit.data?.error?.http_status, 409);
  });
});

test('owner-agent run on an unknown connection_id returns a typed 404', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await postRun(rsUrl, ownerToken, '/v1/owner/connections/cin_missing/run');
    assert.equal(status, 404);
    assert.equal(body?.error?.code, 'connector_instance_not_found');
    const audit = findRunAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.object_id, 'cin_missing');
    assert.equal(audit.data?.connection_id, 'cin_missing');
    assert.equal(audit.data?.error?.code, 'connector_instance_not_found');
  });
});

test('owner-agent run cannot cross owners (other-owner instance is not found)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_other',
      connectorId: connectorKey,
      displayName: 'Other Spotify',
      sourceBindingKey: 'other@example.com',
      ownerSubjectId: OTHER_SUBJECT_ID,
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status } = await postRun(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_other/run');
    // Resolver rejects the foreign instance.
    assert.ok(status === 404 || status === 403, `expected 404/403, got ${status}`);
  });
});

test('owner-agent run rejects a client grant token with 403 and audits it', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_personal',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });
    const clientToken = await approveClientGrant(asUrl, connectorKey, manifest.streams[0].name);

    const { status, body, resp } = await postRun(
      rsUrl,
      clientToken,
      '/v1/owner/connections/cin_spotify_personal/run',
    );
    assert.equal(status, 403);
    assert.equal(body?.error?.code, 'permission_error');

    const audit = findRunAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.actor_type, 'client');
    assert.equal(audit.data?.actor_kind, 'client');
    assert.equal(audit.data?.operation, 'run_now');
    assert.equal(audit.data?.error?.code, 'permission_error');
  });
});

test('owner-agent run rejects a request with no bearer (401)', async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/owner/connections/cin_spotify_personal/run`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    );
    assert.equal(status, 401);
    assert.equal(body?.error?.type, 'authentication_error');
  });
});

test('/mcp continues to reject owner-agent bearers after run control lands', async () => {
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

test('owner-agent control document advertises run_connection as supported with a run URL', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const run = body.actions.find((a) => a.family === 'run_connection');
    assert.ok(run, 'run_connection must be advertised');
    assert.equal(run.status, 'supported');
    assert.equal(run.method, 'POST');
    assert.equal(run.url, `${rsUrl}/v1/owner/connections/{connection_id}/run`);
  });
});
