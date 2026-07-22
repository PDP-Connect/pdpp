// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the UNTESTED owner-CSRF substrate helpers in
 * `server/owner-csrf.ts`. These issue/verify the double-submit CSRF token and
 * shape its cookie + hidden form field. This test OBSERVES the CSRF substrate;
 * it does not change any auth behavior.
 *
 * Contracts pinned:
 *   - deriveOwnerCsrfSecretFromString: deterministic SHA-256 of a namespaced
 *     input (same input => same secret).
 *   - issueOwnerCsrfToken / verifyOwnerCsrfToken: a `<nonce>.<sig>` token that
 *     verifies against its secret; verification fails for the wrong secret, a
 *     tampered signature, a missing dot, an empty nonce/sig, or a non-string.
 *   - buildOwnerCsrfSetCookie: `<name>=<token>; HttpOnly; SameSite=Lax|Strict;
 *     Path=/[; Secure][; Max-Age=<n>]`.
 *   - buildOwnerCsrfClearCookie: empty value, Max-Age=0.
 *   - readCsrfTokenFromCookieHeader: extracts the token from a Cookie header;
 *     null when absent or the header is null.
 *   - renderCsrfHiddenField: a hidden input whose value strips characters
 *     outside `[A-Za-z0-9_\-=.]` (so it cannot break out of the attribute).
 *
 * Deterministic (crypto) substrate. No DB, no server, no fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  issueOwnerCsrfToken,
  verifyOwnerCsrfToken,
  deriveOwnerCsrfSecretFromString,
  buildOwnerCsrfSetCookie,
  buildOwnerCsrfClearCookie,
  readCsrfTokenFromCookieHeader,
  renderCsrfHiddenField,
  OWNER_CSRF_COOKIE_NAME,
  OWNER_CSRF_FIELD_NAME,
} from '../server/owner-csrf.ts';

const secretA = deriveOwnerCsrfSecretFromString('seed-A');
const secretB = deriveOwnerCsrfSecretFromString('seed-B');

// --- deriveOwnerCsrfSecretFromString ----------------------------------------

test('deriveOwnerCsrfSecretFromString: is deterministic and 32 bytes (SHA-256)', () => {
  const a = deriveOwnerCsrfSecretFromString('input-x');
  const b = deriveOwnerCsrfSecretFromString('input-x');
  assert.equal(Buffer.compare(a, b), 0, 'same input => identical secret');
  assert.equal(a.length, 32, 'sha256 digest is 32 bytes');
  assert.notEqual(Buffer.compare(a, deriveOwnerCsrfSecretFromString('input-y')), 0, 'different input differs');
});

// --- issue / verify round-trip ----------------------------------------------

test('issueOwnerCsrfToken/verifyOwnerCsrfToken: a freshly issued token verifies against its secret', () => {
  const token = issueOwnerCsrfToken(secretA);
  assert.ok(token.includes('.'), `token must be <nonce>.<sig>: ${token}`);
  assert.equal(verifyOwnerCsrfToken(token, secretA), true, 'valid token verifies');
});

test('verifyOwnerCsrfToken: rejects the wrong secret', () => {
  const token = issueOwnerCsrfToken(secretA);
  assert.equal(verifyOwnerCsrfToken(token, secretB), false, 'a token minted with secretA must not verify under secretB');
});

test('verifyOwnerCsrfToken: rejects a tampered signature', () => {
  const token = issueOwnerCsrfToken(secretA);
  const lastChar = token.slice(-1);
  const flipped = token.slice(0, -1) + (lastChar === 'A' ? 'B' : 'A');
  assert.equal(verifyOwnerCsrfToken(flipped, secretA), false, 'a flipped last char breaks the signature');
});

test('verifyOwnerCsrfToken: rejects malformed tokens', () => {
  assert.equal(verifyOwnerCsrfToken('no-dot-here', secretA), false, 'missing dot');
  assert.equal(verifyOwnerCsrfToken('.sigonly', secretA), false, 'empty nonce');
  assert.equal(verifyOwnerCsrfToken('nonceonly.', secretA), false, 'empty signature');
  assert.equal(verifyOwnerCsrfToken(null, secretA), false, 'null');
  assert.equal(verifyOwnerCsrfToken(undefined, secretA), false, 'undefined');
});

// --- buildOwnerCsrfSetCookie ------------------------------------------------

test('buildOwnerCsrfSetCookie: default attributes (HttpOnly, SameSite=Lax, Path, Max-Age)', () => {
  const cookie = buildOwnerCsrfSetCookie('TOK');
  assert.ok(cookie.startsWith(`${OWNER_CSRF_COOKIE_NAME}=TOK`), `name=value first: ${cookie}`);
  assert.ok(cookie.includes('HttpOnly'), 'HttpOnly');
  assert.ok(cookie.includes('SameSite=Lax'), 'default SameSite=Lax');
  assert.ok(cookie.includes('Path=/'), 'Path=/');
  assert.ok(/Max-Age=\d+/.test(cookie), 'a numeric Max-Age');
  assert.equal(cookie.includes('Secure'), false, 'not Secure by default');
});

test('buildOwnerCsrfSetCookie: secure + strict + explicit max-age', () => {
  const cookie = buildOwnerCsrfSetCookie('TOK', { secure: true, sameSite: 'strict', maxAgeSeconds: 3600 });
  assert.ok(cookie.includes('SameSite=Strict'), 'SameSite=Strict');
  assert.ok(cookie.includes('Secure'), 'Secure present');
  assert.ok(cookie.includes('Max-Age=3600'), 'explicit Max-Age');
});

test('buildOwnerCsrfClearCookie: empty value with Max-Age=0', () => {
  const cookie = buildOwnerCsrfClearCookie();
  assert.ok(cookie.startsWith(`${OWNER_CSRF_COOKIE_NAME}=;`), `cleared value: ${cookie}`);
  assert.ok(cookie.includes('Max-Age=0'), 'Max-Age=0 expires the cookie');
});

// --- readCsrfTokenFromCookieHeader ------------------------------------------

test('readCsrfTokenFromCookieHeader: extracts the token from a Cookie header', () => {
  assert.equal(
    readCsrfTokenFromCookieHeader(`${OWNER_CSRF_COOKIE_NAME}=abc123; other=x`),
    'abc123',
    'reads the csrf cookie value among others',
  );
});

test('readCsrfTokenFromCookieHeader: null when the cookie is absent or the header is null', () => {
  assert.equal(readCsrfTokenFromCookieHeader('other=x'), null, 'no csrf cookie');
  assert.equal(readCsrfTokenFromCookieHeader(null), null, 'null header');
  assert.equal(readCsrfTokenFromCookieHeader(undefined), null, 'undefined header');
});

// --- renderCsrfHiddenField --------------------------------------------------

test('renderCsrfHiddenField: renders a hidden input carrying the csrf field name', () => {
  const html = renderCsrfHiddenField('tok.en-123');
  assert.equal(html, `<input type="hidden" name="${OWNER_CSRF_FIELD_NAME}" value="tok.en-123" />`);
});

test('renderCsrfHiddenField: strips characters outside the token alphabet (attribute-injection safe)', () => {
  const html = renderCsrfHiddenField('abc"><script>alert(1)</script>');
  assert.equal(html.includes('<script>'), false, 'no raw < in the value');
  assert.equal(html.includes('"'), true, 'the attribute delimiters are the only quotes');
  // Only [A-Za-z0-9_\-=.] survive from the token; the injected markup is stripped.
  assert.equal(html, `<input type="hidden" name="${OWNER_CSRF_FIELD_NAME}" value="abcscriptalert1script" />`);
});
