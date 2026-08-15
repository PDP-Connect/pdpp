// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";

import { semanticWorkLimitStepForCpuCount } from "../server/search-semantic.ts";

test("semanticWorkLimitStepForCpuCount snaps down to the nearest allowed step", () => {
  assert.equal(semanticWorkLimitStepForCpuCount(1), 1);
  assert.equal(semanticWorkLimitStepForCpuCount(2), 2);
  assert.equal(semanticWorkLimitStepForCpuCount(3), 2);
  assert.equal(semanticWorkLimitStepForCpuCount(4), 4);
  assert.equal(semanticWorkLimitStepForCpuCount(7), 4);
  assert.equal(semanticWorkLimitStepForCpuCount(8), 8);
});

test("semanticWorkLimitStepForCpuCount caps at 8 regardless of a larger CPU count", () => {
  assert.equal(semanticWorkLimitStepForCpuCount(24), 8);
  assert.equal(semanticWorkLimitStepForCpuCount(128), 8);
});

test("semanticWorkLimitStepForCpuCount never goes below 1, even for a fractional or zero count", () => {
  assert.equal(semanticWorkLimitStepForCpuCount(0), 1);
});
