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

test("ProviderPacing: soft throttle increases currentIntervalMs by 1.5×, floored at initialIntervalMs", () => {
  // Old behavior: ÷multiplicativeDecreaseFactor (×2). New behavior: ×(1+softThrottleGain)
  // default = ×1.5. Updated to reflect the bounded soft-throttle step (Fix 2).
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
  // Throttle: multiply interval by (1 + 0.5) = 1.5
  pacing.recordThrottle();
  assert.equal(pacing.currentIntervalMs, 1200); // 800 × 1.5 = 1200
  // Throttle again: 1200 × 1.5 = 1800
  pacing.recordThrottle();
  assert.equal(pacing.currentIntervalMs, 1800);
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

test("ProviderPacing Part B: a Retry-After is a one-shot wait, NOT a steady-state interval", async () => {
  // Part B — the live failure mode: `recordThrottle({ retryAfterMs })` used to
  // ALSO multiplicatively decrease the sustained interval. A ~100s Retry-After
  // would then become the ongoing inter-request rate and take ~hours of additive
  // recovery to undo — even though the provider only asked us to wait once. The
  // fix: a Retry-After sets the one-shot `nextRetryAfterMs` (honored by the very
  // next admit) but leaves `_currentIntervalMs` untouched.
  const spy = makeSpy();
  let nowMs = 0;
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 250,
    additiveIncreaseMs: 100,
    multiplicativeDecreaseFactor: 0.5,
    now: () => nowMs,
    sleep: spy.sleep,
  });
  // Warm the learned interval down so we can see it stay put.
  pacing.recordSuccess(); // 900
  pacing.recordSuccess(); // 800
  const learnedInterval = pacing.currentIntervalMs;
  assert.equal(learnedInterval, 800, "warmed to a faster learned interval");

  // A large Retry-After arrives.
  pacing.recordThrottle({ retryAfterMs: 100_000 });

  // The sustained interval is UNCHANGED — the 100s is not adopted as the rate,
  // nor even multiplicatively inflated (which would have made it 1600).
  assert.equal(pacing.currentIntervalMs, learnedInterval, "Retry-After does NOT inflate the steady-state interval");
  // The next admit honors the one-shot wait exactly...
  nowMs = 800;
  await pacing.admit();
  assert.equal(spy.calls.at(-1), 100_000, "one-shot wait honored exactly on next admit");
  // ...and the admit AFTER that returns to the learned interval, not 100s.
  nowMs += 100_000;
  await pacing.admit();
  assert.equal(
    spy.calls.at(-1),
    learnedInterval,
    "after the one-shot wait, the sustained rate is the learned interval, not the Retry-After"
  );
  // The back-off reason is still surfaced as retry_after for legibility.
  assert.equal(pacing.snapshot().lastBackoff?.reason, "retry_after", "retry-after back-off reason recorded");
});

test("ProviderPacing Part B: a plain throttle (no Retry-After) still increases the interval (soft 1.5× step)", () => {
  // Guardrail: Part B only changes the retryAfterMs branch. A bare throttle —
  // the MAIMD signal for an unquantified slow-down — now uses the bounded
  // softThrottleGain (×1.5 default) instead of the old ×2. Updated to reflect
  // Fix 2 (bounded soft-throttle replaces the ÷multiplicativeDecreaseFactor path).
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    multiplicativeDecreaseFactor: 0.5,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  pacing.recordThrottle(); // plain: 1000 × 1.5 = 1500
  assert.equal(pacing.currentIntervalMs, 1500, "plain throttle multiplies the interval by 1.5 (soft step)");
  assert.equal(pacing.snapshot().lastBackoff?.reason, "throttle", "plain throttle reason recorded");
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
  assert.equal(pacingA.currentIntervalMs, 1500, "A throttled (1000 × 1.5 = 1500)");
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
  assert.deepEqual(pacing.snapshot(), {
    intervalMs: 1000,
    lastBackoff: null,
    minIntervalMs: 250,
    initialIntervalMs: 1000,
  });

  pacing.recordSuccess();
  pacing.recordThrottle();
  const snap = pacing.snapshot();
  assert.equal(snap.minIntervalMs, 250, "snapshot carries the ceiling");
  assert.equal(snap.intervalMs, snap.lastBackoff?.atIntervalMs, "snapshot interval matches the back-off it just took");
  assert.equal(snap.lastBackoff?.reason, "throttle", "plain throttle reason recorded");

  pacing.recordThrottle({ retryAfterMs: 5000 });
  assert.equal(pacing.snapshot().lastBackoff?.reason, "retry_after", "retry-after back-off reason recorded");
});

// ─── Faster additive recovery from transient back-off (gentle ceiling preserved) ──

test("ProviderPacing: deep transient back-off recovers to the ceiling in FAR fewer successes than the flat base step", () => {
  // The fix: after a burst of real 429s the interval correctly backs off deep
  // (e.g. 16000ms). With the legacy flat 100ms step that tail is ~158 successes.
  // The distance-proportional step (recoveryGain) unwinds the over-backoff in
  // tens of successes — quantified below — WITHOUT being multiplicative.
  const deepIntervalMs = 16_000;
  const ceilingMs = 250;
  const initialIntervalMs = 1000;
  const baseStep = 100;

  function successesToCeiling(recoveryGain: number): number {
    const pacing = new ProviderPacing({
      initialIntervalMs,
      minIntervalMs: ceilingMs,
      additiveIncreaseMs: baseStep,
      recoveryGain,
      restoredIntervalMs: deepIntervalMs, // enter directly at the deep back-off
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    let n = 0;
    while (pacing.currentIntervalMs > ceilingMs && n < 100_000) {
      pacing.recordSuccess();
      n += 1;
    }
    return n;
  }

  const oldFlat = successesToCeiling(0); // legacy flat 100ms step
  const fast = successesToCeiling(0.1); // new default gain

  // Quantified improvement: the flat step needs ~158, the new gain ~34.
  assert.ok(oldFlat >= 150, `sanity: flat-step recovery is the slow tail (${oldFlat})`);
  assert.ok(fast <= 40, `distance-proportional recovery reaches the ceiling in ≤40 successes, got ${fast}`);
  assert.ok(
    fast * 4 < oldFlat,
    `recovery is >4x faster than the flat step: fast=${fast}, old=${oldFlat} (ratio ${(oldFlat / fast).toFixed(1)}x)`
  );
});

test("ProviderPacing: near the operating point the step is STILL the gentle base step (ceiling discovery stays cautious)", () => {
  // The theory constraint: the additive increase in the discovery region
  // (interval at or below initialIntervalMs) MUST remain the gentle base step.
  // recoveryGain only boosts the step ABOVE the operating point.
  const initialIntervalMs = 1000;
  const ceilingMs = 250;
  const baseStep = 100;
  const pacing = new ProviderPacing({
    initialIntervalMs,
    minIntervalMs: ceilingMs,
    additiveIncreaseMs: baseStep,
    recoveryGain: 0.1,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  // Walk down from the operating point. Every step in this region must be the
  // base step exactly (no boost), so the discovery toward the ceiling is gentle.
  let prev = pacing.currentIntervalMs;
  assert.equal(prev, initialIntervalMs);
  while (pacing.currentIntervalMs > ceilingMs) {
    pacing.recordSuccess();
    const step = prev - pacing.currentIntervalMs;
    // At the last sub-base step the floor clamps it; otherwise it is exactly base.
    assert.ok(
      step === baseStep || pacing.currentIntervalMs === ceilingMs,
      `near operating point the step must be the gentle base step (${baseStep}), got ${step}`
    );
    prev = pacing.currentIntervalMs;
  }
  // And the count from operating point to ceiling is identical to the flat step:
  // (1000-250)/100 = 7.5 → 8.
  const flatPacing = new ProviderPacing({
    initialIntervalMs,
    minIntervalMs: ceilingMs,
    additiveIncreaseMs: baseStep,
    recoveryGain: 0,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  let flatN = 0;
  while (flatPacing.currentIntervalMs > ceilingMs) {
    flatPacing.recordSuccess();
    flatN += 1;
  }
  assert.equal(
    flatN,
    8,
    "from the operating point the gentle base step takes the same successes as the legacy flat step"
  );
});

test("ProviderPacing: distance-proportional recovery still NEVER crosses the ceiling", () => {
  // The owner safety number (minIntervalMs) must hold under any recovery shape.
  const ceilingMs = 250;
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: ceilingMs,
    additiveIncreaseMs: 100,
    recoveryGain: 0.1,
    restoredIntervalMs: 30_000, // start deep
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  for (let i = 0; i < 2000; i += 1) {
    pacing.recordSuccess();
    assert.ok(
      pacing.currentIntervalMs >= ceilingMs,
      `interval never crosses the ceiling under boosted recovery (i=${i}, interval=${pacing.currentIntervalMs})`
    );
  }
  assert.equal(pacing.currentIntervalMs, ceilingMs, "rests exactly at the ceiling, never below");
});

test("ProviderPacing: the boosted step is ADDITIVE, not multiplicative — each step is a bounded fixed increment of the current state", () => {
  // Guardrail against a future refactor turning this into a geometric/multiplicative
  // increase (which would break Chiu-Jain convergence and risk overshooting the ceiling).
  // For a multiplicative law the ratio interval[n+1]/interval[n] would be ~constant;
  // for the additive law the per-step DELTA is a deterministic function of the interval
  // (baseStep + gain*(interval-initial)) and the interval shrinks super-linearly but each
  // step is a fixed subtraction, never a multiplication toward zero.
  const initialIntervalMs = 1000;
  const baseStep = 100;
  const gain = 0.1;
  const pacing = new ProviderPacing({
    initialIntervalMs,
    minIntervalMs: 250,
    additiveIncreaseMs: baseStep,
    recoveryGain: gain,
    restoredIntervalMs: 8000,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  let prev = pacing.currentIntervalMs;
  for (let i = 0; i < 5; i += 1) {
    pacing.recordSuccess();
    const observedDelta = prev - pacing.currentIntervalMs;
    // The step is floored to whole ms so intervals stay integer-valued.
    const expectedDelta = Math.floor(baseStep + gain * Math.max(0, prev - initialIntervalMs));
    assert.equal(
      observedDelta,
      expectedDelta,
      `step is exactly the additive fixed increment floor(baseStep + gain*overshoot), not a multiplication (i=${i})`
    );
    assert.ok(Number.isInteger(pacing.currentIntervalMs), `interval stays integer-valued (i=${i})`);
    prev = pacing.currentIntervalMs;
  }
});

test("ProviderPacing: recoveryGain=0 restores the exact legacy flat-step behaviour", () => {
  // Backward-compat escape hatch: gain 0 must reproduce the old constant 100ms step
  // at every interval, including deep above the operating point.
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 250,
    additiveIncreaseMs: 100,
    recoveryGain: 0,
    restoredIntervalMs: 5000,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  assert.equal(pacing.currentIntervalMs, 5000);
  pacing.recordSuccess();
  assert.equal(
    pacing.currentIntervalMs,
    4900,
    "gain=0 is the legacy flat 100ms step even deep above the operating point"
  );
});

// ─── SLVP-ideal §10-D: pacer pollution suppression ──────────────────────────

test("ProviderPacing: recordSuccess with suppressAdditiveIncrease=true leaves interval unchanged", () => {
  // §10-D — while a source-pressure cooldown is active, the recovery lane's
  // successes MUST NOT additive-decrease the shared interval (which would
  // un-learn the back-off and re-pressure the source). Passing
  // suppressAdditiveIncrease=true to recordSuccess suppresses the decrease.
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 250,
    additiveIncreaseMs: 100,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  // Drive interval down to a warm learned value
  pacing.recordSuccess(); // 900
  pacing.recordSuccess(); // 800
  const intervalBeforeRecovery = pacing.currentIntervalMs;
  assert.equal(intervalBeforeRecovery, 800);

  // Recovery-only success: interval MUST NOT change
  pacing.recordSuccess({ suppressAdditiveIncrease: true });
  assert.equal(
    pacing.currentIntervalMs,
    intervalBeforeRecovery,
    "suppressAdditiveIncrease=true leaves the interval unchanged"
  );

  // Multiple suppressed successes still do not move the interval
  pacing.recordSuccess({ suppressAdditiveIncrease: true });
  pacing.recordSuccess({ suppressAdditiveIncrease: true });
  assert.equal(
    pacing.currentIntervalMs,
    intervalBeforeRecovery,
    "repeated suppressed successes leave interval unchanged"
  );
});

test("ProviderPacing: recordThrottle still increases interval even when called after suppressed success", () => {
  // §10-D — recovery may DECELERATE the pacer (throttle still fires), never
  // accelerate it. Throttle must still increase the interval even after a
  // sequence of suppressed successes.
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 250,
    additiveIncreaseMs: 100,
    multiplicativeDecreaseFactor: 0.5,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  pacing.recordSuccess(); // 900
  const before = pacing.currentIntervalMs; // 900

  // Suppressed success does NOT change interval
  pacing.recordSuccess({ suppressAdditiveIncrease: true });
  assert.equal(pacing.currentIntervalMs, before, "suppressed success: no change");

  // Throttle still fires — multiplicative increase
  pacing.recordThrottle();
  assert.ok(
    pacing.currentIntervalMs > before,
    `throttle must still increase interval after suppressed success; before=${before} after=${pacing.currentIntervalMs}`
  );
});

test("ProviderPacing: recordSuccess without suppressAdditiveIncrease (or false) still decreases interval normally", () => {
  // §10-D — the flag is opt-in; a plain recordSuccess() / recordSuccess({suppressAdditiveIncrease:false})
  // must behave identically to the existing additive-decrease behavior.
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 250,
    additiveIncreaseMs: 100,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  assert.equal(pacing.currentIntervalMs, 1000);
  pacing.recordSuccess();
  assert.equal(pacing.currentIntervalMs, 900, "plain recordSuccess() still decreases interval");
  pacing.recordSuccess({ suppressAdditiveIncrease: false });
  assert.equal(pacing.currentIntervalMs, 800, "recordSuccess({suppress:false}) still decreases interval");
});

// ─── SLVP-ideal §10-E: stale warm-start cold re-entry ───────────────────────

test("ProviderPacing §10-E: stale warm-start yields cold-start interval (no burst into possibly-tightened quota)", () => {
  // §10-E — if idle since last run > maxWarmStartAgeMs, the first request of ANY
  // lane re-enters at the conservative cold-start initialIntervalMs, not the
  // restored aggressive one. Warm-start accelerates a *continuing* descent; it
  // must not grant a *cold* burst when the provider may have tightened since then.
  const nowMs = 10_000_000; // arbitrary "current" timestamp
  const maxWarmStartAgeMs = 6 * 60 * 60 * 1000; // 6 hours — the §10-E staleness window
  const staleAge = maxWarmStartAgeMs + 1; // one ms past the window

  const stale = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 250,
    restoredIntervalMs: 320, // learned aggressive interval from prior run
    restoredAtMs: nowMs - staleAge, // persisted staleAge ms ago → stale
    maxWarmStartAgeMs,
    now: () => nowMs,
    sleep: () => Promise.resolve(),
  });
  assert.equal(
    stale.currentIntervalMs,
    1000,
    "stale warm-start: must cold-restart at initialIntervalMs, not the restored 320ms"
  );
});

test("ProviderPacing §10-E: fresh warm-start (within staleness window) restores the learned interval", () => {
  // §10-E — a warm-start whose persisted timestamp is within maxWarmStartAgeMs
  // MUST restore the learned interval (continuing AIMD descent across runs).
  const nowMs = 10_000_000;
  const maxWarmStartAgeMs = 6 * 60 * 60 * 1000;
  const freshAge = maxWarmStartAgeMs - 1; // one ms inside the window

  const fresh = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 250,
    restoredIntervalMs: 320,
    restoredAtMs: nowMs - freshAge,
    maxWarmStartAgeMs,
    now: () => nowMs,
    sleep: () => Promise.resolve(),
  });
  assert.equal(
    fresh.currentIntervalMs,
    320,
    "fresh warm-start: restores the learned interval so AIMD descent compounds across runs"
  );
});

test("ProviderPacing §10-E: warm-start without restoredAtMs or maxWarmStartAgeMs behaves as before (caller-owned guard)", () => {
  // §10-E — if neither restoredAtMs nor maxWarmStartAgeMs is provided, staleness
  // checking is disabled and the existing behaviour is preserved (backwards-
  // compatible: the caller has already decided freshness, as documented in prior
  // PacingOptions.restoredIntervalMs comment).
  const nowMs = 10_000_000;

  // No staleness params → treats as fresh → restores interval (existing behaviour)
  const noStaleness = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 250,
    restoredIntervalMs: 320,
    now: () => nowMs,
    sleep: () => Promise.resolve(),
  });
  assert.equal(
    noStaleness.currentIntervalMs,
    320,
    "no staleness params → restored interval used (backwards-compatible)"
  );
});

test("ProviderPacing §10-E: warm-start exactly AT the staleness boundary is still treated as fresh", () => {
  // §10-E — boundary condition: age === maxWarmStartAgeMs is still fresh (not stale).
  // Stale = strictly greater than the window.
  const nowMs = 10_000_000;
  const maxWarmStartAgeMs = 6 * 60 * 60 * 1000;
  const exactBoundary = maxWarmStartAgeMs; // exactly at the window edge

  const boundary = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 250,
    restoredIntervalMs: 320,
    restoredAtMs: nowMs - exactBoundary,
    maxWarmStartAgeMs,
    now: () => nowMs,
    sleep: () => Promise.resolve(),
  });
  assert.equal(boundary.currentIntervalMs, 320, "warm-start exactly at the age boundary is still treated as fresh");
});

// ─── Fix 1: elapsed-time-weighted recovery (red-team-corrected) ──────────────

test("ProviderPacing Fix1: elapsed weighting — deep interval recovers MUCH faster with large elapsed gap", () => {
  // From a deep interval (~51s), a second success with elapsed ~= that interval
  // should recover ~elapsedRecoveryCap× more than the un-weighted over-backoff
  // term alone would. Base additiveIncreaseMs stays flat (weight doesn't touch it).
  //
  // Key: the first success primes lastSuccessAtMs (null→weight=1, backward-compat).
  // The SECOND success, with a large elapsed gap, demonstrates the weighting.
  const initialIntervalMs = 1000;
  const additiveIncreaseMs = 100;
  const recoveryGain = 0.1;
  const elapsedRecoveryCap = 8;
  // Start deep enough that after the first success we're still well above initial.
  const startIntervalMs = 55_000;

  let nowMs = 0;
  const pacing = new ProviderPacing({
    initialIntervalMs,
    minIntervalMs: 250,
    additiveIncreaseMs,
    recoveryGain,
    elapsedRecoveryCap,
    restoredIntervalMs: startIntervalMs,
    now: () => nowMs,
    sleep: () => Promise.resolve(),
  });

  // First success at t=0: null lastSuccessAtMs → elapsed treated as initialIntervalMs → weight=1
  // step = floor(100 + 0.1 * (55000-1000) * 1) = floor(100 + 5400) = 5500
  pacing.recordSuccess();
  // lastSuccessAtMs is now 0. Interval is now startIntervalMs - 5500 = 49500.
  const intervalAfterFirst = pacing.currentIntervalMs;
  assert.ok(intervalAfterFirst > initialIntervalMs, "still deep above initial after first success");

  // Advance clock by ~49s (simulating one throttled-cadence fetch taking the full interval)
  const bigElapsedMs = 49_000;
  nowMs += bigElapsedMs;

  // Un-weighted step for this interval: floor(100 + 0.1 * (intervalAfterFirst - 1000) * 1)
  const overBackoff = intervalAfterFirst - initialIntervalMs;
  const unweightedStep = Math.floor(additiveIncreaseMs + recoveryGain * overBackoff * 1);
  // Weighted step: weight = clamp(49000/1000, 1, 8) = 8
  const weight = Math.min(elapsedRecoveryCap, Math.max(1, bigElapsedMs / initialIntervalMs));
  const weightedStep = Math.floor(additiveIncreaseMs + recoveryGain * overBackoff * weight);

  pacing.recordSuccess();
  const actualStep = intervalAfterFirst - pacing.currentIntervalMs;

  assert.equal(actualStep, weightedStep, `step = floor(base + gain*overBackoff*weight) = ${weightedStep}`);
  assert.ok(
    weightedStep > unweightedStep * 4,
    `elapsed-weighted recovery (${weightedStep}) is >4× the un-weighted step (${unweightedStep})`
  );
  // Base (additiveIncreaseMs=100) is NOT multiplied — only the over-backoff term is
  const baseContribution = additiveIncreaseMs;
  const overBackoffContribution = weightedStep - baseContribution;
  assert.ok(overBackoffContribution > 0, "over-backoff term contributes positively to the step");
});

test("ProviderPacing Fix1: gentle-near-ceiling PRESERVED — huge elapsed gap at tiny overBackoff does NOT collapse to floor", () => {
  // Red-team's key check: the base additiveIncreaseMs is NOT elapsed-weighted.
  // Near the ceiling (overBackoffMs tiny) even a huge elapsed gap must NOT
  // collapse the interval straight to minIntervalMs in one step.
  //
  // Setup: prime lastSuccessAtMs with a first success, then advance clock hugely.
  const initialIntervalMs = 1000;
  const justAboveInitial = 1100; // overBackoff = 100ms (tiny)
  const minIntervalMs = 100;

  const nowMs = 0;
  const pacing = new ProviderPacing({
    initialIntervalMs,
    minIntervalMs,
    additiveIncreaseMs: 100,
    recoveryGain: 0.1,
    elapsedRecoveryCap: 8,
    restoredIntervalMs: justAboveInitial,
    now: () => nowMs,
    sleep: () => Promise.resolve(),
  });
  assert.equal(pacing.currentIntervalMs, justAboveInitial);

  // First success at t=0: null lastSuccessAtMs → weight=1.
  // overBackoff = 1100-1000=100, step = floor(100 + 0.1*100*1) = 110. Interval → 990.
  pacing.recordSuccess();
  // lastSuccessAtMs is now 0. interval is 990 (below initial, so overBackoff=0 hereafter).

  // Now restore back above initial to re-demonstrate the ceiling check.
  // We re-create a fresh instance seeded just above initial, but this time we
  // prime lastSuccessAtMs via a helper first-success at the same nowMs, then throttle back up.
  // Simpler: use a fresh instance with an initial success that sets lastSuccessAtMs,
  // then apply a throttle to push back above initial, then check one more success.
  const nowMs2 = { v: 0 };
  const pacing2 = new ProviderPacing({
    initialIntervalMs,
    minIntervalMs,
    additiveIncreaseMs: 100,
    recoveryGain: 0.1,
    elapsedRecoveryCap: 8,
    now: () => nowMs2.v,
    sleep: () => Promise.resolve(),
  });
  // Prime lastSuccessAtMs at t=0
  pacing2.recordSuccess(); // 1000 → 900, lastSuccessAtMs=0
  // Push back above initial via throttle: 900 × 1.5 = 1350 (just above initial)
  pacing2.recordThrottle(); // → 1350
  assert.ok(pacing2.currentIntervalMs > initialIntervalMs, "pushed above initial");
  const intervalAboveInitial = pacing2.currentIntervalMs; // 1350, overBackoff=350

  // Advance clock by a huge elapsed gap
  nowMs2.v += 500_000; // weight = clamp(500000/1000, 1, 8) = 8

  pacing2.recordSuccess();
  // overBackoff = 1350 - 1000 = 350. weighted step = floor(100 + 0.1*350*8) = floor(100+280) = 380.
  // After: 1350 - 380 = 970ms — well above minIntervalMs (100ms).
  const expectedStep = Math.floor(100 + 0.1 * (intervalAboveInitial - initialIntervalMs) * 8);
  const actualStep = intervalAboveInitial - pacing2.currentIntervalMs;
  assert.equal(actualStep, expectedStep, `step is bounded to base + weighted-overBackoff: ${expectedStep}`);
  assert.notEqual(
    pacing2.currentIntervalMs,
    minIntervalMs,
    "huge elapsed gap near the ceiling must NOT collapse interval to minIntervalMs in one step"
  );
  assert.ok(
    pacing2.currentIntervalMs > minIntervalMs,
    `interval (${pacing2.currentIntervalMs}) stays well above minIntervalMs (${minIntervalMs})`
  );
});

test("ProviderPacing Fix1: cooldown suppression still wins — suppressed success leaves interval AND lastSuccessAtMs unchanged", () => {
  // §10-D: suppressAdditiveIncrease=true must leave both interval and
  // lastSuccessAtMs unchanged. A suppressed success is not a real recovery tick.
  let nowMs = 1000;
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 250,
    additiveIncreaseMs: 100,
    restoredIntervalMs: 5000,
    now: () => nowMs,
    sleep: () => Promise.resolve(),
  });
  assert.equal(pacing.currentIntervalMs, 5000);

  // First real success to set lastSuccessAtMs
  pacing.recordSuccess();
  const intervalAfterReal = pacing.currentIntervalMs;
  assert.ok(intervalAfterReal < 5000, "real success decreased interval");
  // lastSuccessAtMs is now set to nowMs=1000

  // Advance clock
  nowMs = 60_000;

  // Suppressed success: interval must not change
  const intervalBefore = pacing.currentIntervalMs;
  pacing.recordSuccess({ suppressAdditiveIncrease: true });
  assert.equal(pacing.currentIntervalMs, intervalBefore, "suppressed success does not change interval");

  // Verify lastSuccessAtMs was NOT updated: a real success now should use the old
  // timestamp (elapsed = 60000 - 1000 = 59000ms → weight = min(8, max(1, 59)) = 8)
  // If lastSuccessAtMs HAD been updated to 60000, elapsed would be 0 → weight = 1.
  const intervalBeforeReal2 = pacing.currentIntervalMs;
  pacing.recordSuccess();
  const step2 = intervalBeforeReal2 - pacing.currentIntervalMs;
  // With elapsed=59000ms, weight=8; overBackoff=interval-1000 (positive since we're above initial)
  // If lastSuccessAtMs was NOT updated (correctly), weight=8 and step is large
  // If lastSuccessAtMs WAS updated (incorrectly), weight=1 and step is small
  const overBackoff = Math.max(0, intervalBeforeReal2 - 1000);
  const expectedStepWeighted = Math.floor(100 + 0.1 * overBackoff * 8);
  const expectedStepUnweighted = Math.floor(100 + 0.1 * overBackoff * 1);
  assert.equal(
    step2,
    expectedStepWeighted,
    `suppression preserved lastSuccessAtMs — step uses large elapsed weight (${expectedStepWeighted} not ${expectedStepUnweighted})`
  );
});

test("ProviderPacing Fix1: backward-compat at operating point — normal-cadence success recovers at weight=1", () => {
  // A success with elapsed ≈ initialIntervalMs gives weight = clamp(1, 1, 8) = 1.
  // The step must equal the old un-weighted formula exactly — no behavior change
  // for callers operating at normal cadence.
  const initialIntervalMs = 1000;
  let nowMs = 0;
  const pacing = new ProviderPacing({
    initialIntervalMs,
    minIntervalMs: 250,
    additiveIncreaseMs: 100,
    recoveryGain: 0.1,
    restoredIntervalMs: 5000, // deep — so overBackoff is non-zero
    now: () => nowMs,
    sleep: () => Promise.resolve(),
  });
  // First success: lastSuccessAtMs is null → elapsed treated as initialIntervalMs → weight=1
  const beforeFirst = pacing.currentIntervalMs;
  pacing.recordSuccess();
  const stepFirst = beforeFirst - pacing.currentIntervalMs;
  const expectedUnweighted = Math.floor(100 + 0.1 * (beforeFirst - initialIntervalMs));
  assert.equal(
    stepFirst,
    expectedUnweighted,
    "first success (null lastSuccessAtMs) uses weight=1, matches old formula"
  );

  // Second success: advance by exactly initialIntervalMs → weight = clamp(1000/1000, 1, 8) = 1
  nowMs += initialIntervalMs;
  const beforeSecond = pacing.currentIntervalMs;
  pacing.recordSuccess();
  const stepSecond = beforeSecond - pacing.currentIntervalMs;
  const expectedSecond = Math.floor(100 + 0.1 * (beforeSecond - initialIntervalMs));
  assert.equal(stepSecond, expectedSecond, "normal-cadence elapsed=initialIntervalMs → weight=1 → old formula exactly");
});

// ─── Fix 2: bounded throttle (softThrottleGain + maxIntervalMs) ──────────────

test("ProviderPacing Fix2: plain recordThrottle multiplies by 1.5 (1000 → 1500), not ×2", () => {
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 100,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  assert.equal(pacing.currentIntervalMs, 1000);
  pacing.recordThrottle();
  assert.equal(pacing.currentIntervalMs, 1500, "default softThrottleGain=0.5 → 1000 × 1.5 = 1500");
});

test("ProviderPacing Fix2: repeated throttles are clamped at maxIntervalMs", () => {
  const maxIntervalMs = 3000;
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 100,
    maxIntervalMs,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  // Throttle many times — must never exceed maxIntervalMs
  for (let i = 0; i < 20; i++) {
    pacing.recordThrottle();
    assert.ok(
      pacing.currentIntervalMs <= maxIntervalMs,
      `interval must never exceed maxIntervalMs=${maxIntervalMs} at throttle ${i + 1}, got ${pacing.currentIntervalMs}`
    );
  }
  assert.equal(pacing.currentIntervalMs, maxIntervalMs, "interval rests exactly at maxIntervalMs after saturation");
});

test("ProviderPacing Fix2: maxIntervalMs does not affect retry-after one-shot (retry-after path unchanged)", async () => {
  // maxIntervalMs ONLY clamps plain-throttle sustained interval.
  // retry-after is a one-shot wait and must be honored exactly, even if > maxIntervalMs.
  const spy = makeSpy();
  let nowMs = 0;
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    maxIntervalMs: 2000, // well below the retry-after
    now: () => nowMs,
    sleep: spy.sleep,
  });
  await pacing.admit(); // anchor TAT
  nowMs = 1000;
  pacing.recordThrottle({ retryAfterMs: 90_000 }); // retry-after >> maxIntervalMs
  await pacing.admit();
  assert.equal(spy.calls.at(-1), 90_000, "retry-after one-shot honored exactly even when > maxIntervalMs");
  // Sustained interval must NOT have been inflated to 90000 (or clamped to 2000)
  // — the retry-after path leaves _currentIntervalMs untouched entirely.
  assert.equal(pacing.currentIntervalMs, 1000, "retry-after does not change the sustained interval");
});
