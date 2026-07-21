// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { isKnownBlackFrameFailure } from "./manual-action-stream-smoke.mjs";

const blackRaster = { brightRatio: 0, nearBlackRatio: 1, sampled: true, total: 1000 };

test("black-frame oracle catches the observed uniform-black stream with an error affordance", () => {
  assert.equal(
    isKnownBlackFrameFailure(blackRaster, { hasErrorAffordance: true, hasFirstFrameSignal: false }),
    true
  );
});

test("black-frame oracle does not confuse a merely-loading black surface with the error state", () => {
  assert.equal(
    isKnownBlackFrameFailure(blackRaster, { hasErrorAffordance: false, hasFirstFrameSignal: false }),
    false
  );
});

test("black-frame oracle tolerates a legitimately dark decoded page", () => {
  assert.equal(
    isKnownBlackFrameFailure(blackRaster, { hasErrorAffordance: false, hasFirstFrameSignal: true }),
    false
  );
});
