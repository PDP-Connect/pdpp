// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Behavioral tests for the shared read-resilient-boundary backoff primitive.
 * See `read-resilient-retry.ts` for why the retry counter this module
 * supports must be created once per segment boundary at module scope.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  createRetryCounter,
  nextRetryDelayMs,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
} from "./read-resilient-retry.ts";

test("nextRetryDelayMs starts at the base delay for the first attempt", () => {
  assert.equal(nextRetryDelayMs(0), RETRY_BASE_DELAY_MS);
});

test("nextRetryDelayMs doubles per attempt until the cap", () => {
  assert.equal(nextRetryDelayMs(1), RETRY_BASE_DELAY_MS * 2);
  assert.equal(nextRetryDelayMs(2), RETRY_BASE_DELAY_MS * 4);
  assert.equal(nextRetryDelayMs(3), RETRY_BASE_DELAY_MS * 8);
});

test("nextRetryDelayMs is capped at RETRY_MAX_DELAY_MS and never exceeds it, however large the attempt", () => {
  const atCap = nextRetryDelayMs(10);
  const wayPastCap = nextRetryDelayMs(1000);
  assert.equal(atCap, RETRY_MAX_DELAY_MS);
  assert.equal(wayPastCap, RETRY_MAX_DELAY_MS);
});

test("createRetryCounter returns an independent counter each call — no shared state between boundaries", () => {
  const a = createRetryCounter();
  const b = createRetryCounter();
  a.attempts = 5;
  assert.equal(b.attempts, 0, "mutating one boundary's counter must not affect another's");
});
