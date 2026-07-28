// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBatchPlan,
  FLAT_SLICE_BASELINE_CLUSTERABLE_SHARE_PERCENT,
  MEASURED_MEAN_ERRORS_PER_FILE,
  summarizePlan,
} from "./batch-plan.ts";
import type { FamilyValidationResult } from "./family-validate.ts";
import type { FileHelperSurface, HelperFamily } from "./helper-family.ts";

function surface(file: string, overrides: Partial<FileHelperSurface> = {}): FileHelperSurface {
  return {
    file,
    loc: 100,
    unparseable: false,
    importedHelperModules: [],
    localHelperClusterKeys: [],
    localHelperClusterErrorMass: 0,
    ...overrides,
  };
}

function family(name: string, kind: HelperFamily["kind"], files: FileHelperSurface[]): HelperFamily {
  return { name, kind, keys: [name], files };
}

test("MEASURED_MEAN_ERRORS_PER_FILE and FLAT_SLICE_BASELINE_CLUSTERABLE_SHARE_PERCENT match the ground-truth report's headline figures", () => {
  // Reused, not re-derived — see mod-t1-sample-0725.md §1.4 and mod-t1-build-0725.md §3.4.
  assert.equal(MEASURED_MEAN_ERRORS_PER_FILE, 17.75);
  assert.equal(FLAT_SLICE_BASELINE_CLUSTERABLE_SHARE_PERCENT, 9.6);
});

test("buildBatchPlan projects errorCount as round(fileCount * 17.75), the T1-SAMPLE mean", () => {
  const families = [family("f1", "local-helper", [surface("a.js"), surface("b.js")])];
  const [entry] = buildBatchPlan(families);
  assert.ok(entry);
  assert.equal(entry.projectedErrorCount, Math.round(2 * MEASURED_MEAN_ERRORS_PER_FILE));
});

test("buildBatchPlan sums localHelperClusterErrorMass across every file in the family for projectedClusterableErrorMass", () => {
  const families = [
    family("f1", "local-helper", [
      surface("a.js", { localHelperClusterErrorMass: 16 }),
      surface("b.js", { localHelperClusterErrorMass: 9 }),
    ]),
  ];
  const [entry] = buildBatchPlan(families);
  assert.ok(entry);
  assert.equal(entry.projectedClusterableErrorMass, 25);
});

test("buildBatchPlan ranks families by projectedClusterableErrorMass descending", () => {
  const families = [
    family("low-mass", "local-helper", [surface("a.js", { localHelperClusterErrorMass: 2 })]),
    family("high-mass", "local-helper", [surface("b.js", { localHelperClusterErrorMass: 50 })]),
  ];
  const entries = buildBatchPlan(families);
  assert.deepEqual(
    entries.map((e) => e.name),
    ["high-mass", "low-mass"]
  );
});

test("buildBatchPlan breaks a projectedClusterableErrorMass tie by file count descending", () => {
  const families = [
    family("small", "local-helper", [surface("a.js", { localHelperClusterErrorMass: 0 })]),
    family("big", "ungrouped", [surface("b.js"), surface("c.js"), surface("d.js")]),
  ];
  const entries = buildBatchPlan(families);
  assert.deepEqual(
    entries.map((e) => e.name),
    ["big", "small"]
  );
});

test("buildBatchPlan leaves measuredClusterableSharePercent null for a family with no matching validation entry", () => {
  const families = [family("unvalidated", "local-helper", [surface("a.js")])];
  const [entry] = buildBatchPlan(families);
  assert.ok(entry);
  assert.equal(entry.measuredClusterableSharePercent, null);
});

test("buildBatchPlan attaches the real measured share for a family that WAS validated, without altering the projected numbers", () => {
  const families = [family("validated", "local-helper", [surface("a.js", { localHelperClusterErrorMass: 10 })])];
  const measurement: FamilyValidationResult = {
    familyName: "validated",
    files: ["a.js"],
    attributableErrorCount: 40,
    clusterableErrorMass: 30,
    clusterableSharePercent: 75,
  };
  const measurements = new Map([["validated", measurement]]);
  const [entry] = buildBatchPlan(families, measurements);
  assert.ok(entry);
  assert.equal(entry.measuredClusterableSharePercent, 75);
  assert.equal(entry.projectedClusterableErrorMass, 10); // untouched by the measurement
});

test("buildBatchPlan totalLoc sums each file's loc", () => {
  const families = [family("f1", "local-helper", [surface("a.js", { loc: 40 }), surface("b.js", { loc: 60 })])];
  const [entry] = buildBatchPlan(families);
  assert.ok(entry);
  assert.equal(entry.totalLoc, 100);
});

test("summarizePlan counts total files across all families, matching the sum of each entry's fileCount", () => {
  const families = [
    family("f1", "local-helper", [surface("a.js"), surface("b.js")]),
    family("f2", "ungrouped", [surface("c.js")]),
  ];
  const summary = summarizePlan(buildBatchPlan(families));
  assert.equal(summary.totalFiles, 3);
  assert.equal(summary.totalFamilies, 2);
});

test("summarizePlan counts ungroupedSingletonFiles only from kind:ungrouped entries", () => {
  const families = [
    family("f1", "local-helper", [surface("a.js")]),
    family("f2", "ungrouped", [surface("b.js")]),
    family("f3", "ungrouped", [surface("c.js")]),
  ];
  const summary = summarizePlan(buildBatchPlan(families));
  assert.equal(summary.ungroupedSingletonFiles, 2);
});

test("summarizePlan familiesWithClusterSignal counts only families with nonzero projectedClusterableErrorMass", () => {
  const families = [
    family("has-signal", "local-helper", [surface("a.js", { localHelperClusterErrorMass: 5 })]),
    family("no-signal", "imported-module", [surface("b.js", { localHelperClusterErrorMass: 0 })]),
  ];
  const summary = summarizePlan(buildBatchPlan(families));
  assert.equal(summary.familiesWithClusterSignal, 1);
});
