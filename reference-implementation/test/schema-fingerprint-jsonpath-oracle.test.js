// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure-logic oracle for four untested helpers in server/record-filters.js:
//   - getFieldSchema: safe lookup of a top-level property schema;
//   - nonNullSchemaTypes: the null-stripping type extractor that drives filter
//     coercion and range-queryability;
//   - fingerprintDeclaredFields: the reorder-stable declared-fields fingerprint
//     used to detect projection drift (dedup + sort + stringify);
//   - jsonPathForTopLevelField: the injection-safe `$."<field>"` builder that
//     escapes backslash THEN quote.
// All pure, all previously untested by name. No DB.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getFieldSchema,
  nonNullSchemaTypes,
  fingerprintDeclaredFields,
  jsonPathForTopLevelField,
} from '../server/record-filters.js';

test('getFieldSchema returns a top-level property schema or null', () => {
  const manifestStream = { schema: { properties: { a: { type: 'string' } } } };
  assert.deepEqual(getFieldSchema(manifestStream, 'a'), { type: 'string' });
  assert.equal(getFieldSchema(manifestStream, 'missing'), null);
  assert.equal(getFieldSchema(null, 'a'), null);
});

test('nonNullSchemaTypes strips the null member from a nullable union', () => {
  assert.deepEqual([...nonNullSchemaTypes({ type: 'string' })], ['string']);
  assert.deepEqual([...nonNullSchemaTypes({ type: ['string', 'null'] })], ['string']);
  assert.deepEqual([...nonNullSchemaTypes({ type: ['integer', 'string'] })], ['integer', 'string']);
  assert.equal(nonNullSchemaTypes({}).size, 0);
  assert.equal(nonNullSchemaTypes(null).size, 0);
});

test('fingerprintDeclaredFields is a reorder-stable, deduped, sorted fingerprint', () => {
  assert.equal(fingerprintDeclaredFields(['b', 'a', 'b', 'c']), '["a","b","c"]');
  // Reordering the same set yields an identical fingerprint (projection-drift stable).
  assert.equal(fingerprintDeclaredFields(['c', 'a', 'b']), fingerprintDeclaredFields(['a', 'b', 'c']));
  assert.equal(fingerprintDeclaredFields([]), '[]');
});

test('jsonPathForTopLevelField escapes backslash then quote so a key cannot break out', () => {
  assert.equal(jsonPathForTopLevelField('body'), '$."body"');
  assert.equal(jsonPathForTopLevelField('a"b'), '$."a\\"b"');
  assert.equal(jsonPathForTopLevelField('a\\b'), '$."a\\\\b"');
  // A key containing both: the backslash is doubled FIRST, then the quote escaped.
  assert.equal(jsonPathForTopLevelField('a\\"b'), '$."a\\\\\\"b"');
});
