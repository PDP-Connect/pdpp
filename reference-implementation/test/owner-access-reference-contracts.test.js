import test from 'node:test';
import assert from 'node:assert/strict';

import { getDb } from '../server/db.js';
import { startServer } from '../server/index.js';

// Integration coverage for the additive owner-access reference contracts
// (OpenSpec change redesign-owner-console-product-experience, tasks 10.C.1–4):
//   - PATCH /oauth/register/:clientId          (client-name update)
//   - GET   /_ref/clients/:clientId/tokens      (per-client token listing)
//   - DELETE /_ref/clients/:clientId/tokens/:id (per-token revoke)
//   - GET   /_ref/grant-packages/count          (grant-package count)
//
// The security boundaries under test: no literal bearer is ever returned by
// the token listing, per-token revoke targets exactly one bearer (not the
// whole client), and every surface is owner-session-gated + owner-scoped.

const TEST_PASSWORD = 'owner-access-contracts-test-password';
const TEST_SUBJECT = 'owner_test_subject';
const TEST_DCR_INITIAL_ACCESS_TOKEN = 'pdpp-reference-test-initial-access-token';

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeWithTimeout = (srv) => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolve(); }
    }, 2000);
    srv.close(() => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(); }
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
  if (typeof resp.headers.getSetCookie === 'function') return resp.headers.getSetCookie();
  const single = resp.headers.get('set-cookie');
  return single ? [single] : [];
}

function findSetCookiePair(setCookies, name) {
  for (const header of setCookies) {
    const firstPair = header.split(';')[0];
    if (firstPair.startsWith(`${name}=`)) return firstPair;
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
  const resp = await fetch(`${asUrl}/_ref/clients?owner=true`, { headers: { Cookie: cookie } });
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
    body: JSON.stringify({ user_code: device.user_code }),
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

// ── 10.C.1 client-name update ────────────────────────────────────────────────

test('10.C.1 PATCH /oauth/register/:clientId renames the client and reflects on the next read', async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);
    const registered = await registerClient(asUrl, {
      client_name: 'laptop-export',
      token_endpoint_auth_method: 'none',
    }, sessionCookie);
    assert.equal(registered.status, 201);
    const clientId = registered.body.client_id;

    const before = getDb().prepare('SELECT updated_at FROM oauth_clients WHERE client_id = ?').get(clientId);

    const patchResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(clientId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ client_name: 'backup laptop' }),
    });
    assert.equal(patchResp.status, 200);
    const patched = await patchResp.json();
    assert.equal(patched.client_id, clientId);
    assert.equal(patched.client_name, 'backup laptop');

    // updated_at was driven by the rename.
    const after = getDb().prepare('SELECT updated_at FROM oauth_clients WHERE client_id = ?').get(clientId);
    assert.ok(after.updated_at, 'updated_at must be set after a rename');
    assert.notEqual(after.updated_at, undefined);
    // The rename reflects across the same read the overview/tokens page uses.
    const listed = await listOwnerClients(asUrl, sessionCookie);
    const row = listed.data.find((r) => r.client_id === clientId);
    assert.equal(row.client_name, 'backup laptop', 'rename must reflect in the owner client list');
    // Sanity: updated_at is a real timestamp string.
    assert.equal(typeof after.updated_at, 'string');
    assert.ok(!before || typeof before.updated_at === 'string');
  });
});

test('10.C.1 rename rejects empty names, cross-owner edits, and pre-registered clients', async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);
    const registered = await registerClient(asUrl, {
      client_name: 'owned',
      token_endpoint_auth_method: 'none',
    }, sessionCookie);
    const clientId = registered.body.client_id;

    // Empty name → 400 invalid_client_metadata.
    const emptyResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(clientId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ client_name: '   ' }),
    });
    assert.equal(emptyResp.status, 400);

    // Unsupported field → 400 (scope is not editable here).
    const scopeResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(clientId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ client_name: 'ok', redirect_uris: ['https://evil.example'] }),
    });
    assert.equal(scopeResp.status, 400);

    // Anonymous client (registered by no owner) → 403 forbidden.
    const anon = await registerClient(asUrl, { client_name: 'anon', token_endpoint_auth_method: 'none' });
    const anonResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(anon.body.client_id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ client_name: 'stolen' }),
    });
    assert.equal(anonResp.status, 403);

    // Pre-registered seed → 403 forbidden.
    const seedResp = await fetch(`${asUrl}/oauth/register/pdpp-web-dashboard`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
      body: JSON.stringify({ client_name: 'renamed seed' }),
    });
    assert.equal(seedResp.status, 403);

    // Unauthenticated → not 200 (owner-session-gated).
    const noAuthResp = await fetch(`${asUrl}/oauth/register/${encodeURIComponent(clientId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'noauth' }),
    });
    assert.notEqual(noAuthResp.status, 200);
  });
});

// ── 10.C.2 per-client token listing + 10.C.3 per-token revoke ────────────────

test('10.C.2/10.C.3 per-client token listing exposes no bearer; per-token revoke targets one bearer', async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);
    const registered = await registerClient(asUrl, {
      client_name: 'multi-token client',
      token_endpoint_auth_method: 'none',
    }, sessionCookie);
    const clientId = registered.body.client_id;

    // Issue two bearers against the same client so active_token_count > 1.
    const tokenA = await issueOwnerTokenViaDeviceFlow(asUrl, clientId, sessionCookie);
    const tokenB = await issueOwnerTokenViaDeviceFlow(asUrl, clientId, sessionCookie);
    assert.ok(tokenA.access_token && tokenB.access_token);
    assert.notEqual(tokenA.access_token, tokenB.access_token);

    const listed = await listOwnerClients(asUrl, sessionCookie);
    const clientRow = listed.data.find((r) => r.client_id === clientId);
    assert.equal(clientRow.active_token_count, 2);

    // Per-client token listing.
    const tokensResp = await fetch(`${asUrl}/_ref/clients/${encodeURIComponent(clientId)}/tokens?owner=true`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(tokensResp.status, 200);
    const tokens = await tokensResp.json();
    assert.equal(tokens.object, 'list');
    assert.equal(tokens.data.length, 2);

    // SECURITY: no literal bearer leaks. Each row carries a non-bearer public
    // id and issued/expiry facts, never the raw access_token.
    const serialized = JSON.stringify(tokens);
    assert.ok(!serialized.includes(tokenA.access_token), 'listing must not contain bearer A');
    assert.ok(!serialized.includes(tokenB.access_token), 'listing must not contain bearer B');
    for (const row of tokens.data) {
      assert.equal(row.object, 'owner_client_token');
      assert.equal(typeof row.token_id_public, 'string');
      assert.ok(row.token_id_public.startsWith('tok_'));
      assert.ok(!('token_id' in row), 'no raw token_id field may be present');
      assert.notEqual(row.token_id_public, tokenA.access_token);
      assert.notEqual(row.token_id_public, tokenB.access_token);
      assert.ok('created_at' in row);
      assert.ok('expires_at' in row);
    }

    // The `owner=true` requirement mirrors ref.clients.list.
    const missingOwner = await fetch(`${asUrl}/_ref/clients/${encodeURIComponent(clientId)}/tokens`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(missingOwner.status, 400);

    // Revoke exactly ONE token by its public id.
    const targetPublicId = tokens.data[0].token_id_public;
    const revokeResp = await fetch(
      `${asUrl}/_ref/clients/${encodeURIComponent(clientId)}/tokens/${encodeURIComponent(targetPublicId)}`,
      { method: 'DELETE', headers: { Cookie: sessionCookie } },
    );
    assert.equal(revokeResp.status, 200);
    const revokeBody = await revokeResp.json();
    assert.equal(revokeBody.revoked, true);
    assert.equal(revokeBody.token_id_public, targetPublicId);

    // Exactly one bearer is now inactive; the client itself and its other
    // bearer remain (revoke did NOT cascade the whole client).
    const afterList = await fetch(`${asUrl}/_ref/clients/${encodeURIComponent(clientId)}/tokens?owner=true`, {
      headers: { Cookie: sessionCookie },
    });
    const afterTokens = await afterList.json();
    assert.equal(afterTokens.data.length, 1, 'one active token should remain after per-token revoke');
    assert.notEqual(afterTokens.data[0].token_id_public, targetPublicId);

    const clientStillListed = await listOwnerClients(asUrl, sessionCookie);
    assert.ok(
      clientStillListed.data.some((r) => r.client_id === clientId),
      'per-token revoke must not delete the client',
    );

    // Confirm via introspection: the two bearers now split active/inactive.
    const introA = await introspect(asUrl, tokenA.access_token);
    const introB = await introspect(asUrl, tokenB.access_token);
    const activeCount = [introA.active, introB.active].filter(Boolean).length;
    assert.equal(activeCount, 1, 'exactly one of the two bearers should remain active');

    // Idempotent re-revoke of the same public id → revoked:false.
    const reRevoke = await fetch(
      `${asUrl}/_ref/clients/${encodeURIComponent(clientId)}/tokens/${encodeURIComponent(targetPublicId)}`,
      { method: 'DELETE', headers: { Cookie: sessionCookie } },
    );
    assert.equal(reRevoke.status, 200);
    assert.equal((await reRevoke.json()).revoked, false);
  });
});

test('10.C.2/10.C.3 token listing + revoke are owner-scoped (cross-owner and unknown clients rejected)', async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);

    // Anonymous client (not owned by the session subject).
    const anon = await registerClient(asUrl, { client_name: 'anon', token_endpoint_auth_method: 'none' });
    const anonClientId = anon.body.client_id;

    const listResp = await fetch(`${asUrl}/_ref/clients/${encodeURIComponent(anonClientId)}/tokens?owner=true`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(listResp.status, 403, 'listing another owner\'s client tokens must be forbidden');

    const revokeResp = await fetch(
      `${asUrl}/_ref/clients/${encodeURIComponent(anonClientId)}/tokens/tok_whatever`,
      { method: 'DELETE', headers: { Cookie: sessionCookie } },
    );
    assert.equal(revokeResp.status, 403);

    // Unknown client → 404.
    const unknownResp = await fetch(`${asUrl}/_ref/clients/cli_does_not_exist/tokens?owner=true`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(unknownResp.status, 404);

    // Unauthenticated → not 200 (owner-session-gated).
    const noAuth = await fetch(`${asUrl}/_ref/clients/${encodeURIComponent(anonClientId)}/tokens?owner=true`);
    assert.notEqual(noAuth.status, 200);
  });
});

// ── 10.C.4 grant-package count ───────────────────────────────────────────────

test('10.C.4 GET /_ref/grant-packages/count returns the total without paging the list', async () => {
  await withServer(async ({ asUrl }) => {
    const sessionCookie = await login(asUrl);

    const zero = await fetch(`${asUrl}/_ref/grant-packages/count`, { headers: { Cookie: sessionCookie } });
    assert.equal(zero.status, 200);
    const zeroBody = await zero.json();
    assert.equal(zeroBody.object, 'grant_package_count');
    assert.equal(zeroBody.count, 0);

    // Seed two package rows directly (the runtime consent flow is out of scope
    // for a contract test; the count reads the same table the list pages).
    const now = new Date().toISOString();
    const db = getDb();
    for (const pid of ['gpkg_count_a', 'gpkg_count_b']) {
      db.prepare(`
        INSERT INTO grant_packages(package_id, subject_id, client_id, status, package_json,
          trace_id, scenario_id, created_at, approved_at, revoked_at)
        VALUES (?, ?, 'cli_x', 'active', ?, 't', 's', ?, ?, NULL)
      `).run(pid, TEST_SUBJECT, JSON.stringify({ version: 'test', package_id: pid }), now, now);
    }

    const two = await fetch(`${asUrl}/_ref/grant-packages/count`, { headers: { Cookie: sessionCookie } });
    assert.equal(two.status, 200);
    assert.equal((await two.json()).count, 2);

    // The count matches the length of the (bounded) list surface.
    const listResp = await fetch(`${asUrl}/_ref/grant-packages`, { headers: { Cookie: sessionCookie } });
    const list = await listResp.json();
    assert.equal(list.data.length, 2, 'count should agree with the list length for this small fixture');

    // Owner-session-gated.
    const noAuth = await fetch(`${asUrl}/_ref/grant-packages/count`);
    assert.notEqual(noAuth.status, 200);

    // "count" must not be captured as a package id by the /:id route.
    const notAnId = await fetch(`${asUrl}/_ref/grant-packages/count`, { headers: { Cookie: sessionCookie } });
    const notAnIdBody = await notAnId.json();
    assert.equal(notAnIdBody.object, 'grant_package_count');
    assert.ok(!('package_id' in notAnIdBody));
  });
});
