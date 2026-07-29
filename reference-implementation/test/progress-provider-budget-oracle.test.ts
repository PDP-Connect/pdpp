const TOP_LEVEL_REGEX_1 = /unexpected field/;
const TOP_LEVEL_REGEX_2 = /lookup_miss: expected non-negative integer/;
const TOP_LEVEL_REGEX_3 = /unexpected field/;
const TOP_LEVEL_REGEX_4 = /attachment_hydration_failure_outcome.object/;
const TOP_LEVEL_REGEX_5 = /imap_download_failed: expected non-negative integer/;
const TOP_LEVEL_REGEX_6 = /imap_download_failed: expected non-negative integer/;
const TOP_LEVEL_REGEX_7 = /must be emitted together/;
const TOP_LEVEL_REGEX_8 = /must be emitted together/;
const TOP_LEVEL_REGEX_9 = /stage counters must sum/;

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import {
  validateProgressAttachmentHydrationFailureOutcome,
  validateProgressAttachmentHydrationFailureOutcomeSum,
  validateProgressAttachmentRecoveryOutcome,
  validateProgressProviderBudget,
} from "../runtime/progress-validators.ts";

const validProviderBudget = {
  circuit: {
    previous_state: "closed",
    reason: "provider_throttle",
    state: "half_open",
    trigger: "before_request",
  },
  elapsed_ms: 0,
  object: "provider_budget_circuit_transition",
  request_count: 1,
  retry_tokens_remaining: "unbounded",
};

const validAttachmentRecoveryOutcome = {
  admitted: 2,
  admitted_bytes: 200_000,
  attempted: 3,
  hydration_failed: 0,
  lookup_miss: 0,
  metadata_lookups: 3,
  object: "attachment_recovery_outcome",
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
  object: "attachment_hydration_failure_outcome",
  unclassified_failed: 7,
};

function expectInvalidProviderBudget(value: unknown, messageFragment: string): void {
  assert.throws(
    () => validateProgressProviderBudget(value),
    (err) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(messageFragment), `expected "${err.message}" to include "${messageFragment}"`);
      return true;
    }
  );
}

test("validateProgressProviderBudget: valid provider_budget_circuit_transition envelopes pass", () => {
  assert.doesNotThrow(() => validateProgressProviderBudget(validProviderBudget));
});

test("validateProgressProviderBudget: provider_budget envelope must be an object with the discriminator", () => {
  expectInvalidProviderBudget(null, "PROGRESS.provider_budget: expected object");
  expectInvalidProviderBudget([], "PROGRESS.provider_budget: expected object");
  expectInvalidProviderBudget({ ...validProviderBudget, object: "collection_rate" }, "PROGRESS.provider_budget.object");
});

test("validateProgressProviderBudget: circuit transition details must be supported", () => {
  const missingCircuit: Record<string, unknown> = { ...validProviderBudget };
  missingCircuit.circuit = undefined;

  expectInvalidProviderBudget(missingCircuit, "PROGRESS.provider_budget.circuit");
  expectInvalidProviderBudget(
    { ...validProviderBudget, circuit: { ...validProviderBudget.circuit, previous_state: "retrying" } },
    "PROGRESS.provider_budget.circuit.previous_state"
  );
  expectInvalidProviderBudget(
    { ...validProviderBudget, circuit: { ...validProviderBudget.circuit, state: "retrying" } },
    "PROGRESS.provider_budget.circuit.state"
  );
  expectInvalidProviderBudget(
    { ...validProviderBudget, circuit: { ...validProviderBudget.circuit, reason: "backpressure" } },
    "PROGRESS.provider_budget.circuit.reason"
  );
  expectInvalidProviderBudget(
    { ...validProviderBudget, circuit: { ...validProviderBudget.circuit, trigger: "timer" } },
    "PROGRESS.provider_budget.circuit.trigger"
  );
});

test("validateProgressProviderBudget: counters and retry capacity must be bounded when numeric", () => {
  expectInvalidProviderBudget({ ...validProviderBudget, elapsed_ms: -1 }, "PROGRESS.provider_budget.elapsed_ms");
  expectInvalidProviderBudget({ ...validProviderBudget, request_count: -1 }, "PROGRESS.provider_budget.request_count");
  expectInvalidProviderBudget(
    { ...validProviderBudget, retry_tokens_remaining: -1 },
    "PROGRESS.provider_budget.retry_tokens_remaining"
  );
  expectInvalidProviderBudget(
    { ...validProviderBudget, retry_tokens_remaining: Number.POSITIVE_INFINITY },
    "PROGRESS.provider_budget.retry_tokens_remaining"
  );
});

test("validateProgressAttachmentRecoveryOutcome: accepts the complete aggregate-only shape", () => {
  assert.doesNotThrow(() => validateProgressAttachmentRecoveryOutcome(validAttachmentRecoveryOutcome));
});

test("validateProgressAttachmentRecoveryOutcome: rejects private fields and non-integer counts", () => {
  assert.throws(
    () => validateProgressAttachmentRecoveryOutcome({ ...validAttachmentRecoveryOutcome, gap_id: "private-gap" }),
    TOP_LEVEL_REGEX_1
  );
  assert.throws(
    () => validateProgressAttachmentRecoveryOutcome({ ...validAttachmentRecoveryOutcome, lookup_miss: 0.5 }),
    TOP_LEVEL_REGEX_2
  );
});

test("validateProgressAttachmentHydrationFailureOutcome: accepts only the complete aggregate-only stage shape", () => {
  assert.doesNotThrow(() => validateProgressAttachmentHydrationFailureOutcome(validAttachmentHydrationFailureOutcome));
  for (const privateField of [
    "record_key",
    "detail_locator",
    "filename",
    "url",
    "message",
    "body",
    "http_status",
    "credential",
  ]) {
    assert.throws(
      () =>
        validateProgressAttachmentHydrationFailureOutcome({
          ...validAttachmentHydrationFailureOutcome,
          [privateField]: "private-value",
        }),
      TOP_LEVEL_REGEX_3,
      `${privateField} must not cross the terminal telemetry boundary`
    );
  }
});

test("validateProgressAttachmentHydrationFailureOutcome: rejects an invalid discriminator and non-integer count", () => {
  assert.throws(
    () =>
      validateProgressAttachmentHydrationFailureOutcome({ ...validAttachmentHydrationFailureOutcome, object: "wrong" }),
    TOP_LEVEL_REGEX_4
  );
  assert.throws(
    () =>
      validateProgressAttachmentHydrationFailureOutcome({
        ...validAttachmentHydrationFailureOutcome,
        imap_download_failed: 0.5,
      }),
    TOP_LEVEL_REGEX_5
  );
  assert.throws(
    () =>
      validateProgressAttachmentHydrationFailureOutcome({
        ...validAttachmentHydrationFailureOutcome,
        imap_download_failed: -1,
      }),
    TOP_LEVEL_REGEX_6
  );
});

test("validateProgressAttachmentHydrationFailureOutcomeSum: failure stages require the recovery aggregate and exactly match its hydration failures", () => {
  const hydrationFailed = Object.values(validAttachmentHydrationFailureOutcome)
    .filter((value) => typeof value === "number")
    .reduce((total, count) => total + count, 0);
  assert.doesNotThrow(() =>
    validateProgressAttachmentHydrationFailureOutcomeSum(
      { ...validAttachmentRecoveryOutcome, hydration_failed: hydrationFailed },
      validAttachmentHydrationFailureOutcome
    )
  );
  assert.throws(
    () => validateProgressAttachmentHydrationFailureOutcomeSum(null, validAttachmentHydrationFailureOutcome),
    TOP_LEVEL_REGEX_7
  );
  assert.throws(
    () => validateProgressAttachmentHydrationFailureOutcomeSum(validAttachmentRecoveryOutcome, null),
    TOP_LEVEL_REGEX_8
  );
  assert.throws(
    () =>
      validateProgressAttachmentHydrationFailureOutcomeSum(
        { ...validAttachmentRecoveryOutcome, hydration_failed: hydrationFailed - 1 },
        validAttachmentHydrationFailureOutcome
      ),
    TOP_LEVEL_REGEX_9
  );
});
