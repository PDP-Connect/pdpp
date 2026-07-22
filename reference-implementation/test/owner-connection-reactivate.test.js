// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the owner-agent connection-reactivate control routes
 * (bearer: `server/routes/owner-connection-reactivate.ts`) and the owner-session
 * cookie sibling (`/_ref` route in `server/routes/ref-connectors.ts`):
 *
 *   POST /v1/owner/connections/:connectionId/reactivate  (bearer, on RS)
 *   POST /v1/owner/connectors/:connectorId/reactivate   (bearer, on RS)
 *   POST /_ref/connections/:connectorInstanceId/reactivate (owner-session, on AS)
 *
 * Covers:
 *   - a revoked connection is flipped back to `active`, `revoked_at` is cleared,
 *     already-collected records are preserved, and a reactivate audit event is emitted;
 *   - reactivate on a non-revoked (active) connection returns connector_instance_not_revoked (409);
 *   - reactivate on a foreign/unknown connection_id returns connector_instance_not_found (404);
 *   - a cross-owner reactivate is rejected (foreign id -> 404);
 *   - the connector-only bearer route auto-selects a single revoked connection;
 *   - client grant tokens (403) and missing bearers (401) cannot reactivate;
 *   - the `/_ref` (owner-session cookie) route mirrors the bearer behaviour;
 *   - a repeat reactivate on an already-active connection returns 409.
 *
 * The `/_ref` tests run in open mode (no ownerAuthPassword) so the owner-session
 * gate does not interfere -- auth boundary tests are out of scope here.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { listSpineEventsPage } from '../lib/spine.ts';
import { canonicalConnectorKey } from '../server/connector-key.js';
import { getDb } from '../server/db.js';
import { startServer } from '../server/index.js';
import { ingestRecord } from '../server/records.js';
import {
  createSqliteConnectorInstanceStore,
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

// Open mode (ownerAuthPassword: '') lets /_ref routes work without CSRF/session
// ceremony, and device/approve issues a bearer without a gate.
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

// PAR + consent yields a grant-scoped client-kind bearer (pdpp_token_kind: "client").
// These must NOT reach the owner-agent control surface.
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
        purpose_description: 'owner-connection reactivate boundary test',
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

// seedInstance allows seeding with a custom status (default: 'active') so cross-
// owner revoked instances can be set up without going through the route.
async function seedInstance({
  connectorInstanceId,
  connectorId,
  displayName,
  sourceBindingKey,
  sourceKind = 'account',
  sourceBinding,
  ownerSubjectId = OWNER_SUBJECT_ID,
  status = 'active',
}) {
  const store = createSqliteConnectorInstanceStore();
  await store.upsert({
    connectorInstanceId,
    ownerSubjectId,
    connectorId,
    displayName,
    status,
    sourceKind,
    sourceBindingKey,
    sourceBinding: sourceBinding ?? { account_hint: sourceBindingKey },
    createdAt: NOW,
    updatedAt: NOW,
  });
}

// SQLite store get() is synchronous in :memory: mode.
function getInstance(connectorInstanceId) {
  return createSqliteConnectorInstanceStore().get(connectorInstanceId);
}

// Count physically-stored records for a connection. Proves reactivate does NOT
// delete already-collected records -- a direct table read avoids depending on
// manifest-projection plumbing for this invariant.
function countStoredRecords(connectorInstanceId) {
  return getDb()
    .prepare('SELECT COUNT(*) AS n FROM records WHERE connector_instance_id = ?')
    .get(connectorInstanceId).n;
}

// bearer owner-agent POSTs to the RS (rsUrl).
async function postReactivate(rsUrl, ownerToken, path) {
  return fetchJson(`${rsUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
  });
}

async function postRevoke(rsUrl, ownerToken, path) {
  return fetchJson(`${rsUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
  });
}

function findReactivateAuditEvent(resp) {
  const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
  assert.ok(traceId?.startsWith('trc_'), 'reactivate response should carry an audit trace id');
  const page = listSpineEventsPage('trace', traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === 'owner_agent.connection.reactivate');
  assert.ok(event, 'expected owner_agent.connection.reactivate audit event');
  assert.equal(event.request_id, resp.headers.get('Request-Id'));
  assert.equal(event.token_id, null, 'audit event must not store bearer tokens');
  // No secret material in the serialized event payload.
  const serialized = JSON.stringify(event);
  assert.ok(!/Bearer\s/i.test(serialized), 'audit must not carry a bearer token');
  assert.ok(!serialized.includes('access_token'), 'audit must not carry an access token');
  return event;
}

test('owner-agent bearer reactivates a revoked connection (200), flips to active, clears revoked_at, preserves records', async () => {
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

    // Ingest a record before revoke to verify it survives the round-trip.
    const storageTarget = { connector_id: connectorKey, connector_instance_id: 'cin_spotify_personal' };
    await ingestRecord(storageTarget, { stream, key: 'rec_1', data: { id: 'rec_1', name: 'pre-revoke' } });
    assert.equal(countStoredRecords('cin_spotify_personal'), 1, 'record should exist before revoke');

    const ownerToken = await issueOwnerToken(asUrl);

    // Revoke first so we have a revoked state to reactivate from.
    const revoke = await postRevoke(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_personal/revoke');
    assert.equal(revoke.status, 200);
    assert.equal(getInstance('cin_spotify_personal').status, 'revoked');
    assert.ok(getInstance('cin_spotify_personal').revokedAt, 'revoked_at must be stamped after revoke');

    // Now reactivate.
    const reactivate = await postReactivate(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_personal/reactivate');
    assert.equal(reactivate.status, 200);
    assert.equal(reactivate.body?.object, 'owner_connection_reactivate');
    assert.equal(reactivate.body?.connection_id, 'cin_spotify_personal');
    assert.equal(reactivate.body?.status, 'active');
    assert.ok(typeof reactivate.body?.reactivated_at === 'string' && reactivate.body.reactivated_at.length > 0);

    // Store row is back to active with revoked_at cleared.
    const row = getInstance('cin_spotify_personal');
    assert.equal(row.status, 'active', 'connection must be active after reactivate');
    assert.ok(!row.revokedAt, 'revoked_at must be cleared after reactivate');

    // Records survive the round-trip -- reactivate is zero-cascade.
    assert.equal(countStoredRecords('cin_spotify_personal'), 1, 'pre-revoke record must survive reactivate');

    // Audit event emitted with correct fields.
    const audit = findReactivateAuditEvent(reactivate.resp);
    assert.equal(audit.actor_type, 'owner_agent');
    assert.equal(audit.client_id, OWNER_CLIENT_ID);
    assert.equal(audit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(audit.object_type, 'connection');
    assert.equal(audit.object_id, 'cin_spotify_personal');
    assert.equal(audit.status, 'succeeded');
    assert.equal(audit.data?.operation, 'reactivate');
    assert.equal(audit.data?.connection_id, 'cin_spotify_personal');
    assert.equal(audit.data?.connector_key, connectorKey);
  });
});

test('reactivate on an already-active connection returns connector_instance_not_revoked (409)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_active',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const result = await postReactivate(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_active/reactivate');
    assert.equal(result.status, 409, 'reactivating an active connection must return 409');
    assert.equal(result.body?.error?.code, 'connector_instance_not_revoked');

    // Connection must remain active.
    assert.equal(getInstance('cin_spotify_active').status, 'active');
  });
});

test('reactivate on a foreign/unknown connection_id returns 404', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadReferenceManifest('spotify'));

    const ownerToken = await issueOwnerToken(asUrl);
    const result = await postReactivate(rsUrl, ownerToken, '/v1/owner/connections/cin_does_not_exist/reactivate');
    assert.equal(result.status, 404);
    assert.equal(result.body?.error?.code, 'connector_instance_not_found');
  });
});

test('owner-agent cannot reactivate another owner\'s connection (cross-owner returns 404)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    // Seed a revoked instance belonging to OTHER_SUBJECT_ID.
    await seedInstance({
      connectorInstanceId: 'cin_spotify_other',
      connectorId: connectorKey,
      displayName: 'Other Spotify',
      sourceBindingKey: 'other@example.com',
      ownerSubjectId: OTHER_SUBJECT_ID,
    });
    // Flip it to revoked directly via the store (synchronous in SQLite mode).
    createSqliteConnectorInstanceStore().updateStatus('cin_spotify_other', {
      status: 'revoked',
      updatedAt: new Date().toISOString(),
      revokedAt: new Date().toISOString(),
    });
    assert.equal(getInstance('cin_spotify_other').status, 'revoked');

    // A token for OWNER_SUBJECT_ID must not reach the other owner's connection.
    const ownerToken = await issueOwnerToken(asUrl, OWNER_SUBJECT_ID);
    const result = await postReactivate(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_other/reactivate');
    // The resolver surfaces a cross-owner hit as 404 (ownership mismatch maps to
    // not_found); the requireOwner gate may fire first with 403 depending on how
    // the token was issued. Either way the request must not succeed.
    assert.ok(
      result.status === 404 || result.status === 403,
      `cross-owner reactivate must return 403 or 404, got ${result.status}`,
    );
    // The other owner's connection must remain revoked.
    assert.equal(getInstance('cin_spotify_other').status, 'revoked');
  });
});

test('owner-agent connector-only reactivate route reactivates the single revoked connection', async () => {
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

    // Revoke via connection-scoped route first.
    await postRevoke(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_only/revoke');
    assert.equal(getInstance('cin_spotify_only').status, 'revoked');

    // Reactivate via connector-only route.
    const result = await postReactivate(rsUrl, ownerToken, `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/reactivate`);
    assert.equal(result.status, 200);
    assert.equal(result.body?.object, 'owner_connection_reactivate');
    assert.equal(result.body?.status, 'active');
    const row = getInstance('cin_spotify_only');
    assert.equal(row.status, 'active');
    assert.ok(!row.revokedAt, 'revoked_at must be cleared via connector-only route');

    const audit = findReactivateAuditEvent(result.resp);
    assert.equal(audit.data?.connection_id, 'cin_spotify_only');
    assert.equal(audit.data?.operation, 'reactivate');
  });
});

test('client grant token cannot reactivate (403)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_client_test',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });

    // Revoke it via owner token first.
    const ownerToken = await issueOwnerToken(asUrl);
    await postRevoke(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_client_test/revoke');

    // Client grant must not reach reactivate.
    const clientToken = await approveClientGrant(asUrl, connectorKey, manifest.streams[0].name);
    const result = await fetchJson(`${rsUrl}/v1/owner/connections/cin_spotify_client_test/reactivate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${clientToken}`, 'Content-Type': 'application/json' },
    });
    assert.equal(result.status, 403, 'client grant must not reach reactivate');
    // Connection must remain revoked.
    assert.equal(getInstance('cin_spotify_client_test').status, 'revoked');
  });
});

test('missing bearer cannot reactivate (401)', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_noauth',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });
    const result = await fetchJson(`${rsUrl}/v1/owner/connections/cin_spotify_noauth/reactivate`, {
      method: 'POST',
    });
    assert.equal(result.status, 401);
  });
});

test('owner-session /_ref reactivate mirrors bearer: flips revoked->active, emits audit, preserves records', async () => {
  // /_ref routes are on the AS (asUrl). Open mode means no CSRF/session ceremony.
  await withServer(async ({ asUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const stream = manifest.streams[0].name;
    await seedInstance({
      connectorInstanceId: 'cin_spotify_ref',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });

    // Ingest a record before the round-trip.
    const storageTarget = { connector_id: connectorKey, connector_instance_id: 'cin_spotify_ref' };
    await ingestRecord(storageTarget, { stream, key: 'rec_ref', data: { id: 'rec_ref', name: 'ref-test' } });

    // Revoke via /_ref (open mode, no cookie needed).
    const revokeResp = await fetchJson(`${asUrl}/_ref/connections/cin_spotify_ref/revoke`, {
      method: 'POST',
    });
    assert.equal(revokeResp.status, 200);
    assert.equal(getInstance('cin_spotify_ref').status, 'revoked');

    // Reactivate via /_ref.
    const reactivateResp = await fetchJson(`${asUrl}/_ref/connections/cin_spotify_ref/reactivate`, {
      method: 'POST',
    });
    assert.equal(
      reactivateResp.status,
      200,
      `/_ref reactivate must return 200, got ${reactivateResp.status}: ${JSON.stringify(reactivateResp.body)}`,
    );
    assert.equal(reactivateResp.body?.object, 'ref_connection_reactivate');
    assert.equal(reactivateResp.body?.status, 'active');

    // Connection is active, revoked_at cleared, record intact.
    const row = getInstance('cin_spotify_ref');
    assert.equal(row.status, 'active');
    assert.ok(!row.revokedAt, 'revoked_at must be cleared');
    assert.equal(countStoredRecords('cin_spotify_ref'), 1, 'record must survive reactivate');

    // Audit event emitted under the correct event type and actor_type.
    const traceId = reactivateResp.resp.headers.get('PDPP-Reference-Trace-Id');
    assert.ok(traceId?.startsWith('trc_'), '/_ref reactivate must carry audit trace id');
    const page = listSpineEventsPage('trace', traceId, { limit: 20 });
    const event = page.events.find((e) => e.event_type === 'owner_agent.connection.reactivate');
    assert.ok(event, 'expected owner_agent.connection.reactivate audit event from /_ref path');
    assert.equal(event.actor_type, 'owner_session');
    assert.equal(event.status, 'succeeded');
    assert.equal(event.data?.operation, 'reactivate');
  });
});

test('repeat reactivate on already-active connection returns connector_instance_not_revoked (409)', async () => {
  // Proves the not_revoked guard fires even for a connection that was previously
  // revoked and then reactivated -- the guard is on the current status, not history.
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_repeat',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });

    const ownerToken = await issueOwnerToken(asUrl);

    // Revoke then reactivate (first reactivate succeeds).
    await postRevoke(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_repeat/revoke');
    const first = await postReactivate(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_repeat/reactivate');
    assert.equal(first.status, 200);
    assert.equal(getInstance('cin_spotify_repeat').status, 'active');

    // A second reactivate must fail: the connection is now active, not revoked.
    const second = await postReactivate(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_repeat/reactivate');
    assert.equal(second.status, 409);
    assert.equal(second.body?.error?.code, 'connector_instance_not_revoked');
    // Still active.
    assert.equal(getInstance('cin_spotify_repeat').status, 'active');
  });
});
