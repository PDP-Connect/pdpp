/**
 * Mutation-killing unit tests for the pure connector-instance derivation
 * helpers in `server/connector-instance-utils.ts`.
 *
 * These are used by BOTH the SQLite and Postgres bootstrap paths to derive
 * stable connection ids from a source binding, so a divergence here would
 * silently split one logical connection into two. No test imports them by
 * name today. This file pins:
 *
 *   - stableJson        (canonical, KEY-SORTED serialization — the
 *                        determinism the id hash depends on)
 *   - nonEmptyString    (trim + null-on-blank)
 *   - isSourceKind      (the two-value allowlist)
 *   - makeConnectorInstanceId / ...SourceBindingKey (deterministic + prefix)
 *   - parseSpineSourceShape (canonical > legacy binding_kind > single-id
 *                            fallback resolution, with the exclusive-or gate)
 *   - deriveSpineSource (payload-source precedence over row columns)
 *
 * Determinism is asserted structurally (same input → same output, key
 * order irrelevant) rather than against a hard-coded digest, so the tests
 * pin BEHAVIOR without hard-coding the SHA-256 output.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  deriveSpineSource,
  isSourceKind,
  makeConnectorInstanceId,
  makeConnectorInstanceSourceBindingKey,
  nonEmptyString,
  parseSpineSourceShape,
  stableJson,
} from '../server/connector-instance-utils.ts';

test('stableJson: null->{}, scalars via JSON, arrays recurse, object keys are SORTED', () => {
  assert.equal(stableJson(null), '{}');
  assert.equal(stableJson(undefined), '{}');
  assert.equal(stableJson(42), '42');
  assert.equal(stableJson('x'), '"x"');
  assert.equal(stableJson([1, 'a', null]), '[1,"a",{}]'); // null member -> {}

  // The load-bearing property: object serialization is key-order independent.
  const a = stableJson({ b: 1, a: 2, c: 3 });
  const b = stableJson({ c: 3, a: 2, b: 1 });
  assert.equal(a, b, 'stableJson must be independent of insertion order');
  assert.equal(a, '{"a":2,"b":1,"c":3}');

  // Nested objects are also sorted recursively.
  assert.equal(stableJson({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
});

test('nonEmptyString: trims, returns null for blank/non-string', () => {
  assert.equal(nonEmptyString('  hi  '), 'hi');
  assert.equal(nonEmptyString('x'), 'x');
  assert.equal(nonEmptyString('   '), null);
  assert.equal(nonEmptyString(''), null);
  assert.equal(nonEmptyString(null), null);
  assert.equal(nonEmptyString(42), null);
  assert.equal(nonEmptyString({}), null);
});

test('isSourceKind: only connector | provider_native are valid', () => {
  assert.equal(isSourceKind('connector'), true);
  assert.equal(isSourceKind('provider_native'), true);
  assert.equal(isSourceKind('native'), false);
  assert.equal(isSourceKind(''), false);
  assert.equal(isSourceKind(null), false);
  assert.equal(isSourceKind('Connector'), false); // case-sensitive
});

test('makeConnectorInstanceId: cin_ prefix, 24-hex body, deterministic, input-sensitive', () => {
  const id = makeConnectorInstanceId('owner', 'github', 'connector', 'bkey');
  assert.match(id, /^cin_[0-9a-f]{24}$/, `unexpected id shape: ${id}`);
  // Deterministic for identical inputs.
  assert.equal(makeConnectorInstanceId('owner', 'github', 'connector', 'bkey'), id);
  // Any component change alters the id (kills a mutant that drops a field
  // from the hash input).
  assert.notEqual(makeConnectorInstanceId('owner2', 'github', 'connector', 'bkey'), id);
  assert.notEqual(makeConnectorInstanceId('owner', 'gitlab', 'connector', 'bkey'), id);
  assert.notEqual(makeConnectorInstanceId('owner', 'github', 'provider_native', 'bkey'), id);
  assert.notEqual(makeConnectorInstanceId('owner', 'github', 'connector', 'bkey2'), id);
});

test('makeConnectorInstanceSourceBindingKey: order-independent (rides stableJson)', () => {
  const k1 = makeConnectorInstanceSourceBindingKey({ a: 1, b: 2 });
  const k2 = makeConnectorInstanceSourceBindingKey({ b: 2, a: 1 });
  assert.equal(k1, k2, 'binding key must not depend on object key order');
  // Nullish binding hashes the empty object deterministically.
  assert.equal(makeConnectorInstanceSourceBindingKey(undefined), makeConnectorInstanceSourceBindingKey({}));
  assert.match(k1, /^[0-9a-f]{64}$/);
});

test('parseSpineSourceShape: canonical kind+id wins; non-object -> null', () => {
  assert.equal(parseSpineSourceShape(null), null);
  assert.equal(parseSpineSourceShape('x'), null);
  assert.equal(parseSpineSourceShape([1, 2]), null);

  // Canonical shape.
  assert.deepEqual(parseSpineSourceShape({ kind: 'connector', id: 'github' }), {
    kind: 'connector',
    id: 'github',
  });
  // A canonical kind that is not in the allowlist falls through to null (no
  // legacy/single-id fields present).
  assert.equal(parseSpineSourceShape({ kind: 'bogus', id: 'x' }), null);
});

test('parseSpineSourceShape: legacy binding_kind maps to the matching id field', () => {
  assert.deepEqual(parseSpineSourceShape({ binding_kind: 'connector', connector_id: 'gh' }), {
    kind: 'connector',
    id: 'gh',
  });
  assert.deepEqual(parseSpineSourceShape({ binding_kind: 'provider_native', provider_id: 'plaid' }), {
    kind: 'provider_native',
    id: 'plaid',
  });
  // Legacy kind present but its id field missing -> falls through to single-id
  // inference, which also fails here -> null.
  assert.equal(parseSpineSourceShape({ binding_kind: 'connector' }), null);
});

test('parseSpineSourceShape: single-id inference requires EXACTLY one of connector_id / provider_id', () => {
  assert.deepEqual(parseSpineSourceShape({ connector_id: 'gh' }), { kind: 'connector', id: 'gh' });
  assert.deepEqual(parseSpineSourceShape({ provider_id: 'plaid' }), { kind: 'provider_native', id: 'plaid' });
  // Ambiguous: both present -> null (the exclusive-or gate).
  assert.equal(parseSpineSourceShape({ connector_id: 'gh', provider_id: 'plaid' }), null);
});

test('deriveSpineSource: payload.source has precedence over row columns', () => {
  // A resolvable payload.source is used even when the row also carries columns.
  assert.deepEqual(
    deriveSpineSource({ source: { kind: 'connector', id: 'gh' } }, { source_kind: 'provider_native', source_id: 'plaid' }),
    { kind: 'connector', id: 'gh' },
  );

  // payload.source_binding is the second payload avenue.
  assert.deepEqual(
    deriveSpineSource({ source_binding: { connector_id: 'gh' } }, {}),
    { kind: 'connector', id: 'gh' },
  );

  // payload single-id inference (no source/source_binding keys present).
  assert.deepEqual(deriveSpineSource({ provider_id: 'plaid' }, {}), { kind: 'provider_native', id: 'plaid' });
});

test('deriveSpineSource: falls back to row columns and the runtime-actor special case', () => {
  // No usable payload -> row source_kind/source_id.
  assert.deepEqual(
    deriveSpineSource(null, { source_kind: 'connector', source_id: 'gh' }),
    { kind: 'connector', id: 'gh' },
  );
  // Row provider_id fallback.
  assert.deepEqual(deriveSpineSource({}, { provider_id: 'plaid' }), { kind: 'provider_native', id: 'plaid' });

  // actor_type 'runtime' + actor_id => connector; a non-runtime actor does NOT.
  assert.deepEqual(
    deriveSpineSource({}, { actor_type: 'runtime', actor_id: 'gh' }),
    { kind: 'connector', id: 'gh' },
  );
  assert.equal(deriveSpineSource({}, { actor_type: 'user', actor_id: 'gh' }), null);

  // Nothing resolvable at all -> null.
  assert.equal(deriveSpineSource({}, {}), null);
});
