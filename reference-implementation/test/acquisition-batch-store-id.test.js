/**
 * Unit test for the pure acquisition-batch id derivation.
 *
 * acquisition-batch-store.js's only pure export is makeAcquisitionBatchId (the
 * store factories need a DB). It had no co-named test. The id is a stable,
 * field-sensitive content hash used as the batch primary key, so it is worth
 * pinning: prefix, width, determinism, and sensitivity to every input field.
 * Named *-id to avoid colliding with any future DB-backed store test file.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { makeAcquisitionBatchId } from '../server/stores/acquisition-batch-store.ts';

test('makeAcquisitionBatchId carries the ab_ prefix and a 24-hex-char body', () => {
  const id = makeAcquisitionBatchId('owner', 'gmail', 'sha256abc');
  assert.match(id, /^ab_[0-9a-f]{24}$/);
});

test('makeAcquisitionBatchId is deterministic for identical inputs', () => {
  assert.equal(
    makeAcquisitionBatchId('owner', 'gmail', 'sha'),
    makeAcquisitionBatchId('owner', 'gmail', 'sha'),
  );
});

test('makeAcquisitionBatchId is sensitive to each field', () => {
  const base = makeAcquisitionBatchId('owner', 'gmail', 'sha');
  assert.notEqual(base, makeAcquisitionBatchId('owner2', 'gmail', 'sha'));
  assert.notEqual(base, makeAcquisitionBatchId('owner', 'amazon', 'sha'));
  assert.notEqual(base, makeAcquisitionBatchId('owner', 'gmail', 'sha2'));
});

test('makeAcquisitionBatchId uses newline-delimited fields (no cross-field collision)', () => {
  // If the fields were concatenated without a separator, ("ab","c") and
  // ("a","bc") would collide; the newline delimiter prevents that.
  assert.notEqual(
    makeAcquisitionBatchId('ab', 'c', 'x'),
    makeAcquisitionBatchId('a', 'bc', 'x'),
  );
});
