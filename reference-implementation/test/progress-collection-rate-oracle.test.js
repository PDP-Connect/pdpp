// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { validateProgressCollectionRate } from '../runtime/progress-validators.js';

const validCollectionRate = {
  object: 'collection_rate',
  ceiling_interval_ms: 60000,
  ceiling_rate_per_min: 60,
  current_interval_ms: 1000,
  effective_rate_per_min: 30,
  last_backoff: null,
};

function expectInvalidCollectionRate(value, fieldName) {
  assert.throws(
    () => validateProgressCollectionRate(value),
    (err) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, new RegExp(`PROGRESS\\.collection_rate(?:\\.|:).*${fieldName}`));
      return true;
    },
  );
}

test('validateProgressCollectionRate: valid collection_rate envelopes pass', () => {
  assert.doesNotThrow(() => validateProgressCollectionRate(validCollectionRate));
  assert.doesNotThrow(() =>
    validateProgressCollectionRate({
      ...validCollectionRate,
      last_backoff: { at_interval_ms: 1000, reason: 'retry_after' },
    }),
  );
});

test('validateProgressCollectionRate: collection_rate envelope must be an object with the discriminator', () => {
  expectInvalidCollectionRate(null, 'expected object');
  expectInvalidCollectionRate([], 'expected object');
  expectInvalidCollectionRate({ ...validCollectionRate, object: 'provider_budget_circuit_transition' }, 'object');
});

test('validateProgressCollectionRate: required rate fields must be non-negative numbers', () => {
  for (const fieldName of ['ceiling_interval_ms', 'ceiling_rate_per_min', 'current_interval_ms', 'effective_rate_per_min']) {
    const missingField = { ...validCollectionRate };
    delete missingField[fieldName];
    expectInvalidCollectionRate(missingField, fieldName);
    expectInvalidCollectionRate({ ...validCollectionRate, [fieldName]: -1 }, fieldName);
  }
});

test('validateProgressCollectionRate: last_backoff must be null or a bounded supported reason', () => {
  expectInvalidCollectionRate({ ...validCollectionRate, last_backoff: 'retry_after' }, 'last_backoff');
  expectInvalidCollectionRate({ ...validCollectionRate, last_backoff: { at_interval_ms: -1, reason: 'retry_after' } }, 'at_interval_ms');
  expectInvalidCollectionRate({ ...validCollectionRate, last_backoff: { at_interval_ms: 1000, reason: 'backpressure' } }, 'reason');
});
