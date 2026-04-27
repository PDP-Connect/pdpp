/**
 * Regression tests for the hosted-form CSRF mechanism.
 *
 * Coverage matrix (per owner review):
 *   - login: form POST without CSRF -> 403 + no session cookie
 *   - login: form POST with valid CSRF + wrong password -> 401
 *   - login: form POST with valid CSRF + correct password -> 302 + session
 *   - consent/approve, consent/deny: form POST without CSRF -> 403 (session present)
 *   - device/approve, device/deny:   form POST without CSRF -> 403 (session present)
 *   - matching CSRF from rendered consent/device pages allows the positive path
 *   - JSON callers remain compatible (no CSRF required for JSON content-type)
 *   - login Set-Cookie carries both session and CSRF cookies through Fastify
 *   - signature defends against cookie injection / subdomain overwrite
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startServer } from '../server/index.js';
import {
  initiateOwnerDeviceAuthorization,
  getOwnerDeviceAuthorizationByUserCode,
} from '../server/auth.js';
import {
  deriveOwnerCsrfSecret,
  issueOwnerCsrfToken,
} from '../server/owner-csrf.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, '..');
const SPOTIFY_MANIFEST = JSON.parse(
  readFileSync(join(REFERENCE_IMPL_DIR, 'manifests/spotify.json'), 'utf8'),
);

const TEST_PASSWORD = 'csrf-regression-test-password';

async function closeServer(server) {
  server.asServer.closeAllConnections();
  server.rsServer.closeAllConnections();
  const closeWithTimeout = (srv) => new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 2000);
    srv.close(() => { if (!settled) { settled = true; clearTimeout(timer); resolve(); } });
  });
  await Promise.allSettled([
    closeWithTimeout(server.asServer),
    closeWithTimeout(server.rsServer),
  ]);
}

async function withServer(opts, fn) {
  const server = await startServer({
    quiet: true,
    asPort: 0,
    rsPort: 0,
    dbPath: ':memory:',
    ...opts,
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

function findSetCookieFullEntry(setCookies, name) {
  return setCookies.find((h) => h.startsWith(`${name}=`)) || null;
}

function extractCsrfFieldValue(html) {
  const match = html.match(/<input type="hidden" name="_csrf" value="([^"]+)"\s*\/>/);
  return match ? match[1] : null;
}

async function fetchCsrfFromForm(asUrl, path, sessionCookie) {
  const resp = await fetch(`${asUrl}${path}`, {
    headers: { Accept: 'text/html', Cookie: sessionCookie || '' },
    redirect: 'manual',
  });
  const setCookies = getRawSetCookieList(resp);
  const csrfCookie = findSetCookiePair(setCookies, 'pdpp_owner_csrf');
  const html = await resp.text();
  return {
    status: resp.status,
    csrfCookie,
    csrfField: extractCsrfFieldValue(html),
    setCookies,
    html,
  };
}

async function login(asUrl, password) {
  const csrf = await fetchCsrfFromForm(asUrl, '/owner/login');
  const resp = await fetch(`${asUrl}/owner/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'text/html',
      Cookie: csrf.csrfCookie,
    },
    body: new URLSearchParams({
      password,
      return_to: '/consent',
      _csrf: csrf.csrfField,
    }).toString(),
    redirect: 'manual',
  });
  const setCookies = getRawSetCookieList(resp);
  return {
    status: resp.status,
    location: resp.headers.get('location'),
    sessionCookie: findSetCookiePair(setCookies, 'pdpp_owner_session'),
    setCookies,
    csrfCookie: csrf.csrfCookie,
    csrfField: csrf.csrfField,
  };
}

async function startPendingConsent(asUrl) {
  const registerResp = await fetch(`${asUrl}/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(SPOTIFY_MANIFEST),
  });
  if (!registerResp.ok && registerResp.status !== 409) {
    throw new Error(`connector registration failed: ${registerResp.status} ${await registerResp.text()}`);
  }
  const resp = await fetch(`${asUrl}/oauth/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: 'longview',
      client_display: { name: 'Longview' },
      authorization_details: [
        {
          type: 'https://pdpp.org/data-access',
          connector_id: SPOTIFY_MANIFEST.connector_id,
          purpose_code: 'test',
          purpose_description: 'test',
          access_mode: 'single_use',
          streams: [{ name: 'top_artists' }],
        },
      ],
    }),
  });
  if (!resp.ok) throw new Error(`par failed: ${resp.status} ${await resp.text()}`);
  const body = await resp.json();
  return body.request_uri;
}

// ── login: form POST without CSRF -> 403 + no session ────────────────────────
test('CSRF: form POST /owner/login without _csrf is rejected with 403 and issues no session', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/owner/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
      },
      body: new URLSearchParams({ password: TEST_PASSWORD, return_to: '/consent' }).toString(),
      redirect: 'manual',
    });
    assert.equal(resp.status, 403);
    const setCookies = getRawSetCookieList(resp);
    assert.ok(
      !findSetCookiePair(setCookies, 'pdpp_owner_session'),
      'no owner session cookie SHALL be issued on CSRF failure',
    );
    const text = await resp.text();
    assert.ok(text.includes('form replay') || text.includes('CSRF'), 'page surfaces a CSRF error');
    assert.ok(!text.includes('Incorrect password'), 'CSRF failure SHALL NOT leak password validity');
  });
});

// ── login: matching CSRF + correct password -> 302 + session ────────────────
test('CSRF: form POST /owner/login with valid CSRF and correct password issues a session and redirects', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const result = await login(asUrl, TEST_PASSWORD);
    assert.equal(result.status, 302);
    assert.equal(result.location, '/consent');
    assert.ok(result.sessionCookie?.startsWith('pdpp_owner_session='), 'session cookie SHALL be set');
  });
});

// ── login Set-Cookie carries both session and CSRF cookies through Fastify ──
test('CSRF: login response Set-Cookie carries both session and CSRF rotation cookies through Fastify', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const result = await login(asUrl, TEST_PASSWORD);
    assert.equal(result.status, 302);
    // Session cookie present.
    assert.ok(findSetCookiePair(result.setCookies, 'pdpp_owner_session'));
    // The login flow rotates the CSRF cookie on auth-state change. The
    // rotation Set-Cookie SHALL be present in addition to the session
    // Set-Cookie — Fastify must preserve both header values.
    const csrfRotation = findSetCookieFullEntry(result.setCookies, 'pdpp_owner_csrf');
    assert.ok(csrfRotation, 'CSRF rotation cookie SHALL be present alongside session cookie');
    assert.ok(csrfRotation.includes('Max-Age=0'), 'rotation cookie SHALL be a clear cookie');
  });
});

// ── login: matching CSRF + wrong password -> 401 (CSRF passes, password fails) ─
test('CSRF: form POST /owner/login with valid CSRF and wrong password returns 401 (no session)', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const csrf = await fetchCsrfFromForm(asUrl, '/owner/login');
    const resp = await fetch(`${asUrl}/owner/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
        Cookie: csrf.csrfCookie,
      },
      body: new URLSearchParams({
        password: 'definitely-not-the-password',
        return_to: '/consent',
        _csrf: csrf.csrfField,
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(resp.status, 401);
    const setCookies = getRawSetCookieList(resp);
    assert.ok(!findSetCookiePair(setCookies, 'pdpp_owner_session'));
    const text = await resp.text();
    assert.ok(text.includes('Incorrect password'));
  });
});

// ── consent/approve, consent/deny: form POST without CSRF -> 403 (auth'd) ───
test('CSRF: form POST /consent/approve without _csrf is rejected with 403 even when authenticated', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);

    const resp = await fetch(`${asUrl}/consent/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
        Cookie: sessionCookie,
      },
      body: new URLSearchParams({ request_uri: requestUri }).toString(),
      redirect: 'manual',
    });
    assert.equal(resp.status, 403);
  });
});

test('CSRF: form POST /consent/deny without _csrf is rejected with 403 even when authenticated', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);

    const resp = await fetch(`${asUrl}/consent/deny`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
        Cookie: sessionCookie,
      },
      body: new URLSearchParams({ request_uri: requestUri }).toString(),
      redirect: 'manual',
    });
    assert.equal(resp.status, 403);
  });
});

// ── device/approve, device/deny: form POST without CSRF -> 403 (auth'd) ─────
test('CSRF: form POST /device/approve without _csrf is rejected with 403 even when authenticated', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const device = await initiateOwnerDeviceAuthorization('longview', { baseUrl: asUrl });

    const resp = await fetch(`${asUrl}/device/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
        Cookie: sessionCookie,
      },
      body: new URLSearchParams({ user_code: device.user_code }).toString(),
      redirect: 'manual',
    });
    assert.equal(resp.status, 403);
    const stillPending = await getOwnerDeviceAuthorizationByUserCode(device.user_code);
    assert.ok(stillPending, 'device authorization SHALL remain pending after blocked POST');
  });
});

test('CSRF: form POST /device/deny without _csrf is rejected with 403 even when authenticated', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const device = await initiateOwnerDeviceAuthorization('longview', { baseUrl: asUrl });

    const resp = await fetch(`${asUrl}/device/deny`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
        Cookie: sessionCookie,
      },
      body: new URLSearchParams({ user_code: device.user_code }).toString(),
      redirect: 'manual',
    });
    assert.equal(resp.status, 403);
    const stillPending = await getOwnerDeviceAuthorizationByUserCode(device.user_code);
    assert.ok(stillPending);
  });
});

// ── matching CSRF from rendered consent page allows the positive path ───────
test('CSRF: matching token from /consent GET allows /consent/approve form POST', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);
    const csrf = await fetchCsrfFromForm(
      asUrl,
      `/consent?request_uri=${encodeURIComponent(requestUri)}`,
      sessionCookie,
    );
    assert.ok(csrf.csrfField, 'consent GET SHALL embed a CSRF token');

    const resp = await fetch(`${asUrl}/consent/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
        Cookie: `${sessionCookie}; ${csrf.csrfCookie}`,
      },
      body: new URLSearchParams({ request_uri: requestUri, _csrf: csrf.csrfField }).toString(),
      redirect: 'manual',
    });
    assert.equal(resp.status, 200);
    const text = await resp.text();
    assert.ok(text.includes('Access approved'));
  });
});

// ── matching CSRF from rendered device page allows the positive path ────────
test('CSRF: matching token from /device GET allows /device/approve form POST', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const device = await initiateOwnerDeviceAuthorization('longview', { baseUrl: asUrl });
    const csrf = await fetchCsrfFromForm(
      asUrl,
      `/device?user_code=${encodeURIComponent(device.user_code)}`,
      sessionCookie,
    );
    assert.ok(csrf.csrfField);

    const resp = await fetch(`${asUrl}/device/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
        Cookie: `${sessionCookie}; ${csrf.csrfCookie}`,
      },
      body: new URLSearchParams({ user_code: device.user_code, _csrf: csrf.csrfField }).toString(),
      redirect: 'manual',
    });
    assert.equal(resp.status, 200);
    const cleared = await getOwnerDeviceAuthorizationByUserCode(device.user_code);
    assert.equal(cleared, null);
  });
});

// ── JSON callers remain compatible (no CSRF required for JSON) ──────────────
test('CSRF: JSON POST /consent/approve remains compatible without _csrf', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);
    const resp = await fetch(`${asUrl}/consent/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: sessionCookie,
      },
      body: JSON.stringify({ request_uri: requestUri }),
    });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.ok(body.token);
    assert.ok(body.grant_id);
  });
});

// ── signature defends against cookie injection / subdomain overwrite ────────
test('CSRF: signed double-submit rejects a forged cookie value paired with the same forged form field', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);
    // Attacker controls a sibling subdomain and can overwrite the
    // pdpp_owner_csrf cookie. Naive double-submit accepts any matching
    // pair; signed double-submit requires the pair to verify against the
    // server-side secret. We forge a cookie + field pair that match each
    // other but do not have a valid signature.
    const forged = 'forgednonce.forgedsignature';
    const resp = await fetch(`${asUrl}/consent/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
        Cookie: `${sessionCookie}; pdpp_owner_csrf=${forged}`,
      },
      body: new URLSearchParams({ request_uri: requestUri, _csrf: forged }).toString(),
      redirect: 'manual',
    });
    assert.equal(resp.status, 403, 'forged cookie+field pair SHALL be rejected even when they match');
  });
});

// ── runtime CSRF secret SHALL NOT be derived from the owner password ───────
// Pre-merge regression: the v2 spike derived the CSRF HMAC secret from
// PDPP_OWNER_PASSWORD. Because GET /owner/login is unauthenticated and
// returns one signed (nonce, sig) sample in the hidden field, any
// anonymous fetcher could brute-force a weak password offline. The
// runtime default now uses a random per-process secret; this test
// proves a token forged with a password-derived secret is NOT accepted.
test('CSRF: runtime SHALL NOT accept a token signed with deriveOwnerCsrfSecret(PDPP_OWNER_PASSWORD)', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);

    // Forge a CSRF token using the password-derived secret the prior
    // implementation exposed. This SHALL be rejected because the
    // runtime now signs tokens with a random per-process secret.
    const passwordDerivedSecret = deriveOwnerCsrfSecret(TEST_PASSWORD);
    const passwordDerivedToken = issueOwnerCsrfToken(passwordDerivedSecret);

    const resp = await fetch(`${asUrl}/consent/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
        Cookie: `${sessionCookie}; pdpp_owner_csrf=${passwordDerivedToken}`,
      },
      body: new URLSearchParams({
        request_uri: requestUri,
        _csrf: passwordDerivedToken,
      }).toString(),
      redirect: 'manual',
    });
    assert.equal(resp.status, 403, 'password-derived CSRF token SHALL be rejected by the running server');

    // And the CSRF token actually rendered into the consent page is
    // NOT the password-derived token — fetching /consent and checking
    // the embedded _csrf SHALL produce a different value.
    const csrf = await fetchCsrfFromForm(
      asUrl,
      `/consent?request_uri=${encodeURIComponent(requestUri)}`,
      sessionCookie,
    );
    assert.notEqual(
      csrf.csrfField,
      passwordDerivedToken,
      'rendered CSRF token SHALL NOT equal a token forged from the owner password',
    );
  });
});

// ── signed token from a different password's secret does not validate ───────
test('CSRF: a token signed with a different secret does not validate against the running server', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const { sessionCookie } = await login(asUrl, TEST_PASSWORD);
    const requestUri = await startPendingConsent(asUrl);
    const otherSecret = deriveOwnerCsrfSecret('completely-different-password');
    const otherToken = issueOwnerCsrfToken(otherSecret);
    const resp = await fetch(`${asUrl}/consent/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
        Cookie: `${sessionCookie}; pdpp_owner_csrf=${otherToken}`,
      },
      body: new URLSearchParams({ request_uri: requestUri, _csrf: otherToken }).toString(),
      redirect: 'manual',
    });
    assert.equal(resp.status, 403);
  });
});

// ── Set-Cookie array path: GET /owner/login returns BOTH session-absent and CSRF cookies cleanly through Fastify ─
test('CSRF: GET /owner/login through Fastify exposes a single CSRF Set-Cookie (no duplicate cookies)', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const resp = await fetch(`${asUrl}/owner/login`, {
      headers: { Accept: 'text/html' },
      redirect: 'manual',
    });
    assert.equal(resp.status, 200);
    const setCookies = getRawSetCookieList(resp);
    const csrfEntries = setCookies.filter((s) => s.startsWith('pdpp_owner_csrf='));
    assert.equal(csrfEntries.length, 1, 'exactly one CSRF Set-Cookie SHALL be issued by GET /owner/login');
    assert.ok(csrfEntries[0].includes('HttpOnly'));
    assert.ok(csrfEntries[0].includes('SameSite=Lax'));
  });
});

// ── SameSite=Strict opt-in toggles cookie attribute ─────────────────────────
test('CSRF: ownerAuthSameSite=strict produces SameSite=Strict on session and CSRF cookies', async () => {
  await withServer(
    { ownerAuthPassword: TEST_PASSWORD, ownerAuthSameSite: 'strict' },
    async ({ asUrl }) => {
      const result = await login(asUrl, TEST_PASSWORD);
      assert.equal(result.status, 302);
      const sessionEntry = result.setCookies.find((s) => s.startsWith('pdpp_owner_session='));
      assert.ok(sessionEntry?.includes('SameSite=Strict'), 'session cookie honors strict mode');
      const csrfEntries = result.setCookies.filter((s) => s.startsWith('pdpp_owner_csrf='));
      for (const entry of csrfEntries) {
        assert.ok(entry.includes('SameSite=Strict'), 'CSRF cookie honors strict mode');
      }
    },
  );
});

// ── Force-secure knob threads `Secure` even on plain HTTP ───────────────────
test('CSRF: ownerAuthForceSecureCookies=true marks session and CSRF cookies Secure on plain HTTP', async () => {
  await withServer(
    { ownerAuthPassword: TEST_PASSWORD, ownerAuthForceSecureCookies: true },
    async ({ asUrl }) => {
      const result = await login(asUrl, TEST_PASSWORD);
      const sessionEntry = result.setCookies.find((s) => s.startsWith('pdpp_owner_session='));
      assert.ok(sessionEntry?.includes('Secure'), 'session cookie SHALL be Secure under force-secure');
      const csrfEntries = result.setCookies.filter((s) => s.startsWith('pdpp_owner_csrf='));
      for (const entry of csrfEntries) {
        assert.ok(entry.includes('Secure'), 'CSRF cookie SHALL be Secure under force-secure');
      }
    },
  );
});

// ── Regression: owner-auth disabled + form-encoded POST /owner/logout ──────
// The prior contract for the placeholder gate is that, with no
// PDPP_OWNER_PASSWORD set, owner-auth is a no-op and hosted routes stay
// open. A form-encoded logout POST in that mode SHALL NOT 403 just
// because there is no CSRF token to verify.
test('CSRF: owner-auth disabled — form-encoded POST /owner/logout does not 403 (no-op)', async () => {
  await withServer({}, async ({ asUrl }) => {
    // text/html caller: prior behavior is a redirect to /owner/login.
    const htmlResp = await fetch(`${asUrl}/owner/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'text/html',
      },
      body: '',
      redirect: 'manual',
    });
    assert.notEqual(htmlResp.status, 403, 'form-encoded logout SHALL NOT 403 when owner-auth is disabled');
    assert.equal(htmlResp.status, 302, 'HTML caller SHALL be redirected to /owner/login');
    assert.equal(htmlResp.headers.get('location'), '/owner/login');

    // JSON caller: prior behavior is a 204.
    const jsonResp = await fetch(`${asUrl}/owner/logout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: '',
      redirect: 'manual',
    });
    assert.notEqual(jsonResp.status, 403);
    assert.equal(jsonResp.status, 204, 'JSON caller SHALL receive 204 even with form content-type when owner-auth is disabled');
  });
});

// ── Default local HTTP development still works (no Secure required) ─────────
test('CSRF: default local HTTP development does not require Secure on cookies', async () => {
  await withServer({ ownerAuthPassword: TEST_PASSWORD }, async ({ asUrl }) => {
    const result = await login(asUrl, TEST_PASSWORD);
    assert.equal(result.status, 302, 'login SHALL succeed over plain HTTP without force-secure');
    const sessionEntry = result.setCookies.find((s) => s.startsWith('pdpp_owner_session='));
    assert.ok(!sessionEntry?.includes('Secure'), 'session cookie omits Secure on plain HTTP by default');
  });
});
