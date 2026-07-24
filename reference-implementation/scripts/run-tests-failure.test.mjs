// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { combineTestAndCleanupFailure, testProcessExitFailure } from './run-tests-failure.js';

test('runner preserves spawn and cleanup failures together', () => {
  const spawnError = new Error('spawn failed');
  const cleanupError = new Error('drop failed');
  const failure = combineTestAndCleanupFailure(spawnError, cleanupError, 'could not start test process');

  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(failure.errors, [spawnError, cleanupError]);
});

test('runner preserves failed child output and cleanup failure together', () => {
  const output = '\n==> test/example.test.js\nnot ok 1 - expected pass\n';
  const childError = testProcessExitFailure('test/example.test.js', 1, null, output);
  const cleanupError = new Error('drop failed');
  const failure = combineTestAndCleanupFailure(childError, cleanupError, 'test process failed');

  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(failure.errors, [childError, cleanupError]);
  assert.equal(failure.errors[0].output, output);
});
