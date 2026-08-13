// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { isValidRecoveryHintShape } from "../runtime/connector-gap-bounding.ts";
import { validateDoneError } from "../runtime/done-validators.ts";

const REGEXP_1 = /invalid DONE\.error\.retryable/;
const REGEXP_2 = /succeeded runs must not include terminal error details/;
const REGEXP_3 = /expected object/;
const REGEXP_4 = /expected object/;
const REGEXP_5 = /unsupported fields detail/;
const REGEXP_6 = /invalid DONE\.error\.code/;
const REGEXP_7 = /invalid DONE\.error\.message/;
const REGEXP_8 = /invalid DONE\.error\.message/;
const INVALID_RECOVERY_HINT_MESSAGE_PATTERN = /invalid DONE\.error\.recovery_hint/;

test("validateDoneError returns null when DONE.error is absent", () => {
  assert.equal(validateDoneError("failed", null), null);
});

test("validateDoneError rejects terminal error details on succeeded DONE envelopes", () => {
  const result = validateDoneError("succeeded", { message: "failed anyway" });

  assert.ok(result instanceof Error);
  assert.match(result.message, REGEXP_2);
});

test("validateDoneError rejects non-object and array DONE.error inputs", () => {
  // Deliberately invalid inputs (a string, an array) to prove the fail-closed
  // "expected object" rejection path — validateDoneError's real param type is
  // narrower, so these are cast at the call site rather than the test's point
  // being weakened away.
  const nonObject = validateDoneError("failed", "failed" as unknown as { message: string });
  const array = validateDoneError("failed", [{ message: "failed" }] as unknown as { message: string });

  assert.ok(nonObject instanceof Error);
  assert.match(nonObject.message, REGEXP_3);
  assert.ok(array instanceof Error);
  assert.match(array.message, REGEXP_4);
});

test("validateDoneError rejects unsupported fields and names the field", () => {
  const result = validateDoneError("failed", { detail: "too much", message: "failed" });

  assert.ok(result instanceof Error);
  assert.match(result.message, REGEXP_5);
});

test("validateDoneError rejects invalid DONE.error.code strings", () => {
  const result = validateDoneError("failed", { code: "ProviderThrottle", message: "failed" });

  assert.ok(result instanceof Error);
  assert.match(result.message, REGEXP_6);
});

test("validateDoneError rejects empty or whitespace-only DONE.error.message values", () => {
  const empty = validateDoneError("failed", { message: "" });
  const whitespace = validateDoneError("failed", { message: "   " });

  assert.ok(empty instanceof Error);
  assert.match(empty.message, REGEXP_7);
  assert.ok(whitespace instanceof Error);
  assert.match(whitespace.message, REGEXP_8);
});

test("validateDoneError requires DONE.error.retryable to be boolean when present", () => {
  // "false" (a string) is deliberately the wrong type for `retryable`, to
  // prove the fail-closed rejection.
  const result = validateDoneError("failed", { message: "failed", retryable: "false" as unknown as boolean });

  assert.ok(result instanceof Error);
  assert.match(result.message, REGEXP_1);
});

test("validateDoneError normalizes valid failed DONE.error details", () => {
  assert.deepEqual(validateDoneError("failed", { code: "provider_throttle_1", message: "  trimmed  " }), {
    code: "provider_throttle_1",
    message: "trimmed",
    retryable: null,
  });
  assert.deepEqual(
    validateDoneError("failed", { code: "provider_throttle_1", message: "  trimmed  ", retryable: false }),
    {
      code: "provider_throttle_1",
      message: "trimmed",
      retryable: false,
    }
  );
});

test("validateDoneError accepts a closed-vocabulary recovery_hint distinct from code", () => {
  assert.deepEqual(
    validateDoneError("failed", { code: "session_expired", message: "failed", recovery_hint: "refresh_credentials" }),
    { code: "session_expired", message: "failed", recovery_hint: "refresh_credentials", retryable: null }
  );
  assert.deepEqual(
    validateDoneError("failed", {
      message: "failed",
      recovery_hint: { action: "manual_action_required", retryable: false },
    }),
    { message: "failed", recovery_hint: { action: "manual_action_required", retryable: false }, retryable: null }
  );
});

test("validateDoneError rejects an out-of-vocabulary recovery_hint", () => {
  const result = validateDoneError("failed", { message: "failed", recovery_hint: "made_up_action" });
  assert.ok(result instanceof Error);
  assert.match(result.message, INVALID_RECOVERY_HINT_MESSAGE_PATTERN);
});

test("Steam case: owner-required privacy action maps to manual_action_required", () => {
  // Steam friends list is unavailable because the account owner has restricted
  // the friends list in their privacy settings. The owner must change that
  // setting; retries will not help. This is semantically a manual_action_required
  // case, not not_retriable (connector defect).
  const result = validateDoneError("failed", {
    message: "Steam friends are unavailable because this account restricts the friends list.",
    recovery_hint: { action: "manual_action_required", retryable: false },
  });
  assert.ok(!(result instanceof Error));
  assert.deepEqual(result?.recovery_hint, { action: "manual_action_required", retryable: false });
});

test("validateDoneError rejects empty object and retryable-only object recovery hints", () => {
  const emptyObject = validateDoneError("failed", { message: "failed", recovery_hint: {} });
  assert.ok(emptyObject instanceof Error);
  assert.match(emptyObject.message, INVALID_RECOVERY_HINT_MESSAGE_PATTERN);

  const retryableOnly = validateDoneError("failed", { message: "failed", recovery_hint: { retryable: true } });
  assert.ok(retryableOnly instanceof Error);
  assert.match(retryableOnly.message, INVALID_RECOVERY_HINT_MESSAGE_PATTERN);
});

test("recovery_hint discriminating cases: valid shapes accepted and normalized", () => {
  // Case 1: bare action string (most common)
  const bareAction = validateDoneError("failed", { message: "failed", recovery_hint: "retry_by_runtime" });
  assert.ok(!(bareAction instanceof Error));
  assert.equal(bareAction?.recovery_hint, "retry_by_runtime");

  // Case 2: object with action (required)
  const objectWithAction = validateDoneError("failed", {
    message: "failed",
    recovery_hint: { action: "refresh_credentials" },
  });
  assert.ok(!(objectWithAction instanceof Error));
  assert.deepEqual(objectWithAction?.recovery_hint, { action: "refresh_credentials" });

  // Case 3: object with action + retryable
  const objectWithBoth = validateDoneError("failed", {
    message: "failed",
    recovery_hint: { action: "retry_on_connector_upgrade", retryable: false },
  });
  assert.ok(!(objectWithBoth instanceof Error));
  assert.deepEqual(objectWithBoth?.recovery_hint, { action: "retry_on_connector_upgrade", retryable: false });
});

test("recovery_hint discriminating cases: invalid shapes rejected", () => {
  // Case 1: retryable-only object (no action)
  const retryableOnly = validateDoneError("failed", { message: "failed", recovery_hint: { retryable: true } });
  assert.ok(retryableOnly instanceof Error);

  // Case 2: empty object
  const empty = validateDoneError("failed", { message: "failed", recovery_hint: {} });
  assert.ok(empty instanceof Error);

  // Case 3: unknown action
  const unknownAction = validateDoneError("failed", { message: "failed", recovery_hint: "unknown_action_value" });
  assert.ok(unknownAction instanceof Error);

  // Case 4: wrong retryable type
  const wrongRetryableType = validateDoneError("failed", {
    message: "failed",
    recovery_hint: { action: "refresh_credentials", retryable: "true" as unknown as boolean },
  });
  assert.ok(wrongRetryableType instanceof Error);

  // Case 5: missing action in object form
  const missingAction = validateDoneError("failed", {
    message: "failed",
    recovery_hint: { retryable: false } as unknown as { action: string },
  });
  assert.ok(missingAction instanceof Error);
});

test("recovery_hint objects require action when they are objects; empty and retryable-only objects are protocol violations", () => {
  // Valid: bare action string
  assert.equal(isValidRecoveryHintShape("refresh_credentials"), true);

  // Valid: object with required action field
  assert.equal(isValidRecoveryHintShape({ action: "refresh_credentials" }), true);
  assert.equal(isValidRecoveryHintShape({ action: "refresh_credentials", retryable: false }), true);
  assert.equal(isValidRecoveryHintShape({ action: "manual_action_required", retryable: true }), true);

  // Invalid: empty object (no action)
  assert.equal(isValidRecoveryHintShape({}), false);

  // Invalid: retryable-only object (no action)
  assert.equal(isValidRecoveryHintShape({ retryable: true }), false);
  assert.equal(isValidRecoveryHintShape({ retryable: false }), false);

  // Invalid: unknown keys alongside action
  assert.equal(
    isValidRecoveryHintShape({ action: "refresh_credentials", connector_detail: "private", retryable: false }),
    false
  );

  // Invalid: wrong type for action
  assert.equal(isValidRecoveryHintShape({ action: 123, retryable: false }), false);
  assert.equal(isValidRecoveryHintShape({ action: null, retryable: false }), false);

  // Invalid: unknown action
  assert.equal(isValidRecoveryHintShape({ action: "made_up_action", retryable: false }), false);

  // Invalid: wrong type for retryable
  assert.equal(isValidRecoveryHintShape({ action: "refresh_credentials", retryable: "false" }), false);

  // Valid: absent (null/undefined)
  assert.equal(isValidRecoveryHintShape(undefined), true);
  assert.equal(isValidRecoveryHintShape(null), true);
});
