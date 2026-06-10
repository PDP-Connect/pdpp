/**
 * Deterministic unit coverage for verify-http-surfaces.mjs — the §3.4 LIVE
 * HTTP read-surface verifier. These tests exercise the pure helpers and the
 * seed-coverage contract WITHOUT a database or a booted server, so they run in
 * the normal unit suite. The full restore→migrate→HTTP integration is proven
 * by run-backup-restore-validation.sh against the running Postgres container.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  containsUrlShapedConnectorId,
  parseArgs,
  SEED_EXPECTATIONS,
} from './verify-http-surfaces.mjs';

test('containsUrlShapedConnectorId flags registry URLs anywhere in the payload', () => {
  assert.equal(
    containsUrlShapedConnectorId({ connector_id: 'https://registry.pdpp.org/connectors/gmail' }),
    true,
  );
  // nested
  assert.equal(
    containsUrlShapedConnectorId({ data: [{ source: { id: 'https://x/y' } }] }),
    true,
  );
});

test('containsUrlShapedConnectorId passes clean canonical-key payloads', () => {
  assert.equal(containsUrlShapedConnectorId({ connector_id: 'gmail', connector_key: 'gmail' }), false);
  assert.equal(containsUrlShapedConnectorId({ data: [{ connector_key: 'claude-code' }] }), false);
  assert.equal(containsUrlShapedConnectorId(null), false);
  assert.equal(containsUrlShapedConnectorId(undefined), false);
});

test('containsUrlShapedConnectorId catches scheme-shaped values other than https', () => {
  // The check is deliberately scheme-agnostic ('://') so it also catches a
  // local-device-style or custom-scheme leak, not just https registry URLs.
  assert.equal(containsUrlShapedConnectorId({ id: 'ftp://host/x' }), true);
});

test('parseArgs defaults the owner subject to the seed owner', () => {
  assert.deepEqual(parseArgs(['node', 'verify-http-surfaces.mjs']), { ownerSubject: 'owner_sub_1' });
});

test('parseArgs honors an explicit --owner-subject', () => {
  assert.deepEqual(
    parseArgs(['node', 'verify-http-surfaces.mjs', '--owner-subject', 'owner_xyz']),
    { ownerSubject: 'owner_xyz' },
  );
});

test('seed expectations cover the canonical keys the migration produces', () => {
  const keys = SEED_EXPECTATIONS.map((e) => e.key).sort();
  // gmail (URL-shaped → gmail), codex (wrapped local-device → codex), and
  // spotify (already-canonical, must NOT be rewritten) are the read-asserted
  // canonical keys. claude-code is exercised at the connection/grant layer.
  assert.deepEqual(keys, ['codex', 'gmail', 'spotify']);
});

test('exactly one seed expectation carries a stale URL alias (Decision 8 coverage)', () => {
  const withAlias = SEED_EXPECTATIONS.filter((e) => typeof e.urlAlias === 'string' && e.urlAlias.includes('://'));
  assert.equal(withAlias.length, 1, 'one connector must be read back via its stale URL-shaped id');
  assert.equal(withAlias[0].key, 'gmail');
  assert.equal(withAlias[0].urlAlias, 'https://registry.pdpp.org/connectors/gmail');
});

test('every seed expectation names a stream and a positive expected count', () => {
  for (const e of SEED_EXPECTATIONS) {
    assert.equal(typeof e.stream, 'string');
    assert.ok(e.stream.length > 0, `stream for ${e.key} must be non-empty`);
    assert.ok(Number.isInteger(e.expected) && e.expected > 0, `expected count for ${e.key} must be a positive int`);
  }
});
