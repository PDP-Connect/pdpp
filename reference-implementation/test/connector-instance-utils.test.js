// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the pure connector-instance id/key derivation helpers.
 *
 * These helpers are the canonical key derivation shared by the SQLite and
 * Postgres bootstrap paths (and the connector-instance store). They are pure
 * (no I/O), so they are exercised directly here. The assertions pin:
 *   - stableJson canonical ordering + null/array/scalar shapes,
 *   - the cin_ id prefix + 24-hex-char truncation width,
 *   - source-kind classification boundaries,
 *   - nonEmptyString trimming semantics,
 *   - the spine-source shape parsing precedence (canonical > legacy > inferred),
 *   - deriveSpineSource payload-then-row fallback precedence.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  stableJson,
  hashKey,
  makeConnectorInstanceSourceBindingKey,
  makeConnectorInstanceId,
  nonEmptyString,
  isSourceKind,
  parseSpineSourceShape,
  deriveSpineSource,
} from '../server/connector-instance-utils.ts';

test('stableJson emits keys in sorted order regardless of insertion order', () => {
  const a = stableJson({ b: 1, a: 2 });
  const b = stableJson({ a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1}');
});

test('stableJson maps null and undefined to empty object literal', () => {
  assert.equal(stableJson(null), '{}');
  assert.equal(stableJson(undefined), '{}');
});

test('stableJson recurses into arrays and nested objects', () => {
  assert.equal(stableJson([{ y: 1, x: 2 }, 'z']), '[{"x":2,"y":1},"z"]');
});

test('stableJson serializes scalars via JSON.stringify', () => {
  assert.equal(stableJson('hi'), '"hi"');
  assert.equal(stableJson(7), '7');
  assert.equal(stableJson(true), 'true');
});

test('hashKey returns a stable 64-char sha256 hex digest', () => {
  const digest = hashKey('abc');
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, hashKey('abc'));
  assert.notEqual(digest, hashKey('abd'));
});

test('makeConnectorInstanceSourceBindingKey is order-insensitive over binding keys', () => {
  const k1 = makeConnectorInstanceSourceBindingKey({ b: 1, a: 2 });
  const k2 = makeConnectorInstanceSourceBindingKey({ a: 2, b: 1 });
  assert.equal(k1, k2);
  // null binding hashes the empty-object literal.
  assert.equal(makeConnectorInstanceSourceBindingKey(null), hashKey('{}'));
});

test('makeConnectorInstanceId carries the cin_ prefix and a 24-hex-char body', () => {
  const id = makeConnectorInstanceId('owner', 'gmail', 'connector', 'bk');
  assert.match(id, /^cin_[0-9a-f]{24}$/);
  // Deterministic + sensitive to every field.
  assert.equal(id, makeConnectorInstanceId('owner', 'gmail', 'connector', 'bk'));
  assert.notEqual(id, makeConnectorInstanceId('owner2', 'gmail', 'connector', 'bk'));
  assert.notEqual(id, makeConnectorInstanceId('owner', 'gmail', 'provider_native', 'bk'));
});

test('nonEmptyString trims and rejects blank / non-string values', () => {
  assert.equal(nonEmptyString('  x  '), 'x');
  assert.equal(nonEmptyString('   '), null);
  assert.equal(nonEmptyString(''), null);
  assert.equal(nonEmptyString(5), null);
  assert.equal(nonEmptyString(null), null);
});

test('isSourceKind accepts only the two canonical kinds', () => {
  assert.equal(isSourceKind('connector'), true);
  assert.equal(isSourceKind('provider_native'), true);
  assert.equal(isSourceKind('provider'), false);
  assert.equal(isSourceKind(''), false);
  assert.equal(isSourceKind(null), false);
});

test('parseSpineSourceShape prefers canonical kind+id when valid', () => {
  assert.deepEqual(
    parseSpineSourceShape({ kind: 'connector', id: 'gmail', connector_id: 'other' }),
    { kind: 'connector', id: 'gmail' },
  );
});

test('parseSpineSourceShape falls back to legacy binding_kind mapping', () => {
  assert.deepEqual(
    parseSpineSourceShape({ binding_kind: 'connector', connector_id: 'gmail' }),
    { kind: 'connector', id: 'gmail' },
  );
  assert.deepEqual(
    parseSpineSourceShape({ binding_kind: 'provider_native', provider_id: 'apple' }),
    { kind: 'provider_native', id: 'apple' },
  );
});

test('parseSpineSourceShape infers kind from an unambiguous single id', () => {
  assert.deepEqual(parseSpineSourceShape({ connector_id: 'gmail' }), { kind: 'connector', id: 'gmail' });
  assert.deepEqual(parseSpineSourceShape({ provider_id: 'apple' }), { kind: 'provider_native', id: 'apple' });
  // Ambiguous: both ids present without canonical/legacy discriminator -> null.
  assert.equal(parseSpineSourceShape({ connector_id: 'g', provider_id: 'a' }), null);
});

test('parseSpineSourceShape rejects non-object shapes', () => {
  assert.equal(parseSpineSourceShape(null), null);
  assert.equal(parseSpineSourceShape('x'), null);
  assert.equal(parseSpineSourceShape([{ kind: 'connector', id: 'g' }]), null);
});

test('deriveSpineSource prefers payload.source over source_binding and row', () => {
  const payload = {
    source: { kind: 'connector', id: 'fromsource' },
    source_binding: { kind: 'connector', id: 'frombinding' },
  };
  const row = { source_kind: 'connector', source_id: 'fromrow' };
  assert.deepEqual(deriveSpineSource(payload, row), { kind: 'connector', id: 'fromsource' });
});

test('deriveSpineSource falls back to row source_kind/source_id when payload has nothing', () => {
  assert.deepEqual(
    deriveSpineSource({}, { source_kind: 'provider_native', source_id: 'apple' }),
    { kind: 'provider_native', id: 'apple' },
  );
});

test('deriveSpineSource treats runtime actor row as a connector source', () => {
  assert.deepEqual(
    deriveSpineSource({}, { actor_type: 'runtime', actor_id: 'gmail' }),
    { kind: 'connector', id: 'gmail' },
  );
  // Non-runtime actor is not treated as a connector source.
  assert.equal(deriveSpineSource({}, { actor_type: 'user', actor_id: 'gmail' }), null);
});

test('deriveSpineSource returns null when no shape resolves', () => {
  assert.equal(deriveSpineSource(null, {}), null);
});
