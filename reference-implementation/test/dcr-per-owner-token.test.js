import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';

const TEST_PASSWORD = 'dcr-owner-token-test-password';
const TEST_SUBJECT = 'owner_test_subject';
const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeWithTimeout = (srv) => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve();
      }
    }, 2000);
    srv.close(() => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

async function withServer(fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ownerAuthPassword: TEST_PASSWORD,
    ownerAuthSubjectId: TEST_SUBJECT,
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
  });
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
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

async function fetchCsrfFromForm(asUrl, path, sessionCookie = '') {
  const resp = await fetch(`${asUrl}${path}`, {
    headers: { Accept: 'text/html', Cookie: sessionCookie },
    redirect: 'manual',
  });
  const setCookies = getRawSetCookieList(resp);
  const html = await resp.text();
  return {
    csrfCookie: findSetCookiePair(setCookies, 'pdpp_owner_csrf'),
    csrfField: extractCsrfFieldValue(html),
  };
}

async function login(asUrl) {
  const csrf = await fetchCsrfFromForm(asUrl, '/owner/login');
  const resp = await fetch(`${asUrl}/owner/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
      Cookie: csrf.csrfCookie,
    },
    body: new URLSearchParams({
      password: TEST_PASSWORD,
      return_to: '/dashboard/deployment/tokens',
      _csrf: csrf.csrfField,
    }).toString(),
    redirect: 'manual',
  });
  assert.equal(resp.status, 302);
  const sessionCookie = findSetCookiePair(getRawSetCookieList(resp), 'pdpp_owner_session');
  assert.ok(sessionCookie, 'login should issue owner session cookie');
  return sessionCookie;
}

async function registerClient(asUrl, body, cookie = '') {
  const resp = await fetch(`${asUrl}/oauth/register`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const json = await resp.json();
  return { body: json, status: resp.status };
}

async function listOwnerClients(asUrl, cookie) {
  const resp = await fetch(`${asUrl}/_ref/clients?owner=true`, {
    headers: { Cookie: cookie },
  });
  assert.equal(resp.status, 200);
  return resp.json();
}

async function issueOwnerTokenViaDeviceFlow(asUrl, clientId, cookie) {
  const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  });
  assert.equal(deviceResp.status, 200);
  const device = await deviceResp.json();

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ user_code: device.user_code, subject_id: 'attacker_ignored_when_owner_auth_enabled' }),
  });
  assert.equal(approveResp.status, 200);

  const tokenResp = await fetch(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }),
  });
  assert.equal(tokenResp.status, 200);
  return tokenResp.json();
}

async function introspect(asUrl, token) {
  const resp = await fetch(`${asUrl}/introspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.equal(resp.status, 200);
  return resp.json();
}

test('DCR per owner token: owner-issued clients list and cascade-revoke owner bearer', async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);

    const ownerRegistered = await registerClient(asUrl, {
      client_name: 'laptop-export',
      issuer_subject_id: 'body_must_not_win',
      token_endpoint_auth_method: 'none',
    }, sessionCookie);
    assert.equal(ownerRegistered.status, 201);
    assert.equal(ownerRegistered.body.client_name, 'laptop-export');
    assert.ok(ownerRegistered.body.client_id);

    const anonymousRegistered = await registerClient(asUrl, {
      client_name: 'Anonymous extension attempt',
      issuer_subject_id: 'body_must_be_dropped',
      token_endpoint_auth_method: 'none',
    });
    assert.equal(anonymousRegistered.status, 201);

    const listed = await listOwnerClients(asUrl, sessionCookie);
    const clientIds = listed.data.map((row) => row.client_id);
    assert.ok(clientIds.includes(ownerRegistered.body.client_id));
    assert.ok(!clientIds.includes(anonymousRegistered.body.client_id));
    const listedOwnerClient = listed.data.find((row) => row.client_id === ownerRegistered.body.client_id);
    assert.equal(listedOwnerClient.client_name, 'laptop-export');
    assert.equal(listedOwnerClient.active_token_count, 0);

    const token = await issueOwnerTokenViaDeviceFlow(asUrl, ownerRegistered.body.client_id, sessionCookie);
    assert.ok(token.access_token);
    const active = await introspect(asUrl, token.access_token);
    assert.equal(active.active, true);
    assert.equal(active.pdpp_token_kind, 'owner');
    assert.equal(active.subject_id, TEST_SUBJECT);
    assert.equal(active.client_id, ownerRegistered.body.client_id);

    const listedAfterIssue = await listOwnerClients(asUrl, sessionCookie);
    const issuedClient = listedAfterIssue.data.find((row) => row.client_id === ownerRegistered.body.client_id);
    assert.equal(issuedClient.client_name, 'laptop-export');
    assert.equal(issuedClient.active_token_count, 1);

    const deleteResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(ownerRegistered.body.client_id)}`, {
      method: 'DELETE',
      headers: { Cookie: sessionCookie },
    });
    assert.equal(deleteResp.status, 204);

    const inactive = await introspect(asUrl, token.access_token);
    assert.equal(inactive.active, false);
    assert.equal(inactive.inactive_reason, 'token_revoked');

    const listedAfterDelete = await listOwnerClients(asUrl, sessionCookie);
    assert.ok(!listedAfterDelete.data.some((row) => row.client_id === ownerRegistered.body.client_id));

    const deleteAgainResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(ownerRegistered.body.client_id)}`, {
      method: 'DELETE',
      headers: { Cookie: sessionCookie },
    });
    assert.equal(deleteAgainResp.status, 404);

    const deleteAnonymousResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(anonymousRegistered.body.client_id)}`, {
      method: 'DELETE',
      headers: { Cookie: sessionCookie },
    });
    assert.equal(deleteAnonymousResp.status, 403);

    const deletePreRegisteredResp = await fetch(`${asUrl}/oauth/register/pdpp-web-dashboard`, {
      method: 'DELETE',
      headers: { Cookie: sessionCookie },
    });
    assert.equal(deletePreRegisteredResp.status, 403);
  });
});
