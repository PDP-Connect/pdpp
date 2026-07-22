// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the pure acquisition-batch id builder
// (server/stores/acquisition-batch-store.ts).
//
// `makeAcquisitionBatchId` is a deterministic content-address over
// (ownerSubjectId, connectorId, artifactSha256): a sha256 of the newline-
// joined tuple, prefixed `ab_` and truncated to 24 hex chars. Assertions pin
// the prefix, the length, determinism, and — critically — the newline
// separator that keeps field-boundary-shifted inputs from colliding.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

import { makeAcquisitionBatchId } from '../server/stores/acquisition-batch-store.ts';

test('makeAcquisitionBatchId is deterministic for the same inputs', () => {
  const a = makeAcquisitionBatchId('owner-1', 'github', 'sha-abc');
  const b = makeAcquisitionBatchId('owner-1', 'github', 'sha-abc');
  assert.equal(a, b);
});

test('makeAcquisitionBatchId has the ab_ prefix and a 24-hex-char body', () => {
  const id = makeAcquisitionBatchId('owner-1', 'github', 'sha-abc');
  assert.match(id, /^ab_[0-9a-f]{24}$/);
  assert.equal(id.length, 'ab_'.length + 24);
});

test('makeAcquisitionBatchId matches the sha256(prefix-joined) contract', () => {
  // Recompute independently: sha256("owner\nconnector\nsha") sliced to 24.
  const expected = `ab_${createHash('sha256').update('owner-1\ngithub\nsha-abc').digest('hex').slice(0, 24)}`;
  assert.equal(makeAcquisitionBatchId('owner-1', 'github', 'sha-abc'), expected);
});

test('makeAcquisitionBatchId is sensitive to each field', () => {
  const base = makeAcquisitionBatchId('owner-1', 'github', 'sha-abc');
  assert.notEqual(base, makeAcquisitionBatchId('owner-2', 'github', 'sha-abc'));
  assert.notEqual(base, makeAcquisitionBatchId('owner-1', 'gitlab', 'sha-abc'));
  assert.notEqual(base, makeAcquisitionBatchId('owner-1', 'github', 'sha-xyz'));
});

test('makeAcquisitionBatchId does not collide across shifted field boundaries', () => {
  // Without the newline separator, ('ab','c') and ('a','bc') would hash the
  // same concatenation. The '\n' delimiter must keep them distinct.
  assert.notEqual(
    makeAcquisitionBatchId('ab', 'c', 'x'),
    makeAcquisitionBatchId('a', 'bc', 'x')
  );
});
