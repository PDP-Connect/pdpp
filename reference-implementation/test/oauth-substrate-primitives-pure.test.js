// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the OAuth/PKCE crypto primitives in
// server/oauth-substrate/primitives.ts. No test imports this module by name; all
// six exports were unpinned.
//
// RED note: this is auth-substrate crypto. The tests only OBSERVE the deterministic
// hashing / token shapes; no security state is mutated.
//
// Mutation surface:
//   base64UrlSha256 -- the PKCE S256 challenge derivation. Pinned against the
//     RFC 7636 Appendix B official test vector (verifier -> challenge), so any
//     change to the hash algorithm/encoding is caught by an exact-equality check.
//   hashOAuthRefreshToken -- sha256 base64url of the refresh token (deterministic).
//   generateToken / generateOAuthRefreshToken -- opaque secret SHAPES (length,
//     prefix, charset) — these are random so only structural properties are pinned.
//   PKCE_CODE_VERIFIER_RE -- RFC 7636 verifier shape: 43..128 unreserved chars.
//   SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS -- S256 only.

import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PKCE_CODE_VERIFIER_RE,
  SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS,
  base64UrlSha256,
  generateOAuthRefreshToken,
  generateToken,
  hashOAuthRefreshToken,
} from '../server/oauth-substrate/primitives.ts';

// ---------------------------------------------------------------------------
// base64UrlSha256 — the PKCE S256 challenge (RFC 7636 Appendix B vector)
// ---------------------------------------------------------------------------

test('base64UrlSha256: matches the RFC 7636 Appendix B PKCE test vector', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  assert.equal(base64UrlSha256(verifier), expectedChallenge, 'S256 challenge derivation must match RFC 7636');
});

test('base64UrlSha256: is base64url (no +, /, or = padding) and deterministic', () => {
  const out = base64UrlSha256('hello');
  assert.equal(out, base64UrlSha256('hello'), 'deterministic');
  assert.ok(!/[+/=]/.test(out), 'base64url encoding has no +, /, or padding');
  // Cross-check against an independently computed digest.
  assert.equal(out, createHash('sha256').update('hello').digest('base64url'));
});

test('base64UrlSha256: distinct inputs produce distinct digests', () => {
  assert.notEqual(base64UrlSha256('a'), base64UrlSha256('b'));
});

// ---------------------------------------------------------------------------
// hashOAuthRefreshToken
// ---------------------------------------------------------------------------

test('hashOAuthRefreshToken: sha256-base64url of the token, deterministic', () => {
  const token = 'rt_example_secret_value';
  const expected = createHash('sha256').update(token).digest('base64url');
  assert.equal(hashOAuthRefreshToken(token), expected);
  assert.equal(hashOAuthRefreshToken(token), hashOAuthRefreshToken(token), 'stable');
});

test('hashOAuthRefreshToken: the empty-string digest is the known sha256("") base64url', () => {
  assert.equal(hashOAuthRefreshToken(''), '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
});

// ---------------------------------------------------------------------------
// generateToken / generateOAuthRefreshToken — opaque secret shapes
// ---------------------------------------------------------------------------

test('generateToken: 64 lowercase hex chars (32 random bytes) and non-repeating', () => {
  const t = generateToken();
  assert.match(t, /^[0-9a-f]{64}$/, '32 bytes -> 64 hex chars');
  assert.notEqual(generateToken(), generateToken(), 'two calls differ (random)');
});

test('generateOAuthRefreshToken: rt_ prefix + base64url body', () => {
  const rt = generateOAuthRefreshToken();
  assert.ok(rt.startsWith('rt_'), 'rt_ prefix');
  const body = rt.slice(3);
  assert.ok(body.length > 0);
  assert.ok(!/[+/=]/.test(body), 'body is base64url (no +, /, padding)');
  assert.notEqual(generateOAuthRefreshToken(), generateOAuthRefreshToken(), 'random');
});

// ---------------------------------------------------------------------------
// PKCE_CODE_VERIFIER_RE (RFC 7636 verifier shape)
// ---------------------------------------------------------------------------

test('PKCE_CODE_VERIFIER_RE: accepts 43..128 unreserved chars, rejects out-of-range lengths', () => {
  assert.ok(PKCE_CODE_VERIFIER_RE.test('a'.repeat(43)), 'min length 43 accepted');
  assert.ok(PKCE_CODE_VERIFIER_RE.test('a'.repeat(128)), 'max length 128 accepted');
  assert.ok(!PKCE_CODE_VERIFIER_RE.test('a'.repeat(42)), 'below 43 rejected');
  assert.ok(!PKCE_CODE_VERIFIER_RE.test('a'.repeat(129)), 'above 128 rejected');
});

test('PKCE_CODE_VERIFIER_RE: accepts the unreserved set, rejects disallowed characters', () => {
  assert.ok(PKCE_CODE_VERIFIER_RE.test(`${'A'.repeat(40)}._~-`), 'A-Z . _ ~ - are all allowed');
  assert.ok(!PKCE_CODE_VERIFIER_RE.test(`${'a'.repeat(42)}/`), 'slash is not in the unreserved set');
  assert.ok(!PKCE_CODE_VERIFIER_RE.test(`${'a'.repeat(42)}+`), 'plus is not allowed');
  assert.ok(!PKCE_CODE_VERIFIER_RE.test(`${'a'.repeat(42)} `), 'space is not allowed');
});

// ---------------------------------------------------------------------------
// SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS
// ---------------------------------------------------------------------------

test('SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS: S256 only (plain is NOT supported)', () => {
  assert.ok(SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS.has('S256'));
  assert.ok(!SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS.has('plain'), 'plain method must not be accepted');
  assert.equal(SUPPORTED_AUTHORIZATION_CODE_CHALLENGE_METHODS.size, 1, 'exactly one supported method');
});
