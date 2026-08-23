// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { isDeterministicSourcesReadError, shouldRetrySourcesReadError } from "./read-error-classification.ts";

test("deterministic 4xx source-read failures do not enter the retry loop", () => {
  const resourceServerRejection = Object.assign(new Error("limit is required"), { status: 400 });
  assert.equal(shouldRetrySourcesReadError(resourceServerRejection), false);
});

test("untyped RSC transport races remain retryable", () => {
  assert.equal(shouldRetrySourcesReadError(new Error("The destination stream closed early")), true);
});

test("timeout and rate-limit statuses remain retryable", () => {
  assert.equal(isDeterministicSourcesReadError(Object.assign(new Error("timeout"), { status: 408 })), false);
  assert.equal(isDeterministicSourcesReadError(Object.assign(new Error("rate limited"), { status: 429 })), false);
});
