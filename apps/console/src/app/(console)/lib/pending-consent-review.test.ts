// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { requireOneClickConsentApproval } from "./pending-consent-review.ts";

const HOSTED_BATCH_REVIEW_ERROR = /Batch approval requires hosted source review/;

test("single consent may use the console one-click approval flow", () => {
  assert.doesNotThrow(() => requireOneClickConsentApproval({ batch: false }));
});

test("batch consent never enters the console one-click approval flow", () => {
  assert.throws(() => requireOneClickConsentApproval({ batch: true }), HOSTED_BATCH_REVIEW_ERROR);
});
