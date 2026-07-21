// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Production control-plane regression for local-device source authority.
 *
 * This deliberately reaches every mounted mutation route under its real
 * authentication adapter. It is not a route-unit substitute: the server owns
 * both HTTP listeners, the persisted instance row, owner login, and the
 * owner-agent device-code exchange.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { getDb } from '../server/db.js';
import { canonicalConnectorKey } from '../server/connector-key.js';
import { startServer } from '../server/index.js';
import { createSqliteConnectorInstanceStore } from '../server/stores/connector-instance-store.js';

const INSTANCE_ID = 'cin_local_device_control_matrix';
const OWNER_ID = 'owner_local';
const PASSWORD = 'local-device-matrix-password';
const CLIENT_ID = 'cli_longview';
const NOW = '2026-07-21T12:00:00.000Z';

async function closeServer(server) {
  server.schedulerManager?.stop?.();
  server.abortStartupBackfill?.('test shutdown');
  await Promise.resolve(server.startupBackfillDone).catch(() => {});
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  await Promise.allSettled([
    new Promise((resolve) => server.asServer.close(resolve)),
    new Promise((resolve) => server.rsServer.close(resolve)),
  ]);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { body, status: response.status };
}

function setCookiePair(response, name) {
  const headers = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  return headers
    .map((header) => header.split(';')[0])
    .find((pair) => pair.startsWith(`${name}=`)) ?? null;
}

async function loginOwner(asUrl) {
  const loginPage = await fetch(`${asUrl}/owner/login`, { headers: { Accept: 'text/html' }, redirect: 'manual' });
  const csrfCookie = setCookiePair(loginPage, 'pdpp_owner_csrf');
  const csrfField = (await loginPage.text()).match(/name="_csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrfCookie && csrfField, 'owner login must provide the CSRF proof');
  const login = await fetch(`${asUrl}/owner/login`, {
    method: 'POST',
    headers: { Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded', Cookie: csrfCookie },
    body: new URLSearchParams({ password: PASSWORD, return_to: '/', _csrf: csrfField }).toString(),
    redirect: 'manual',
  });
  const sessionCookie = setCookiePair(login, 'pdpp_owner_session');
  assert.ok(sessionCookie, 'owner login must issue a session cookie');
  return sessionCookie;
}

async function issueOwnerAgentToken(asUrl, sessionCookie) {
  const device = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  assert.equal(device.status, 200);
  const approved = await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({ user_code: device.body.user_code, subject_id: OWNER_ID }),
  });
  assert.equal(approved.status, 200);
  const token = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.body.device_code,
      client_id: CLIENT_ID,
    }),
  });
  assert.equal(token.status, 200);
  assert.ok(token.body?.access_token, 'device code must issue an owner-agent bearer');
  return token.body.access_token;
}

function mutation(method, path, auth, body = undefined) {
  return {
    method,
    path,
    options: {
      method,
      headers: {
        ...auth,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  };
}

function schedulerSideEffects() {
  return {
    activeRuns: getDb().prepare('SELECT COUNT(*) AS count FROM controller_active_runs').get().count,
    schedules: getDb().prepare('SELECT COUNT(*) AS count FROM connector_schedules').get().count,
  };
}

test('all 18 cookie and owner-agent local-device control selectors fail closed without scheduler side effects', async () => {
  const server = await startServer({
    quiet: true, asPort: 0, rsPort: 0, dbPath: ':memory:', ownerAuthPassword: PASSWORD,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  try {
    const manifest = JSON.parse(readFileSync(new URL('../manifests/spotify.json', import.meta.url), 'utf8'));
    const registered = await fetchJson(`${asUrl}/connectors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(manifest),
    });
    assert.equal(registered.status, 201);
    const connectorId = canonicalConnectorKey(manifest.connector_id);
    assert.ok(connectorId);
    await createSqliteConnectorInstanceStore().upsert({
      connectorInstanceId: INSTANCE_ID,
      ownerSubjectId: OWNER_ID,
      connectorId,
      displayName: 'Local Spotify export',
      status: 'active',
      sourceKind: 'local_device',
      sourceBindingKey: 'local-device-matrix',
      sourceBinding: { kind: 'local_device', device: 'laptop' },
      createdAt: NOW,
      updatedAt: NOW,
    });

    const cookie = await loginOwner(asUrl);
    const ownerToken = await issueOwnerAgentToken(asUrl, cookie);
    const cookieAuth = { Cookie: cookie };
    const bearerAuth = { Authorization: `Bearer ${ownerToken}` };
    const connectionSchedule = `/_ref/connections/${encodeURIComponent(INSTANCE_ID)}/schedule`;
    const connectorSchedule = `/_ref/connectors/${encodeURIComponent(connectorId)}/schedule`;
    const ownerConnectionSchedule = `/v1/owner/connections/${encodeURIComponent(INSTANCE_ID)}/schedule`;
    const ownerConnectorSchedule = `/v1/owner/connectors/${encodeURIComponent(connectorId)}/schedule`;
    const scheduleBody = { interval_seconds: 900 };

    const requests = [
      // Cookie/session surface: both selector shapes × every mutation.
      mutation('POST', `/_ref/connections/${encodeURIComponent(INSTANCE_ID)}/run`, cookieAuth),
      mutation('PUT', connectionSchedule, cookieAuth, scheduleBody),
      mutation('POST', `${connectionSchedule}/pause`, cookieAuth),
      mutation('POST', `${connectionSchedule}/resume`, cookieAuth),
      mutation('DELETE', connectionSchedule, cookieAuth),
      mutation('POST', `/_ref/connectors/${encodeURIComponent(connectorId)}/run`, cookieAuth),
      mutation('PUT', connectorSchedule, cookieAuth, scheduleBody),
      mutation('POST', `${connectorSchedule}/pause`, cookieAuth),
      mutation('POST', `${connectorSchedule}/resume`, cookieAuth),
      mutation('DELETE', connectorSchedule, cookieAuth),
      // Owner-agent surface exposes run/toggle/delete (schedule PUT remains
      // owner-session-only by contract): both selector shapes × all eight routes.
      mutation('POST', `/v1/owner/connections/${encodeURIComponent(INSTANCE_ID)}/run`, bearerAuth),
      mutation('POST', `${ownerConnectionSchedule}/pause`, bearerAuth),
      mutation('POST', `${ownerConnectionSchedule}/resume`, bearerAuth),
      mutation('DELETE', ownerConnectionSchedule, bearerAuth),
      mutation('POST', `/v1/owner/connectors/${encodeURIComponent(connectorId)}/run`, bearerAuth),
      mutation('POST', `${ownerConnectorSchedule}/pause`, bearerAuth),
      mutation('POST', `${ownerConnectorSchedule}/resume`, bearerAuth),
      mutation('DELETE', ownerConnectorSchedule, bearerAuth),
    ];
    assert.equal(requests.length, 18, 'matrix must cover every independently mounted local-device control route');

    const initialSideEffects = schedulerSideEffects();
    assert.deepEqual(initialSideEffects, { activeRuns: 0, schedules: 0 });
    for (const request of requests) {
      const baseUrl = request.path.startsWith('/v1/') ? rsUrl : asUrl;
      const response = await fetchJson(`${baseUrl}${request.path}`, request.options);
      assert.equal(response.status, 409, `${request.method} ${request.path} must reject local-device control`);
      assert.equal(response.body?.error?.code, 'local_device_control_unsupported', `${request.method} ${request.path}`);
      assert.deepEqual(schedulerSideEffects(), initialSideEffects, `${request.method} ${request.path} must be side-effect free`);
    }
  } finally {
    await closeServer(server);
  }
});
