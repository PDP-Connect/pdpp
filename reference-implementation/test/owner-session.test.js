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
