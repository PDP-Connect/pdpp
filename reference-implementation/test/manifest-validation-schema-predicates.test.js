// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure, no-DB unit tests for the schema-shape PREDICATES + blob_ref validator in
// server/connector-manifest-validation.ts. The module's one existing test
// (manifest-sensitivity.test.js) covers only sensitivity; these 8 pure functions
// were unpinned by name. They gate what a connector manifest may declare as
// searchable / cursorable / range-filterable / aggregatable, so a wrong verdict
// silently admits an unqueryable field or rejects a valid one.
//
// Mutation surface:
//   isTopLevelSearchableStringField -- 'string' or an array of only string/null.
//   isReferenceCompatibleCursorSchema -- exactly one non-null type; integer/number
//     always, string ONLY with format date|date-time. (isRangeQueryableFieldSchema
//     and isMinMaxAggregateFieldSchema alias this.)
//   schemaTypeIncludes -- scalar-or-array type membership.
//   isNumericAggregateFieldSchema / isScalarAggregateGroupFieldSchema /
//     isTimeBucketAggregateFieldSchema -- aggregation field-type gates.
//   isPositiveInteger -- integer AND > 0.
//   validateBlobRefSchemaDeclaration -- blob_ref object shape (typed props +
//     required blob_id), throws invalid_request-coded errors.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isNumericAggregateFieldSchema,
  isPositiveInteger,
  isRangeQueryableFieldSchema,
  isReferenceCompatibleCursorSchema,
  isScalarAggregateGroupFieldSchema,
  isTimeBucketAggregateFieldSchema,
  isTopLevelSearchableStringField,
  schemaTypeIncludes,
  validateBlobRefSchemaDeclaration,
} from '../server/connector-manifest-validation.ts';

// ---------------------------------------------------------------------------
// isTopLevelSearchableStringField
// ---------------------------------------------------------------------------

test('isTopLevelSearchableStringField: plain string and nullable-string array pass', () => {
  assert.equal(isTopLevelSearchableStringField({ type: 'string' }), true);
  assert.equal(isTopLevelSearchableStringField({ type: ['string', 'null'] }), true);
});

test('isTopLevelSearchableStringField: mixed or non-string types fail', () => {
  assert.equal(isTopLevelSearchableStringField({ type: ['string', 'integer'] }), false, 'string+integer is not purely string');
  assert.equal(isTopLevelSearchableStringField({ type: 'integer' }), false);
  assert.equal(isTopLevelSearchableStringField({ type: ['null'] }), false, 'no string member');
  assert.equal(isTopLevelSearchableStringField(null), false);
});

// ---------------------------------------------------------------------------
// isReferenceCompatibleCursorSchema (and its range/minmax aliases)
// ---------------------------------------------------------------------------

test('isReferenceCompatibleCursorSchema: integer/number single types are compatible', () => {
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'integer' }), true);
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'number' }), true);
  assert.equal(isReferenceCompatibleCursorSchema({ type: ['integer', 'null'] }), true, 'nullable integer ok');
});

test('isReferenceCompatibleCursorSchema: string is compatible ONLY with date/date-time format', () => {
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'string', format: 'date' }), true);
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'string', format: 'date-time' }), true);
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'string' }), false, 'plain string not cursorable');
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'string', format: 'email' }), false, 'non-date format not cursorable');
});

test('isReferenceCompatibleCursorSchema: multiple non-null types or boolean are not compatible', () => {
  assert.equal(isReferenceCompatibleCursorSchema({ type: ['integer', 'string'] }), false, 'two non-null types');
  assert.equal(isReferenceCompatibleCursorSchema({ type: 'boolean' }), false);
  assert.equal(isReferenceCompatibleCursorSchema(null), false);
});

test('isRangeQueryableFieldSchema aliases the cursor-compat check', () => {
  assert.equal(isRangeQueryableFieldSchema({ type: 'integer' }), true);
  assert.equal(isRangeQueryableFieldSchema({ type: 'string' }), false);
});

// ---------------------------------------------------------------------------
// schemaTypeIncludes
// ---------------------------------------------------------------------------

test('schemaTypeIncludes: matches scalar type or array membership', () => {
  assert.equal(schemaTypeIncludes({ type: 'object' }, 'object'), true);
  assert.equal(schemaTypeIncludes({ type: ['object', 'null'] }, 'object'), true);
  assert.equal(schemaTypeIncludes({ type: ['string', 'null'] }, 'object'), false);
  assert.equal(schemaTypeIncludes(null, 'string'), false);
});

// ---------------------------------------------------------------------------
// aggregation field-type gates
// ---------------------------------------------------------------------------

test('isNumericAggregateFieldSchema: single integer/number only', () => {
  assert.equal(isNumericAggregateFieldSchema({ type: 'integer' }), true);
  assert.equal(isNumericAggregateFieldSchema({ type: ['number', 'null'] }), true);
  assert.equal(isNumericAggregateFieldSchema({ type: 'string' }), false);
  assert.equal(isNumericAggregateFieldSchema({ type: ['integer', 'string'] }), false);
});

test('isScalarAggregateGroupFieldSchema: boolean/integer/number/string scalar only', () => {
  for (const t of ['boolean', 'integer', 'number', 'string']) {
    assert.equal(isScalarAggregateGroupFieldSchema({ type: t }), true, `${t} is a scalar group field`);
  }
  assert.equal(isScalarAggregateGroupFieldSchema({ type: 'object' }), false);
  assert.equal(isScalarAggregateGroupFieldSchema({ type: ['string', 'integer'] }), false, 'ambiguous multi-type');
});

test('isTimeBucketAggregateFieldSchema: string with date/date-time format only', () => {
  assert.equal(isTimeBucketAggregateFieldSchema({ type: 'string', format: 'date' }), true);
  assert.equal(isTimeBucketAggregateFieldSchema({ type: ['string', 'null'], format: 'date-time' }), true);
  assert.equal(isTimeBucketAggregateFieldSchema({ type: 'string' }), false, 'no format -> not a time bucket');
  assert.equal(isTimeBucketAggregateFieldSchema({ type: 'integer' }), false, 'integer is not a date string');
});

// ---------------------------------------------------------------------------
// isPositiveInteger
// ---------------------------------------------------------------------------

test('isPositiveInteger: integer AND strictly greater than zero', () => {
  assert.equal(isPositiveInteger(1), true);
  assert.equal(isPositiveInteger(1000), true);
  assert.equal(isPositiveInteger(0), false, 'zero is not positive');
  assert.equal(isPositiveInteger(-1), false);
  assert.equal(isPositiveInteger(1.5), false, 'non-integer');
  assert.equal(isPositiveInteger('1'), false, 'string not accepted');
  assert.equal(isPositiveInteger(null), false);
});

// ---------------------------------------------------------------------------
// validateBlobRefSchemaDeclaration
// ---------------------------------------------------------------------------

function validBlobRef() {
  return {
    type: 'object',
    properties: {
      blob_id: { type: 'string' },
      mime_type: { type: 'string' },
      size_bytes: { type: 'integer' },
      sha256: { type: 'string' },
    },
    required: ['blob_id'],
  };
}

function expectManifestReject(fn) {
  assert.throws(fn, (err) => {
    assert.equal(err.code, 'invalid_request', `expected invalid_request, got ${err.code}`);
    return true;
  });
}

test('validateBlobRefSchemaDeclaration: a well-formed blob_ref object passes', () => {
  assert.doesNotThrow(() => validateBlobRefSchemaDeclaration({ name: 'files' }, validBlobRef(), 'invalid_request'));
});

test('validateBlobRefSchemaDeclaration: a non-object blob_ref is rejected', () => {
  expectManifestReject(() => validateBlobRefSchemaDeclaration({ name: 'files' }, { type: 'string' }, 'invalid_request'));
});

test('validateBlobRefSchemaDeclaration: a wrong-typed property is rejected', () => {
  const bad = validBlobRef();
  bad.properties.size_bytes = { type: 'string' }; // must be integer
  expectManifestReject(() => validateBlobRefSchemaDeclaration({ name: 'files' }, bad, 'invalid_request'));
});

test('validateBlobRefSchemaDeclaration: a missing required property declaration is rejected', () => {
  const bad = validBlobRef();
  delete bad.properties.sha256;
  expectManifestReject(() => validateBlobRefSchemaDeclaration({ name: 'files' }, bad, 'invalid_request'));
});

test('validateBlobRefSchemaDeclaration: blob_id must be in required[]', () => {
  const bad = validBlobRef();
  bad.required = []; // blob_id no longer required
  expectManifestReject(() => validateBlobRefSchemaDeclaration({ name: 'files' }, bad, 'invalid_request'));
});
