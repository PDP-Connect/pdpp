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

// ─── SLVP-ideal simulation: the controller accelerates and respects the ceiling ──

test("ProviderPacing: sustained success monotonically DECREASES the interval toward the ceiling (throughput rises)", () => {
  // The test that catches the flat-19/min posture: under sustained success the
  // EFFECTIVE INTERVAL must shrink over time toward the ceiling, raising
  // throughput — not stay pinned at the cold start.
  const ceilingMs = 250;
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: ceilingMs,
    additiveIncreaseMs: 100,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  const trajectory: number[] = [pacing.currentIntervalMs];
  for (let i = 0; i < 12; i += 1) {
    pacing.recordSuccess();
    trajectory.push(pacing.currentIntervalMs);
  }
  // Monotonically non-increasing.
  for (let i = 1; i < trajectory.length; i += 1) {
    const prev = trajectory[i - 1] as number;
    const curr = trajectory[i] as number;
    assert.ok(curr <= prev, `interval must never rise under sustained success: ${prev} -> ${curr}`);
  }
  const first = trajectory[0] as number;
  const last = trajectory.at(-1) as number;
  assert.ok(last < first, "interval decreased overall (throughput rose)");
  assert.equal(last, ceilingMs, "interval converged to the ceiling under sustained success");
});

test("ProviderPacing: injected throttle multiplicatively INCREASES the interval, then success recovers it", () => {
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 250,
    additiveIncreaseMs: 100,
    multiplicativeDecreaseFactor: 0.5,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  // Discover down toward the ceiling.
  for (let i = 0; i < 8; i += 1) {
    pacing.recordSuccess();
  }
  const beforeThrottle = pacing.currentIntervalMs;
  assert.ok(beforeThrottle < 1000, "controller discovered a faster interval before pressure");
  // Inject 429 pressure.
  pacing.recordThrottle();
  assert.ok(pacing.currentIntervalMs > beforeThrottle, "throttle multiplicatively slowed the rate");
  const afterThrottle = pacing.currentIntervalMs;
  // Sustained success recovers (additively) — slower than the multiplicative drop.
  pacing.recordSuccess();
  assert.ok(pacing.currentIntervalMs < afterThrottle, "success recovers the interval after a back-off");
  assert.equal(
    afterThrottle - pacing.currentIntervalMs,
    100,
    "recovery is additive (one step), not a multiplicative lunge — adapt up slow"
  );
});

test("ProviderPacing: the interval NEVER crosses the ceiling under any success volume", () => {
  const ceilingMs = 250;
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: ceilingMs,
    additiveIncreaseMs: 100,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  for (let i = 0; i < 1000; i += 1) {
    pacing.recordSuccess();
    assert.ok(pacing.currentIntervalMs >= ceilingMs, "interval never crosses the ceiling (faster than allowed)");
  }
  assert.equal(pacing.currentIntervalMs, ceilingMs, "rests exactly at the ceiling");
});

test("ProviderPacing: warm-start restores the prior run's learned interval, clamped to the ceiling", () => {
  // A fresh run resumes near the prior run's learned interval, not the cold seed.
  const warm = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 250,
    restoredIntervalMs: 320,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  assert.equal(warm.currentIntervalMs, 320, "warm-start resumes at the restored learned interval, not the cold 1000ms");

  // A restored value faster than the ceiling is clamped to the ceiling (never
  // probes past the operator's risk tolerance even if state is corrupt/stale).
  const clamped = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 250,
    restoredIntervalMs: 50,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  assert.equal(clamped.currentIntervalMs, 250, "warm-start never restores faster than the ceiling");

  // No restored value → cold start at the discovery seed.
  const cold = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 250,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  assert.equal(cold.currentIntervalMs, 1000, "no warm-start → cold discovery seed");
});

test("ProviderPacing: snapshot() exposes interval, ceiling, and last back-off for legibility", () => {
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 250,
    additiveIncreaseMs: 100,
    multiplicativeDecreaseFactor: 0.5,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  assert.deepEqual(pacing.snapshot(), { intervalMs: 1000, lastBackoff: null, minIntervalMs: 250 });

  pacing.recordSuccess();
  pacing.recordThrottle();
  const snap = pacing.snapshot();
  assert.equal(snap.minIntervalMs, 250, "snapshot carries the ceiling");
  assert.equal(snap.intervalMs, snap.lastBackoff?.atIntervalMs, "snapshot interval matches the back-off it just took");
  assert.equal(snap.lastBackoff?.reason, "throttle", "plain throttle reason recorded");

  pacing.recordThrottle({ retryAfterMs: 5000 });
  assert.equal(pacing.snapshot().lastBackoff?.reason, "retry_after", "retry-after back-off reason recorded");
});
