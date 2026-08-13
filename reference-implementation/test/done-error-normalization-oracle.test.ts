// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

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

test("recovery_hint accepts only actionable shapes", () => {
  const bareAction = validateDoneError("failed", { message: "failed", recovery_hint: "retry_by_runtime" });
  assert.ok(!(bareAction instanceof Error));
  assert.equal(bareAction?.recovery_hint, "retry_by_runtime");

  const objectWithAction = validateDoneError("failed", {
    message: "failed",
    recovery_hint: { action: "refresh_credentials" },
  });
  assert.ok(!(objectWithAction instanceof Error));
  assert.deepEqual(objectWithAction?.recovery_hint, { action: "refresh_credentials" });

  const objectWithBoth = validateDoneError("failed", {
    message: "failed",
    recovery_hint: { action: "retry_on_connector_upgrade", retryable: false },
  });
  assert.ok(!(objectWithBoth instanceof Error));
  assert.deepEqual(objectWithBoth?.recovery_hint, { action: "retry_on_connector_upgrade", retryable: false });
  for (const invalid of [
    {},
    { retryable: true },
    { action: "made_up_action" },
    { action: "refresh_credentials", retryable: "false" },
    { action: "refresh_credentials", connector_detail: "private" },
  ]) {
    const result = validateDoneError("failed", { message: "failed", recovery_hint: invalid });
    assert.ok(result instanceof Error, `accepted invalid recovery_hint: ${JSON.stringify(invalid)}`);
    assert.match(result.message, INVALID_RECOVERY_HINT_MESSAGE_PATTERN);
  }
});
