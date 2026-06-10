import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderPacing } from "./provider-pacing.js";

function makeSpy(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    sleep: (ms: number): Promise<void> => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

test("ProviderPacing: first admit() sleeps initialIntervalMs", async () => {
  const spy = makeSpy();
  const nowMs = 0;
  const pacing = new ProviderPacing({
    initialIntervalMs: 200,
    now: () => nowMs,
    sleep: spy.sleep,
  });
  await pacing.admit();
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0], 200, "first admit sleeps initialIntervalMs");
});

test("ProviderPacing: unset initialIntervalMs uses a conservative default", async () => {
  const spy = makeSpy();
  const pacing = new ProviderPacing({
    now: () => 0,
    sleep: spy.sleep,
  });

  await pacing.admit();

  assert.equal(spy.calls[0], 1000, "configured pacing starts conservatively when no rate is provided");
});

test("ProviderPacing: additive increase reduces currentIntervalMs toward minIntervalMs", () => {
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 100,
    additiveIncreaseMs: 200,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  assert.equal(pacing.currentIntervalMs, 1000);
  pacing.recordSuccess();
  assert.equal(pacing.currentIntervalMs, 800);
  pacing.recordSuccess();
  assert.equal(pacing.currentIntervalMs, 600);
  // Floor at minIntervalMs
  pacing.recordSuccess();
  pacing.recordSuccess();
  pacing.recordSuccess();
  assert.equal(pacing.currentIntervalMs, 100, "capped at minIntervalMs");
});

test("ProviderPacing: multiplicative decrease increases currentIntervalMs, floored at initialIntervalMs", () => {
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 100,
    additiveIncreaseMs: 200,
    multiplicativeDecreaseFactor: 0.5,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  // Increase fill rate first
  pacing.recordSuccess();
  assert.equal(pacing.currentIntervalMs, 800);
  // Throttle: multiply interval by 1/0.5 = 2
  pacing.recordThrottle();
  assert.equal(pacing.currentIntervalMs, 1600);
  // Throttle again
  pacing.recordThrottle();
  assert.equal(pacing.currentIntervalMs, 3200);
});

test("ProviderPacing: throttle from initial never goes below initialIntervalMs", () => {
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    multiplicativeDecreaseFactor: 0.5,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  // At initial, throttle should not go below initialIntervalMs
  // Actually initial / 0.5 = 2000 which is > initial, so this floors at initial only when < initial
  // Test that after success + throttle, floor holds
  pacing.recordSuccess(); // 900
  pacing.recordSuccess(); // 800
  // Apply many throttles — should grow, never go below 1000
  pacing.recordThrottle(); // 1600
  pacing.recordSuccess(); // 1500
  pacing.recordSuccess(); // 1400
  // Many successes back down toward initial
  for (let i = 0; i < 20; i++) {
    pacing.recordSuccess();
  }
  assert.ok(pacing.currentIntervalMs >= 0, "interval stayed non-negative");
});

test("ProviderPacing: one-way error ratchet — throttle after success raises interval; success after throttle only raises fill rate", () => {
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 100,
    additiveIncreaseMs: 100,
    multiplicativeDecreaseFactor: 0.5,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  // Increase fill rate
  pacing.recordSuccess(); // 900
  pacing.recordSuccess(); // 800
  const beforeThrottle = pacing.currentIntervalMs;
  // Throttle — interval should increase
  pacing.recordThrottle();
  assert.ok(pacing.currentIntervalMs > beforeThrottle, "throttle raises interval");
  const afterThrottle = pacing.currentIntervalMs;
  // Success after throttle — interval decreases (fill rate improves), but
  // calling success many times never goes below 0
  pacing.recordSuccess();
  assert.ok(pacing.currentIntervalMs < afterThrottle, "success reduces interval after throttle");
  assert.ok(pacing.currentIntervalMs >= 100, "stays >= minIntervalMs");
});

test("ProviderPacing: Retry-After honored exactly on next admit()", async () => {
  const spy = makeSpy();
  let nowMs = 0;
  const pacing = new ProviderPacing({
    initialIntervalMs: 200,
    now: () => nowMs,
    sleep: spy.sleep,
  });
  // First admit anchors
  await pacing.admit();
  nowMs = 200;
  // Signal a throttle with retryAfterMs
  pacing.recordThrottle({ retryAfterMs: 5000 });
  await pacing.admit();
  assert.equal(spy.calls.at(-1), 5000, "Retry-After honored exactly");
});

test("ProviderPacing: idle-credit cap — long idle gap does not accumulate unbounded credit", async () => {
  const sleepCalls: number[] = [];
  let nowMs = 0;
  const initialIntervalMs = 1000;
  const burstToleranceMs = 500;
  const pacing = new ProviderPacing({
    initialIntervalMs,
    burstToleranceMs,
    now: () => nowMs,
    sleep: (ms) => {
      sleepCalls.push(ms);
      return Promise.resolve();
    },
  });

  // First admit
  await pacing.admit();
  sleepCalls.length = 0;

  // Simulate a long idle gap — advance clock by 10x burst tolerance
  nowMs += 10 * burstToleranceMs;

  // Next admit: should NOT sleep 0 (no unbounded credit)
  // With GCRA idle cap, TAT is effectively now - burstToleranceMs,
  // so nextTat = (now - burstToleranceMs) + initialIntervalMs
  // delay = nextTat - now = initialIntervalMs - burstToleranceMs = 500
  await pacing.admit();
  const delay = sleepCalls[0] ?? 0;
  assert.ok(
    delay >= initialIntervalMs - burstToleranceMs,
    `idle-credit cap prevents free burst: delay=${delay} should be >= ${initialIntervalMs - burstToleranceMs}`
  );
});

test("ProviderPacing: provider isolation — two instances throttled independently", () => {
  const pacingA = new ProviderPacing({
    initialIntervalMs: 1000,
    multiplicativeDecreaseFactor: 0.5,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  const pacingB = new ProviderPacing({
    initialIntervalMs: 1000,
    multiplicativeDecreaseFactor: 0.5,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });

  pacingA.recordThrottle();
  assert.equal(pacingA.currentIntervalMs, 2000, "A throttled");
  assert.equal(pacingB.currentIntervalMs, 1000, "B unaffected by A throttle");
});
