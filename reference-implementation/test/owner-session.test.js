import crypto from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildOwnerSessionClearCookie,
  buildOwnerSessionSetCookie,
  createOwnerSessionController,
  decodeOwnerSession,
  deriveOwnerSessionSecret,
  encodeOwnerSession,
  OWNER_SESSION_COOKIE_NAME,
  OWNER_SESSION_DEFAULT_TTL_SECONDS,
  parseCookieHeader,
  readOwnerSessionFromCookieHeader,
} from '../server/owner-session.ts';

test('owner-session default lifetime balances dashboard persistence with finite expiry', () => {
  assert.equal(OWNER_SESSION_DEFAULT_TTL_SECONDS, 7 * 24 * 60 * 60);
});

test('owner-session primitives round-trip signed sessions through cookie headers', () => {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const secret = deriveOwnerSessionSecret('placeholder-test-password');
  const payload = {
    sub: 'owner_local',
    iat: nowSeconds - 10,
    exp: nowSeconds + 1000,
  };
  const token = encodeOwnerSession(payload, secret);
  const cookieHeader = `${OWNER_SESSION_COOKIE_NAME}=${encodeURIComponent(token)}; theme=light`;

  assert.deepEqual(parseCookieHeader(cookieHeader), {
    [OWNER_SESSION_COOKIE_NAME]: token,
    theme: 'light',
  });
  assert.deepEqual(readOwnerSessionFromCookieHeader(cookieHeader, secret), payload);
  assert.equal(
    decodeOwnerSession(token, secret, { nowSeconds: nowSeconds + 1000 }),
    null,
    'expired tokens are rejected',
  );

  const setCookie = buildOwnerSessionSetCookie(token, {
    maxAgeSeconds: OWNER_SESSION_DEFAULT_TTL_SECONDS,
    secure: true,
  });
  assert.ok(setCookie.startsWith(`${OWNER_SESSION_COOKIE_NAME}=`));
  assert.ok(setCookie.includes('HttpOnly'));
  assert.ok(setCookie.includes('SameSite=Lax'));
  assert.ok(setCookie.includes('Path=/'));
  assert.ok(setCookie.includes('Secure'));
  assert.ok(setCookie.includes(`Max-Age=${OWNER_SESSION_DEFAULT_TTL_SECONDS}`));

  const clearCookie = buildOwnerSessionClearCookie({ secure: true });
  assert.ok(clearCookie.startsWith(`${OWNER_SESSION_COOKIE_NAME}=`));
  assert.ok(clearCookie.includes('Secure'));
  assert.ok(clearCookie.includes('Max-Age=0'));
});

test('owner-session controller preserves the current owner-auth session semantics', () => {
  const controller = createOwnerSessionController({
    password: 'placeholder-test-password',
    subjectId: 'owner_testing_custom',
  });

  assert.equal(controller.enabled, true);
  assert.equal(controller.subjectId, 'owner_testing_custom');

  const setCookie = controller.issueSessionCookieHeader({ secure: true });
  assert.ok(setCookie?.includes('HttpOnly'));

  const sessionCookie = setCookie?.split(';')[0] ?? '';
  assert.ok(sessionCookie.startsWith(`${OWNER_SESSION_COOKIE_NAME}=`));

  const session = controller.readSessionFromCookieHeader(sessionCookie);
  assert.equal(session?.sub, 'owner_testing_custom');
  assert.equal(typeof session?.iat, 'number');
  assert.equal(typeof session?.exp, 'number');

  const cleared = controller.clearSessionCookieHeader({ secure: true });
  assert.ok(cleared.includes('Max-Age=0'));
});

test('deriveOwnerSessionSecret uses scrypt KDF (not fast SHA-256)', () => {
  // Verify the returned buffer is 32 bytes — scrypt output length.
  const secret = deriveOwnerSessionSecret('some-test-password');
  assert.equal(secret.length, 32, 'derived secret must be 32 bytes (scrypt output)');

  // Verify that the same password always yields the same key (deterministic).
  const secret2 = deriveOwnerSessionSecret('some-test-password');
  assert.deepEqual(secret, secret2, 'same password must yield same secret');

  // Verify that a different password yields a different key.
  const other = deriveOwnerSessionSecret('different-password');
  assert.notDeepEqual(secret, other, 'different password must yield different secret');

  // Verify the output is NOT the raw SHA-256 of the old derivation, so we
  // can be certain we are not running the old fast path.
  const oldDerivation = crypto.createHash('sha256').update('pdpp-owner-session:some-test-password').digest();
  assert.notDeepEqual(secret, oldDerivation, 'new derivation must differ from single-round SHA-256');
});

test('deriveOwnerSessionSecret wrong password produces different secret (sign/verify fails)', () => {
  const secretCorrect = deriveOwnerSessionSecret('correct-password');
  const secretWrong = deriveOwnerSessionSecret('wrong-password');

  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = { sub: 'owner_local', iat: nowSeconds - 5, exp: nowSeconds + 3600 };
  const token = encodeOwnerSession(payload, secretCorrect);

  // Token signed with correct secret must verify.
  assert.deepEqual(decodeOwnerSession(token, secretCorrect), payload);
  // Same token presented with a wrong secret must be rejected.
  assert.equal(decodeOwnerSession(token, secretWrong), null, 'wrong password must fail verification');
});

test('owner-session package export is available via the workspace package name', async () => {
  const ownerSession = await import('pdpp-reference-implementation/owner-session');

  assert.equal(ownerSession.OWNER_SESSION_COOKIE_NAME, OWNER_SESSION_COOKIE_NAME);
  assert.equal(typeof ownerSession.encodeOwnerSession, 'function');
  assert.equal(typeof ownerSession.createOwnerSessionController, 'function');
});

// ---------------------------------------------------------------------------
// Two-sided owner-session contract.
//
// The owner session cookie is HMAC-signed with a key derived from
// PDPP_OWNER_PASSWORD via deriveOwnerSessionSecret(). It is *minted* on one
// import surface (the AS, reference-implementation/server/owner-auth.ts, which
// imports the controller from '../server/owner-session.ts') and independently
// *validated* on another (the Next.js console,
// apps/console/src/app/dashboard/lib/owner-token.ts, which imports the same
// controller through the package-export specifier
// 'pdpp-reference-implementation/owner-session').
//
// These two surfaces resolve to the same source module today (package.json
// "exports": "./owner-session" -> "./server/owner-session.ts"), so the derived
// key is byte-identical and an AS-minted cookie validates console-side. If a
// future change ever updates the key derivation on only one surface — e.g. the
// scrypt KDF hardening (commit 54f5ddc3) landing in the AS bundle but a stale
// console bundle still computing the old SHA-256 key — every dashboard read
// would redirect a freshly-authenticated owner to /owner/login. These tests
// pin that contract so the divergence fails CI instead of production.
// ---------------------------------------------------------------------------

test('two-sided contract: AS-minted owner cookie validates through the console package-export surface', async () => {
  const password = 'two-sided-contract-password';

  // Mint exactly as the AS does: build a controller from the internal
  // server module and issue a session Set-Cookie header.
  const asController = createOwnerSessionController({ password, subjectId: 'owner_local' });
  const setCookie = asController.issueSessionCookieHeader();
  assert.ok(setCookie, 'AS controller must issue a session cookie when enabled');
  // Extract the bare cookie value (cookie-name=value) from the Set-Cookie header.
  const cookieValue = setCookie.split(';', 1)[0].slice(`${OWNER_SESSION_COOKIE_NAME}=`.length);
  assert.ok(cookieValue.length > 0, 'minted cookie must carry a non-empty value');

  // Validate exactly as the console does: resolve the controller through the
  // package-export specifier (the import surface used by owner-token.ts) and
  // read the session from the cookie value (mirrors readDashboardOwnerSession).
  const { createOwnerSessionController: createConsoleController } = await import(
    'pdpp-reference-implementation/owner-session'
  );
  const consoleController = createConsoleController({ password, subjectId: 'owner_local' });
  const session = consoleController.readSessionFromCookieValue(cookieValue);

  assert.notEqual(session, null, 'console surface must accept the AS-minted cookie (two-sided KDF agreement)');
  assert.equal(session?.sub, 'owner_local');
});

test('two-sided contract: derived signing key is byte-identical across the AS and console import surfaces', async () => {
  const password = 'byte-equality-contract-password';

  // Server-internal surface (used by owner-auth.ts via '../server/owner-session.ts').
  const asKey = deriveOwnerSessionSecret(password);
  // Package-export surface (used by the console via 'pdpp-reference-implementation/owner-session').
  const { deriveOwnerSessionSecret: deriveConsoleKey } = await import(
    'pdpp-reference-implementation/owner-session'
  );
  const consoleKey = deriveConsoleKey(password);

  assert.deepEqual(
    asKey,
    consoleKey,
    'the HMAC signing key must be byte-identical on both surfaces or cookies fail to cross-validate',
  );
});

test('two-sided contract: a console controller with the wrong password rejects an AS-minted cookie', async () => {
  const asController = createOwnerSessionController({ password: 'correct-owner-password', subjectId: 'owner_local' });
  const setCookie = asController.issueSessionCookieHeader();
  assert.ok(setCookie);
  const cookieValue = setCookie.split(';', 1)[0].slice(`${OWNER_SESSION_COOKIE_NAME}=`.length);

  const { createOwnerSessionController: createConsoleController } = await import(
    'pdpp-reference-implementation/owner-session'
  );
  // A console process configured with a different PDPP_OWNER_PASSWORD derives a
  // different key and must reject the cookie — the negative half of the contract
  // that proves validation is actually keyed on the shared secret.
  const wrongController = createConsoleController({ password: 'a-different-password', subjectId: 'owner_local' });
  assert.equal(
    wrongController.readSessionFromCookieValue(cookieValue),
    null,
    'a wrong-password console controller must reject the AS-minted cookie',
  );
});
