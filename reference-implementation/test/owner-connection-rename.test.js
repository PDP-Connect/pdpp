/**
 * Integration suite for the bearer-authed owner-agent connection rename route
 * `PATCH /v1/owner/connections/:connectionId` (mounted from
 * `server/routes/owner-connections.ts`).
 *
 * Covers the owner-agent rename slice (task 4.4) of the owner-agent control
 * surface:
 *
 *   - a trusted owner-agent bearer can rename a seeded connection, and a
 *     follow-up `GET /v1/owner/connections` reflects the new `display_name`
 *     with `label_status: "owner_set"`;
 *   - the rename response itself carries the owner-agent contract
 *     (`connection_id`, `connector_key`, `label_status: "owner_set"`);
 *   - client grant tokens and missing/unauthenticated bearers cannot rename;
 *   - `/mcp` continues to reject owner bearers (the boundary this lane preserves);
 *   - missing / empty / non-string `display_name` return a typed 400
 *     `invalid_request` with `param: "display_name"`;
 *   - an unknown / cross-owner `connection_id` returns a typed 404
 *     `connector_instance_not_found`;
 *   - the public read connection alias agrees on `connection_id` and the
 *     renamed `display_name` after rename.
 *
 * Spec: openspec/changes/add-owner-agent-control-surface
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { listSpineEventsPage } from '../lib/spine.ts';
import { startServer } from '../server/index.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { canonicalConnectorKey } from '../server/connector-key.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const OWNER_SUBJECT_ID = 'owner_local';
const OTHER_SUBJECT_ID = 'owner_other';
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
  const server = await startServer({ quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:', ownerAuthPassword: '' });
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
  const clientId = 'cli_longview';
  const device = (await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }).toString(),
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
      client_id: clientId,
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
        purpose_description: 'owner-connection rename boundary test',
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

function loadManifest(name) {
  return JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, '..', 'packages', 'polyfill-connectors', 'manifests', `${name}.json`), 'utf8'),
  );
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

async function seedInstance({ connectorInstanceId, connectorId, displayName, sourceBindingKey, ownerSubjectId = OWNER_SUBJECT_ID }) {
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

async function renameConnection(rsUrl, ownerToken, connectionId, body) {
  return fetchJson(`${rsUrl}/v1/owner/connections/${encodeURIComponent(connectionId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${ownerToken}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function findRenameAuditEvent(resp) {
  const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
  assert.ok(traceId?.startsWith('trc_'), 'rename response should carry an audit trace id');
  const page = listSpineEventsPage('trace', traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === 'owner_agent.connection.rename');
  assert.ok(event, 'expected owner-agent rename audit event');
  assert.equal(event.request_id, resp.headers.get('Request-Id'));
  assert.equal(event.token_id, null, 'audit event must not store bearer tokens');
  assert.equal(event.data?.display_name, undefined, 'audit event must not store raw display_name values');
  assert.equal(typeof event.data?.display_name_supplied, 'boolean');
  return event;
}

test('owner-agent bearer renames a connection and the listing reflects the new label', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    // Seed unlabeled (display_name == connector key) so it starts as fallback.
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: connectorKey,
      displayName: connectorKey,
      sourceBindingKey: 'the owner@example.com',
    });

    const ownerToken = await issueOwnerToken(asUrl);

    // Precondition: the listing reports the connection as label-needed.
    const before = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const beforeRow = before.body.data.find((r) => r.connection_id === 'cin_amazon_personal');
    assert.equal(beforeRow.label_status, 'fallback');

    // Rename.
    const { status, body, resp } = await renameConnection(rsUrl, ownerToken, 'cin_amazon_personal', {
      display_name: 'the owner personal',
    });
    assert.equal(status, 200);
    assert.equal(body.object, 'owner_connection');
    assert.equal(body.connection_id, 'cin_amazon_personal');
    assert.equal(body.connector_instance_id, 'cin_amazon_personal');
    assert.equal(body.connector_key, connectorKey);
    assert.equal(body.connector_id, connectorKey);
    assert.equal(body.display_name, 'the owner personal');
    assert.equal(body.label_status, 'owner_set');

    const audit = findRenameAuditEvent(resp);
    assert.equal(audit.actor_type, 'owner_agent');
    assert.equal(audit.actor_id, 'cli_longview');
    assert.equal(audit.client_id, 'cli_longview');
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.object_type, 'connection');
    assert.equal(audit.object_id, 'cin_amazon_personal');
    assert.equal(audit.status, 'succeeded');
    assert.equal(audit.data?.actor_kind, 'owner_agent');
    assert.equal(audit.data?.auth_token_kind, 'owner');
    assert.equal(audit.data?.operation, 'rename_connection');
    assert.equal(audit.data?.connector_key, connectorKey);
    assert.equal(audit.data?.display_name_supplied, true);
    assert.equal(audit.data?.label_status, 'owner_set');

    // Follow-up listing reflects the new label with owner_set status.
    const after = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const afterRow = after.body.data.find((r) => r.connection_id === 'cin_amazon_personal');
    assert.equal(afterRow.display_name, 'the owner personal');
    assert.equal(afterRow.label_status, 'owner_set');
  });
});

test('owner-agent bearer can label two Amazon connections distinctly', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: connectorKey,
      displayName: connectorKey,
      sourceBindingKey: 'the owner@example.com',
    });
    await seedInstance({
      connectorInstanceId: 'cin_amazon_shared',
      connectorId: connectorKey,
      displayName: connectorKey,
      sourceBindingKey: 'shared@example.com',
    });

    const ownerToken = await issueOwnerToken(asUrl);
    await renameConnection(rsUrl, ownerToken, 'cin_amazon_personal', { display_name: 'the owner personal' });
    await renameConnection(rsUrl, ownerToken, 'cin_amazon_shared', { display_name: 'Shared Amazon' });

    const { body } = await fetchJson(
      `${rsUrl}/v1/owner/connections?connector_id=${encodeURIComponent(connectorKey)}`,
      { headers: { Authorization: `Bearer ${ownerToken}` } },
    );
    const personal = body.data.find((r) => r.connection_id === 'cin_amazon_personal');
    const shared = body.data.find((r) => r.connection_id === 'cin_amazon_shared');
    assert.equal(personal.display_name, 'the owner personal');
    assert.equal(personal.label_status, 'owner_set');
    assert.equal(shared.display_name, 'Shared Amazon');
    assert.equal(shared.label_status, 'owner_set');
  });
});

test('owner-agent rename trims whitespace around the display name', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: connectorKey,
      displayName: connectorKey,
      sourceBindingKey: 'the owner@example.com',
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await renameConnection(rsUrl, ownerToken, 'cin_amazon_personal', {
      display_name: '  the owner personal  ',
    });
    assert.equal(status, 200);
    assert.equal(body.display_name, 'the owner personal');
  });
});

test('owner-agent rename rejects a missing display_name with a typed 400', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: connectorKey,
      displayName: connectorKey,
      sourceBindingKey: 'the owner@example.com',
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await renameConnection(rsUrl, ownerToken, 'cin_amazon_personal', {});
    assert.equal(status, 400);
    assert.equal(body?.error?.code, 'invalid_request');
    assert.equal(body?.error?.param, 'display_name');
    const audit = findRenameAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.data?.actor_kind, 'owner_agent');
    assert.equal(audit.data?.display_name_supplied, false);
    assert.equal(audit.data?.error?.code, 'invalid_request');
    assert.equal(audit.data?.error?.http_status, 400);
  });
});

test('owner-agent rename rejects an empty/whitespace display_name with a typed 400', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: connectorKey,
      displayName: connectorKey,
      sourceBindingKey: 'the owner@example.com',
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await renameConnection(rsUrl, ownerToken, 'cin_amazon_personal', {
      display_name: '   ',
    });
    assert.equal(status, 400);
    assert.equal(body?.error?.code, 'invalid_request');
    assert.equal(body?.error?.param, 'display_name');
  });
});

test('owner-agent rename rejects a non-string display_name with a typed 400', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: connectorKey,
      displayName: connectorKey,
      sourceBindingKey: 'the owner@example.com',
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await renameConnection(rsUrl, ownerToken, 'cin_amazon_personal', {
      display_name: 42,
    });
    assert.equal(status, 400);
    assert.equal(body?.error?.code, 'invalid_request');
    assert.equal(body?.error?.param, 'display_name');
  });
});

test('owner-agent rename of an unknown connection_id returns a typed 404', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadManifest('amazon'));
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await renameConnection(rsUrl, ownerToken, 'cin_does_not_exist', {
      display_name: 'Whatever',
    });
    assert.equal(status, 404);
    assert.equal(body?.error?.code, 'connector_instance_not_found');
  });
});

test('owner-agent rename cannot cross owners (other owner instance is not found)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    // Instance belongs to a DIFFERENT owner subject.
    await seedInstance({
      connectorInstanceId: 'cin_amazon_other',
      connectorId: connectorKey,
      displayName: connectorKey,
      sourceBindingKey: 'other@example.com',
      ownerSubjectId: OTHER_SUBJECT_ID,
    });
    // Token authenticates as the default OWNER_SUBJECT_ID.
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await renameConnection(rsUrl, ownerToken, 'cin_amazon_other', {
      display_name: 'Hijack attempt',
    });
    assert.equal(status, 404);
    assert.equal(body?.error?.code, 'connector_instance_not_found');
  });
});

test('owner-agent rename rejects a client grant token with 403', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: connectorKey,
      displayName: connectorKey,
      sourceBindingKey: 'the owner@example.com',
    });
    const streamName = manifest.streams[0].name;
    const clientToken = await approveClientGrant(asUrl, connectorKey, streamName);

    const { status, body, resp } = await renameConnection(rsUrl, clientToken, 'cin_amazon_personal', {
      display_name: 'the owner personal',
    });
    assert.equal(status, 403);
    assert.equal(body?.error?.code, 'permission_error');
    const audit = findRenameAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.actor_type, 'client');
    assert.equal(audit.client_id, 'longview');
    assert.equal(audit.data?.actor_kind, 'client');
    assert.equal(audit.data?.auth_token_kind, 'client');
    assert.equal(audit.data?.display_name_supplied, true);
    assert.equal(audit.data?.error?.code, 'permission_error');
  });
});

test('owner-agent rename rejects a request with no bearer (401)', async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body } = await fetchJson(`${rsUrl}/v1/owner/connections/cin_amazon_personal`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ display_name: 'the owner personal' }),
    });
    assert.equal(status, 401);
    assert.equal(body?.error?.type, 'authentication_error');
  });
});

test('/mcp continues to reject owner-agent bearers after rename support lands', async () => {
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

test('owner-agent rename is the single source of truth: a fresh store read agrees on connection_id and display_name', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: connectorKey,
      displayName: connectorKey,
      sourceBindingKey: 'the owner@example.com',
    });
    const ownerToken = await issueOwnerToken(asUrl);
    await renameConnection(rsUrl, ownerToken, 'cin_amazon_personal', { display_name: 'the owner personal' });

    // The owner-agent surface and a direct store read (what the cookie-authed
    // `/_ref` listing and public-read connection decoration both project from)
    // must agree on connection identity + the renamed label, proving the rename
    // persisted to the shared store row rather than a surface-local view.
    const ownerList = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const ownerRow = ownerList.body.data.find((r) => r.connection_id === 'cin_amazon_personal');
    assert.equal(ownerRow.display_name, 'the owner personal');

    const stored = await createSqliteConnectorInstanceStore().get('cin_amazon_personal');
    assert.equal(stored.connectorInstanceId, ownerRow.connection_id);
    assert.equal(stored.displayName, ownerRow.display_name);
  });
});
