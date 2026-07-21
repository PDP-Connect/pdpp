import assert from 'node:assert/strict';
import test from 'node:test';

import { validateProgressProviderBudget } from '../runtime/progress-validators.js';

const validProviderBudget = {
  object: 'provider_budget_circuit_transition',
  circuit: {
    previous_state: 'closed',
    state: 'half_open',
    reason: 'provider_throttle',
    trigger: 'before_request',
  },
  elapsed_ms: 0,
  request_count: 1,
  retry_tokens_remaining: 'unbounded',
};

function expectInvalidProviderBudget(value, messageFragment) {
  assert.throws(
    () => validateProgressProviderBudget(value),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes(messageFragment),
        `expected "${err.message}" to include "${messageFragment}"`,
      );
      return true;
    },
  );
}

test('validateProgressProviderBudget: valid provider_budget_circuit_transition envelopes pass', () => {
  assert.doesNotThrow(() => validateProgressProviderBudget(validProviderBudget));
});

test('validateProgressProviderBudget: provider_budget envelope must be an object with the discriminator', () => {
  expectInvalidProviderBudget(null, 'PROGRESS.provider_budget: expected object');
  expectInvalidProviderBudget([], 'PROGRESS.provider_budget: expected object');
  expectInvalidProviderBudget(
    { ...validProviderBudget, object: 'collection_rate' },
    'PROGRESS.provider_budget.object',
  );
});

test('validateProgressProviderBudget: circuit transition details must be supported', () => {
  const missingCircuit = { ...validProviderBudget };
  delete missingCircuit.circuit;

  expectInvalidProviderBudget(missingCircuit, 'PROGRESS.provider_budget.circuit');
  expectInvalidProviderBudget(
    { ...validProviderBudget, circuit: { ...validProviderBudget.circuit, previous_state: 'retrying' } },
    'PROGRESS.provider_budget.circuit.previous_state',
  );
  expectInvalidProviderBudget(
    { ...validProviderBudget, circuit: { ...validProviderBudget.circuit, state: 'retrying' } },
    'PROGRESS.provider_budget.circuit.state',
  );
  expectInvalidProviderBudget(
    { ...validProviderBudget, circuit: { ...validProviderBudget.circuit, reason: 'backpressure' } },
    'PROGRESS.provider_budget.circuit.reason',
  );
  expectInvalidProviderBudget(
    { ...validProviderBudget, circuit: { ...validProviderBudget.circuit, trigger: 'timer' } },
    'PROGRESS.provider_budget.circuit.trigger',
  );
});

test('validateProgressProviderBudget: counters and retry capacity must be bounded when numeric', () => {
  expectInvalidProviderBudget(
    { ...validProviderBudget, elapsed_ms: -1 },
    'PROGRESS.provider_budget.elapsed_ms',
  );
  expectInvalidProviderBudget(
    { ...validProviderBudget, request_count: -1 },
    'PROGRESS.provider_budget.request_count',
  );
  expectInvalidProviderBudget(
    { ...validProviderBudget, retry_tokens_remaining: -1 },
    'PROGRESS.provider_budget.retry_tokens_remaining',
  );
  expectInvalidProviderBudget(
    { ...validProviderBudget, retry_tokens_remaining: Infinity },
    'PROGRESS.provider_budget.retry_tokens_remaining',
  );
});
