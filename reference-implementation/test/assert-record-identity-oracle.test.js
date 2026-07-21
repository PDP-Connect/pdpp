// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure-logic oracle for assertRecordIdentity (server/record-expand-helpers.js),
// the shared write-path identity guard that keeps the SQLite and Postgres record
// stores from diverging: each manifest-declared primary-key field present in the
// record `data` must equal its position in the record's key tuple, else it
// throws Error with code 'invalid_record_identity'. Fields omitted from data,
// short key tuples, and null data are graceful skips. Previously untested by
// name. No DB.

import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRecordIdentity } from '../server/record-expand-helpers.js';

function identityError() {
  return (err) => {
    assert.equal(err.code, 'invalid_record_identity');
    return true;
  };
}

test('legacy id-guard (no primary-key fields): data.id must equal a single-part key', () => {
  assert.doesNotThrow(() => assertRecordIdentity([], 'k1', { id: 'k1' }));
  assert.throws(() => assertRecordIdentity([], 'k1', { id: 'other' }), identityError());
  // No data.id => nothing to check.
  assert.doesNotThrow(() => assertRecordIdentity([], 'k1', { foo: 'x' }));
});

test('compound key: each declared field present in data must match its key position', () => {
  assert.doesNotThrow(() => assertRecordIdentity(['a', 'b'], ['1', '2'], { a: '1', b: '2' }));
  assert.throws(
    () => assertRecordIdentity(['a', 'b'], ['1', '2'], { a: '1', b: '9' }),
    (err) => {
      assert.equal(err.code, 'invalid_record_identity');
      assert.ok(err.message.includes("primary-key field 'b'"));
      return true;
    }
  );
});

test('compound key: a field omitted from data is not checked', () => {
  assert.doesNotThrow(() => assertRecordIdentity(['a', 'b'], ['1', '2'], { a: '1' }));
});

test('compound key: a key tuple shorter than the declared fields skips missing key parts', () => {
  // data.b is present but the key tuple has no position 1 -> not a false mismatch.
  assert.doesNotThrow(() => assertRecordIdentity(['a', 'b'], ['1'], { a: '1', b: '2' }));
});

test('single-field key: a scalar string or number key stringifies for comparison', () => {
  assert.doesNotThrow(() => assertRecordIdentity(['a'], 'x', { a: 'x' }));
  assert.doesNotThrow(() => assertRecordIdentity(['a'], 5, { a: 5 }));
  assert.throws(() => assertRecordIdentity(['a'], 'x', { a: 'y' }), identityError());
});

test('null / non-object data is a no-op', () => {
  assert.doesNotThrow(() => assertRecordIdentity(['a'], 'x', null));
  assert.doesNotThrow(() => assertRecordIdentity(['a'], 'x', undefined));
  assert.doesNotThrow(() => assertRecordIdentity(['a'], 'x', 'not-an-object'));
});
