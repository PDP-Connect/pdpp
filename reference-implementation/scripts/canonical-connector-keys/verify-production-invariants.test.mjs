import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalConnectorKey } from '../../server/connector-key.js';
import { isNonCanonicalConnectorId } from './verify-production-invariants.mjs';

// These tests pin the pure straggler-detection predicate the data-agnostic
// production verifier uses. No database required.

test('URL-shaped first-party id is non-canonical (must be rewritten)', () => {
  assert.equal(isNonCanonicalConnectorId('https://registry.pdpp.org/connectors/gmail'), true);
});

test('legacy snake_case alias is non-canonical', () => {
  // claude_code is a known legacy alias for claude-code.
  assert.equal(canonicalConnectorKey('claude_code'), 'claude-code');
  assert.equal(isNonCanonicalConnectorId('claude_code'), true);
});

test('local-device wrapped storage form is non-canonical', () => {
  assert.equal(isNonCanonicalConnectorId('local-device:codex:cin_abc'), true);
  assert.equal(isNonCanonicalConnectorId('local-device:codex'), true);
});

test('bare canonical first-party key is canonical (no rewrite)', () => {
  for (const key of ['gmail', 'codex', 'spotify', 'claude-code']) {
    assert.equal(canonicalConnectorKey(key), key, `${key} should canonicalize to itself`);
    assert.equal(isNonCanonicalConnectorId(key), false, `${key} should be treated as canonical`);
  }
});

test('valid CUSTOM connector key (outside first-party allowlist) is NOT a straggler', () => {
  // A correct migration leaves custom-manifest keys untouched; the verifier
  // must not falsely flag a custom-connector deployment. canonicalConnectorKey
  // returns null for these (not first-party), but they are valid keys.
  for (const key of ['my_org_crm', 'acme-source', 'internal.tool']) {
    assert.equal(canonicalConnectorKey(key), null, `${key} is not first-party`);
    assert.equal(isNonCanonicalConnectorId(key), false, `${key} should be accepted as a custom key`);
  }
});

test('malformed / non-registry-URL value is a straggler (fail closed)', () => {
  // A document URL is not a valid connector key and is not a known shape.
  assert.equal(isNonCanonicalConnectorId('https://example.com/unknown'), true);
  // A value with whitespace is not a valid key.
  assert.equal(isNonCanonicalConnectorId('has space'), true);
  // A bare URL-registry slug that is unknown is still URL-shaped => straggler.
  assert.equal(isNonCanonicalConnectorId('https://registry.pdpp.org/connectors/unknownslug'), true);
});

test('empty / null / non-string values are ignored (not stragglers)', () => {
  assert.equal(isNonCanonicalConnectorId(''), false);
  assert.equal(isNonCanonicalConnectorId(null), false);
  assert.equal(isNonCanonicalConnectorId(undefined), false);
  assert.equal(isNonCanonicalConnectorId(123), false);
});
