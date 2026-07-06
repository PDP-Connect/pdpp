/**
 * Unit coverage for two UNTESTED pure substrate surfaces:
 *
 *   1. OAuth/PKCE crypto primitives in `server/oauth-substrate/primitives.ts`:
 *        - base64UrlSha256 / hashOAuthRefreshToken: deterministic SHA-256 →
 *          base64url (no padding, url-safe alphabet); both are the same
 *          transform (refresh-token-at-rest hashing == generic SHA-256).
 *        - generateToken: 64-hex-char opaque bearer (32 random bytes); distinct
 *          across calls.
 *        - generateOAuthRefreshToken: `rt_` + base64url(32 random bytes).
 *        - SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS: exactly {S256}.
 *        - PKCE_CODE_VERIFIER_RE: RFC 7636 verifier shape (43..128 of the
 *          unreserved set); rejects too-short/too-long/illegal-char.
 *
 *   2. The truthfulness GATE of `buildHybridRetrievalCapability`
 *      (`server/metadata.ts`): hybrid only composes when BOTH lexical and
 *      semantic are available; returns null otherwise, and `{supported:false}`
 *      when explicitly unsupported. (`search-count-capability.test.js` covers
 *      only the cursor/count advertisement, not this gate.)
 *
 * These observe crypto/auth SUBSTRATE shapes; they do not exercise or alter any
 * grant/consent decision. Pure — only `node:crypto` is imported. No DB/server.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';

import {
  generateToken,
  generateOAuthRefreshToken,
  hashOAuthRefreshToken,
  base64UrlSha256,
  SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS,
  PKCE_CODE_VERIFIER_RE,
} from '../server/oauth-substrate/primitives.ts';
import { buildHybridRetrievalCapability } from '../server/metadata.ts';

// --- base64UrlSha256 --------------------------------------------------------

test('base64UrlSha256: deterministic SHA-256 base64url, url-safe and unpadded', () => {
  // Known vector: SHA-256("hello") in base64url.
  assert.equal(base64UrlSha256('hello'), 'LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ');
  // Matches node's own digest for an arbitrary input.
  assert.equal(base64UrlSha256('pkce-verifier-xyz'), createHash('sha256').update('pkce-verifier-xyz').digest('base64url'));
  // base64url alphabet only (no +, /, or = padding).
  assert.equal(/[+/=]/.test(base64UrlSha256('hello')), false, 'must be base64url, not standard base64');
});

test('base64UrlSha256: distinct inputs produce distinct digests', () => {
  assert.notEqual(base64UrlSha256('a'), base64UrlSha256('b'));
});

// --- hashOAuthRefreshToken --------------------------------------------------

test('hashOAuthRefreshToken: SHA-256 base64url of the token, equal to base64UrlSha256', () => {
  assert.equal(hashOAuthRefreshToken('rt_secret'), createHash('sha256').update('rt_secret').digest('base64url'));
  // The at-rest hash IS the generic SHA-256 transform.
  assert.equal(hashOAuthRefreshToken('same-input'), base64UrlSha256('same-input'));
});

test('hashOAuthRefreshToken: coerces non-string input via String() rather than throwing', () => {
  // The impl wraps in String(); a number hashes as its decimal string.
  assert.equal(hashOAuthRefreshToken(12345), createHash('sha256').update('12345').digest('base64url'));
});

// --- generateToken ----------------------------------------------------------

test('generateToken: 64-char lowercase hex (32 random bytes), distinct across calls', () => {
  const token = generateToken();
  assert.match(token, /^[0-9a-f]{64}$/, `token: ${token}`);
  assert.notEqual(generateToken(), generateToken(), 'two generated tokens must differ');
});

// --- generateOAuthRefreshToken ----------------------------------------------

test('generateOAuthRefreshToken: rt_ prefix + base64url body, distinct across calls', () => {
  const rt = generateOAuthRefreshToken();
  assert.equal(rt.startsWith('rt_'), true, `must carry rt_ prefix: ${rt}`);
  assert.match(rt, /^rt_[A-Za-z0-9_-]+$/, `body must be base64url: ${rt}`);
  assert.equal(/[+/=]/.test(rt.slice(3)), false, 'body must not contain +, /, or = padding');
  assert.notEqual(generateOAuthRefreshToken(), generateOAuthRefreshToken(), 'two refresh tokens must differ');
});

// --- SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS -------------------------

test('SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS: exactly {S256}', () => {
  assert.equal(SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS.has('S256'), true, 'S256 supported');
  assert.equal(SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS.has('plain'), false, 'plain not supported');
  assert.equal(SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS.size, 1, 'only one method');
});

// --- PKCE_CODE_VERIFIER_RE ---------------------------------------------------

test('PKCE_CODE_VERIFIER_RE: accepts 43..128 unreserved chars, rejects out-of-range and illegal chars', () => {
  assert.equal(PKCE_CODE_VERIFIER_RE.test('a'.repeat(43)), true, '43 chars is the minimum');
  assert.equal(PKCE_CODE_VERIFIER_RE.test('a'.repeat(128)), true, '128 chars is the maximum');
  assert.equal(PKCE_CODE_VERIFIER_RE.test('a'.repeat(42)), false, '42 chars is too short');
  assert.equal(PKCE_CODE_VERIFIER_RE.test('a'.repeat(129)), false, '129 chars is too long');
  // Unreserved set is A-Za-z0-9 . _ ~ -
  assert.equal(PKCE_CODE_VERIFIER_RE.test(`Aa0._~-${'x'.repeat(40)}`), true, 'unreserved chars allowed');
  assert.equal(PKCE_CODE_VERIFIER_RE.test(`${'a'.repeat(43)} `), false, 'space is illegal');
  assert.equal(PKCE_CODE_VERIFIER_RE.test(`${'a'.repeat(43)}+`), false, 'plus is illegal');
});

// --- buildHybridRetrievalCapability: both-available truthfulness gate -------

test('buildHybridRetrievalCapability: composes only when BOTH lexical and semantic are available', () => {
  const both = buildHybridRetrievalCapability({});
  assert.equal(both.supported, true, 'defaults have both available => supported');
  assert.deepEqual(both.sources, ['lexical', 'semantic'], 'advertises both sources');
});

test('buildHybridRetrievalCapability: returns null when either underlying surface is unavailable', () => {
  assert.equal(buildHybridRetrievalCapability({ semanticAvailable: false }), null, 'no semantic => null');
  assert.equal(buildHybridRetrievalCapability({ lexicalAvailable: false }), null, 'no lexical => null');
});

test('buildHybridRetrievalCapability: explicit unsupported returns {supported:false}, not null', () => {
  assert.deepEqual(
    buildHybridRetrievalCapability({ supported: false }),
    { supported: false },
    'explicit non-support is a distinct signal from the both-available gate',
  );
});
