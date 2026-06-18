// Pins the shared write-path record-identity guard used by both the SQLite and
// Postgres record stores. Before this guard, identity validation only checked
// `data.id`, so streams with a non-`id` primary key or a compound primary key
// received no identity validation at all (R2 / spec-core primary_key contract).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertRecordIdentity } from '../server/record-expand-helpers.js';

function identityError(fields, key, data) {
  try {
    assertRecordIdentity(fields, key, data);
    return null;
  } catch (err) {
    return err;
  }
}

test('single non-id primary key: data field must match the key', () => {
  // Stream keyed by account_number, not id.
  assert.equal(identityError(['account_number'], '12345', { account_number: '12345', balance: 10 }), null);

  const err = identityError(['account_number'], '12345', { account_number: '99999' });
  assert.ok(err, 'mismatched non-id key must throw');
  assert.equal(err.code, 'invalid_record_identity');
  assert.match(err.message, /account_number/);
});

test('compound primary key: every present field must match its key position', () => {
  const fields = ['account_id', 'txn_id'];
  assert.equal(identityError(fields, ['acc_1', 'txn_9'], { account_id: 'acc_1', txn_id: 'txn_9' }), null);

  const wrongSecond = identityError(fields, ['acc_1', 'txn_9'], { account_id: 'acc_1', txn_id: 'txn_X' });
  assert.ok(wrongSecond, 'mismatch on a compound key component must throw');
  assert.equal(wrongSecond.code, 'invalid_record_identity');
  assert.match(wrongSecond.message, /txn_id/);

  const wrongFirst = identityError(fields, ['acc_1', 'txn_9'], { account_id: 'acc_OTHER', txn_id: 'txn_9' });
  assert.ok(wrongFirst, 'mismatch on the first compound component must throw');
  assert.match(wrongFirst.message, /account_id/);
});

test('fields absent from data are not checked (key tuple may carry implied values)', () => {
  // account_id present and correct; txn_id omitted from data is allowed.
  assert.equal(identityError(['account_id', 'txn_id'], ['acc_1', 'txn_9'], { account_id: 'acc_1' }), null);
});

test('empty primary_key falls back to legacy data.id guard', () => {
  assert.equal(identityError([], 'rec_1', { id: 'rec_1' }), null);

  const err = identityError([], 'rec_1', { id: 'rec_DIFFERENT' });
  assert.ok(err, 'legacy data.id mismatch must still throw when no primary_key is known');
  assert.equal(err.code, 'invalid_record_identity');
});

test('single-element array key behaves like a one-field key', () => {
  assert.equal(identityError(['account_number'], ['12345'], { account_number: '12345' }), null);
  const err = identityError(['account_number'], ['12345'], { account_number: '0' });
  assert.ok(err);
  assert.equal(err.code, 'invalid_record_identity');
});

test('numeric vs string key values compare by string form (storage normalizes keys)', () => {
  // A record whose data carries a numeric id but whose key is the string form
  // must be accepted (keys are encoded as strings downstream).
  assert.equal(identityError(['id'], '42', { id: 42 }), null);
});

test('non-object data is a no-op (deletes / tombstones carry no data)', () => {
  assert.equal(identityError(['account_number'], '12345', null), null);
  assert.equal(identityError(['account_number'], '12345', undefined), null);
});
