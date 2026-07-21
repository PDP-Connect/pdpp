// Pure, no-DB unit tests for operations/read-projection.ts — the shared read-side
// field-projection helpers. No test imports this module by name. These implement
// the `fields` query-param contract used across read operations: parse the field
// list, then whitelist a record's data down to those fields.
//
// Mutation surface:
//   normalizeProjectionFields -- array OR comma-string input, flattens nested
//     commas, trims, drops blanks, DEDUPES, and returns null for an empty result.
//   projectRecordEnvelope -- when the record has a plain-object `data`, projects
//     `data` (preserving sibling envelope fields like id); otherwise projects the
//     record itself; no/empty fields -> the record unchanged; whitelist semantics
//     (only present, requested keys survive).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeProjectionFields,
  projectRecordEnvelope,
} from '../operations/read-projection.ts';

// ---------------------------------------------------------------------------
// normalizeProjectionFields
// ---------------------------------------------------------------------------

test('normalizeProjectionFields: a comma string is split into fields', () => {
  assert.deepEqual(normalizeProjectionFields('a,b,c'), ['a', 'b', 'c']);
});

test('normalizeProjectionFields: an array of fields passes through', () => {
  assert.deepEqual(normalizeProjectionFields(['a', 'b']), ['a', 'b']);
});

test('normalizeProjectionFields: nested commas inside array entries are flattened', () => {
  assert.deepEqual(normalizeProjectionFields(['a,b', 'c']), ['a', 'b', 'c']);
});

test('normalizeProjectionFields: trims whitespace, drops blanks, and DEDUPES', () => {
  assert.deepEqual(normalizeProjectionFields(' a , a , b , '), ['a', 'b'], 'dedup + trim + drop empties');
});

test('normalizeProjectionFields: empty / whitespace / non-string-non-array -> null', () => {
  assert.equal(normalizeProjectionFields(''), null);
  assert.equal(normalizeProjectionFields('   '), null, 'only-whitespace yields no fields -> null');
  assert.equal(normalizeProjectionFields([]), null);
  assert.equal(normalizeProjectionFields(null), null);
  assert.equal(normalizeProjectionFields(42), null, 'a bare number is not a field spec');
});

// ---------------------------------------------------------------------------
// projectRecordEnvelope
// ---------------------------------------------------------------------------

test('projectRecordEnvelope: projects the data sub-object, preserving envelope siblings', () => {
  const out = projectRecordEnvelope({ id: 'rec-1', object: 'record', data: { a: 1, b: 2, c: 3 } }, ['a', 'c']);
  assert.deepEqual(out.data, { a: 1, c: 3 }, 'only requested data fields survive');
  assert.equal(out.id, 'rec-1', 'envelope id preserved');
  assert.equal(out.object, 'record', 'envelope object preserved');
});

test('projectRecordEnvelope: a record without a data object is projected directly', () => {
  const out = projectRecordEnvelope({ a: 1, b: 2, c: 3 }, ['a']);
  assert.deepEqual(out, { a: 1 });
});

test('projectRecordEnvelope: no / empty fields returns the record unchanged', () => {
  const record = { id: '1', data: { a: 1 } };
  assert.equal(projectRecordEnvelope(record, null), record, 'null fields -> unchanged (same ref)');
  assert.equal(projectRecordEnvelope(record, []), record, 'empty fields -> unchanged');
});

test('projectRecordEnvelope: a requested field absent from data simply does not appear (no undefined key)', () => {
  const out = projectRecordEnvelope({ id: '1', data: { a: 1 } }, ['a', 'missing']);
  assert.deepEqual(out.data, { a: 1 }, 'absent requested field is omitted, not set to undefined');
  assert.ok(!('missing' in out.data), 'no phantom key created');
});

test('projectRecordEnvelope: an array-valued data is NOT treated as a projectable object', () => {
  // data is an array -> the not-a-plain-object branch projects the record itself.
  const out = projectRecordEnvelope({ id: '1', data: [1, 2, 3] }, ['id']);
  assert.deepEqual(out, { id: '1' }, 'array data falls through to record-level projection');
});
