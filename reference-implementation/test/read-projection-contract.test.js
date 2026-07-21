// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeProjectionFields,
  projectRecordEnvelope,
} from '../operations/read-projection.ts';

// Mutation-killing unit tests for the pure record-projection read helper
// (`operations/read-projection.ts`). This module shapes the field-projection
// contract shared by `rs.records.list` and `rs.records.detail`: it normalizes
// the caller-supplied `fields` selector (array | comma-string | absent) into a
// deduped, whitespace-trimmed list — or `null` to mean "no projection" — and
// then projects a record envelope down to those fields, preferring the nested
// `data` payload when present and falling back to the flat record otherwise.
//
// No DB, no I/O: every assertion pins observable output for a fixed input so a
// behavior change to any branch flips a test.

// --------------------------------------------------------------------------
// normalizeProjectionFields
// --------------------------------------------------------------------------

test('normalizeProjectionFields: absent / empty inputs collapse to null (no-projection sentinel)', () => {
  // null / undefined / non-string-non-array => empty raw => null, NOT [].
  assert.equal(normalizeProjectionFields(undefined), null);
  assert.equal(normalizeProjectionFields(null), null);
  assert.equal(normalizeProjectionFields(42), null);
  assert.equal(normalizeProjectionFields({}), null);
  assert.equal(normalizeProjectionFields(true), null);

  // Empty string and empty array also collapse to null, not [].
  assert.equal(normalizeProjectionFields(''), null);
  assert.equal(normalizeProjectionFields([]), null);

  // A string of only separators / whitespace yields no fields => null.
  assert.equal(normalizeProjectionFields(',,'), null);
  assert.equal(normalizeProjectionFields('   '), null);
  assert.equal(normalizeProjectionFields([' ', '']), null);
});

test('normalizeProjectionFields: string input splits on comma and trims', () => {
  assert.deepEqual(normalizeProjectionFields('a,b,c'), ['a', 'b', 'c']);
  assert.deepEqual(normalizeProjectionFields(' a , b , c '), ['a', 'b', 'c']);
  // Single field, no comma.
  assert.deepEqual(normalizeProjectionFields('only'), ['only']);
});

test('normalizeProjectionFields: array input is accepted and each entry re-split on comma', () => {
  assert.deepEqual(normalizeProjectionFields(['a', 'b']), ['a', 'b']);
  // Each array entry is itself comma-split — a nested "a,b" fans out.
  assert.deepEqual(normalizeProjectionFields(['a,b', 'c']), ['a', 'b', 'c']);
  // Non-string entries are coerced via String() before splitting.
  assert.deepEqual(normalizeProjectionFields([1, 2]), ['1', '2']);
});

test('normalizeProjectionFields: de-duplicates while preserving first-seen order', () => {
  assert.deepEqual(normalizeProjectionFields('a,b,a,c,b'), ['a', 'b', 'c']);
  assert.deepEqual(normalizeProjectionFields(['a', 'a,b', 'b']), ['a', 'b']);
  // Order is first-seen, not sorted: 'c' before 'a' stays that way.
  assert.deepEqual(normalizeProjectionFields('c,a,c'), ['c', 'a']);
});

test('normalizeProjectionFields: returns a real array (Set is spread out)', () => {
  const out = normalizeProjectionFields('a,b');
  assert.ok(Array.isArray(out));
  assert.equal(out.length, 2);
});

// --------------------------------------------------------------------------
// projectRecordEnvelope
// --------------------------------------------------------------------------

test('projectRecordEnvelope: null / empty field list returns the record untouched (same reference)', () => {
  const rec = { id: 'r1', data: { a: 1, b: 2 } };
  assert.equal(projectRecordEnvelope(rec, null), rec);
  assert.equal(projectRecordEnvelope(rec, undefined), rec);
  assert.equal(projectRecordEnvelope(rec, []), rec);
});

test('projectRecordEnvelope: projects the nested `data` object, keeping the envelope intact', () => {
  const rec = { id: 'r1', stream: 's', data: { a: 1, b: 2, c: 3 } };
  const out = projectRecordEnvelope(rec, ['a', 'c']);
  assert.deepEqual(out, { id: 'r1', stream: 's', data: { a: 1, c: 3 } });
  // Envelope-level keys are NOT filtered — only `data` is narrowed.
  assert.equal(out.id, 'r1');
  assert.equal(out.stream, 's');
  // Original record is not mutated.
  assert.deepEqual(rec.data, { a: 1, b: 2, c: 3 });
});

test('projectRecordEnvelope: unknown fields are simply omitted (no undefined keys added)', () => {
  const rec = { id: 'r1', data: { a: 1 } };
  const out = projectRecordEnvelope(rec, ['a', 'missing']);
  assert.deepEqual(out, { id: 'r1', data: { a: 1 } });
  assert.ok(!Object.prototype.hasOwnProperty.call(out.data, 'missing'));
});

test('projectRecordEnvelope: falls back to flat projection when `data` is absent', () => {
  const rec = { id: 'r1', title: 't', extra: 'x' };
  const out = projectRecordEnvelope(rec, ['id', 'title']);
  assert.deepEqual(out, { id: 'r1', title: 't' });
  // `extra` dropped because there is no `data` object to preserve the envelope.
  assert.ok(!Object.prototype.hasOwnProperty.call(out, 'extra'));
});

test('projectRecordEnvelope: `data` that is an array is treated as flat (not the nested branch)', () => {
  // Array data fails the `!Array.isArray` guard, so the flat branch runs and
  // projects the top-level record — selecting `id` keeps it, `data` dropped.
  const rec = { id: 'r1', data: [1, 2, 3] };
  const out = projectRecordEnvelope(rec, ['id']);
  assert.deepEqual(out, { id: 'r1' });
  assert.ok(!Object.prototype.hasOwnProperty.call(out, 'data'));
});

test('projectRecordEnvelope: `data` that is null is treated as flat', () => {
  const rec = { id: 'r1', data: null, keep: 'k' };
  const out = projectRecordEnvelope(rec, ['id', 'data']);
  // Flat branch: both `id` and (present-but-null) `data` are kept, `keep` dropped.
  assert.deepEqual(out, { id: 'r1', data: null });
});

test('projectRecordEnvelope: only own-enumerable keys are copied (inherited props ignored)', () => {
  const proto = { inherited: 'nope' };
  const data = Object.create(proto);
  data.own = 'yes';
  const rec = { id: 'r1', data };
  const out = projectRecordEnvelope(rec, ['own', 'inherited']);
  // `inherited` lives on the prototype and must NOT be picked up.
  assert.deepEqual(out, { id: 'r1', data: { own: 'yes' } });
});
