// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the pure request-filter helpers (server/record-filters.js).
//
// Covered: field-schema lookup, non-null schema-type extraction, comparable-
// value coercion (integer/number/date/string, strict vs lenient), and the
// range-predicate evaluator whose four comparators (gte/gt/lte/lt) are prime
// boundary mutants. `passesRequestFilters` consumes already-compiled filter
// objects, so it is exercised directly without the grant-scoped compiler.
//
// NOTE: `compileRequestFilters`, `passesTimeRange`, and
// `passesGrantRecordConstraints` are intentionally out of scope — they are
// grant / consent-time enforcement code.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  coerceComparableValue,
  getFieldSchema,
  invalidQueryError,
  nonNullSchemaTypes,
  passesRequestFilters,
} from '../server/record-filters.js';

test('invalidQueryError defaults to invalid_request and honors an override', () => {
  assert.equal(invalidQueryError('m').code, 'invalid_request');
  assert.equal(invalidQueryError('m', 'invalid_expand').code, 'invalid_expand');
});

test('getFieldSchema reads a nested property schema or returns null', () => {
  const stream = { schema: { properties: { age: { type: 'integer' } } } };
  assert.deepEqual(getFieldSchema(stream, 'age'), { type: 'integer' });
  assert.equal(getFieldSchema(stream, 'missing'), null);
  assert.equal(getFieldSchema(null, 'age'), null);
  assert.equal(getFieldSchema({}, 'age'), null);
});

test('nonNullSchemaTypes strips null and normalizes scalar vs array type', () => {
  assert.deepEqual([...nonNullSchemaTypes({ type: 'string' })], ['string']);
  assert.deepEqual([...nonNullSchemaTypes({ type: ['string', 'null'] })], ['string']);
  assert.deepEqual([...nonNullSchemaTypes({ type: ['integer', 'null', 'number'] })], ['integer', 'number']);
  assert.equal(nonNullSchemaTypes({}).size, 0);
  assert.equal(nonNullSchemaTypes(null).size, 0);
});

test('coerceComparableValue returns null for null/undefined input', () => {
  assert.equal(coerceComparableValue(null, { type: 'integer' }), null);
  assert.equal(coerceComparableValue(undefined, { type: 'integer' }), null);
});

test('coerceComparableValue coerces integers and rejects non-integers', () => {
  assert.equal(coerceComparableValue('42', { type: 'integer' }), 42);
  assert.equal(coerceComparableValue(7, { type: 'integer' }), 7);
  assert.equal(coerceComparableValue('1.5', { type: 'integer' }), null);
  // strict mode throws instead of returning null.
  assert.throws(() => coerceComparableValue('nope', { type: 'integer' }, { strict: true }));
});

test('coerceComparableValue coerces numbers', () => {
  assert.equal(coerceComparableValue('3.14', { type: 'number' }), 3.14);
  assert.equal(coerceComparableValue('abc', { type: 'number' }), null);
  assert.throws(() => coerceComparableValue('abc', { type: 'number' }, { strict: true }));
});

test('coerceComparableValue parses date/date-time strings to epoch millis', () => {
  const schema = { type: 'string', format: 'date' };
  assert.equal(
    coerceComparableValue('2026-01-01', schema),
    Date.parse('2026-01-01')
  );
  assert.equal(coerceComparableValue('not-a-date', schema), null);
  assert.throws(() => coerceComparableValue('not-a-date', schema, { strict: true }));
});

test('coerceComparableValue falls back to String for plain string fields', () => {
  assert.equal(coerceComparableValue('hello', { type: 'string' }), 'hello');
  // No schema type at all → String() fallback.
  assert.equal(coerceComparableValue(123, {}), '123');
});

test('passesRequestFilters returns true for empty / absent filter sets', () => {
  assert.equal(passesRequestFilters({ a: 1 }, []), true);
  assert.equal(passesRequestFilters({ a: 1 }, null), true);
  assert.equal(passesRequestFilters({ a: 1 }, undefined), true);
});

test('passesRequestFilters evaluates exact filters via String equality', () => {
  const filters = [{ kind: 'exact', field: 'status', value: 'active' }];
  assert.equal(passesRequestFilters({ status: 'active' }, filters), true);
  assert.equal(passesRequestFilters({ status: 'inactive' }, filters), false);
  // Numeric field stringifies before comparing.
  assert.equal(passesRequestFilters({ status: 5 }, [{ kind: 'exact', field: 'status', value: '5' }]), true);
});

test('passesRequestFilters returns false when the comparable value is null', () => {
  const filters = [{ kind: 'range', field: 'age', fieldSchema: { type: 'integer' }, operators: { gte: 10 } }];
  // Missing field → comparable null → fails.
  assert.equal(passesRequestFilters({}, filters), false);
});

test('passesRequestFilters honors gte (inclusive lower bound)', () => {
  const filters = [{ kind: 'range', field: 'age', fieldSchema: { type: 'integer' }, operators: { gte: 18 } }];
  assert.equal(passesRequestFilters({ age: 18 }, filters), true); // boundary inclusive
  assert.equal(passesRequestFilters({ age: 17 }, filters), false);
  assert.equal(passesRequestFilters({ age: 19 }, filters), true);
});

test('passesRequestFilters honors gt (exclusive lower bound)', () => {
  const filters = [{ kind: 'range', field: 'age', fieldSchema: { type: 'integer' }, operators: { gt: 18 } }];
  assert.equal(passesRequestFilters({ age: 18 }, filters), false); // boundary excluded
  assert.equal(passesRequestFilters({ age: 19 }, filters), true);
});

test('passesRequestFilters honors lte (inclusive upper bound)', () => {
  const filters = [{ kind: 'range', field: 'age', fieldSchema: { type: 'integer' }, operators: { lte: 65 } }];
  assert.equal(passesRequestFilters({ age: 65 }, filters), true); // boundary inclusive
  assert.equal(passesRequestFilters({ age: 66 }, filters), false);
});

test('passesRequestFilters honors lt (exclusive upper bound)', () => {
  const filters = [{ kind: 'range', field: 'age', fieldSchema: { type: 'integer' }, operators: { lt: 65 } }];
  assert.equal(passesRequestFilters({ age: 65 }, filters), false); // boundary excluded
  assert.equal(passesRequestFilters({ age: 64 }, filters), true);
});

test('passesRequestFilters ANDs multiple operators on one range filter', () => {
  const filters = [
    { kind: 'range', field: 'age', fieldSchema: { type: 'integer' }, operators: { gte: 18, lte: 65 } },
  ];
  assert.equal(passesRequestFilters({ age: 30 }, filters), true);
  assert.equal(passesRequestFilters({ age: 10 }, filters), false);
  assert.equal(passesRequestFilters({ age: 70 }, filters), false);
});
