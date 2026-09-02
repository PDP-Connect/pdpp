// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The shared baseline must actually be healthy.
 *
 * Every cross-surface oracle builds on `healthyConnectionInput()` and draws
 * conclusions from what changes when it overrides one field. If the baseline is
 * not green, none of those conclusions hold — a "disagreement" is then just the
 * fixture's own defect wearing a product's clothes.
 *
 * That is not hypothetical: the helper this was extracted from carried a
 * comment describing it as a healthy baseline while defaulting to an active,
 * unexpired backoff, which computes `cooling_off`. Four fixture defects in one
 * oracle went unnoticed until a control asserted green. This invariant is the
 * cheapest possible guard against the fifth.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { computeConnectionHealth } from "../runtime/connection-health.ts";
import { healthyConnectionInput } from "./fixtures/connection-health-baseline.ts";

test("INVARIANT: the shared baseline computes healthy", () => {
  assert.equal(
    computeConnectionHealth(healthyConnectionInput()).state,
    "healthy",
    "every oracle that overrides one field of this baseline depends on it being green to begin with"
  );
});

test("INVARIANT: every condition on the baseline is satisfied or not-applicable", () => {
  // A stricter statement of the same idea: `healthy` could in principle be
  // reached with a `false` condition the classifier happens to tolerate. It is
  // not — nothing is wrong with this connection at all.
  const snapshot = computeConnectionHealth(healthyConnectionInput());
  const unsatisfied = snapshot.conditions.filter(
    (condition) => condition.current && condition.status === "false"
  );
  assert.deepEqual(
    unsatisfied.map((condition) => `${condition.type}:${condition.reason}`),
    [],
    "a baseline with any current false condition is not a neutral starting point"
  );
});

test("INVARIANT: overriding one field is enough to move the verdict off healthy", () => {
  // Proves the baseline is not trivially/unconditionally green — if it were,
  // every downstream assertion would pass for the wrong reason.
  const stale = computeConnectionHealth(healthyConnectionInput({ freshness: { axis: "stale" } }));
  assert.notEqual(stale.state, "healthy", "the baseline must be sensitive to the fields oracles override");
});
