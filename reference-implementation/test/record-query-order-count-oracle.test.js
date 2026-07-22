// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure-logic oracle for the query_records pagination / ordering / count-grade
// contract (server/record-query-helpers.ts). These validators decide the
// effective list order and the count/window vocabulary that every query_records
// response honors, and the cursor key round-trip — all pure, all previously
// UNTESTED by name. A silently weakened guard here would accept a sort no-op or
// mis-decode a compound cursor with no failing test. No DB.
//
// Spec: openspec/changes/canonicalize-public-read-contract

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parsePageOrder,
  resolveListOrder,
  validateCountKind,
  validateWindowKind,
  encodeKey,
  decodeKey,
} from '../server/record-query-helpers.ts';

function invalidWith(code, messageSubstring) {
  return (err) => {
    assert.equal(err.code, code, `expected code ${code}, got ${err.code}`);
    if (messageSubstring !== undefined) {
      assert.ok(err.message.includes(messageSubstring), `message should include ${JSON.stringify(messageSubstring)}, got ${JSON.stringify(err.message)}`);
    }
    return true;
  };
}

test('parsePageOrder defaults to DESC and maps asc/desc, rejecting anything else', () => {
  assert.equal(parsePageOrder(null), 'DESC');
  assert.equal(parsePageOrder(''), 'DESC');
  assert.equal(parsePageOrder('asc'), 'ASC');
  assert.equal(parsePageOrder('desc'), 'DESC');
  assert.throws(() => parsePageOrder('sideways'), invalidWith('invalid_request', 'order must be asc or desc'));
});

test('resolveListOrder: canonical sort wins; legacy order applies only when sort is absent', () => {
  // Sort present -> its direction wins regardless of order absence.
  assert.equal(resolveListOrder(null, { field: 'x', direction: 'ASC' }), 'ASC');
  // Sort absent -> legacy order decides.
  assert.equal(resolveListOrder('asc', null), 'ASC');
  assert.equal(resolveListOrder(null, null), 'DESC'); // both absent -> default DESC
});

test('resolveListOrder: agreeing sort+order is accepted; disagreement is rejected', () => {
  assert.equal(resolveListOrder('desc', { field: 'x', direction: 'DESC' }), 'DESC');
  assert.throws(
    () => resolveListOrder('asc', { field: 'x', direction: 'DESC' }),
    (err) => {
      assert.equal(err.code, 'invalid_sort');
      assert.equal(err.param, 'sort');
      assert.ok(err.message.includes('sort and order disagree'));
      return true;
    }
  );
});

test('validateCountKind accepts the canonical vocabulary and rejects others', () => {
  assert.doesNotThrow(() => validateCountKind(null));
  assert.doesNotThrow(() => validateCountKind(''));
  for (const kind of ['none', 'estimated', 'exact']) {
    assert.doesNotThrow(() => validateCountKind(kind));
  }
  assert.throws(() => validateCountKind('fuzzy'), invalidWith('invalid_request', 'count must be one of: none, estimated, exact'));
});

test('validateWindowKind accepts none/exact and rejects others', () => {
  assert.doesNotThrow(() => validateWindowKind(null));
  assert.doesNotThrow(() => validateWindowKind('none'));
  assert.doesNotThrow(() => validateWindowKind('exact'));
  // `estimated` is a count grade, NOT a window grade.
  assert.throws(() => validateWindowKind('estimated'), invalidWith('invalid_request', 'window must be one of: none, exact'));
});

test('encodeKey/decodeKey round-trips a compound (array) key and leaves scalar keys as strings', () => {
  assert.equal(encodeKey('abc'), 'abc');
  assert.equal(encodeKey(['a', 'b']), '["a","b"]');
  assert.deepEqual(decodeKey(encodeKey(['a', 'b'])), ['a', 'b']);
  assert.equal(decodeKey('abc'), 'abc');
  // A JSON scalar (non-array) decodes back to the ORIGINAL string, not the number.
  assert.equal(decodeKey('42'), '42');
});
