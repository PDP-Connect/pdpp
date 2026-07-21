// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit coverage for the record read-model field-projection helpers in
 * `operations/read-projection.ts`.
 *
 * These two pure functions back the `fields=` projection on the public read
 * surface: `rs-records-list` (MCP `query_records` / REST list) and
 * `rs-records-detail` (`fetch`) both import them to shape the record envelope a
 * grant-scoped client sees. The contract they encode:
 *
 *   normalizeProjectionFields(value):
 *     - accepts an array OR a comma-string OR anything else;
 *     - splits every entry on ",", trims, drops empties;
 *     - de-duplicates preserving first-seen order;
 *     - returns null (NOT []) when nothing survives — the sentinel that means
 *       "no projection, return the full envelope".
 *
 *   projectRecordEnvelope(record, fields):
 *     - null/empty fields => identity (returns the SAME object reference);
 *     - when record.data is a plain object, projects INSIDE record.data and
 *       preserves the outer envelope keys;
 *     - otherwise projects the top-level record;
 *     - only own-enumerable keys that actually exist are copied (no undefined
 *       holes; prototype keys are never leaked).
 *
 * Pure, no DB, no server. Exact-output assertions so any field-mapping / filter
 * / dedupe / sentinel mutation flips a test red.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeProjectionFields,
  projectRecordEnvelope,
} from '../operations/read-projection.ts';

test('normalizeProjectionFields: array input trims, drops empties, de-dupes preserving order', () => {
  const out = normalizeProjectionFields([' a ', 'b', 'a', '', '  ', 'c']);
  assert.deepEqual(out, ['a', 'b', 'c'], `got ${JSON.stringify(out)}`);
});

test('normalizeProjectionFields: comma-string input is split, trimmed, de-duped', () => {
  const out = normalizeProjectionFields('id, amount ,id,  , merchant');
  assert.deepEqual(out, ['id', 'amount', 'merchant'], `got ${JSON.stringify(out)}`);
});

test('normalizeProjectionFields: array entries that themselves contain commas are re-split', () => {
  // Each array entry is String()'d then split on "," again — a nested
  // "a,b" entry must expand to two fields, not stay one.
  const out = normalizeProjectionFields(['a,b', 'c']);
  assert.deepEqual(out, ['a', 'b', 'c'], `got ${JSON.stringify(out)}`);
});

test('normalizeProjectionFields: empty / whitespace / undefined => null sentinel (NOT [])', () => {
  assert.equal(normalizeProjectionFields([]), null, 'empty array');
  assert.equal(normalizeProjectionFields(''), null, 'empty string');
  assert.equal(normalizeProjectionFields('   ,  , '), null, 'all-whitespace/comma string');
  assert.equal(normalizeProjectionFields(undefined), null, 'undefined');
  assert.equal(normalizeProjectionFields(null), null, 'null');
  assert.equal(normalizeProjectionFields(42), null, 'number (non-array, non-string)');
});

test('normalizeProjectionFields: single surviving field returns a one-element array, not null', () => {
  const out = normalizeProjectionFields('  only  ');
  assert.deepEqual(out, ['only'], `got ${JSON.stringify(out)}`);
});

test('projectRecordEnvelope: null/empty fields is identity and returns the SAME reference', () => {
  const record = { id: 'r1', data: { a: 1, b: 2 } };
  assert.equal(projectRecordEnvelope(record, null), record, 'null fields must be pass-through by reference');
  assert.equal(projectRecordEnvelope(record, []), record, 'empty fields must be pass-through by reference');
  assert.equal(projectRecordEnvelope(record, undefined), record, 'undefined fields must be pass-through by reference');
});

test('projectRecordEnvelope: projects INSIDE record.data and preserves outer envelope keys', () => {
  const record = {
    id: 'r1',
    stream: 'orders',
    data: { amount: 10, merchant: 'acme', currency: 'USD' },
  };
  const out = projectRecordEnvelope(record, ['amount', 'currency']);
  assert.deepEqual(
    out,
    { id: 'r1', stream: 'orders', data: { amount: 10, currency: 'USD' } },
    `got ${JSON.stringify(out)}`,
  );
  // Must be a new object (data reshaped), not the original reference.
  assert.notEqual(out, record, 'should not return original when projecting');
  assert.notEqual(out.data, record.data, 'data should be a fresh projected object');
  // Original must be untouched (no mutation of input).
  assert.deepEqual(
    record.data,
    { amount: 10, merchant: 'acme', currency: 'USD' },
    'input record.data must not be mutated',
  );
});

test('projectRecordEnvelope: missing requested data field is simply absent (no undefined hole)', () => {
  const record = { id: 'r1', data: { amount: 10 } };
  const out = projectRecordEnvelope(record, ['amount', 'missing']);
  assert.deepEqual(out, { id: 'r1', data: { amount: 10 } }, `got ${JSON.stringify(out)}`);
  assert.equal('missing' in out.data, false, '"missing" must not be an own key');
});

test('projectRecordEnvelope: with no data object, projects the top-level record', () => {
  const record = { id: 'r1', stream: 'orders', amount: 10 };
  const out = projectRecordEnvelope(record, ['id', 'amount']);
  assert.deepEqual(out, { id: 'r1', amount: 10 }, `got ${JSON.stringify(out)}`);
});

test('projectRecordEnvelope: array-valued data is treated as top-level, not projected-into', () => {
  // record.data is an array => the `!Array.isArray` guard fails, so the whole
  // record is projected at the top level; "data" is not among fields => dropped.
  const record = { id: 'r1', data: [1, 2, 3] };
  const out = projectRecordEnvelope(record, ['id']);
  assert.deepEqual(out, { id: 'r1' }, `got ${JSON.stringify(out)}`);
});

test('projectRecordEnvelope: null data is treated as top-level (typeof null === object but falsy guard)', () => {
  const record = { id: 'r1', data: null, extra: 'x' };
  const out = projectRecordEnvelope(record, ['id', 'data']);
  // record.data is null => falsy => top-level projection; "data" IS requested
  // and is an own key, so it is copied (value null).
  assert.deepEqual(out, { id: 'r1', data: null }, `got ${JSON.stringify(out)}`);
  assert.equal('data' in out, true);
  assert.equal(out.data, null);
});

test('projectRecordEnvelope: prototype-inherited keys are never leaked into the projection', () => {
  const proto = { inherited: 'nope' };
  const data = Object.create(proto);
  data.amount = 10;
  const record = { id: 'r1', data };
  const out = projectRecordEnvelope(record, ['amount', 'inherited']);
  assert.deepEqual(out, { id: 'r1', data: { amount: 10 } }, `got ${JSON.stringify(out)}`);
  assert.equal('inherited' in out.data, false, 'inherited proto key must not be copied');
});
