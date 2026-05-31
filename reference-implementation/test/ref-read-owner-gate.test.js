// Black-box regression tests for the gate-ref-reads-when-owner-auth-enabled
// change.
//
// Pins three invariants:
//   1. With PDPP_OWNER_PASSWORD set, every `_ref` GET rejects an
//      unauthenticated caller with `401 owner_session_required`.
//   2. With PDPP_OWNER_PASSWORD set, the same `_ref` GETs accept an
//      owner-session cookie obtained from `POST /owner/login`.
//   3. With PDPP_OWNER_PASSWORD unset, `_ref` GETs remain open
//      (preserving the local-dev behavior the spec calls out).
//
// Spec: openspec/changes/gate-ref-reads-when-owner-auth-enabled/specs/
//       reference-implementation-architecture/spec.md
import test from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';

const TEST_PASSWORD = 'gate-ref-reads-test-password';

// All `_ref` GET routes the spec lists as the durable read surface.
// Routes that take an :id segment use a clearly-fake id so the handler
// either returns 404 (when password-disabled or session-bearing) or 401
// (when password-enabled and unauthenticated). Either way the auth gate
// runs *before* the body, so the status check is the contract under
// test, not the underlying handler outcome.
const REF_READ_ROUTES = [
  '/_ref/traces',
  '/_ref/grants',
  '/_ref/runs',
  '/_ref/search?q=anything',
  '/_ref/traces/trace_does_not_exist',
  '/_ref/grants/grant_does_not_exist/timeline',
  '/_ref/runs/run_does_not_exist/timeline',
  '/_ref/dataset/summary',
  '/_ref/dataset/summary/streams',
  '/_ref/dataset/size',
  '/_ref/dataset/top',
  '/_ref/records/version-stats',
  '/_ref/connectors',
  '/_ref/connectors/connector_does_not_exist',
  '/_ref/approvals',
  '/_ref/records/timeline',
  '/_ref/schedules',
  '/_ref/connectors/connector_does_not_exist/schedule',
  '/_ref/deployment',
  '/_ref/clients?owner=true',
];

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeOne = (srv) => new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 2000);
    srv.close(() => { if (!settled) { settled = true; clearTimeout(t); resolve(); } });
  });
  await Promise.allSettled([closeOne(server.asServer), closeOne(server.rsServer)]);
}

async function withServer(opts, fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ...opts,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  try {
    await fn({ asUrl });
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

async function fetchCsrf(asUrl) {
  const resp = await fetch(`${asUrl}/owner/login`, {
    headers: { Accept: 'text/html' },
    redirect: 'manual',
  });
  const setCookies = getRawSetCookieList(resp);
  const csrfCookie = findSetCookiePair(setCookies, 'pdpp_owner_csrf');
  const html = await resp.text();
  const csrfField = extractCsrfFieldValue(html);
  return { csrfCookie, csrfField };
}

async function login(asUrl, password) {
  const csrf = await fetchCsrf(asUrl);
  const resp = await fetch(`${asUrl}/owner/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
      Cookie: csrf.csrfCookie || '',
    },
    body: new URLSearchParams({
      password,
      return_to: '/',
      _csrf: csrf.csrfField || '',
    }).toString(),
    redirect: 'manual',
  });
  const setCookies = getRawSetCookieList(resp);
  const sessionCookie = findSetCookiePair(setCookies, 'pdpp_owner_session');
  if (!sessionCookie) {
    throw new Error(`expected pdpp_owner_session cookie after /owner/login, got status ${resp.status}`);
  }
  return sessionCookie;
}

async function fetchJson(url, opts = {}) {
  const resp = await fetch(url, opts);
  const body = await resp.json();
  return { body, status: resp.status };
}

async function issueOwnerToken(asUrl, sessionCookie) {
  const clientId = 'cli_longview';
  const { body: device, status: deviceStatus } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  });
  assert.equal(deviceStatus, 200);

  const approveResp = await fetch(`${asUrl}/device/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify({
      user_code: device.user_code,
      subject_id: 'owner_token_must_not_unlock_ref_reads',
    }),
  });
  assert.equal(approveResp.status, 200);

  const { body: tokenBody, status: tokenStatus } = await fetchJson(`${asUrl}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
      client_id: clientId,
    }),
  });
  assert.equal(tokenStatus, 200);
  assert.ok(tokenBody.access_token, 'device exchange should issue an owner token');
  return tokenBody.access_token;
}

test('_ref reads: password-enabled rejects unauthenticated callers with 401 owner_session_required', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    for (const route of REF_READ_ROUTES) {
      const resp = await fetch(`${asUrl}${route}`, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
      });
      assert.equal(resp.status, 401, `expected 401 for ${route}, got ${resp.status}`);
      const body = await resp.json();
      assert.equal(
        body?.error?.code,
        'owner_session_required',
        `expected owner_session_required for ${route}, got ${JSON.stringify(body)}`,
      );
    }
  });
});

test('_ref reads: password-enabled rejects owner bearer without owner session', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const sessionCookie = await login(asUrl, TEST_PASSWORD);
    const ownerToken = await issueOwnerToken(asUrl, sessionCookie);

    for (const route of REF_READ_ROUTES) {
      const resp = await fetch(`${asUrl}${route}`, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${ownerToken}`,
        },
        redirect: 'manual',
      });
      assert.equal(resp.status, 401, `expected 401 for ${route} with owner bearer but no session, got ${resp.status}`);
      const body = await resp.json();
      assert.equal(
        body?.error?.code,
        'owner_session_required',
        `expected owner_session_required for ${route}, got ${JSON.stringify(body)}`,
      );
    }
  });
});

test('_ref reads: password-enabled accepts an owner-session cookie', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const sessionCookie = await login(asUrl, TEST_PASSWORD);
    for (const route of REF_READ_ROUTES) {
      const resp = await fetch(`${asUrl}${route}`, {
        headers: { Accept: 'application/json', Cookie: sessionCookie },
        redirect: 'manual',
      });
      // The auth gate has passed when the response is no longer 401.
      // The underlying handler may still return 200, 404, or another
      // domain-specific status depending on whether the fake id resolves;
      // what we care about here is that the gate did not block the call.
      assert.notEqual(
        resp.status,
        401,
        `expected non-401 for ${route} with owner session, got 401`,
      );
      // And we should never see the auth-failure error envelope.
      try {
        const body = await resp.clone().json();
        assert.notEqual(
          body?.error?.code,
          'owner_session_required',
          `unexpected owner_session_required body for ${route}`,
        );
      } catch {
        // Non-JSON body — fine.
      }
    }
  });
});

test('_ref reads: password-disabled local-dev mode remains open', async () => {
  await withServer({ ownerAuthPassword: '' }, async ({ asUrl }) => {
    for (const route of REF_READ_ROUTES) {
      const resp = await fetch(`${asUrl}${route}`, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
      });
      assert.notEqual(
        resp.status,
        401,
        `expected open access for ${route} when password is unset, got 401`,
      );
      try {
        const body = await resp.clone().json();
        assert.notEqual(
          body?.error?.code,
          'owner_session_required',
          `unexpected owner_session_required body for ${route} in open mode`,
        );
      } catch {
        // Non-JSON body — fine.
      }
    }
  });
});
