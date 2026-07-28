// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * family-validate.ts's `validateFamily` is a real git/tsc orchestration
 * script (see its own header) — exercised for real against the actual
 * repository in T2-BATCH-PREP's report, not mocked here (matching this
 * tool's existing precedent: mutation-oracle.ts is proven by running it
 * for real, not by a unit test of its orchestration). What IS unit-tested
 * here is the pure attribution/sharing arithmetic this module EXPORTS
 * (not a re-derivation — these are the exact functions `validateFamily`
 * itself calls): the before/after non-test-error-line filter, the
 * attributable-error-count delta, and the clusterable-share percentage.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { attributableErrorCount, clusterableSharePercent, nonTestErrorLines } from "./family-validate.ts";

test("nonTestErrorLines keeps only error lines whose file path does NOT start with reference-implementation/test/ (repo-root-relative tsc invocation)", () => {
  const lines = [
    "reference-implementation/test/foo.test.ts(1,2): error TS7006: implicit any",
    "packages/cli/src/x.ts(3,4): error TS2322: not assignable",
    "reference-implementation/runtime/controller.ts(5,6): error TS2345: bad arg",
    "not a real error line",
  ];
  assert.deepEqual(nonTestErrorLines(lines), [
    "packages/cli/src/x.ts(3,4): error TS2322: not assignable",
    "reference-implementation/runtime/controller.ts(5,6): error TS2345: bad arg",
  ]);
});

test("attributableErrorCount is the raw line-count delta between before/after tsc output", () => {
  const before = Array.from({ length: 39 }, (_, i) => `line${i}`);
  const after = Array.from({ length: 394 }, (_, i) => `line${i}`);
  assert.equal(attributableErrorCount(before, after), 355);
});

test("clusterableSharePercent matches T1-BUILD's own measured 9.6% figure on the flat-slice numbers (34/355)", () => {
  const share = clusterableSharePercent(34, 355);
  assert.equal(Math.round(share * 10) / 10, 9.6);
});

test("clusterableSharePercent is 0, not NaN or Infinity, when attributableErrorCount is 0 (a family with zero measured errors)", () => {
  assert.equal(clusterableSharePercent(0, 0), 0);
  assert.equal(clusterableSharePercent(5, 0), 0); // defensive: mass without attributable errors is nonsensical, must not divide by zero
});

test("clusterableSharePercent can exceed 100% is impossible by construction here, but the formula itself does not clamp — verifies the raw ratio is reported honestly", () => {
  // A cluster's potentialErrorMassReduction is a proxy count (call sites *
  // param names), not literally bounded by the tsc error count, so in
  // principle mass could exceed attributable count for a given family;
  // the batch-plan report must show this raw, not silently clamp it,
  // because an unclamped >100% is itself a signal the proxy and the real
  // count diverge for that family and is worth a human's attention.
  const share = clusterableSharePercent(500, 355);
  assert.ok(share > 100);
});
