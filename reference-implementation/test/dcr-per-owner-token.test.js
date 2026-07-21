import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb } from '../server/db.js';
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
      return_to: '/deployment/tokens',
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

function seedActiveHostedMcpPackageForClient(clientId) {
  const now = new Date().toISOString();
  const packageId = 'gpkg_dcr_delete_cascade';
  const packageTokenId = 'tok_dcr_delete_cascade';
  const refreshTokenHash = 'rt_hash_dcr_delete_cascade';
  const db = getDb();

  db.prepare(`
    INSERT INTO grant_packages(
      package_id, subject_id, client_id, status, package_json,
      trace_id, scenario_id, created_at, approved_at, revoked_at
    ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL)
  `).run(
    packageId,
    TEST_SUBJECT,
    clientId,
    JSON.stringify({ version: 'test', package_id: packageId }),
    'trace_dcr_delete_cascade',
    'scenario_dcr_delete_cascade',
    now,
    now,
  );

  db.prepare(`
    INSERT INTO tokens(token_id, grant_id, package_id, subject_id, client_id, token_kind, expires_at, revoked)
    VALUES (?, NULL, ?, ?, ?, 'mcp_package', NULL, FALSE)
  `).run(packageTokenId, packageId, TEST_SUBJECT, clientId);

  db.prepare(`
    INSERT INTO oauth_refresh_tokens(
      refresh_token_hash, client_id, grant_id, package_id, subject_id, status,
      created_at, expires_at, last_used_at, revoked_at
    ) VALUES (?, ?, NULL, ?, ?, 'active', ?, NULL, NULL, NULL)
  `).run(refreshTokenHash, clientId, packageId, TEST_SUBJECT, now);

  return { packageId, packageTokenId, refreshTokenHash };
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

    const packageState = seedActiveHostedMcpPackageForClient(ownerRegistered.body.client_id);

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

    const revokedPackage = getDb().prepare(
      'SELECT status, revoked_at FROM grant_packages WHERE package_id = ?',
    ).get(packageState.packageId);
    assert.equal(revokedPackage.status, 'revoked');
    assert.ok(revokedPackage.revoked_at, 'client deletion must revoke package row');

    const revokedPackageToken = getDb().prepare(
      'SELECT revoked FROM tokens WHERE token_id = ?',
    ).get(packageState.packageTokenId);
    assert.equal(revokedPackageToken.revoked, 1);

    const revokedRefresh = getDb().prepare(
      'SELECT status, revoked_at FROM oauth_refresh_tokens WHERE refresh_token_hash = ?',
    ).get(packageState.refreshTokenHash);
    assert.equal(revokedRefresh.status, 'revoked');
    assert.ok(revokedRefresh.revoked_at, 'client deletion must revoke package refresh token');

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

test('owner device approval binds a public dynamic client to the approving owner for revoke', async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);

    const registered = await registerClient(asUrl, {
      client_name: 'Daisy local owner agent',
      token_endpoint_auth_method: 'none',
    });
    assert.equal(registered.status, 201);
    assert.ok(registered.body.client_id);

    const listedBeforeApproval = await listOwnerClients(asUrl, sessionCookie);
    assert.ok(!listedBeforeApproval.data.some((row) => row.client_id === registered.body.client_id));

    const token = await issueOwnerTokenViaDeviceFlow(asUrl, registered.body.client_id, sessionCookie);
    assert.ok(token.access_token);
    const active = await introspect(asUrl, token.access_token);
    assert.equal(active.active, true);
    assert.equal(active.pdpp_token_kind, 'owner');
    assert.equal(active.subject_id, TEST_SUBJECT);
    assert.equal(active.client_id, registered.body.client_id);

    const listedAfterApproval = await listOwnerClients(asUrl, sessionCookie);
    const ownerClient = listedAfterApproval.data.find((row) => row.client_id === registered.body.client_id);
    assert.ok(ownerClient, 'approval should bind the dynamic client to the approving owner');
    assert.equal(ownerClient.client_name, 'Daisy local owner agent');
    assert.equal(ownerClient.active_token_count, 1);

    const deleteResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(registered.body.client_id)}`, {
      method: 'DELETE',
      headers: { Cookie: sessionCookie },
    });
    assert.equal(deleteResp.status, 204);

    const inactive = await introspect(asUrl, token.access_token);
    assert.equal(inactive.active, false);
    assert.equal(inactive.inactive_reason, 'token_revoked');
  });
});

// ── DCR optional URI seeding from AS_PUBLIC_URL ──────────────────────────────

test('DCR seeds client_uri / logo_uri / policy_uri / tos_uri from AS_PUBLIC_URL when registrant omits them', async () => {
  const prior = process.env.AS_PUBLIC_URL;
  process.env.AS_PUBLIC_URL = 'https://as.example.com';
  try {
    await withServer(async ({ asUrl }) => {
      const result = await registerClient(asUrl, {
        client_name: 'minimal-client',
        token_endpoint_auth_method: 'none',
      });
      assert.equal(result.status, 201, 'registration must succeed');
      assert.equal(result.body.client_uri, 'https://as.example.com', 'client_uri must be seeded from AS_PUBLIC_URL');
      assert.equal(result.body.logo_uri, 'https://as.example.com/icon.svg', 'logo_uri must be seeded as base/icon.svg');
      assert.equal(result.body.policy_uri, 'https://as.example.com', 'policy_uri must be seeded from AS_PUBLIC_URL');
      assert.equal(result.body.tos_uri, 'https://as.example.com', 'tos_uri must be seeded from AS_PUBLIC_URL');
    });
  } finally {
    if (prior === undefined) {
      delete process.env.AS_PUBLIC_URL;
    } else {
      process.env.AS_PUBLIC_URL = prior;
    }
  }
});

test('DCR does not override explicit client_uri / logo_uri / policy_uri / tos_uri from registrant', async () => {
  const prior = process.env.AS_PUBLIC_URL;
  process.env.AS_PUBLIC_URL = 'https://as.example.com';
  try {
    await withServer(async ({ asUrl }) => {
      const result = await registerClient(asUrl, {
        client_name: 'explicit-uri-client',
        client_uri: 'https://my-client.example.com',
        logo_uri: 'https://my-client.example.com/logo.png',
        policy_uri: 'https://my-client.example.com/privacy',
        tos_uri: 'https://my-client.example.com/terms',
        token_endpoint_auth_method: 'none',
      });
      assert.equal(result.status, 201, 'registration must succeed');
      assert.equal(result.body.client_uri, 'https://my-client.example.com', 'explicit client_uri must not be overridden');
      assert.equal(result.body.logo_uri, 'https://my-client.example.com/logo.png', 'explicit logo_uri must not be overridden');
      assert.equal(result.body.policy_uri, 'https://my-client.example.com/privacy', 'explicit policy_uri must not be overridden');
      assert.equal(result.body.tos_uri, 'https://my-client.example.com/terms', 'explicit tos_uri must not be overridden');
    });
  } finally {
    if (prior === undefined) {
      delete process.env.AS_PUBLIC_URL;
    } else {
      process.env.AS_PUBLIC_URL = prior;
    }
  }
});

test('DCR omits URI fields when AS_PUBLIC_URL is not set', async () => {
  const prior = process.env.AS_PUBLIC_URL;
  delete process.env.AS_PUBLIC_URL;
  try {
    await withServer(async ({ asUrl }) => {
      const result = await registerClient(asUrl, {
        client_name: 'no-public-url-client',
        token_endpoint_auth_method: 'none',
      });
      assert.equal(result.status, 201, 'registration must succeed');
      assert.equal(result.body.client_uri, undefined, 'client_uri must be absent when AS_PUBLIC_URL unset');
      assert.equal(result.body.logo_uri, undefined, 'logo_uri must be absent when AS_PUBLIC_URL unset');
      assert.equal(result.body.policy_uri, undefined, 'policy_uri must be absent when AS_PUBLIC_URL unset');
      assert.equal(result.body.tos_uri, undefined, 'tos_uri must be absent when AS_PUBLIC_URL unset');
    });
  } finally {
    if (prior === undefined) {
      delete process.env.AS_PUBLIC_URL;
    } else {
      process.env.AS_PUBLIC_URL = prior;
    }
  }
});
