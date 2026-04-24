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

test('owner-session package export is available via the workspace package name', async () => {
  const ownerSession = await import('pdpp-reference-implementation/owner-session');

  assert.equal(ownerSession.OWNER_SESSION_COOKIE_NAME, OWNER_SESSION_COOKIE_NAME);
  assert.equal(typeof ownerSession.encodeOwnerSession, 'function');
  assert.equal(typeof ownerSession.createOwnerSessionController, 'function');
});
