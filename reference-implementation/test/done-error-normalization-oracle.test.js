// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateDoneError } from '../runtime/done-validators.js';

test('validateDoneError returns null when DONE.error is absent', () => {
  assert.equal(validateDoneError('failed', null), null);
});

test('validateDoneError rejects terminal error details on succeeded DONE envelopes', () => {
  const result = validateDoneError('succeeded', { message: 'failed anyway' });

  assert.equal(result instanceof Error, true);
  assert.match(result.message, /succeeded runs must not include terminal error details/);
});

test('validateDoneError rejects non-object and array DONE.error inputs', () => {
  const nonObject = validateDoneError('failed', 'failed');
  const array = validateDoneError('failed', [{ message: 'failed' }]);

  assert.equal(nonObject instanceof Error, true);
  assert.match(nonObject.message, /expected object/);
  assert.equal(array instanceof Error, true);
  assert.match(array.message, /expected object/);
});

test('validateDoneError rejects unsupported fields and names the field', () => {
  const result = validateDoneError('failed', { message: 'failed', detail: 'too much' });

  assert.equal(result instanceof Error, true);
  assert.match(result.message, /unsupported fields detail/);
});

test('validateDoneError rejects invalid DONE.error.code strings', () => {
  const result = validateDoneError('failed', { code: 'ProviderThrottle', message: 'failed' });

  assert.equal(result instanceof Error, true);
  assert.match(result.message, /invalid DONE\.error\.code/);
});

test('validateDoneError rejects empty or whitespace-only DONE.error.message values', () => {
  const empty = validateDoneError('failed', { message: '' });
  const whitespace = validateDoneError('failed', { message: '   ' });

  assert.equal(empty instanceof Error, true);
  assert.match(empty.message, /invalid DONE\.error\.message/);
  assert.equal(whitespace instanceof Error, true);
  assert.match(whitespace.message, /invalid DONE\.error\.message/);
});

test('validateDoneError requires DONE.error.retryable to be boolean when present', () => {
  const result = validateDoneError('failed', { message: 'failed', retryable: 'false' });

  assert.equal(result instanceof Error, true);
  assert.match(result.message, /invalid DONE\.error\.retryable/);
});

test('validateDoneError normalizes valid failed DONE.error details', () => {
  assert.deepEqual(validateDoneError('failed', { code: 'provider_throttle_1', message: '  trimmed  ' }), {
    code: 'provider_throttle_1',
    message: 'trimmed',
    retryable: null,
  });
  assert.deepEqual(
    validateDoneError('failed', { code: 'provider_throttle_1', message: '  trimmed  ', retryable: false }),
    {
      code: 'provider_throttle_1',
      message: 'trimmed',
      retryable: false,
    },
  );
});
