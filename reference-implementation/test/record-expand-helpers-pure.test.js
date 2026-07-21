// Pure-helper unit coverage for the storage-agnostic record helpers in
// server/record-expand-helpers.js that back the record read/write paths.
//
// record-identity-validation.test.js already pins `assertRecordIdentity`.
// This file pins the other pure, non-grant helpers that had NO direct
// coverage and back real contracts on the record surface:
//
//   - normalizePrimaryKey      — the primary-key normalization used to derive
//                                the identity guard's field list.
//   - parseIntegerValue        — strict integer coercion for numeric query
//                                params (whitespace/sign/non-numeric rules).
//   - SAFE_JSON_FIELD /
//     assertSafeJsonField      — the SQL-injection guard that lets a backend
//                                interpolate only `$.<field>` identifiers into
//                                SQL. This is a security boundary; a loosened
//                                regex must fail loudly here.
//   - invalidQueryError        — the typed query-error factory + default code.
//
// These do not touch grant/scope logic; assertions observe behavior only.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  invalidQueryError,
  normalizePrimaryKey,
  parseIntegerValue,
  SAFE_JSON_FIELD,
  assertSafeJsonField,
} from '../server/record-expand-helpers.js';

// ─── invalidQueryError ──────────────────────────────────────────────────────

test('invalidQueryError defaults to invalid_request and preserves an explicit code', () => {
  const def = invalidQueryError('bad');
  assert.ok(def instanceof Error);
  assert.equal(def.message, 'bad');
  assert.equal(def.code, 'invalid_request');

  const explicit = invalidQueryError('nope', 'invalid_sort');
  assert.equal(explicit.code, 'invalid_sort');
  assert.equal(explicit.message, 'nope');
});

// ─── normalizePrimaryKey ────────────────────────────────────────────────────

test('normalizePrimaryKey wraps a non-empty string key into a single-element list', () => {
  assert.deepEqual(normalizePrimaryKey('id'), ['id']);
});

test('normalizePrimaryKey keeps a compound array and drops empty/non-string members', () => {
  assert.deepEqual(normalizePrimaryKey(['a', 'b']), ['a', 'b']);
  // Empty strings and non-strings are filtered out, preserving order.
  assert.deepEqual(normalizePrimaryKey(['a', '', 'b', 0, null, undefined, 'c']), ['a', 'b', 'c']);
});

test('normalizePrimaryKey returns an empty list for empty/invalid input (legacy id fallback)', () => {
  assert.deepEqual(normalizePrimaryKey(''), []);
  assert.deepEqual(normalizePrimaryKey([]), []);
  assert.deepEqual(normalizePrimaryKey(null), []);
  assert.deepEqual(normalizePrimaryKey(undefined), []);
  assert.deepEqual(normalizePrimaryKey(42), []);
  assert.deepEqual(normalizePrimaryKey(['', null]), []);
});

// ─── parseIntegerValue ──────────────────────────────────────────────────────

test('parseIntegerValue passes through an integer number', () => {
  assert.equal(parseIntegerValue(0), 0);
  assert.equal(parseIntegerValue(42), 42);
  assert.equal(parseIntegerValue(-7), -7);
});

test('parseIntegerValue rejects a non-integer number', () => {
  assert.equal(parseIntegerValue(1.5), null);
  assert.equal(parseIntegerValue(Number.NaN), null);
  assert.equal(parseIntegerValue(Infinity), null);
});

test('parseIntegerValue parses a clean integer string, tolerating surrounding whitespace', () => {
  assert.equal(parseIntegerValue('42'), 42);
  assert.equal(parseIntegerValue('  42  '), 42);
  assert.equal(parseIntegerValue('-7'), -7);
  assert.equal(parseIntegerValue('0'), 0);
});

test('parseIntegerValue rejects non-numeric, decimal, and mixed strings', () => {
  for (const bad of ['', 'abc', '4.2', '4px', '0x10', '1e3', '4 2', '+', '-', '12,000']) {
    assert.equal(parseIntegerValue(bad), null, `${JSON.stringify(bad)} must not parse`);
  }
});

test('parseIntegerValue rejects non-string, non-number inputs', () => {
  for (const bad of [null, undefined, {}, [], true]) {
    assert.equal(parseIntegerValue(bad), null);
  }
});

// ─── SAFE_JSON_FIELD / assertSafeJsonField (SQL-injection guard) ─────────────

test('SAFE_JSON_FIELD accepts plain identifiers only', () => {
  for (const ok of ['id', 'created_at', '_private', 'A1', 'field_9', '__x__']) {
    assert.ok(SAFE_JSON_FIELD.test(ok), `${ok} should be a safe field`);
  }
});

test('SAFE_JSON_FIELD rejects anything that could break out of a $.<field> path', () => {
  // Leading digit, dots, quotes, brackets, whitespace, SQL/path metacharacters,
  // and empty string must all be rejected so they can never be interpolated.
  for (const bad of [
    '',
    '1field',
    'a.b',
    'a b',
    'a-b',
    'a"b',
    "a'b",
    'a;b',
    'a)b',
    'a]b',
    'a$b',
    'a\nb',
    "'; DROP TABLE records; --",
    'field ',     // trailing space
    ' field',     // leading space
    'weird.key',
  ]) {
    assert.equal(SAFE_JSON_FIELD.test(bad), false, `${JSON.stringify(bad)} must be rejected`);
  }
});

test('assertSafeJsonField is a no-op for a safe field and throws for an unsafe one', () => {
  assert.doesNotThrow(() => assertSafeJsonField('created_at', 'cursor_field'));

  let caught;
  try {
    assertSafeJsonField("a'; DROP TABLE records; --", 'cursor_field');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof Error, 'an unsafe field throws');
  // The label and the offending value are surfaced (JSON-stringified) so the
  // failure is diagnosable without leaking a raw value into SQL.
  assert.match(caught.message, /Unsafe JSON field cursor_field/);
  assert.match(caught.message, /DROP TABLE/);
});

test('assertSafeJsonField throws for a non-string field', () => {
  for (const bad of [null, undefined, 42, {}, ['id']]) {
    assert.throws(() => assertSafeJsonField(bad, 'field'), Error);
  }
});
