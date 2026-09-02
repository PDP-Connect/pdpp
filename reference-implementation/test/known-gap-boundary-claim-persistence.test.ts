// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector's `boundary_claim` must SURVIVE the runtime into `known_gaps`.
 *
 * `buildKnownGap` is a strict allowlist: it names every field it copies and
 * silently drops the rest. That is the correct default for durable evidence —
 * but it meant the typed boundary claim added for the coverage-horizon
 * denominator rule was discarded before it ever reached storage, so the whole
 * axis was inert in production while every unit test passed against
 * hand-built run summaries.
 *
 * These tests exercise the real builder, not a fixture, and pin both
 * directions: the recognized claim persists, and anything else does not.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { buildKnownGap } from "../runtime/connector-gap-bounding.ts";

test("a recognized boundary_claim survives into the stored known_gap", () => {
  const gap = buildKnownGap({
    boundaryClaim: "provider_history_boundary",
    kind: "skip_result",
    reason: "history_ended_before_provider_count",
    recoveryHint: { action: "retry_by_runtime", retryable: true },
    stream: "group_messages",
  });
  assert.equal(
    gap.boundary_claim,
    "provider_history_boundary",
    "the claim is contract, not telemetry: the denominator rule reads this exact field off the stored gap"
  );
});

test("a gap with no boundary_claim stores no boundary_claim key at all", () => {
  // Absence must stay absent rather than become `null`: every pre-existing
  // skip in production has no claim, and a null would be a new value that
  // downstream readers must learn to ignore.
  const gap = buildKnownGap({
    kind: "skip_result",
    reason: "rate_limited",
    stream: "group_messages",
  });
  assert.equal("boundary_claim" in gap, false);
});

test("an UNRECOGNIZED boundary_claim is dropped, never stored", () => {
  // Validated at the trust boundary. Storing an unknown claim verbatim would
  // let a future/typo'd value sit in durable evidence looking authoritative.
  for (const claim of ["provider_history_boundary_v2", "PROVIDER_HISTORY_BOUNDARY", "", "true", 1, {}]) {
    const gap = buildKnownGap({
      boundaryClaim: claim,
      kind: "skip_result",
      reason: "history_ended_before_provider_count",
      stream: "group_messages",
    });
    assert.equal(
      "boundary_claim" in gap,
      false,
      `${JSON.stringify(claim)} is outside the closed vocabulary and must be dropped`
    );
  }
});

test("the claim does not disturb the rest of the gap shape", () => {
  const withClaim = buildKnownGap({
    boundaryClaim: "provider_history_boundary",
    kind: "skip_result",
    reason: "history_ended_before_provider_count",
    recoveryHint: { action: "retry_by_runtime", retryable: true },
    stream: "group_messages",
  });
  const withoutClaim = buildKnownGap({
    kind: "skip_result",
    reason: "history_ended_before_provider_count",
    recoveryHint: { action: "retry_by_runtime", retryable: true },
    stream: "group_messages",
  });
  const { boundary_claim: _dropped, ...rest } = withClaim;
  assert.deepEqual(rest, withoutClaim, "adding the claim must be purely additive — severity, reason, scope unchanged");
});
