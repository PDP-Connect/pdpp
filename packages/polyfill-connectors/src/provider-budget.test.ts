// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CircuitBreaker,
  ProviderBudgetController,
  RetryBudget,
  retryBudgetCapacityFromRequestCap,
} from "./provider-budget.js";

test("RetryBudget: consumes retry tokens and refills on successes", () => {
  const budget = new RetryBudget({ capacity: 2, refillPerSuccess: 0.5 });

  assert.equal(budget.consume(), true);
  assert.equal(budget.remaining, 1);
  assert.equal(budget.consume(), true);
  assert.equal(budget.remaining, 0);
  assert.equal(budget.consume(), false);

  budget.recordSuccess();
  assert.equal(budget.remaining, 0.5);
  assert.equal(budget.consume(), false, "fractional token is not enough for a retry");
  budget.recordSuccess();
  assert.equal(budget.remaining, 1);
  assert.equal(budget.consume(), true);
});

test("retryBudgetCapacityFromRequestCap: derives ratio-based capacity and preserves unbounded runs", () => {
  assert.equal(retryBudgetCapacityFromRequestCap({ maxRequests: 50 }), 10);
  assert.equal(retryBudgetCapacityFromRequestCap({ maxRequests: 3, minCapacity: 1 }), 1);
  assert.equal(retryBudgetCapacityFromRequestCap({ maxRequests: Number.POSITIVE_INFINITY }), Number.POSITIVE_INFINITY);
});

test("CircuitBreaker: honors minimum throughput before opening", () => {
  const breaker = new CircuitBreaker({ failureRateThreshold: 0.5, minimumThroughput: 4, now: () => 0 });

  breaker.recordFailure();
  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.state, "closed", "minimum throughput prevents false-open on tiny samples");

  breaker.recordFailure();
  assert.equal(breaker.state, "open");
});

test("CircuitBreaker: open blocks requests, half-open probes after timeout, success closes", () => {
  let nowMs = 0;
  const breaker = new CircuitBreaker({
    failureRateThreshold: 0.5,
    minimumThroughput: 2,
    now: () => nowMs,
    resetTimeoutMs: 1000,
  });

  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.state, "open");
  assert.equal(breaker.beforeRequest().ok, false, "open circuit fast-fails before reset timeout");

  nowMs = 1000;
  assert.equal(breaker.beforeRequest().ok, true, "reset timeout allows a half-open probe");
  assert.equal(breaker.state, "half_open");
  breaker.recordSuccess();
  assert.equal(breaker.state, "closed");
});

test("CircuitBreaker: half-open probe failure reopens", () => {
  let nowMs = 0;
  const breaker = new CircuitBreaker({
    failureRateThreshold: 0.5,
    minimumThroughput: 2,
    now: () => nowMs,
    resetTimeoutMs: 1000,
  });

  breaker.recordFailure();
  breaker.recordFailure();
  nowMs = 1000;
  assert.equal(breaker.beforeRequest().ok, true);
  breaker.recordFailure();
  assert.equal(breaker.state, "open");
});

test("CircuitBreaker: remainingCooldownMs reports the exact wait until half-open, 0 when not open", () => {
  let nowMs = 0;
  const breaker = new CircuitBreaker({
    failureRateThreshold: 0.5,
    minimumThroughput: 2,
    now: () => nowMs,
    resetTimeoutMs: 1000,
  });

  // Closed circuit owes no cool-down — a transient back-off has nothing to wait.
  assert.equal(breaker.remainingCooldownMs(), 0, "closed circuit owes no cool-down");

  breaker.recordFailure();
  breaker.recordFailure();
  assert.equal(breaker.state, "open");
  assert.equal(breaker.remainingCooldownMs(), 1000, "freshly opened circuit owes the full reset timeout");

  nowMs = 600;
  assert.equal(breaker.remainingCooldownMs(), 400, "cool-down shrinks as the clock advances");

  nowMs = 1000;
  assert.equal(breaker.remainingCooldownMs(), 0, "no cool-down owed once the reset timeout has elapsed");

  // Half-open after a probe also owes nothing (it is no longer blocking).
  assert.equal(breaker.beforeRequest().ok, true);
  assert.equal(breaker.state, "half_open");
  assert.equal(breaker.remainingCooldownMs(), 0, "half-open circuit owes no cool-down");
});

test("ProviderBudgetController: circuitCooldownMs surfaces the breaker's remaining cool-down (0 when no breaker)", () => {
  let nowMs = 0;
  const budget = new ProviderBudgetController({
    circuitBreaker: {
      failureRateThreshold: 1,
      minimumThroughput: 1,
      now: () => nowMs,
      resetTimeoutMs: 5000,
      windowSize: 1,
    },
  });
  assert.equal(budget.circuitCooldownMs(), 0, "no cool-down owed before the circuit opens");
  budget.recordFailure();
  assert.equal(budget.circuitCooldownMs(), 5000, "open circuit surfaces the full cool-down");
  nowMs = 2000;
  assert.equal(budget.circuitCooldownMs(), 3000, "cool-down shrinks with elapsed time");

  const noBreaker = new ProviderBudgetController({ retryBudget: { capacity: 1 } });
  assert.equal(noBreaker.circuitCooldownMs(), 0, "a controller without a circuit breaker owes no cool-down");
});

test("ProviderBudgetController: drains generic circuit state transitions", async () => {
  let nowMs = 0;
  const budget = new ProviderBudgetController({
    circuitBreaker: {
      failureRateThreshold: 1,
      minimumThroughput: 1,
      now: () => nowMs,
      resetTimeoutMs: 1000,
    },
    retryBudget: { capacity: 2 },
  });

  budget.recordThrottle({ retryAfterAlreadySlept: true });
  assert.equal(budget.circuitBreaker?.state, "open");
  assert.deepEqual(budget.drainCircuitTransitions(), [
    {
      elapsedMs: 0,
      previousState: "closed",
      reason: "provider_throttle",
      requestCount: 0,
      retryTokensRemaining: 2,
      state: "open",
      trigger: "provider_throttle",
    },
  ]);
  assert.deepEqual(budget.drainCircuitTransitions(), [], "drain clears the durable-transition handoff buffer");

  nowMs = 1000;
  assert.equal((await budget.beforeRequest()).ok, true);
  budget.recordSuccess();

  assert.deepEqual(
    budget.drainCircuitTransitions().map(({ previousState, reason, state, trigger }) => ({
      previousState,
      reason,
      state,
      trigger,
    })),
    [
      { previousState: "open", reason: "reset_timeout", state: "half_open", trigger: "before_request" },
      { previousState: "half_open", reason: "success", state: "closed", trigger: "success" },
    ]
  );
});

test("ProviderBudgetController: gates by request budget before pacing", async () => {
  const sleeps: number[] = [];
  const budget = new ProviderBudgetController({
    pacing: {
      initialIntervalMs: 1000,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
    runBudget: { maxRequests: 1 },
  });

  assert.deepEqual(await budget.beforeRequest(), { ok: true });
  budget.recordRequest();
  const stop = await budget.beforeRequest();

  assert.equal(stop.ok, false);
  if (!stop.ok) {
    assert.equal(stop.reason, "max_requests");
    assert.equal(stop.requestCount, 1);
  }
  assert.deepEqual(sleeps, [1000], "second request did not pay pacing wait after budget exhaustion");
});

test("ProviderBudgetController: wall-clock budget returns planned defer metadata", async () => {
  let nowMs = 10_000;
  const budget = new ProviderBudgetController({ runBudget: { maxWallClockMs: 500, now: () => nowMs } });

  assert.equal((await budget.beforeRequest()).ok, true);
  nowMs = 10_500;
  const stop = await budget.beforeRequest();

  assert.equal(stop.ok, false);
  if (!stop.ok) {
    assert.equal(stop.reason, "max_wall_clock");
    assert.equal(stop.elapsedMs, 500);
  }
});

test("ProviderBudgetController: retry budget exhaustion is distinct from source pressure", () => {
  const budget = new ProviderBudgetController({ retryBudget: { capacity: 1 } });

  assert.deepEqual(budget.consumeRetry(), { ok: true });
  const stop = budget.consumeRetry();

  assert.equal(stop.ok, false);
  if (!stop.ok) {
    assert.equal(stop.reason, "retry_budget");
    assert.equal(stop.retryTokensRemaining, 0);
  }
});

test("ProviderBudgetController: throttle ratchets pacing without double-paying already slept Retry-After", async () => {
  const sleeps: number[] = [];
  let nowMs = 0;
  const budget = new ProviderBudgetController({
    pacing: {
      initialIntervalMs: 200,
      now: () => nowMs,
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  });

  await budget.beforeRequest();
  nowMs = 200;
  budget.recordThrottle({ retryAfterAlreadySlept: true, retryAfterMs: 5000 });
  await budget.beforeRequest();

  assert.notEqual(sleeps.at(-1), 5000, "Retry-After already slept by retry layer is not paid again by pacing");
});

test("ProviderBudgetController: success improves pacing and refills retry budget", () => {
  const budget = new ProviderBudgetController({
    pacing: { additiveIncreaseMs: 100, initialIntervalMs: 1000, minIntervalMs: 100, sleep: () => Promise.resolve() },
    retryBudget: { capacity: 1 },
  });

  assert.deepEqual(budget.consumeRetry(), { ok: true });
  assert.equal(budget.consumeRetry().ok, false);
  budget.recordSuccess();
  assert.deepEqual(budget.consumeRetry(), { ok: true });
  assert.equal(budget.pacing?.currentIntervalMs, 900);
});
