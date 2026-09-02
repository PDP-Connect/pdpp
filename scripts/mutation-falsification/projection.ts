// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The total, conservative projection table (design.md Decision #3 /
 * specs/mutation-falsification/spec.md). Pure functions only — no I/O, no
 * randomness, fully unit-testable. `killed`/`survived`/`inconclusive` are
 * NEVER accepted as input anywhere in this program; this file is the only
 * place they are computed, and only from an AttemptReceipt's raw axis
 * observations.
 *
 * Table (every row implemented literally below, in `projectOutcome`):
 *
 *   1. Any clean baseline/materialization/protocol/authority/
 *      artifact-retention/cleanup failure           -> inconclusive (preserve failing axis)
 *   2. Timeout/signal/resource stop/malformed-or-     -> inconclusive (never infer a kill)
 *      partial output/unexplained nondeterminism
 *   3. Validated not_exercised reachability            -> inconclusive (send to triage)
 *   4. Focused fails, mutation-attributable             -> killed (backstop MAY be not_run_focused_kill)
 *   5. Focused passes, backstop fails,                  -> killed + selectorMiss: true
 *      mutation-attributable
 *   6. Focused passes, backstop passes                  -> survived (pending triage)
 *
 * No automatic retries anywhere in this file. `aggregateTrial` is the only
 * place multiple attempts sharing one trial_key are combined, and it never
 * retries — it returns `inconclusive` on any disagreement between valid
 * attempts, else the single shared verdict.
 */

import type { AttemptAxes, AxisObservation } from "./schemas.ts";

export type Projection = "killed" | "survived" | "inconclusive";

export interface ProjectionResult {
  /** Present only when projection is `inconclusive` due to a specific failing axis (table rows 1-3). */
  failingAxis?: string;
  projection: Projection;
  /**
   * Present only for row 5: focused passed but the complete mutant backstop
   * failed on a mutation-attributable assertion. Callers MUST stop selector
   * promotion when this is true.
   */
  selectorMiss?: true;
}

function isCleanFailureAxis(observation: AxisObservation): boolean {
  return observation.status === "failed";
}

/**
 * `projectOutcome` never infers "mutation-attributable" from exit codes or
 * axis status alone — the caller must supply this honestly, having already
 * distinguished a recognized owning-test assertion failure (mutation
 * signal) from an infrastructure/protocol/accounting/cleanup/resource
 * error (not mutation signal). This is deliberate: this function has no
 * way to independently verify test-framework semantics, so making the
 * caller assert it explicitly keeps the dishonest path visible in the
 * caller's own code rather than hidden inside this "pure" function.
 */
export function projectOutcome(observations: {
  axes: AttemptAxes;
  isMutationAttributableFailure: boolean;
}): ProjectionResult {
  const { axes, isMutationAttributableFailure } = observations;

  // Row 1: any clean baseline/materialization/protocol/authority/
  // artifact-retention/cleanup failure -> inconclusive, preserve the axis.
  for (const [name, observation] of [
    ["baseline", axes.baseline],
    ["materialization", axes.materialization],
    ["cleanup", axes.cleanup],
  ] as const) {
    if (isCleanFailureAxis(observation)) {
      return { projection: "inconclusive", failingAxis: name };
    }
  }

  // Row 3: validated not_exercised reachability -> inconclusive, pending triage.
  // Also covers unknown reachability (no adapter-supplied validated evidence
  // either way) — spec: "not_exercised requires adapter-supplied validated
  // reachability evidence; otherwise reachability is unknown", and neither
  // outcome may ever be treated as survived.
  if (axes.reachability.status === "not_exercised" || axes.reachability.status === "unknown") {
    return { projection: "inconclusive", failingAxis: "reachability" };
  }
  if (isCleanFailureAxis(axes.reachability)) {
    return { projection: "inconclusive", failingAxis: "reachability" };
  }

  const focusedFailed = isCleanFailureAxis(axes.focused);
  const focusedPassed = axes.focused.status === "ok";

  // Row 4: focused check fails for a mutation-attributable assertion -> killed.
  // The backstop MAY be not_run_focused_kill (an explicit, allowed axis
  // value) or MAY have actually run; either way a focused kill is decisive.
  if (focusedFailed) {
    if (!isMutationAttributableFailure) {
      // A focused failure that is NOT mutation-attributable (an infra/
      // protocol/cleanup/resource error masquerading as a test failure) is
      // never a kill — row 2.
      return { projection: "inconclusive", failingAxis: "focused" };
    }
    return { projection: "killed" };
  }

  if (!focusedPassed) {
    // Focused axis is neither a clean pass nor a clean fail (e.g. a
    // timeout/signal/malformed-output status) -> row 2, never infer a kill.
    return { projection: "inconclusive", failingAxis: "focused" };
  }

  // Focused passed. The complete mutant backstop is now mandatory.
  const backstop = axes.backstop;
  if (backstop.status === "ok") {
    // Row 6: focused passed, backstop passed -> survived, pending triage.
    return { projection: "survived" };
  }
  if (isCleanFailureAxis(backstop)) {
    if (!isMutationAttributableFailure) {
      // Backstop failed but not on a mutation-attributable assertion (an
      // infra/protocol/accounting/cleanup/resource error) -> inconclusive,
      // required backstop did not complete meaningfully.
      return { projection: "inconclusive", failingAxis: "backstop" };
    }
    // Row 5: focused passed, backstop fails for a mutation-attributable
    // assertion -> killed, but record a selector miss and stop promotion.
    return { projection: "killed", selectorMiss: true };
  }
  // Any other backstop status (not_applicable is invalid here because a
  // focused pass makes the backstop mandatory; not_run_focused_kill is
  // invalid because focused did NOT fail) -> a required backstop that
  // cannot complete is always inconclusive, never survived.
  return { projection: "inconclusive", failingAxis: "backstop" };
}

/**
 * Normalizes a `ProjectionResult` to a value that can be compared for exact
 * equality across attempts — every field that affects promotion decisions
 * downstream, not just the broad `projection` bucket. Two attempts that
 * both project `"killed"` are NOT the same outcome if one carries
 * `selectorMiss: true` (backstop caught what the selector/focused check
 * missed — promotion must stop) and the other doesn't; likewise two
 * `"inconclusive"` attempts with different `failingAxis` values (e.g. one
 * `"focused"`, one `"cleanup"`) are different evidence, not agreement.
 */
function normalizedOutcomeKey(result: ProjectionResult): string {
  return JSON.stringify({
    projection: result.projection,
    failingAxis: result.failingAxis ?? null,
    selectorMiss: result.selectorMiss ?? false,
  });
}

/**
 * Combines multiple valid attempts sharing one trial_key. No retries: if
 * any two valid attempts disagree on the COMPLETE normalized outcome —
 * projection, failingAxis, AND selectorMiss — the aggregate trial is
 * inconclusive and every raw attempt remains visible to the caller. This
 * compares the full outcome, not just the broad `projection` bucket: a
 * `killed` attempt with `selectorMiss: true` and a `killed` attempt without
 * it are NOT in agreement (one says "stop selector promotion", the other
 * doesn't — that disagreement must surface, not be silently collapsed by
 * whichever attempt happens to be `first`). Order-independent: the result
 * never depends on which attempt in the input array happens to be first.
 * A single attempt's projection is returned unchanged.
 */
export function aggregateTrial(attempts: ProjectionResult[]): ProjectionResult {
  if (attempts.length === 0) {
    throw new Error("aggregateTrial: at least one attempt is required");
  }
  const [first, ...rest] = attempts as [ProjectionResult, ...ProjectionResult[]];
  const firstKey = normalizedOutcomeKey(first);
  const allAgree = rest.every((attempt) => normalizedOutcomeKey(attempt) === firstKey);
  if (!allAgree) {
    return { projection: "inconclusive", failingAxis: "contradictory_trial_key" };
  }
  return first;
}
