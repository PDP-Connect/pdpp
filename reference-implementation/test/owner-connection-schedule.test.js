// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration suite for the bearer-authed owner-agent schedule lifecycle
 * control routes (mounted from `server/routes/owner-connection-schedule.ts`):
 *
 *   POST /v1/owner/connections/:connectionId/schedule/pause
 *   POST /v1/owner/connections/:connectionId/schedule/resume
 *   POST /v1/owner/connectors/:connectorId/schedule/pause
 *   POST /v1/owner/connectors/:connectorId/schedule/resume
 *   DELETE /v1/owner/connections/:connectionId/schedule
 *   DELETE /v1/owner/connectors/:connectorId/schedule
 *
 * Covers the instance-scoped owner-agent operations slice (tasks 6.1-6.4) plus
 * the authorization/audit/revocation hardening (tasks 3.1-3.4, 8.1, 8.4):
 *
 *   - a trusted owner-agent bearer pauses, resumes, and deletes an instance-scoped
 *     connection schedule by `connection_id`, and the change persists;
 *   - the connector-only route auto-selects the single active connection
 *     (single-instance compatibility, task 6.3);
 *   - the connector-only route rejects a connector with two active connections
 *     using a typed `ambiguous_connection` (409) carrying the available
 *     `connection_id` values and `retry_with: connection_id` (task 6.2);
 *   - public read and owner-agent listing agree on `connection_id` after the
 *     schedule mutation (task 6.4);
 *   - every mutation emits non-secret `owner_agent.connection.schedule` audit
 *     evidence; failures are typed and audited without secrets (task 3.3);
 *   - client grant tokens (403), missing bearers (401), and `/mcp` owner
 *     bearers (403) cannot reach the routes (tasks 3.1, 3.2);
 *   - a REVOKED owner-agent credential cannot read (`GET /v1/owner/connections`)
 *     or control (pause) — task 3.4.
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
import { startServer } from '../server/index.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';
import { createSqliteSchedulerStore } from '../server/stores/scheduler-store.ts';

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
        purpose_description: 'owner-connection schedule boundary test',
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

function loadPackageManifest(name) {
  return JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, '..', 'packages', 'polyfill-connectors', 'manifests', `${name}.json`), 'utf8'),
  );
}

// The reference-implementation's own spotify manifest declares no restrictive
// refresh policy, so its schedule is automation-eligible — resume (enabled:
// true) is allowed. The packaged amazon manifest recommends manual refresh, so
// resuming amazon is intentionally blocked (covered by a dedicated test).
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

// Seed an enabled schedule for one connection directly, so pause/resume have a
// row to act on without driving a real run or PUT lifecycle.
async function seedSchedule({ connectorInstanceId, connectorId, enabled = true }) {
  const store = createSqliteSchedulerStore();
  await store.createSchedule({
    connector_instance_id: connectorInstanceId,
    connector_id: connectorId,
    interval_seconds: 86_400,
    jitter_seconds: 0,
    enabled,
    created_at: NOW,
    updated_at: NOW,
  });
}

function scheduleEnabled(connectorInstanceId) {
  const record = createSqliteSchedulerStore().getSchedule(connectorInstanceId);
  return record ? record.enabled : null;
}

async function postSchedule(rsUrl, ownerToken, path) {
  return fetchJson(`${rsUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
  });
}

async function deleteSchedule(rsUrl, ownerToken, path) {
  return fetchJson(`${rsUrl}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
  });
}

function scheduleExists(connectorInstanceId) {
  return createSqliteSchedulerStore().getSchedule(connectorInstanceId) !== null;
}

function findScheduleAuditEvent(resp) {
  const traceId = resp.headers.get('PDPP-Reference-Trace-Id');
  assert.ok(traceId?.startsWith('trc_'), 'schedule response should carry an audit trace id');
  const page = listSpineEventsPage('trace', traceId, { limit: 20 });
  const event = page.events.find((entry) => entry.event_type === 'owner_agent.connection.schedule');
  assert.ok(event, 'expected owner-agent schedule audit event');
  assert.equal(event.request_id, resp.headers.get('Request-Id'));
  assert.equal(event.token_id, null, 'audit event must not store bearer tokens');
  return event;
}

test('owner-agent bearer pauses then resumes an instance-scoped connection schedule', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_personal',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });
    await seedSchedule({ connectorInstanceId: 'cin_spotify_personal', connectorId: connectorKey, enabled: true });

    const ownerToken = await issueOwnerToken(asUrl);

    // Pause.
    const pause = await postSchedule(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_spotify_personal/schedule/pause',
    );
    assert.equal(pause.status, 200);
    assert.equal(pause.body.enabled, false);
    assert.equal(scheduleEnabled('cin_spotify_personal'), false, 'pause must persist');

    const pauseAudit = findScheduleAuditEvent(pause.resp);
    assert.equal(pauseAudit.actor_type, 'owner_agent');
    assert.equal(pauseAudit.actor_id, OWNER_CLIENT_ID);
    assert.equal(pauseAudit.client_id, OWNER_CLIENT_ID);
    assert.equal(pauseAudit.subject_id, OWNER_SUBJECT_ID);
    assert.equal(pauseAudit.object_type, 'connection');
    assert.equal(pauseAudit.object_id, 'cin_spotify_personal');
    assert.equal(pauseAudit.status, 'succeeded');
    assert.equal(pauseAudit.data?.actor_kind, 'owner_agent');
    assert.equal(pauseAudit.data?.auth_token_kind, 'owner');
    assert.equal(pauseAudit.data?.operation, 'pause_schedule');
    assert.equal(pauseAudit.data?.selector, 'connection_id');
    assert.equal(pauseAudit.data?.connection_id, 'cin_spotify_personal');
    assert.equal(pauseAudit.data?.connector_key, connectorKey);

    // Resume.
    const resume = await postSchedule(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_spotify_personal/schedule/resume',
    );
    assert.equal(resume.status, 200);
    assert.equal(resume.body.enabled, true);
    assert.equal(scheduleEnabled('cin_spotify_personal'), true, 'resume must persist');

    const resumeAudit = findScheduleAuditEvent(resume.resp);
    assert.equal(resumeAudit.data?.operation, 'resume_schedule');
    assert.equal(resumeAudit.status, 'succeeded');
  });
});

test('owner-agent listing agrees on connection_id and reflects the paused schedule after control', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_personal',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });
    await seedSchedule({ connectorInstanceId: 'cin_spotify_personal', connectorId: connectorKey, enabled: true });
    const ownerToken = await issueOwnerToken(asUrl);

    // Listing reports the connection with its schedule enabled.
    const before = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const beforeRow = before.body.data.find((r) => r.connection_id === 'cin_spotify_personal');
    assert.equal(beforeRow.schedule?.enabled, true);

    await postSchedule(rsUrl, ownerToken, '/v1/owner/connections/cin_spotify_personal/schedule/pause');

    // The same listing now reflects the paused schedule on the SAME
    // connection_id — the owner-agent control mutation and read surface agree.
    const after = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const afterRow = after.body.data.find((r) => r.connection_id === 'cin_spotify_personal');
    assert.equal(afterRow.connection_id, beforeRow.connection_id);
    assert.equal(afterRow.schedule?.enabled, false);
  });
});

test('owner-agent connector-only pause auto-selects the single active connection', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_only',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });
    await seedSchedule({ connectorInstanceId: 'cin_spotify_only', connectorId: connectorKey, enabled: true });

    const ownerToken = await issueOwnerToken(asUrl);
    const pause = await postSchedule(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/schedule/pause`,
    );
    assert.equal(pause.status, 200);
    assert.equal(pause.body.enabled, false);
    assert.equal(scheduleEnabled('cin_spotify_only'), false);

    const audit = findScheduleAuditEvent(pause.resp);
    assert.equal(audit.data?.selector, 'connector_id');
    // The auto-selected connection's concrete id is recorded for audit.
    assert.equal(audit.data?.connection_id, 'cin_spotify_only');
    assert.equal(audit.data?.operation, 'pause_schedule');
  });
});

test('owner-agent connector-only action rejects two active connections with typed ambiguous_connection', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadPackageManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: connectorKey,
      displayName: 'the owner personal',
      sourceBindingKey: 'the owner@example.com',
    });
    await seedInstance({
      connectorInstanceId: 'cin_amazon_shared',
      connectorId: connectorKey,
      displayName: 'Shared Amazon',
      sourceBindingKey: 'shared@example.com',
    });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await postSchedule(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/schedule/pause`,
    );
    assert.equal(status, 409);
    assert.equal(body?.error?.code, 'ambiguous_connection');
    // The envelope carries the available connection ids + retry guidance so the
    // agent can recover without a probe.
    assert.equal(body?.error?.retry_with, 'connection_id');
    const ids = (body?.error?.available_connections ?? []).map((c) => c.connection_id).sort();
    assert.deepEqual(ids, ['cin_amazon_personal', 'cin_amazon_shared']);
    // Owner-meaningful labels travel with the available connections.
    const labels = (body?.error?.available_connections ?? [])
      .map((c) => c.display_name)
      .filter(Boolean)
      .sort();
    assert.deepEqual(labels, ['Shared Amazon', 'the owner personal']);

    const audit = findScheduleAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.data?.selector, 'connector_id');
    assert.equal(audit.data?.connector_key, connectorKey);
    assert.equal(audit.data?.error?.code, 'ambiguous_connection');
    assert.equal(audit.data?.error?.http_status, 409);
  });
});

test('owner-agent resume is blocked when the connector refresh policy forbids automation', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    // The packaged usaa manifest is background_safe:false (owner-present
    // login required, no opt-in path), so resuming (enabling) its schedule
    // is rejected with the same eligibility semantics the cookie-authed
    // surface enforces — proving the shared mutation path, not a cloned
    // one. (Amazon and Reddit no longer fit this case: both now declare
    // background_safe:true and accept an explicit owner-enabled schedule.)
    const manifest = await registerConnector(asUrl, loadPackageManifest('usaa'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_usaa_solo',
      connectorId: connectorKey,
      displayName: 'the owner personal',
      sourceBindingKey: 'the owner@example.com',
    });
    await seedSchedule({ connectorInstanceId: 'cin_usaa_solo', connectorId: connectorKey, enabled: false });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await postSchedule(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_usaa_solo/schedule/resume',
    );
    assert.equal(status, 400);
    assert.equal(body?.error?.code, 'invalid_request');
    // Pause is still allowed (no eligibility gate on disabling).
    assert.equal(scheduleEnabled('cin_usaa_solo'), false, 'resume must not have flipped the row');
  });
});

test('owner-agent schedule action on an unknown connection_id returns a typed 404', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await postSchedule(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_missing/schedule/pause',
    );
    assert.equal(status, 404);
    assert.equal(body?.error?.code, 'connector_instance_not_found');
  });
});

test('owner-agent schedule action on a connection with no schedule returns a typed 404', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_noschedule',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await postSchedule(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_spotify_noschedule/schedule/pause',
    );
    assert.equal(status, 404);
    assert.equal(body?.error?.code, 'not_found');
  });
});

test('owner-agent schedule action cannot cross owners (other-owner instance is not found)', async () => {
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
    await seedSchedule({ connectorInstanceId: 'cin_spotify_other', connectorId: connectorKey, enabled: true });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status } = await postSchedule(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_spotify_other/schedule/pause',
    );
    // Resolver rejects the foreign instance; the row is untouched.
    assert.ok(status === 404 || status === 403, `expected 404/403, got ${status}`);
    assert.equal(scheduleEnabled('cin_spotify_other'), true, 'foreign schedule must be untouched');
  });
});

test('owner-agent schedule action rejects a client grant token with 403 and audits it', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_personal',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });
    await seedSchedule({ connectorInstanceId: 'cin_spotify_personal', connectorId: connectorKey, enabled: true });
    const clientToken = await approveClientGrant(asUrl, connectorKey, manifest.streams[0].name);

    const { status, body, resp } = await postSchedule(
      rsUrl,
      clientToken,
      '/v1/owner/connections/cin_spotify_personal/schedule/pause',
    );
    assert.equal(status, 403);
    assert.equal(body?.error?.code, 'permission_error');
    assert.equal(scheduleEnabled('cin_spotify_personal'), true, 'client token must not mutate the schedule');

    const audit = findScheduleAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.actor_type, 'client');
    assert.equal(audit.data?.actor_kind, 'client');
    assert.equal(audit.data?.error?.code, 'permission_error');
  });
});

test('owner-agent schedule action rejects a request with no bearer (401)', async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/owner/connections/cin_spotify_personal/schedule/pause`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
    );
    assert.equal(status, 401);
    assert.equal(body?.error?.type, 'authentication_error');
  });
});

test('/mcp continues to reject owner-agent bearers after schedule control lands', async () => {
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

test('owner-agent bearer deletes an instance-scoped connection schedule (204) and it persists', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_personal',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });
    await seedSchedule({ connectorInstanceId: 'cin_spotify_personal', connectorId: connectorKey, enabled: true });

    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteSchedule(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_spotify_personal/schedule',
    );
    assert.equal(del.status, 204);
    assert.equal(del.body, null, 'delete returns an empty 204 body');
    assert.equal(scheduleExists('cin_spotify_personal'), false, 'delete must remove the schedule row');

    const audit = findScheduleAuditEvent(del.resp);
    assert.equal(audit.actor_type, 'owner_agent');
    assert.equal(audit.actor_id, OWNER_CLIENT_ID);
    assert.equal(audit.object_type, 'connection');
    assert.equal(audit.object_id, 'cin_spotify_personal');
    assert.equal(audit.status, 'succeeded');
    assert.equal(audit.data?.operation, 'delete_schedule');
    assert.equal(audit.data?.selector, 'connection_id');
    assert.equal(audit.data?.connection_id, 'cin_spotify_personal');
    assert.equal(audit.data?.connector_key, connectorKey);
  });
});

test('owner-agent connector-only delete auto-selects the single active connection', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_only',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });
    await seedSchedule({ connectorInstanceId: 'cin_spotify_only', connectorId: connectorKey, enabled: true });

    const ownerToken = await issueOwnerToken(asUrl);
    const del = await deleteSchedule(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/schedule`,
    );
    assert.equal(del.status, 204);
    assert.equal(scheduleExists('cin_spotify_only'), false);

    const audit = findScheduleAuditEvent(del.resp);
    assert.equal(audit.data?.selector, 'connector_id');
    assert.equal(audit.data?.connection_id, 'cin_spotify_only');
    assert.equal(audit.data?.operation, 'delete_schedule');
  });
});

test('owner-agent connector-only delete rejects two active connections with typed ambiguous_connection', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadPackageManifest('amazon'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_amazon_personal',
      connectorId: connectorKey,
      displayName: 'the owner personal',
      sourceBindingKey: 'the owner@example.com',
    });
    await seedSchedule({ connectorInstanceId: 'cin_amazon_personal', connectorId: connectorKey, enabled: true });
    await seedInstance({
      connectorInstanceId: 'cin_amazon_shared',
      connectorId: connectorKey,
      displayName: 'Shared Amazon',
      sourceBindingKey: 'shared@example.com',
    });
    await seedSchedule({ connectorInstanceId: 'cin_amazon_shared', connectorId: connectorKey, enabled: true });

    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await deleteSchedule(
      rsUrl,
      ownerToken,
      `/v1/owner/connectors/${encodeURIComponent(connectorKey)}/schedule`,
    );
    assert.equal(status, 409);
    assert.equal(body?.error?.code, 'ambiguous_connection');
    assert.equal(body?.error?.retry_with, 'connection_id');
    const ids = (body?.error?.available_connections ?? []).map((c) => c.connection_id).sort();
    assert.deepEqual(ids, ['cin_amazon_personal', 'cin_amazon_shared']);
    // Neither schedule was touched by the ambiguous request.
    assert.equal(scheduleExists('cin_amazon_personal'), true, 'ambiguous delete must not remove a schedule');
    assert.equal(scheduleExists('cin_amazon_shared'), true, 'ambiguous delete must not remove a schedule');

    const audit = findScheduleAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.data?.operation, 'delete_schedule');
    assert.equal(audit.data?.selector, 'connector_id');
    assert.equal(audit.data?.error?.code, 'ambiguous_connection');
    assert.equal(audit.data?.error?.http_status, 409);
  });
});

test('owner-agent delete on a connection with no schedule returns a typed 404 and audits the no-op', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_noschedule',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body, resp } = await deleteSchedule(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_spotify_noschedule/schedule',
    );
    assert.equal(status, 404);
    assert.equal(body?.error?.code, 'not_found');

    const audit = findScheduleAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.data?.operation, 'delete_schedule');
    assert.equal(audit.data?.error?.code, 'not_found');
  });
});

test('owner-agent delete on an unknown connection_id returns a typed 404', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const ownerToken = await issueOwnerToken(asUrl);
    const { status, body } = await deleteSchedule(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_missing/schedule',
    );
    assert.equal(status, 404);
    assert.equal(body?.error?.code, 'connector_instance_not_found');
  });
});

test('owner-agent delete cannot cross owners (other-owner schedule is untouched)', async () => {
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
    await seedSchedule({ connectorInstanceId: 'cin_spotify_other', connectorId: connectorKey, enabled: true });
    const ownerToken = await issueOwnerToken(asUrl);
    const { status } = await deleteSchedule(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_spotify_other/schedule',
    );
    assert.ok(status === 404 || status === 403, `expected 404/403, got ${status}`);
    assert.equal(scheduleExists('cin_spotify_other'), true, 'foreign schedule must be untouched');
  });
});

test('owner-agent delete rejects a client grant token with 403 and audits it', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_personal',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });
    await seedSchedule({ connectorInstanceId: 'cin_spotify_personal', connectorId: connectorKey, enabled: true });
    const clientToken = await approveClientGrant(asUrl, connectorKey, manifest.streams[0].name);

    const { status, body, resp } = await deleteSchedule(
      rsUrl,
      clientToken,
      '/v1/owner/connections/cin_spotify_personal/schedule',
    );
    assert.equal(status, 403);
    assert.equal(body?.error?.code, 'permission_error');
    assert.equal(scheduleExists('cin_spotify_personal'), true, 'client token must not delete the schedule');

    const audit = findScheduleAuditEvent(resp);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.actor_type, 'client');
    assert.equal(audit.data?.operation, 'delete_schedule');
    assert.equal(audit.data?.error?.code, 'permission_error');
  });
});

test('owner-agent delete rejects a request with no bearer (401)', async () => {
  await withServer(async ({ rsUrl }) => {
    const { status, body } = await fetchJson(
      `${rsUrl}/v1/owner/connections/cin_spotify_personal/schedule`,
      { method: 'DELETE', headers: { 'Content-Type': 'application/json' } },
    );
    assert.equal(status, 401);
    assert.equal(body?.error?.type, 'authentication_error');
  });
});

test('a revoked owner-agent credential cannot read connections or control a schedule', async () => {
  await withServer(async ({ asUrl, rsUrl }) => {
    const manifest = await registerConnector(asUrl, loadReferenceManifest('spotify'));
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    await seedInstance({
      connectorInstanceId: 'cin_spotify_personal',
      connectorId: connectorKey,
      displayName: 'My Spotify',
      sourceBindingKey: 'the owner@example.com',
    });
    await seedSchedule({ connectorInstanceId: 'cin_spotify_personal', connectorId: connectorKey, enabled: true });

    const ownerToken = await issueOwnerToken(asUrl);

    // Sanity: the credential works before revocation (read + control).
    const beforeRead = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(beforeRead.status, 200);
    const beforePause = await postSchedule(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_spotify_personal/schedule/pause',
    );
    assert.equal(beforePause.status, 200);

    // Revoke the owner credential the same way RFC 7592 client deletion does:
    // cascade-revoke the issuing client's tokens.
    exec(referenceQueries.authTokensRevokeByClientId, [OWNER_CLIENT_ID]);

    // Read is now rejected as unauthenticated (revoked token introspects inactive).
    const afterRead = await fetchJson(`${rsUrl}/v1/owner/connections`, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    assert.equal(afterRead.status, 401);
    assert.equal(afterRead.body?.error?.type, 'authentication_error');

    // Control is rejected too — and the schedule row is untouched by the
    // revoked credential (it stays paused from the pre-revocation call).
    const afterResume = await postSchedule(
      rsUrl,
      ownerToken,
      '/v1/owner/connections/cin_spotify_personal/schedule/resume',
    );
    assert.equal(afterResume.status, 401);
    assert.equal(scheduleEnabled('cin_spotify_personal'), false, 'revoked credential must not resume the schedule');
  });
});
