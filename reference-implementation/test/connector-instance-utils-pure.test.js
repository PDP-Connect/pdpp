// Pure, no-DB unit tests for server/connector-instance-utils.ts. No test imports
// this module by name (spine-source-boot-backfill.test.js drives deriveSpineSource
// through a DB boot backfill, not the pure functions directly). These id-derivation
// helpers are shared by the SQLite + Postgres bootstrap paths, so a divergence here
// silently splits connection identity across backends.
//
// Mutation surface:
//   stableJson    -- canonical key-SORTED serialization: two objects with the same
//     entries in different key order MUST serialize identically (determinism is the
//     whole point; it feeds the sha256 binding key).
//   makeConnectorInstanceId -- `cin_` prefix + 24-hex-char slice; distinct inputs
//     produce distinct ids; identical inputs are stable.
//   parseSpineSourceShape -- precedence: canonical {kind,id} > legacy binding_kind >
//     bare connector_id/provider_id (mutually exclusive); typed rejects.
//   nonEmptyString / isSourceKind -- trim + source-kind allowlist.
//   deriveSpineSource -- payload.source wins; payload.source_binding next; bare
//     payload ids next (pure branches only, row absent).

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

// ---------------------------------------------------------------------------
// stableJson: deterministic key-sorted serialization
// ---------------------------------------------------------------------------

test('stableJson: object serialization is key-order-independent', () => {
  const a = stableJson({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = stableJson({ c: { y: 2, z: 1 }, a: 2, b: 1 });
  assert.equal(a, b, 'same entries in different key order must serialize identically');
  assert.equal(a, '{"a":2,"b":1,"c":{"y":2,"z":1}}', 'keys are sorted ascending');
});

test('stableJson: null/undefined collapse to {} and arrays preserve order', () => {
  assert.equal(stableJson(null), '{}');
  assert.equal(stableJson(undefined), '{}');
  assert.equal(stableJson([3, 1, 2]), '[3,1,2]', 'array order is significant (not sorted)');
  assert.equal(stableJson('x'), '"x"');
});

test('makeConnectorInstanceSourceBindingKey: equal-but-reordered bindings hash identically', () => {
  const k1 = makeConnectorInstanceSourceBindingKey({ kind: 'connector', id: 'gmail' });
  const k2 = makeConnectorInstanceSourceBindingKey({ id: 'gmail', kind: 'connector' });
  assert.equal(k1, k2, 'key-order independence flows through to the sha256 binding key');
  const k3 = makeConnectorInstanceSourceBindingKey({ kind: 'connector', id: 'amazon' });
  assert.notEqual(k1, k3, 'different binding -> different key');
  assert.equal(k1.length, 64, 'sha256 hex is 64 chars');
});

// ---------------------------------------------------------------------------
// makeConnectorInstanceId
// ---------------------------------------------------------------------------

test('makeConnectorInstanceId: cin_ prefix + 24 hex chars, deterministic', () => {
  const id = makeConnectorInstanceId('owner-1', 'gmail', 'connector', 'bkey');
  assert.match(id, /^cin_[0-9a-f]{24}$/, 'cin_ prefix + 24-hex slice');
  const id2 = makeConnectorInstanceId('owner-1', 'gmail', 'connector', 'bkey');
  assert.equal(id, id2, 'same inputs -> same id');
});

test('makeConnectorInstanceId: any component change changes the id', () => {
  const base = makeConnectorInstanceId('owner-1', 'gmail', 'connector', 'bkey');
  assert.notEqual(base, makeConnectorInstanceId('owner-2', 'gmail', 'connector', 'bkey'), 'owner matters');
  assert.notEqual(base, makeConnectorInstanceId('owner-1', 'amazon', 'connector', 'bkey'), 'connector matters');
  assert.notEqual(base, makeConnectorInstanceId('owner-1', 'gmail', 'provider_native', 'bkey'), 'kind matters');
  assert.notEqual(base, makeConnectorInstanceId('owner-1', 'gmail', 'connector', 'bkey2'), 'binding key matters');
});

// ---------------------------------------------------------------------------
// nonEmptyString / isSourceKind
// ---------------------------------------------------------------------------

test('nonEmptyString: trims to a value or null', () => {
  assert.equal(nonEmptyString('  x  '), 'x');
  assert.equal(nonEmptyString('   '), null);
  assert.equal(nonEmptyString(''), null);
  assert.equal(nonEmptyString(5), null);
  assert.equal(nonEmptyString(null), null);
});

test('isSourceKind: only connector and provider_native are valid', () => {
  assert.equal(isSourceKind('connector'), true);
  assert.equal(isSourceKind('provider_native'), true);
  assert.equal(isSourceKind('native'), false);
  assert.equal(isSourceKind('Connector'), false, 'case-sensitive');
  assert.equal(isSourceKind(null), false);
});

// ---------------------------------------------------------------------------
// parseSpineSourceShape: precedence
// ---------------------------------------------------------------------------

test('parseSpineSourceShape: canonical {kind,id} wins over legacy/bare fields', () => {
  const out = parseSpineSourceShape({
    kind: 'connector', id: 'canonical-id',
    binding_kind: 'provider_native', provider_id: 'legacy-id',
    connector_id: 'bare-id',
  });
  assert.deepEqual(out, { kind: 'connector', id: 'canonical-id' });
});

test('parseSpineSourceShape: legacy binding_kind used when no canonical kind/id', () => {
  assert.deepEqual(
    parseSpineSourceShape({ binding_kind: 'connector', connector_id: 'c1' }),
    { kind: 'connector', id: 'c1' },
  );
  assert.deepEqual(
    parseSpineSourceShape({ binding_kind: 'provider_native', provider_id: 'p1' }),
    { kind: 'provider_native', id: 'p1' },
  );
});

test('parseSpineSourceShape: bare connector_id/provider_id are mutually exclusive', () => {
  assert.deepEqual(parseSpineSourceShape({ connector_id: 'c1' }), { kind: 'connector', id: 'c1' });
  assert.deepEqual(parseSpineSourceShape({ provider_id: 'p1' }), { kind: 'provider_native', id: 'p1' });
  // both present with no disambiguating kind -> ambiguous -> null
  assert.equal(parseSpineSourceShape({ connector_id: 'c1', provider_id: 'p1' }), null);
});

test('parseSpineSourceShape: invalid canonical kind falls through, non-object rejects', () => {
  // kind not in allowlist -> not treated as canonical; no legacy/bare -> null
  assert.equal(parseSpineSourceShape({ kind: 'weird', id: 'x' }), null);
  assert.equal(parseSpineSourceShape(null), null);
  assert.equal(parseSpineSourceShape([1, 2]), null, 'arrays rejected');
  assert.equal(parseSpineSourceShape('string'), null);
});

// ---------------------------------------------------------------------------
// deriveSpineSource: payload precedence (pure branches, no row source)
// ---------------------------------------------------------------------------

test('deriveSpineSource: payload.source is consulted first', () => {
  const out = deriveSpineSource(
    { source: { kind: 'connector', id: 'from-source' }, source_binding: { connector_id: 'from-binding' } },
    {},
  );
  assert.deepEqual(out, { kind: 'connector', id: 'from-source' });
});

test('deriveSpineSource: payload.source_binding used when source absent/unparseable', () => {
  const out = deriveSpineSource({ source_binding: { provider_id: 'pb' } }, {});
  assert.deepEqual(out, { kind: 'provider_native', id: 'pb' });
});

test('deriveSpineSource: bare payload connector_id used when no source/source_binding', () => {
  assert.deepEqual(deriveSpineSource({ connector_id: 'bare-c' }, {}), { kind: 'connector', id: 'bare-c' });
});

test('deriveSpineSource: falls back to the row when payload yields nothing', () => {
  // Pure fallback: row source_kind + source_id.
  assert.deepEqual(
    deriveSpineSource({}, { source_kind: 'connector', source_id: 'row-c' }),
    { kind: 'connector', id: 'row-c' },
  );
  // runtime actor fallback -> connector
  assert.deepEqual(
    deriveSpineSource(null, { actor_type: 'runtime', actor_id: 'act-1' }),
    { kind: 'connector', id: 'act-1' },
  );
  // nothing resolvable -> null
  assert.equal(deriveSpineSource(null, {}), null);
});
