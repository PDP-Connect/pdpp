// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import test from "node:test";
import { aggregateTrial, type ProjectionResult, projectOutcome } from "./projection.ts";
import type { AttemptAxes } from "./schemas.ts";

const OK = { status: "ok" } as const;
function failed(failure: string, detail = "observed detail") {
  return { status: "failed" as const, failure, detail };
}

/**
 * Reachability defaults to a clean `ok` here so each table-row test below
 * isolates the single axis it names — a real attempt with `unknown`
 * reachability is covered separately by the row-3 tests, which explicitly
 * set it.
 */
function baseAxes(overrides: Partial<AttemptAxes> = {}): AttemptAxes {
  return {
    baseline: OK,
    materialization: OK,
    focused: OK,
    backstop: OK,
    reachability: OK,
    cleanup: OK,
    ...overrides,
  };
}

// ── Row 1: clean baseline/materialization/cleanup failures -> inconclusive ──

test("row 1: baseline failure projects inconclusive and preserves the failing axis", () => {
  const result = projectOutcome({
    axes: baseAxes({ baseline: failed("baseline_did_not_pass") }),
    isMutationAttributableFailure: false,
  });
  assert.deepEqual(result, { projection: "inconclusive", failingAxis: "baseline" });
});

test("row 1: materialization failure projects inconclusive and preserves the failing axis", () => {
  const result = projectOutcome({
    axes: baseAxes({ materialization: failed("dependency_install_failed") }),
    isMutationAttributableFailure: false,
  });
  assert.deepEqual(result, { projection: "inconclusive", failingAxis: "materialization" });
});

test("row 1: cleanup failure projects inconclusive and preserves the failing axis", () => {
  const result = projectOutcome({
    axes: baseAxes({ cleanup: failed("workspace_not_destroyed") }),
    isMutationAttributableFailure: false,
  });
  assert.deepEqual(result, { projection: "inconclusive", failingAxis: "cleanup" });
});

// ── Row 2: timeout/signal/malformed output on the focused axis -> inconclusive, never a kill ──

test("row 2: a focused failure that is NOT mutation-attributable (protocol/timeout error) never projects killed", () => {
  const result = projectOutcome({
    axes: baseAxes({ focused: failed("timeout") }),
    isMutationAttributableFailure: false,
  });
  assert.deepEqual(result, { projection: "inconclusive", failingAxis: "focused" });
});

test("row 2: a focused axis in a non-ok, non-failed state (malformed output) is inconclusive, not killed", () => {
  const result = projectOutcome({
    // A status this program never itself produces for `focused` in practice,
    // but the function must still fail closed rather than treat it as a pass.
    axes: baseAxes({ focused: { status: "not_applicable" } }),
    isMutationAttributableFailure: false,
  });
  assert.deepEqual(result, { projection: "inconclusive", failingAxis: "focused" });
});

// ── Row 3: validated not_exercised / unknown reachability -> inconclusive, pending triage ──

test("row 3: validated not_exercised reachability projects inconclusive, never survived", () => {
  const result = projectOutcome({
    axes: baseAxes({ reachability: { status: "not_exercised" } }),
    isMutationAttributableFailure: false,
  });
  assert.deepEqual(result, { projection: "inconclusive", failingAxis: "reachability" });
});

test("row 3: unknown reachability (no validated evidence either way) projects inconclusive", () => {
  const result = projectOutcome({
    axes: baseAxes({ reachability: { status: "unknown" } }),
    isMutationAttributableFailure: false,
  });
  assert.deepEqual(result, { projection: "inconclusive", failingAxis: "reachability" });
});

// ── Row 4: focused fails on a mutation-attributable assertion -> killed ──

test("row 4: focused fails on a mutation-attributable assertion -> killed, backstop not required", () => {
  const result = projectOutcome({
    axes: baseAxes({
      focused: failed("owning_test_assertion_failure"),
      backstop: { status: "not_run_focused_kill" },
    }),
    isMutationAttributableFailure: true,
  });
  assert.deepEqual(result, { projection: "killed" });
});

test("row 4: focused fails on a mutation-attributable assertion -> killed even when backstop actually ran and passed", () => {
  const result = projectOutcome({
    axes: baseAxes({ focused: failed("owning_test_assertion_failure"), backstop: OK }),
    isMutationAttributableFailure: true,
  });
  assert.deepEqual(result, { projection: "killed" });
});

// ── Row 5: focused passes, backstop fails on a mutation-attributable assertion -> killed + selectorMiss ──

test("row 5: focused passes but backstop fails on a mutation-attributable assertion -> killed with selectorMiss", () => {
  const result = projectOutcome({
    axes: baseAxes({ focused: OK, backstop: failed("owning_test_assertion_failure") }),
    isMutationAttributableFailure: true,
  });
  assert.deepEqual(result, { projection: "killed", selectorMiss: true });
});

// ── Row 6: focused passes, backstop passes -> survived, pending triage ──

test("row 6: focused and backstop both pass -> survived", () => {
  const result = projectOutcome({
    axes: baseAxes({ focused: OK, backstop: OK }),
    isMutationAttributableFailure: false,
  });
  assert.deepEqual(result, { projection: "survived" });
});

// ── Backstop cannot complete: never survived ──

test("a required backstop that fails for non-mutation reasons after a focused pass is inconclusive, never survived", () => {
  const result = projectOutcome({
    axes: baseAxes({ focused: OK, backstop: failed("authority_receipt_invalid") }),
    isMutationAttributableFailure: false,
  });
  assert.deepEqual(result, { projection: "inconclusive", failingAxis: "backstop" });
});

test("a missing/not_applicable backstop after a focused pass is inconclusive, never survived", () => {
  const result = projectOutcome({
    axes: baseAxes({ focused: OK, backstop: { status: "not_applicable" } }),
    isMutationAttributableFailure: false,
  });
  assert.deepEqual(result, { projection: "inconclusive", failingAxis: "backstop" });
});

// ── aggregateTrial: no automatic retries, contradictory attempts -> inconclusive ──

test("aggregateTrial: a single attempt's projection passes through unchanged", () => {
  const attempt: ProjectionResult = { projection: "killed" };
  assert.deepEqual(aggregateTrial([attempt]), attempt);
});

test("aggregateTrial: agreeing attempts return the shared verdict", () => {
  const attempts: ProjectionResult[] = [{ projection: "survived" }, { projection: "survived" }];
  assert.deepEqual(aggregateTrial(attempts), { projection: "survived" });
});

test("aggregateTrial: contradictory attempts (killed vs survived) for one trial_key are inconclusive", () => {
  const attempts: ProjectionResult[] = [{ projection: "killed" }, { projection: "survived" }];
  const result = aggregateTrial(attempts);
  assert.equal(result.projection, "inconclusive");
  assert.equal(result.failingAxis, "contradictory_trial_key");
});

test("aggregateTrial: throws on an empty attempt list rather than silently producing a verdict", () => {
  assert.throws(() => aggregateTrial([]));
});

// ── P1-5: selector/failing-axis disagreement must surface, not be picked ──
//
// Two attempts can share the same broad `projection` bucket while
// disagreeing on the qualifications that actually drive downstream
// promotion decisions. A comparator that only checked `projection` would
// silently treat these as agreement (and — since it kept whichever
// attempt happened to be first — its answer would depend on attempt
// order, never surfacing the disagreement at all).

test("aggregateTrial: killed WITH selectorMiss vs killed WITHOUT selectorMiss is a disagreement, not a match", () => {
  const withMiss: ProjectionResult = { projection: "killed", selectorMiss: true };
  const withoutMiss: ProjectionResult = { projection: "killed" };
  const result = aggregateTrial([withMiss, withoutMiss]);
  assert.equal(result.projection, "inconclusive");
  assert.equal(result.failingAxis, "contradictory_trial_key");
});

test("aggregateTrial: killed-with-selectorMiss disagreement result does not depend on attempt order (permutation)", () => {
  const withMiss: ProjectionResult = { projection: "killed", selectorMiss: true };
  const withoutMiss: ProjectionResult = { projection: "killed" };
  const forward = aggregateTrial([withMiss, withoutMiss]);
  const reversed = aggregateTrial([withoutMiss, withMiss]);
  assert.deepEqual(forward, reversed);
  assert.equal(forward.projection, "inconclusive");
});

test("aggregateTrial: inconclusive/focused vs inconclusive/cleanup is a disagreement, not a match", () => {
  const focusedFailure: ProjectionResult = { projection: "inconclusive", failingAxis: "focused" };
  const cleanupFailure: ProjectionResult = { projection: "inconclusive", failingAxis: "cleanup" };
  const result = aggregateTrial([focusedFailure, cleanupFailure]);
  assert.equal(result.projection, "inconclusive");
  assert.equal(result.failingAxis, "contradictory_trial_key");
});

test("aggregateTrial: inconclusive/focused vs inconclusive/cleanup disagreement does not depend on attempt order (permutation)", () => {
  const focusedFailure: ProjectionResult = { projection: "inconclusive", failingAxis: "focused" };
  const cleanupFailure: ProjectionResult = { projection: "inconclusive", failingAxis: "cleanup" };
  const forward = aggregateTrial([focusedFailure, cleanupFailure]);
  const reversed = aggregateTrial([cleanupFailure, focusedFailure]);
  assert.deepEqual(forward, reversed);
});

test("aggregateTrial: three attempts that all genuinely agree (including selectorMiss) return the shared verdict, order-independent", () => {
  const a: ProjectionResult = { projection: "killed", selectorMiss: true };
  const b: ProjectionResult = { projection: "killed", selectorMiss: true };
  const c: ProjectionResult = { projection: "killed", selectorMiss: true };
  for (const perm of [
    [a, b, c],
    [b, c, a],
    [c, a, b],
    [c, b, a],
  ]) {
    assert.deepEqual(aggregateTrial(perm), { projection: "killed", selectorMiss: true });
  }
});

test("aggregateTrial: two attempts that fully agree (same projection, no failingAxis, no selectorMiss) still return the shared verdict", () => {
  const attempts: ProjectionResult[] = [{ projection: "killed" }, { projection: "killed" }];
  assert.deepEqual(aggregateTrial(attempts), { projection: "killed" });
});
