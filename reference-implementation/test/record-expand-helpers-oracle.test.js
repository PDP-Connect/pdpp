// Pure-logic oracle for three untested helpers in server/record-expand-helpers.js:
//   - normalizePrimaryKey: normalizes a manifest primary_key to a clean string[]
//     (filters non-string/empty array members, wraps a scalar, [] otherwise);
//   - parseIntegerValue: the integer coercion behind filter comparisons (accepts
//     integer numbers, trims decimal strings, rejects floats / non-numeric);
//   - assertSafeJsonField: the injection guard restricting an interpolated
//     `$.<field>` JSON path to a safe SQL identifier.
// All pure, all previously untested by name. No DB.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizePrimaryKey,
  parseIntegerValue,
  assertSafeJsonField,
  SAFE_JSON_FIELD,
} from '../server/record-expand-helpers.js';

test('normalizePrimaryKey cleans an array, wraps a scalar string, and returns [] otherwise', () => {
  assert.deepEqual(normalizePrimaryKey(['a', '', 'b', 123, null]), ['a', 'b']);
  assert.deepEqual(normalizePrimaryKey('id'), ['id']);
  assert.deepEqual(normalizePrimaryKey(''), []);
  assert.deepEqual(normalizePrimaryKey(null), []);
  assert.deepEqual(normalizePrimaryKey(42), []);
});

test('parseIntegerValue accepts integer numbers and integer strings, rejecting floats and non-numeric', () => {
  assert.equal(parseIntegerValue(42), 42);
  assert.equal(parseIntegerValue(4.5), null); // a non-integer number is rejected
  assert.equal(parseIntegerValue('42'), 42);
  assert.equal(parseIntegerValue('-7'), -7);
  assert.equal(parseIntegerValue(' 10 '), 10); // surrounding whitespace is trimmed
  assert.equal(parseIntegerValue('4.5'), null);
  assert.equal(parseIntegerValue('abc'), null);
  assert.equal(parseIntegerValue('4a'), null);
  assert.equal(parseIntegerValue(''), null);
  assert.equal(parseIntegerValue(null), null);
  assert.equal(parseIntegerValue(undefined), null);
});

test('SAFE_JSON_FIELD admits identifier-shaped fields and rejects the rest', () => {
  assert.ok(SAFE_JSON_FIELD.test('field_1'));
  assert.ok(SAFE_JSON_FIELD.test('_x'));
  assert.ok(!SAFE_JSON_FIELD.test('1field')); // leading digit
  assert.ok(!SAFE_JSON_FIELD.test('a.b')); // dot
  assert.ok(!SAFE_JSON_FIELD.test('a b')); // space
  assert.ok(!SAFE_JSON_FIELD.test('')); // empty
});

test('assertSafeJsonField throws on an unsafe field and passes a safe identifier', () => {
  assert.throws(() => assertSafeJsonField('a.b', 'field'), /Unsafe JSON field field/);
  assert.throws(() => assertSafeJsonField(123, 'field'), /Unsafe JSON field field/);
  assert.throws(() => assertSafeJsonField('', 'field'), /Unsafe JSON field field/);
  assert.doesNotThrow(() => assertSafeJsonField('good_field', 'field'));
});
