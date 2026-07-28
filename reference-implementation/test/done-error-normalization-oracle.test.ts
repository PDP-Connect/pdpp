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
