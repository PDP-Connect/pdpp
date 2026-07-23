// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateProgressAttachmentHydrationFailureOutcome,
  validateProgressAttachmentRecoveryOutcome,
  validateProgressProviderBudget,
} from '../runtime/progress-validators.js';

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

const validAttachmentRecoveryOutcome = {
  admitted: 2,
  admitted_bytes: 200_000,
  attempted: 3,
  hydration_failed: 0,
  lookup_miss: 0,
  metadata_lookups: 3,
  object: 'attachment_recovery_outcome',
  recovered: 2,
  run_cap_deferred: 3,
  served: 5,
};

const validAttachmentHydrationFailureOutcome = {
  blob_upload_http_4xx: 1,
  blob_upload_http_5xx: 2,
  blob_upload_integrity_failed: 3,
  blob_upload_invalid_response: 4,
  blob_upload_transport_failed: 5,
  imap_download_failed: 6,
  object: 'attachment_hydration_failure_outcome',
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

test('validateProgressAttachmentRecoveryOutcome: accepts the complete aggregate-only shape', () => {
  assert.doesNotThrow(() => validateProgressAttachmentRecoveryOutcome(validAttachmentRecoveryOutcome));
});

test('validateProgressAttachmentRecoveryOutcome: rejects private fields and non-integer counts', () => {
  assert.throws(
    () => validateProgressAttachmentRecoveryOutcome({ ...validAttachmentRecoveryOutcome, gap_id: 'private-gap' }),
    /unexpected field/,
  );
  assert.throws(
    () => validateProgressAttachmentRecoveryOutcome({ ...validAttachmentRecoveryOutcome, lookup_miss: 0.5 }),
    /lookup_miss: expected non-negative integer/,
  );
});

test('validateProgressAttachmentHydrationFailureOutcome: accepts only the complete aggregate-only stage shape', () => {
  assert.doesNotThrow(() => validateProgressAttachmentHydrationFailureOutcome(validAttachmentHydrationFailureOutcome));
  for (const privateField of ['record_key', 'detail_locator', 'filename', 'url', 'message', 'body', 'http_status', 'credential']) {
    assert.throws(
      () => validateProgressAttachmentHydrationFailureOutcome({ ...validAttachmentHydrationFailureOutcome, [privateField]: 'private-value' }),
      /unexpected field/,
      `${privateField} must not cross the terminal telemetry boundary`,
    );
  }
});

test('validateProgressAttachmentHydrationFailureOutcome: rejects an invalid discriminator and non-integer count', () => {
  assert.throws(
    () => validateProgressAttachmentHydrationFailureOutcome({ ...validAttachmentHydrationFailureOutcome, object: 'wrong' }),
    /attachment_hydration_failure_outcome.object/,
  );
  assert.throws(
    () => validateProgressAttachmentHydrationFailureOutcome({ ...validAttachmentHydrationFailureOutcome, imap_download_failed: 0.5 }),
    /imap_download_failed: expected non-negative integer/,
  );
  assert.throws(
    () => validateProgressAttachmentHydrationFailureOutcome({ ...validAttachmentHydrationFailureOutcome, imap_download_failed: -1 }),
    /imap_download_failed: expected non-negative integer/,
  );
});
