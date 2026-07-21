// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderBudgetController,
  type ProviderBudgetDeferReason,
  retryBudgetCapacityFromRequestCap,
} from "./provider-budget.ts";

/**
 * The scheduler's cross-run source-pressure cooldown is armed ONLY by gap
 * reasons in this set (mirror of
 * `reference-implementation/runtime/scheduler-source-pressure-cooldown.ts`,
 * pinned there by `scheduler-source-pressure-cooldown.test.js` line 240). It is
 * duplicated here as a literal so this package can assert its run-control
 * primitive's defer reasons stay disjoint from it WITHOUT importing across the
 * package boundary. If the scheduler set ever grows, that test fails and this
 * one must be reconciled deliberately.
 */
const SOURCE_PRESSURE_GAP_REASONS: ReadonlySet<string> = new Set(["rate_limited", "upstream_pressure"]);

/**
 * Every reason the converged provider-budget controller can DEFER a run with.
 * These are PLANNED stops (the run chose to stop at a self-imposed envelope or a
 * fast-fail circuit), NOT provider-driven source pressure. Per the doctrine,
 * budget exhaustion must never arm the cross-run cooldown — that would falsely
 * tell the scheduler the source is hot.
 */
const PROVIDER_BUDGET_DEFER_REASONS: readonly ProviderBudgetDeferReason[] = [
  "max_requests",
  "max_wall_clock",
  "circuit_open",
  "retry_budget",
];

test("DISCRIMINATION: no provider-budget defer reason is a source-pressure reason", () => {
  for (const reason of PROVIDER_BUDGET_DEFER_REASONS) {
    assert.equal(
      SOURCE_PRESSURE_GAP_REASONS.has(reason),
      false,
      `provider-budget defer reason '${reason}' must NOT arm the source-pressure cooldown (planned stop ≠ source pressure)`
    );
  }
});

test("DISCRIMINATION: the two reason taxonomies are fully disjoint", () => {
  const budget = new Set<string>(PROVIDER_BUDGET_DEFER_REASONS);
  const intersection = [...SOURCE_PRESSURE_GAP_REASONS].filter((r) => budget.has(r));
  assert.deepEqual(intersection, [], "source-pressure and budget-exhaustion reason sets share no member");
});

test("DISCRIMINATION: every controller stop carries a budget-exhaustion (non-pressure) reason", () => {
  // Run cap trip → max_requests.
  const capController = new ProviderBudgetController({ runBudget: { maxRequests: 1 } });
  capController.recordRequest();
  const capStop = capController.currentStop("max_requests");
  assert.equal(SOURCE_PRESSURE_GAP_REASONS.has(capStop.reason), false);

  // Retry budget exhaustion → retry_budget.
  const retryController = new ProviderBudgetController({
    retryBudget: { capacity: retryBudgetCapacityFromRequestCap({ maxRequests: 5 }), refillPerSuccess: 0 },
  });
  // Drain the retry budget, then the next consume returns a `retry_budget` stop.
  let stop: { ok: true } | { ok: false; reason: ProviderBudgetDeferReason } = { ok: true };
  for (let i = 0; i < 10; i++) {
    stop = retryController.consumeRetry();
    if (!stop.ok) {
      break;
    }
  }
  assert.equal(stop.ok, false, "retry budget eventually closes");
  if (!stop.ok) {
    assert.equal(stop.reason, "retry_budget");
    assert.equal(SOURCE_PRESSURE_GAP_REASONS.has(stop.reason), false, "retry-budget stop is not source pressure");
  }
});

test("DISCRIMINATION: an open circuit defers with circuit_open, which is not source pressure", () => {
  const controller = new ProviderBudgetController({
    circuitBreaker: { failureRateThreshold: 0.5, minimumThroughput: 1, windowSize: 2, resetTimeoutMs: 60_000 },
  });
  // Drive the breaker open with failures.
  controller.recordFailure();
  controller.recordFailure();
  const stop = controller.currentStop("circuit_open");
  assert.equal(
    SOURCE_PRESSURE_GAP_REASONS.has(stop.reason),
    false,
    "circuit_open is a planned fast-fail, not pressure"
  );
});
