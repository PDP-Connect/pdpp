// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the pure JSON-Schema capability-classification predicates in
 * `server/connector-manifest-validation.ts`. These decide which query / cursor /
 * aggregation capabilities a connector field advertises from its declared JSON
 * Schema — the read-model input that the schema/capabilities surfaces project.
 * None had by-name coverage (except `nonNullSchemaTypes`, whose branches are
 * re-pinned here).
 *
 * Contracts pinned:
 *   - nonNullSchemaTypes: normalizes `type` (scalar/array/absent) and drops "null".
 *   - schemaTypeIncludes: scalar-equals OR array-membership.
 *   - isPositiveInteger: integer AND > 0 (rejects 0, negatives, floats, strings).
 *   - isTopLevelSearchableStringField: `"string"`, or an array that INCLUDES
 *     "string" and is otherwise only "string"/"null" (a string|number union is
 *     NOT searchable-string).
 *   - isReferenceCompatibleCursorSchema (== isRangeQueryableFieldSchema ==
 *     isMinMaxAggregateFieldSchema): exactly one non-null type; integer/number
 *     qualify; string qualifies only with format date|date-time; a multi-type
 *     union does not.
 *   - isNumericAggregateFieldSchema: exactly one non-null type ∈ {integer, number}.
 *   - isScalarAggregateGroupFieldSchema: one non-null type ∈ {boolean, integer,
 *     number, string}.
 *   - isTimeBucketAggregateFieldSchema: one non-null type "string" WITH format
 *     date|date-time.
 *
 * Pure — the module imports only connector-key helpers (no DB). No fixtures.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nonNullSchemaTypes,
  schemaTypeIncludes,
  isPositiveInteger,
  isTopLevelSearchableStringField,
  isRangeQueryableFieldSchema,
  isReferenceCompatibleCursorSchema,
  isNumericAggregateFieldSchema,
  isMinMaxAggregateFieldSchema,
  isScalarAggregateGroupFieldSchema,
  isTimeBucketAggregateFieldSchema,
} from '../server/connector-manifest-validation.ts';

// --- nonNullSchemaTypes -----------------------------------------------------

test('nonNullSchemaTypes: normalizes scalar/array/absent type and drops "null"', () => {
  assert.deepEqual(nonNullSchemaTypes({ type: 'integer' }), ['integer'], 'scalar wraps to array');
  assert.deepEqual(nonNullSchemaTypes({ type: ['string', 'null'] }), ['string'], 'null dropped from array');
  assert.deepEqual(nonNullSchemaTypes({}), [], 'absent type => empty');
  assert.deepEqual(nonNullSchemaTypes(null), [], 'null schema => empty');
  assert.deepEqual(nonNullSchemaTypes({ type: ['integer', 'string'] }), ['integer', 'string'], 'union preserved');
});

// --- schemaTypeIncludes -----------------------------------------------------

test('schemaTypeIncludes: matches a scalar type or an array member', () => {
  assert.equal(schemaTypeIncludes({ type: 'string' }, 'string'), true, 'scalar equals');
  assert.equal(schemaTypeIncludes({ type: ['string', 'null'] }, 'string'), true, 'array membership');
  assert.equal(schemaTypeIncludes({ type: 'number' }, 'string'), false, 'scalar mismatch');
  assert.equal(schemaTypeIncludes({ type: ['integer', 'null'] }, 'string'), false, 'not a member');
  assert.equal(schemaTypeIncludes(null, 'string'), false, 'null schema');
});

// --- isPositiveInteger ------------------------------------------------------

test('isPositiveInteger: true only for integers strictly greater than zero', () => {
  assert.equal(isPositiveInteger(5), true);
  assert.equal(isPositiveInteger(1), true);
  assert.equal(isPositiveInteger(0), false, 'zero is not positive');
  assert.equal(isPositiveInteger(-3), false, 'negative');
  assert.equal(isPositiveInteger(1.5), false, 'float');
  assert.equal(isPositiveInteger('5'), false, 'numeric string');
  assert.equal(isPositiveInteger(null), false, 'null');
});

// --- isTopLevelSearchableStringField ----------------------------------------

test('isTopLevelSearchableStringField: plain string or a string|null union is searchable', () => {
  assert.equal(isTopLevelSearchableStringField({ type: 'string' }), true, 'plain string');
  assert.equal(isTopLevelSearchableStringField({ type: ['string', 'null'] }), true, 'string|null');
});

test('isTopLevelSearchableStringField: a union with a non-string, non-null member is NOT searchable', () => {
  assert.equal(isTopLevelSearchableStringField({ type: ['string', 'number'] }), false, 'string|number');
  assert.equal(isTopLevelSearchableStringField({ type: 'number' }), false, 'number only');
  assert.equal(isTopLevelSearchableStringField({ type: ['integer', 'null'] }), false, 'no string at all');
});

// --- isReferenceCompatibleCursorSchema / range / min-max (same predicate) ---

test('isReferenceCompatibleCursorSchema: integer/number qualify; date-typed string qualifies', () => {
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'integer' }), true, 'integer');
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'number' }), true, 'number');
  assert.equal(isReferenceCompatibleCursorSchema({ type: ['integer', 'null'] }), true, 'integer|null still one non-null');
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'string', format: 'date' }), true, 'string date');
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'string', format: 'date-time' }), true, 'string date-time');
});

test('isReferenceCompatibleCursorSchema: plain string, multi-type union, or non-object are rejected', () => {
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'string' }), false, 'plain string (no date format)');
  assert.equal(isReferenceCompatibleCursorSchema({ type: ['integer', 'string'] }), false, 'two non-null types');
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'boolean' }), false, 'boolean');
  assert.equal(isReferenceCompatibleCursorSchema(null), false, 'non-object');
});

test('isRangeQueryableFieldSchema and isMinMaxAggregateFieldSchema delegate to the cursor predicate', () => {
  for (const schema of [{ type: 'integer' }, { type: 'string', format: 'date' }, { type: 'string' }, { type: 'boolean' }]) {
    const expected = isReferenceCompatibleCursorSchema(schema);
    assert.equal(isRangeQueryableFieldSchema(schema), expected, `range parity for ${JSON.stringify(schema)}`);
    assert.equal(isMinMaxAggregateFieldSchema(schema), expected, `min/max parity for ${JSON.stringify(schema)}`);
  }
});

// --- isNumericAggregateFieldSchema ------------------------------------------

test('isNumericAggregateFieldSchema: exactly one non-null integer/number type', () => {
  assert.equal(isNumericAggregateFieldSchema({ type: 'number' }), true);
  assert.equal(isNumericAggregateFieldSchema({ type: ['integer', 'null'] }), true);
  assert.equal(isNumericAggregateFieldSchema({ type: 'string' }), false, 'string');
  assert.equal(isNumericAggregateFieldSchema({ type: ['integer', 'string'] }), false, 'ambiguous union');
});

// --- isScalarAggregateGroupFieldSchema --------------------------------------

test('isScalarAggregateGroupFieldSchema: boolean/integer/number/string qualify, containers do not', () => {
  for (const t of ['boolean', 'integer', 'number', 'string']) {
    assert.equal(isScalarAggregateGroupFieldSchema({ type: t }), true, `${t} groups`);
  }
  assert.equal(isScalarAggregateGroupFieldSchema({ type: 'array' }), false, 'array');
  assert.equal(isScalarAggregateGroupFieldSchema({ type: 'object' }), false, 'object');
  assert.equal(isScalarAggregateGroupFieldSchema({ type: ['string', 'number'] }), false, 'union');
});

// --- isTimeBucketAggregateFieldSchema ---------------------------------------

test('isTimeBucketAggregateFieldSchema: a string typed with a date/date-time format', () => {
  assert.equal(isTimeBucketAggregateFieldSchema({ type: 'string', format: 'date' }), true, 'date');
  assert.equal(isTimeBucketAggregateFieldSchema({ type: 'string', format: 'date-time' }), true, 'date-time');
  assert.equal(isTimeBucketAggregateFieldSchema({ type: 'string' }), false, 'string with no format');
  assert.equal(isTimeBucketAggregateFieldSchema({ type: 'string', format: 'email' }), false, 'non-date format');
  assert.equal(isTimeBucketAggregateFieldSchema({ type: 'number', format: 'date' }), false, 'number is not a time bucket');
});
