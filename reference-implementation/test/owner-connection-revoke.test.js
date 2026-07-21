// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the bearer-authed owner-agent connection-revoke control
 * routes (mounted from `server/routes/owner-connection-revoke.ts`):
 *
 *   POST /v1/owner/connections/:connectionId/revoke
 *   POST /v1/owner/connectors/:connectorId/revoke
 *
 * Covers the owner-agent revoke packet (design "Deferred: connection-revoke
 * durability" → Unit 2, tasks 3.1d/6.1d) plus the durability guard it depends on
 * (Unit 1, proven at the store level in connector-instance-store.test.js and
 * end-to-end here through the default-account class):
 *
 *   - a trusted owner-agent bearer revokes an instance-scoped connection by
 *     connection_id (200), the connection stops collecting future data, and
 *     already-collected records remain readable (revoke != delete);
 *   - a DEFAULT-ACCOUNT connection revoked through the route stays revoked across
 *     subsequent owner reads and a re-materialization attempt (the durability
 *     regression that failed before the Unit 1 guard);
 *   - no sibling overreach: revoking one connection on a connector leaves a
 *     sibling connection active and collectable;
 *   - the connector-only route auto-selects a single active connection and
 *     rejects two active connections with a typed ambiguous_connection (409);
 *   - a repeat revoke returns a typed connector_instance_inactive;
 *   - foreign/unknown connection ids are 404 (never a cross-owner revoke);
 *   - client grant tokens (403), missing bearers (401), revoked owner-agent
 *     credentials (401), and `/mcp` owner bearers (403) cannot revoke;
 *   - every attempt emits non-secret owner_agent.connection.revoke audit
 *     evidence with no bearer/secret;
 *   - the control surface advertises revoke_connection as supported.
 *
 * Spec: openspec/changes/add-owner-agent-control-surface
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { exec, referenceQueries } from '../lib/db.ts';
import { listSpineEventsPage } from '../lib/spine.ts';
import { canonicalConnectorKey } from '../server/connector-key.js';
import { getDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { ingestRecord } from '../server/records.js';
import {
  createSqliteConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from '../server/stores/connector-instance-store.js';

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
    await fn({ asUrl, rsUrl, server });
  } finally {
    await closeServer(server);
  }
}

// Device-code exchange yields an owner-kind bearer (pdpp_token_kind: "owner").
// Returns both the access token and the issuing client id so a test can revoke
// the credential by cascading the client's tokens (RFC 7592-style deletion).
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
        purpose_description: 'owner-connection revoke boundary test',
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
  sourceKind = 'account',
  sourceBinding,
  ownerSubjectId = OWNER_SUBJECT_ID,
}) {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorInstanceId,
    ownerSubjectId,
    connectorId,
    displayName,
    status: 'active',
    sourceKind,
    sourceBindingKey,
    sourceBinding: sourceBinding ?? { account_hint: sourceBindingKey },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function getInstance(connectorInstanceId) {
  return createSqliteConnectorInstanceStore().get(connectorInstanceId);
}

// Count physically-stored records for a connection. Used to prove revoke does
// NOT delete already-collected records (revoke != forget) — a direct table read
// avoids depending on manifest-projection plumbing for this invariant.
function countStoredRecords(connectorInstanceId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ?')
    .get(connectorInstanceId).n;
}

async function postRevoke(rsUrl, ownerToken, path) {
  return fetchJson(`${rsUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
  });
}

function findRevokeAuditEvent(resp) {
  const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
  assert.ok(traceId?.startsWith('trc_'), 'revoke response should carry an audit trace id');
  const page = listSpineEventsPage('trace', traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === 'owner_agent.connection.revoke');
  assert.ok(event, 'expected owner-agent revoke audit event');
  assert.equal(event.request_id, resp.headers.get('Request-Id'));
  assert.equal(event.token_id, null, 'audit event must not store bearer tokens');
  // No secret material in the serialized event payload.
  const serialized = JSON.stringify(event);
  assert.ok(!/Bearer\s/i.test(serialized), 'audit must not carry a bearer token');
  assert.ok(!serialized.includes('access_token'), 'audit must not carry an access token');
  return event;
}

test('owner-agent bearer revokes an instance-scoped connection (200), stops future collection, preserves records', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const stream = manifest.streams[0].name;
    await seedInstance({
      connectorInstanceId: 'cin_spotify_personal',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });

    // Pre-existing record collected before revoke.
    const storageTarget = { connector_id: connectorKey, connector_instance_id: 'cin_spotify_personal' };
    await ingestRecord(storageTarget, { stream, key: 'rec_1', data: { id: 'rec_1', name: 'pre-revoke' } });
    assert.equal(countStoredRecords('cin_spotify_personal'), 1, 'record should exist before revoke');

    const ownerToken = await issueOwnerToken(asUrl);
    const revoke = await postRevoke(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_personal/revoke');
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body?.object, 'owner_connection_revoke');
    assert.equal(revoke.body?.connection_id, 'cin_spotify_personal');
    assert.equal(revoke.body?.status, 'revoked');
    assert.ok(typeof revoke.body?.revoked_at === 'string' && revoke.body.revoked_at.length > 0);

    // The stored row is soft-flipped to revoked with a revoked_at stamp.
    const row = getInstance('cin_spotify_personal');
    assert.equal(row.status, 'revoked');
    assert.ok(row.revokedAt, 'revoked_at must be stamped');

    // Already-collected records remain stored (revoke != delete records).
    assert.equal(countStoredRecords('cin_spotify_personal'), 1, 'pre-revoke record must survive revoke');

    const audit = findRevokeAuditEvent(revoke.resp);
    assert.equal(audit.actor_type, 'owner_agent');
    assert.equal(audit.client_id, OWNER_CLIENT_ID);
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.object_type, 'connection');
    assert.equal(audit.object_id, 'cin_spotify_personal');
    assert.equal(audit.status, 'succeeded');
    assert.equal(audit.data?.operation, 'revoke');
    assert.equal(audit.data?.selector, 'connection_id');
    assert.equal(audit.data?.connection_id, 'cin_spotify_personal');
    assert.equal(audit.data?.connector_key, connectorKey);
  });
});

test('a revoked DEFAULT-ACCOUNT connection stays revoked across owner reads (durability guard)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    // github is an API/network default-account connector: its connection
    // materializes implicitly. Register it, then materialize the default account
    // by listing connections (which triggers dashboard materialization) — but to
    // be explicit and deterministic we materialize directly through the store.
    const manifest = await registerConnector(asUrl, loadReferenceManifest('github'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const store = createSqliteConnectorInstanceStore();
    const defaultId = makeDefaultAccountConnectorInstanceId(OWNER_SUBJECT_ID, connectorKey);
    await store.ensureDefaultAccountConnection({
      ownerSubjectId: OWNER_SUBJECT_ID,
      connectorId: connectorKey,
      displayName: manifest.display_name || connectorKey,
      now: NOW,
    });
    assert.equal(getInstance(defaultId).status, 'active', 'default account should materialize active');

    const ownerToken = await issueOwnerToken(asUrl);

    // Revoke the default-account connection via the owner-agent route.
    const revoke = await postRevoke(rsUrl, ownerToken, `/v1/owner/connections/${defaultId}/revoke`);
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body?.status, 'revoked');
    assert.equal(getInstance(defaultId).status, 'revoked');

    // Two subsequent owner listings must NOT resurrect it to active. Before the
    // Unit 1 durability guard, the dashboard/owner read path re-materialized the
    // deterministically-keyed revoked row back to active.
    for (const attempt of [1, 2]) {
      const list = await fetchJson(`${rsUrl}/v1/owner/connections`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(list.status, 200, `owner list read ${attempt} should succeed`);
      const row = (list.body?.data ?? []).find((c) => c.connection_id === defaultId);
      // The connection may be listed (revoked rows are still owner-visible) but
      // it MUST NOT be active.
      if (row) {
        assert.equal(row.status, 'revoked', `default account must stay revoked after read ${attempt}`);
      }
      assert.equal(getInstance(defaultId).status, 'revoked', `stored row must stay revoked after read ${attempt}`);
    }

    // A direct re-materialization attempt (the dashboard path) also respects the
    // revoke.
    const reEnsured = await store.ensureDefaultAccountConnection({
      ownerSubjectId: OWNER_SUBJECT_ID,
      connectorId: connectorKey,
      displayName: manifest.display_name || connectorKey,
      now: '2026-06-01T00:00:00.000Z',
    });
    assert.equal(reEnsured.status, 'revoked', 'default-account materialization must not resurrect a revoke');
    assert.equal(getInstance(defaultId).status, 'revoked');
  });
});

test('owner-agent revoke does not over-reach: a sibling connection stays active and collectable', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const stream = manifest.streams[0].name;
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
    const revoke = await postRevoke(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_personal/revoke');
    assert.equal(revoke.status, 200);

    // The sibling is untouched and can still collect.
    assert.equal(getInstance('cin_spotify_personal').status, 'revoked');
    const sibling = getInstance('cin_spotify_shared');
    assert.equal(sibling.status, 'active', 'sibling connection must remain active');

    const siblingTarget = { connector_id: connectorKey, connector_instance_id: 'cin_spotify_shared' };
    await ingestRecord(siblingTarget, { stream, key: 'rec_sibling', data: { id: 'rec_sibling' } });
    assert.equal(
      countStoredRecords('cin_spotify_shared'),
      1,
      'sibling connection must remain collectable after sibling revoke',
    );
  });
});

test('owner-agent connector-only revoke auto-selects the single active connection', async () => {
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
    const revoke = await postRevoke(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/revoke`,
    );
    assert.equal(revoke.status, 200);
    assert.equal(revoke.body?.connection_id, 'cin_spotify_only');
    assert.equal(getInstance('cin_spotify_only').status, 'revoked');

    const audit = findRevokeAuditEvent(revoke.resp);
    assert.equal(audit.data?.selector, 'connector_id');
    assert.equal(audit.data?.connection_id, 'cin_spotify_only');
    assert.equal(audit.data?.operation, 'revoke');
  });
});

test('owner-agent connector-only revoke rejects two active connections with typed ambiguous_connection', async () => {
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
    const { status, body, resp } = await postRevoke(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/revoke`,
    );
    assert.equal(status, 409);
    assert.equal(body?.error?.code, 'ambiguous_connection');
    assert.equal(body?.error?.retry_with, 'connection_id');
    const ids = (body?.error?.available_connections ?? []).map((c) => c.connection_id).sort();
    assert.deepEqual(ids, ['cin_spotify_personal', 'cin_spotify_shared']);

    // Neither connection was revoked by the ambiguous request.
    assert.equal(getInstance('cin_spotify_personal').status, 'active');
    assert.equal(getInstance('cin_spotify_shared').status, 'active');

    const audit = findRevokeAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.data?.selector, 'connector_id');
    assert.equal(audit.data?.error?.code, 'ambiguous_connection');
    assert.equal(audit.data?.error?.http_status, 409);
  });
});

test('owner-agent repeat revoke returns typed connector_instance_inactive', async () => {
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

    const first = await postRevoke(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_personal/revoke');
    assert.equal(first.status, 200);

    const second = await postRevoke(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_personal/revoke');
    assert.equal(second.status, 400);
    assert.equal(second.body?.error?.code, 'connector_instance_inactive');
    // Still revoked, not crashed or flipped.
    assert.equal(getInstance('cin_spotify_personal').status, 'revoked');
  });
});

test('owner-agent revoke on an unknown connection_id returns a typed 404', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await postRevoke(rsUrl, ownerToken, '/v1/owner/connections/cin_missing/revoke');
    assert.equal(status, 404);
    assert.equal(body?.error?.code, 'connector_instance_not_found');
    const audit = findRevokeAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.object_id, 'cin_missing');
    assert.equal(audit.data?.error?.code, 'connector_instance_not_found');
  });
});

test('owner-agent revoke cannot cross owners (other-owner connection is not found)', async () => {
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
    const { status } = await postRevoke(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_other/revoke');
    assert.ok(status === 404 || status === 403, `expected 404/403, got ${status}`);
    // The foreign connection was not revoked.
    assert.equal(getInstance('cin_spotify_other').status, 'active');
  });
});

test('owner-agent revoke rejects a client grant token with 403 and audits it', async () => {
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

    const { status, body, resp } = await postRevoke(
      rsUrl,
      clientToken,
      '/v1/owner/connections/cin_spotify_personal/revoke',
    );
    assert.equal(status, 403);
    assert.equal(body?.error?.code, 'permission_error');
    // The connection was NOT revoked by the rejected client.
    assert.equal(getInstance('cin_spotify_personal').status, 'active');

    const audit = findRevokeAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.actor_type, 'client');
    assert.equal(audit.data?.actor_kind, 'client');
    assert.equal(audit.data?.operation, 'revoke');
    assert.equal(audit.data?.error?.code, 'permission_error');
  });
});

test('owner-agent revoke rejects a request with no bearer (401)', async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/owner/connections/cin_spotify_personal/revoke`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    );
    assert.equal(status, 401);
    assert.equal(body?.error?.type, 'authentication_error');
  });
});

test('a revoked owner-agent credential cannot revoke a connection (401)', async () => {
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

    // Revoke the owner-agent credential the way RFC 7592 client deletion does:
    // cascade-revoke the issuing client's tokens (same path the schedule suite
    // uses for task 3.4).
    exec(referenceQueries.authTokensRevokeByClientId, [OWNER_CLIENT_ID]);

    const { status, body } = await postRevoke(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_personal/revoke');
    assert.equal(status, 401);
    assert.equal(body?.error?.type, 'authentication_error');
    // The connection was NOT revoked by the dead credential.
    assert.equal(getInstance('cin_spotify_personal').status, 'active');
  });
});

test('/mcp continues to reject owner-agent bearers after revoke control lands', async () => {
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

test('owner-agent control document advertises revoke_connection as supported with a revoke URL', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const ownerToken = await issueOwnerToken(asUrl);
    const { body } = await fetchJson(`${rsUrl}/v1/owner/control`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const revoke = body.actions.find((a) => a.family === 'revoke_connection');
    assert.ok(revoke, 'revoke_connection must be advertised');
    assert.equal(revoke.status, 'supported');
    assert.equal(revoke.method, 'POST');
    assert.equal(revoke.url, `${rsUrl}/v1/owner/connections/{connection_id}/revoke`);
  });
});
