/**
 * Integration suite for the bearer-authed owner-agent connection-scoped
 * diagnostics reads (mounted from `server/routes/owner-connection-diagnostics.ts`):
 *
 *   GET /v1/owner/connections/:connectionId/diagnostics
 *   GET /v1/owner/connectors/:connectorId/diagnostics
 *
 * Covers the connection-scoped diagnostics primitive (design "Deferred:
 * connection-scoped diagnostics", tasks 6.1d / 3.1d flip) plus the
 * authorization/audit hardening shared by the owner-agent control family:
 *
 *   - a trusted owner-agent bearer reads ONE connection's diagnostics by
 *     `connection_id` and receives the typed health classification, last run,
 *     last successful run, last ingest time, schedule state, and freshness;
 *   - the response is connection-scoped: it carries no device-exporter subsystem
 *     state and no sibling-connection rows, even when the owner has two active
 *     connections for the same connector (the over-broad sharing the design
 *     rejected for device-rooted diagnostics);
 *   - the connector-only route auto-selects the single active connection, and
 *     rejects a connector with two active connections using a typed
 *     `ambiguous_connection` (409) carrying the available `connection_id` values
 *     and `retry_with: connection_id`;
 *   - every read emits non-secret `owner_agent.connection.inspect` audit
 *     evidence with no bearer token;
 *   - client grant tokens (403), missing bearers (401), unknown/foreign
 *     connections (404), and `/mcp` owner bearers (403) cannot read diagnostics;
 *   - the control surface advertises inspect_diagnostics as supported.
 *
 * Spec: openspec/changes/add-owner-agent-control-surface
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
    await fn({ asUrl, rsUrl });
  } finally {
    await closeServer(server);
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
        purpose_description: 'owner-connection diagnostics boundary test',
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

async function getDiagnostics(rsUrl, ownerToken, path) {
  return fetchJson(`${rsUrl}${path}`, {
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
}

function findInspectAuditEvent(resp) {
  const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
  assert.ok(traceId?.startsWith('trc_'), 'diagnostics response should carry an audit trace id');
  const page = listSpineEventsPage('trace', traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === 'owner_agent.connection.inspect');
  assert.ok(event, 'expected owner-agent inspect audit event');
  assert.equal(event.request_id, resp.headers.get('Request-Id'));
  assert.equal(event.token_id, null, 'audit event must not store bearer tokens');
  return event;
}

const HEALTH_STATES = new Set([
  'blocked',
  'cooling_off',
  'degraded',
  'healthy',
  'idle',
  'needs_attention',
  'unknown',
]);

test('owner-agent bearer reads connection-scoped diagnostics by connection_id and audits it', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_personal',
      connectorId: connectorKey,
      displayName: 'the owner personal',
      sourceBindingKey: 'the owner@example.com',
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await getDiagnostics(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_spotify_personal/diagnostics',
    );
    assert.equal(status, 200);
    assert.equal(body?.object, 'owner_connection_diagnostics');
    assert.equal(body?.connection_id, 'cin_spotify_personal');
    assert.equal(body?.connector_id, connectorKey);
    assert.equal(body?.connector_key, connectorKey);
    assert.equal(body?.display_name, 'the owner personal');
    // Typed health classification using the canonical taxonomy. A seeded
    // never-run connection projects to `idle` (no terminal run evidence).
    assert.ok(HEALTH_STATES.has(body?.health?.state), `unexpected health state: ${body?.health?.state}`);
    assert.ok('reason_code' in (body?.health ?? {}), 'health carries reason_code');
    assert.ok('axes' in (body?.health ?? {}), 'health carries axes');
    assert.ok('badges' in (body?.health ?? {}), 'health carries badges');
    // Connection-scoped run + schedule + freshness fields are present (null when
    // no evidence), and the response declares last_ingest_at.
    assert.ok('last_run' in body, 'response carries last_run');
    assert.ok('last_successful_run' in body, 'response carries last_successful_run');
    assert.ok('last_ingest_at' in body, 'response carries last_ingest_at');
    assert.ok('schedule' in body, 'response carries schedule');
    assert.ok('freshness' in body, 'response carries freshness');

    const audit = findInspectAuditEvent(resp);
    assert.equal(audit.actor_type, 'owner_agent');
    assert.equal(audit.actor_id, OWNER_CLIENT_ID);
    assert.equal(audit.client_id, OWNER_CLIENT_ID);
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.object_type, 'connection');
    assert.equal(audit.object_id, 'cin_spotify_personal');
    assert.equal(audit.status, 'succeeded');
    assert.equal(audit.data?.actor_kind, 'owner_agent');
    assert.equal(audit.data?.auth_token_kind, 'owner');
    assert.equal(audit.data?.operation, 'inspect_diagnostics');
    assert.equal(audit.data?.selector, 'connection_id');
    assert.equal(audit.data?.connection_id, 'cin_spotify_personal');
    assert.equal(audit.data?.connector_key, connectorKey);
    assert.equal(audit.data?.health_state, body.health.state, 'audit records the observed health state');
  });
});

test('diagnostics is connection-scoped: two active connections do not leak into one read', async () => {
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
    const { status, body } = await getDiagnostics(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_spotify_personal/diagnostics',
    );
    assert.equal(status, 200);
    // The read describes exactly the addressed connection — never the sibling.
    assert.equal(body?.connection_id, 'cin_spotify_personal');
    assert.equal(body?.display_name, 'the owner personal');
    // The sibling connection id must appear nowhere in the serialized response
    // (no device-wide / sibling-connection bleed-through).
    const serialized = JSON.stringify(body);
    assert.ok(
      !serialized.includes('cin_spotify_shared'),
      'sibling connection_id must not leak into a connection-scoped diagnostics read',
    );
    assert.ok(
      !serialized.includes('Shared Spotify'),
      'sibling display_name must not leak into a connection-scoped diagnostics read',
    );
    // The response carries no device-exporter subsystem envelope.
    assert.ok(!serialized.includes('device_exporter'), 'must not carry device-exporter subsystem state');
    assert.ok(!serialized.includes('source_instances'), 'must not carry device source-instance list');
  });
});

test('owner-agent connector-only diagnostics auto-selects the single active connection', async () => {
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
    const { status, body, resp } = await getDiagnostics(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/diagnostics`,
    );
    assert.equal(status, 200);
    assert.equal(body?.connection_id, 'cin_spotify_only');

    const audit = findInspectAuditEvent(resp);
    assert.equal(audit.data?.selector, 'connector_id');
    assert.equal(audit.data?.connection_id, 'cin_spotify_only');
    assert.equal(audit.data?.operation, 'inspect_diagnostics');
  });
});

test('owner-agent connector-only diagnostics rejects two active connections with typed ambiguous_connection', async () => {
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
    const { status, body, resp } = await getDiagnostics(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/diagnostics`,
    );
    assert.equal(status, 409);
    assert.equal(body?.error?.code, 'ambiguous_connection');
    assert.equal(body?.error?.retry_with, 'connection_id');
    const ids = (body?.error?.available_connections ?? []).map((c) => c.connection_id).sort();
    assert.deepEqual(ids, ['cin_spotify_personal', 'cin_spotify_shared']);
    const labels = (body?.error?.available_connections ?? [])
      .map((c) => c.display_name)
      .filter(Boolean)
      .sort();
    assert.deepEqual(labels, ['Shared Spotify', 'the owner personal']);

    const audit = findInspectAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.data?.selector, 'connector_id');
    assert.equal(audit.data?.connector_key, connectorKey);
    assert.equal(audit.data?.operation, 'inspect_diagnostics');
    assert.equal(audit.data?.error?.code, 'ambiguous_connection');
    assert.equal(audit.data?.error?.http_status, 409);
  });
});

test('owner-agent diagnostics on an unknown connection_id returns a typed 404', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await getDiagnostics(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_missing/diagnostics',
    );
    assert.equal(status, 404);
    assert.equal(body?.error?.code, 'connector_instance_not_found');
    const audit = findInspectAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.object_id, 'cin_missing');
    assert.equal(audit.data?.connection_id, 'cin_missing');
    assert.equal(audit.data?.error?.code, 'connector_instance_not_found');
  });
});

test('owner-agent diagnostics cannot cross owners (other-owner instance is not found)', async () => {
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
    const { status } = await getDiagnostics(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_spotify_other/diagnostics',
    );
    // Resolver rejects the foreign instance.
    assert.ok(status === 404 || status === 403, `expected 404/403, got ${status}`);
  });
});

test('owner-agent diagnostics rejects a client grant token with 403 and audits it', async () => {
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

    const { status, body, resp } = await getDiagnostics(
      rsUrl,
      clientToken,
      '/v1/owner/connections/cin_spotify_personal/diagnostics',
    );
    assert.equal(status, 403);
    assert.equal(body?.error?.code, 'permission_error');

    const audit = findInspectAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.actor_type, 'client');
    assert.equal(audit.data?.actor_kind, 'client');
    assert.equal(audit.data?.operation, 'inspect_diagnostics');
    assert.equal(audit.data?.error?.code, 'permission_error');
  });
});

test('owner-agent diagnostics rejects a request with no bearer (401)', async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/owner/connections/cin_spotify_personal/diagnostics`,
    );
    assert.equal(status, 401);
    assert.equal(body?.error?.type, 'authentication_error');
  });
});

test('/mcp continues to reject owner-agent bearers after diagnostics control lands', async () => {
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

test('owner-agent control document advertises inspect_diagnostics as supported with a diagnostics URL', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const diagnostics = body.actions.find((a) => a.family === 'inspect_diagnostics');
    assert.ok(diagnostics, 'inspect_diagnostics must be advertised');
    assert.equal(diagnostics.status, 'supported');
    assert.equal(diagnostics.method, 'GET');
    assert.equal(diagnostics.url, `${rsUrl}/v1/owner/connections/{connection_id}/diagnostics`);
  });
});
