// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Mutation-killing unit tests for the pure expand/projection helpers in
 * `server/record-expand-helpers.js`.
 *
 * `assertRecordIdentity` is already covered by
 * `record-identity-validation.test.js`. This file pins the OTHER exported
 * pure surface with no by-name coverage:
 *
 *   - normalizePrimaryKey  (array/scalar/empty normalization)
 *   - parseIntegerValue    (integer coercion + strict digit regex)
 *   - assertSafeJsonField  (the SQL-safety allowlist guard that THROWS on
 *                           any field name outside /^[A-Za-z_][A-Za-z_0-9]*$/)
 *   - buildEffectiveFilter (grant∩request field projection + required-field
 *                           union)
 *   - normalizeExpandRequest (the whole invalid_expand / insufficient_scope
 *                             error tree + limit clamping)
 *
 * The `assertSafeJsonField` cases are the security-relevant ones: a mutant
 * that loosens the regex (e.g. allows a leading digit, a dot, or a quote)
 * would let unsafe identifiers reach SQL interpolation, and turns red here.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SAFE_JSON_FIELD,
  assertSafeJsonField,
  buildEffectiveFilter,
  normalizeExpandRequest,
  normalizePrimaryKey,
  parseIntegerValue,
} from '../server/record-expand-helpers.js';

function assertThrowsCode(fn, code, messageIncludes) {
  let thrown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown, 'expected the call to throw, but it returned normally');
  if (code !== undefined) {
    assert.equal(thrown.code, code, `expected code=${code} but got ${JSON.stringify(thrown.code)} (${thrown.message})`);
  }
  if (messageIncludes !== undefined) {
    assert.ok(
      String(thrown.message).includes(messageIncludes),
      `expected message to include "${messageIncludes}" but got "${thrown.message}"`,
    );
  }
  return thrown;
}

test('normalizePrimaryKey: arrays filter non-string/empty; scalar wraps; junk -> []', () => {
  assert.deepEqual(normalizePrimaryKey(['a', 'b']), ['a', 'b']);
  // Non-string and empty-string members are dropped.
  assert.deepEqual(normalizePrimaryKey(['a', '', null, 3, 'b']), ['a', 'b']);
  // A non-empty scalar string wraps into a one-element array.
  assert.deepEqual(normalizePrimaryKey('id'), ['id']);
  // Empty string, undefined, number, object -> empty array.
  assert.deepEqual(normalizePrimaryKey(''), []);
  assert.deepEqual(normalizePrimaryKey(undefined), []);
  assert.deepEqual(normalizePrimaryKey(42), []);
});

test('parseIntegerValue: accepts int number / digit strings; rejects floats, blanks, garbage', () => {
  assert.equal(parseIntegerValue(7), 7);
  assert.equal(parseIntegerValue('7'), 7);
  assert.equal(parseIntegerValue('  -12 '), -12); // trimmed, sign allowed
  // A float number is NOT an integer -> null (Number.isInteger guard).
  assert.equal(parseIntegerValue(7.5), null);
  // A float string fails the /^-?\d+$/ regex -> null.
  assert.equal(parseIntegerValue('7.5'), null);
  assert.equal(parseIntegerValue(''), null);
  assert.equal(parseIntegerValue('   '), null);
  assert.equal(parseIntegerValue('12abc'), null);
  assert.equal(parseIntegerValue(null), null);
});

test('assertSafeJsonField: passes valid identifiers, THROWS on anything outside the allowlist', () => {
  // Valid: letter/underscore start, then letters/digits/underscores.
  assert.equal(assertSafeJsonField('emitted_at', 'x'), undefined);
  assert.equal(assertSafeJsonField('_private', 'x'), undefined);
  assert.equal(assertSafeJsonField('Field9', 'x'), undefined);
  assert.ok(SAFE_JSON_FIELD.test('emitted_at'));

  // A leading digit is unsafe (kills a mutant that drops the anchor).
  assertThrowsCode(() => assertSafeJsonField('9field', 'sort'), undefined, 'Unsafe JSON field sort');
  // A dot (nested path) is unsafe.
  assertThrowsCode(() => assertSafeJsonField('a.b', 'sort'), undefined, 'Unsafe JSON field');
  // A quote / SQL-injection attempt is unsafe.
  assertThrowsCode(() => assertSafeJsonField('a"; DROP', 'sort'), undefined, 'Unsafe JSON field');
  // Whitespace / empty / non-string are unsafe.
  assertThrowsCode(() => assertSafeJsonField('a b', 'sort'));
  assertThrowsCode(() => assertSafeJsonField('', 'sort'));
  assertThrowsCode(() => assertSafeJsonField(123, 'sort'));
});

test('buildEffectiveFilter: intersects request fields with grant, unions required fields', () => {
  // Grant limits to [a,b,c]; request narrows to [b,c,z] -> intersection [b,c].
  const eff = buildEffectiveFilter(
    { fields: ['a', 'b', 'c'], time_range: { since: 't' }, resources: ['k1'] },
    { fields: ['b', 'c', 'z'] },
    [],
  );
  assert.deepEqual(eff.fields, ['b', 'c']);
  assert.deepEqual(eff.timeRange, { since: 't' });
  assert.deepEqual(eff.resources, ['k1']);
  assert.equal(eff.consentTimeField, null);

  // No grant field limit + request fields -> request fields used verbatim.
  const eff2 = buildEffectiveFilter({}, { fields: ['x', 'y'] }, []);
  assert.deepEqual(eff2.fields, ['x', 'y']);

  // requiredFields are unioned in FRONT and de-duplicated.
  const eff3 = buildEffectiveFilter({ fields: ['a', 'b'] }, {}, ['id', 'a']);
  assert.deepEqual(eff3.fields, ['id', 'a', 'b']);

  // No grant limit and no request fields -> null (full projection).
  const eff4 = buildEffectiveFilter({}, {}, ['id']);
  assert.equal(eff4.fields, null, 'no field constraint anywhere -> null, required-fields not injected');
});

// ---- normalizeExpandRequest: the invalid_expand / insufficient_scope tree ----

const MANIFEST_STREAM = {
  relationships: [
    { name: 'items', stream: 'order_items', cardinality: 'has_many' },
    { name: 'customer', stream: 'customers', cardinality: 'belongs_to' },
  ],
  query: {
    expand: [
      { name: 'items', default_limit: 10, max_limit: 25 },
      { name: 'customer' },
    ],
  },
};
const FULL_GRANT = { streams: [{ name: 'order_items' }, { name: 'customers' }] };

test('normalizeExpandRequest: no expand -> [], and expand_limit without expand is rejected', () => {
  assert.deepEqual(normalizeExpandRequest({}, 'orders', FULL_GRANT, MANIFEST_STREAM, 'DESC'), []);
  assert.deepEqual(normalizeExpandRequest({ expand: '' }, 'orders', FULL_GRANT, MANIFEST_STREAM, 'DESC'), []);

  // expand_limit present but expand absent -> invalid_expand (two guard sites).
  assertThrowsCode(
    () => normalizeExpandRequest({ expand_limit: { items: 5 } }, 'orders', FULL_GRANT, MANIFEST_STREAM, 'DESC'),
    'invalid_expand',
    'expand_limit requires a matching expand relation',
  );
});

test('normalizeExpandRequest: happy path applies default and requested limits, dedupes', () => {
  // Default limit from capability (10) when no explicit limit.
  const [items] = normalizeExpandRequest({ expand: 'items' }, 'orders', FULL_GRANT, MANIFEST_STREAM, 'ASC');
  assert.equal(items.name, 'items');
  assert.equal(items.limit, 10);
  assert.equal(items.order, 'ASC');

  // Explicit valid limit within max_limit is applied.
  const [limited] = normalizeExpandRequest(
    { expand: 'items', expand_limit: { items: 5 } },
    'orders',
    FULL_GRANT,
    MANIFEST_STREAM,
    'DESC',
  );
  assert.equal(limited.limit, 5);

  // Repeated relation names are de-duplicated to a single expansion.
  const dup = normalizeExpandRequest({ expand: ['items', 'items'] }, 'orders', FULL_GRANT, MANIFEST_STREAM, 'DESC');
  assert.equal(dup.length, 1);
});

test('normalizeExpandRequest: rejects nested, unknown, ungranted relations and bad limits', () => {
  // Nested path (dot) unsupported.
  assertThrowsCode(
    () => normalizeExpandRequest({ expand: 'items.sku' }, 'orders', FULL_GRANT, MANIFEST_STREAM, 'DESC'),
    'invalid_expand',
    'Nested expansion',
  );

  // Unknown relation (not in relationships/capabilities).
  assertThrowsCode(
    () => normalizeExpandRequest({ expand: 'ghost' }, 'orders', FULL_GRANT, MANIFEST_STREAM, 'DESC'),
    'invalid_expand',
    'Unsupported expand relation',
  );

  // Known relation but no grant to the child stream -> insufficient_scope (NOT invalid_expand).
  assertThrowsCode(
    () => normalizeExpandRequest({ expand: 'items' }, 'orders', { streams: [] }, MANIFEST_STREAM, 'DESC'),
    'insufficient_scope',
    'requires grant access',
  );

  // expand_limit on a non-has_many relation is rejected.
  assertThrowsCode(
    () =>
      normalizeExpandRequest(
        { expand: 'customer', expand_limit: { customer: 3 } },
        'orders',
        FULL_GRANT,
        MANIFEST_STREAM,
        'DESC',
      ),
    'invalid_expand',
    'only valid for has_many',
  );

  // Non-positive limit rejected.
  assertThrowsCode(
    () =>
      normalizeExpandRequest(
        { expand: 'items', expand_limit: { items: 0 } },
        'orders',
        FULL_GRANT,
        MANIFEST_STREAM,
        'DESC',
      ),
    'invalid_expand',
    'must be a positive integer',
  );

  // Limit above max_limit rejected (25 is the declared max for items).
  assertThrowsCode(
    () =>
      normalizeExpandRequest(
        { expand: 'items', expand_limit: { items: 26 } },
        'orders',
        FULL_GRANT,
        MANIFEST_STREAM,
        'DESC',
      ),
    'invalid_expand',
    'exceeds max_limit 25',
  );

  // expand_limit referencing a relation NOT in expand[] is rejected.
  assertThrowsCode(
    () =>
      normalizeExpandRequest(
        { expand: 'items', expand_limit: { customer: 5 } },
        'orders',
        FULL_GRANT,
        MANIFEST_STREAM,
        'DESC',
      ),
    'invalid_expand',
    'requires a matching expand relation',
  );
});

test('normalizeExpandRequest: boundary limit equal to max_limit is accepted (off-by-one guard)', () => {
  const [items] = normalizeExpandRequest(
    { expand: 'items', expand_limit: { items: 25 } },
    'orders',
    FULL_GRANT,
    MANIFEST_STREAM,
    'DESC',
  );
  assert.equal(items.limit, 25, 'limit exactly at max_limit must be allowed (> not >=)');
});
