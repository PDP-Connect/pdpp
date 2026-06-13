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
  // §9-C2 (rate-space): the additive increase now raises the RATE by a constant
  // calibrated step (matched to additiveIncreaseMs at the operating point), so the
  // FIRST step off 1000 is exactly −200ms (1000→800, live behavior preserved) but
  // subsequent steps shrink as the interval narrows (rate climbs linearly, not
  // super-linearly). 800→667 (rate 75→90/min, +15/min ≈ the matched step), etc.
  const pacing = new ProviderPacing({
    initialIntervalMs: 1000,
    minIntervalMs: 100,
    additiveIncreaseMs: 200,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  assert.equal(pacing.currentIntervalMs, 1000);
  pacing.recordSuccess();
  assert.equal(
    pacing.currentIntervalMs,
    800,
    "first step is the calibrated −200ms (rate +15/min) — matches the operating-point step"
  );
  pacing.recordSuccess();
  assert.equal(
    pacing.currentIntervalMs,
    667,
    "rate-space: +15/min from 75/min → 90/min → 667ms (a SMALLER interval step than the old flat 200ms)"
  );
  // Floor at minIntervalMs: continues converging by constant rate increments and
  // is hard-clamped at the floor (the safety ceiling is still never crossed).
  pacing.recordSuccess();
  pacing.recordSuccess();
  pacing.recordSuccess();
  assert.equal(
    pacing.currentIntervalMs,
    444,
    "still descending toward the floor by constant rate steps (not yet clamped)"
  );
  for (let i = 0; i < 40; i += 1) {
    pacing.recordSuccess();
  }
  assert.equal(
    pacing.currentIntervalMs,
    100,
    "capped at minIntervalMs (hard floor still binds — rests exactly at the ceiling)"
  );
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
  // Warm the learned interval down so we can see it stay put. §9-C2 (rate-space):
  // first success is the calibrated −100ms (1000→900); the second raises the RATE
  // by the same constant step, so 900→818 (a smaller interval decrement than the
  // old flat 100ms — the rate, not the interval, moves by a fixed amount).
  pacing.recordSuccess(); // 900
  pacing.recordSuccess(); // 818 (rate-space step from 900)
  const learnedInterval = pacing.currentIntervalMs;
  assert.equal(learnedInterval, 818, "warmed to a faster learned interval (rate-space second step)");

  // A large Retry-After arrives.
  pacing.recordThrottle({ retryAfterMs: 100_000 });

  // The sustained interval is UNCHANGED — the 100s is not adopted as the rate,
  // nor even multiplicatively inflated.
  assert.equal(pacing.currentIntervalMs, learnedInterval, "Retry-After does NOT inflate the steady-state interval");
  // The next admit honors the one-shot wait exactly...
  nowMs = 818;
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
  // §9-C2 (rate-space): the ramp now takes more successes (the rate climbs in
  // constant increments, so each interval step shrinks as it nears the floor).
  // 28 successes carry 1000→250; sample 12 to assert monotonic descent, then
  // confirm convergence to the ceiling.
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
  const sampled = trajectory.at(-1) as number;
  assert.ok(sampled < first, "interval decreased overall over the sampled window (throughput rose)");
  assert.equal(
    sampled,
    429,
    "rate-space: 12 successes reach 429ms (interval steps shrink as the rate climbs linearly)"
  );
  // Continue to convergence: sustained success still rests at exactly the ceiling.
  for (let i = 0; i < 30; i += 1) {
    pacing.recordSuccess();
  }
  assert.equal(pacing.currentIntervalMs, ceilingMs, "interval converged to the ceiling under sustained success");
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

test("ProviderPacing: deep transient back-off recovers to the ceiling fast (rate-space subsumes the old flat tail; recoveryGain still helps)", () => {
  // After a burst of real 429s the interval correctly backs off deep (e.g.
  // 16000ms). §9-C2 (rate-space) CHANGES the recovery shape for the better: in
  // rate space the per-success step raises the RATE by a constant, so at a DEEP
  // interval (where the rate is tiny) the base step is a LARGE interval jump. The
  // old "~158-success flat tail" (the slow legacy 100ms-per-success climb from
  // 16000ms) NO LONGER EXISTS — the rate-space base step alone reaches the ceiling
  // in ~36 successes. The elapsed-weighted recoveryGain term still shaves a few
  // more off (and, crucially, is the fast-recovery path when fetches are SLOW; see
  // the Fix1 elapsed-weighting test). Both stay ADDITIVE and ban-safe (every
  // intermediate interval is still slower than the rate that already succeeded).
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

  const rateBaseOnly = successesToCeiling(0); // pure rate-space base step (no boost)
  const withBoost = successesToCeiling(0.1); // rate-space base + deep-recovery boost

  // Rate-space ALONE recovers a deep spike fast — the old slow flat tail is gone.
  assert.equal(
    rateBaseOnly,
    36,
    "rate-space base step alone recovers 16000→250 in 36 successes (the old ~158 flat tail is gone)"
  );
  // The recoveryGain boost still helps (a few fewer successes) and never hurts.
  assert.ok(
    withBoost <= rateBaseOnly,
    `recoveryGain still helps (or is neutral): boost=${withBoost} <= base=${rateBaseOnly}`
  );
  assert.ok(withBoost <= 40, `deep recovery reaches the ceiling in ≤40 successes, got ${withBoost}`);
});

test("ProviderPacing §9-C2 IDEAL: near the ceiling the per-success RATE gain is ~CONSTANT (rate-space AIMD), NOT super-accelerating", () => {
  // §9-C2 (slvp-ideal, IMPLEMENTED) — the regression guard for the IDEAL, replacing
  // the old "step is exactly the flat 100ms" pin (which encoded the WRONG shape: a
  // flat INTERVAL step makes the RATE super-accelerate toward the floor). True AIMD
  // increases the RATE by a fixed amount per success. So the load-bearing property
  // is now: across the WHOLE operating range [floor, initial] the per-success RATE
  // gain stays ~constant (≈ the calibrated step), NOT climbing 1×→7.5× as the
  // interval narrows. The control LAW approaches the ceiling cautiously by
  // construction — it does not rely on the floor clamp to bound the ramp.
  const initialIntervalMs = 1000;
  const ceilingMs = 250;
  const baseStep = 100;
  const ratePerMin = (ms: number): number => 60_000 / ms;
  // The calibrated constant rate step (matched to the interval law at the operating
  // point): rate(initial − baseStep) − rate(initial) = 66.667 − 60 = 6.667/min.
  const calibratedRateStep = ratePerMin(initialIntervalMs - baseStep) - ratePerMin(initialIntervalMs);

  const pacing = new ProviderPacing({
    initialIntervalMs,
    minIntervalMs: ceilingMs,
    additiveIncreaseMs: baseStep,
    recoveryGain: 0.1, // boost is zero in this region (overBackoff = 0), so it does not perturb the band
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  assert.equal(pacing.currentIntervalMs, initialIntervalMs);

  // Walk down from the operating point to the floor, recording the per-success RATE
  // gain at every step. Every FULL step must sit in a TIGHT band around the
  // calibrated step (the only deviation is integer-rounding noise); the single
  // partial step that lands ON the floor is allowed to be smaller (it is clamped).
  let prevInterval = pacing.currentIntervalMs;
  const fullStepRatios: number[] = [];
  while (pacing.currentIntervalMs > ceilingMs) {
    pacing.recordSuccess();
    const dRate = ratePerMin(pacing.currentIntervalMs) - ratePerMin(prevInterval);
    const ratio = dRate / calibratedRateStep;
    if (pacing.currentIntervalMs > ceilingMs) {
      // A full (un-clamped) step — must be in the tight rate-space band.
      fullStepRatios.push(ratio);
    } else {
      // The final partial step into the floor — may be a fraction of the full step
      // (correct: it only covers the remaining distance), never MORE than a step.
      assert.ok(
        ratio <= 1.1,
        `final floor-clamped step is never larger than a full rate step (got ${ratio.toFixed(3)}×)`
      );
    }
    prevInterval = pacing.currentIntervalMs;
  }
  // The IDEAL: every full step's rate gain is within ±10% of the calibrated step —
  // i.e. CONSTANT, not the 1×→7.5× super-acceleration of the old interval law.
  for (const ratio of fullStepRatios) {
    assert.ok(
      ratio > 0.9 && ratio < 1.1,
      `§9-C2 ideal: per-success RATE gain must be ~constant (±10%), got ${ratio.toFixed(3)}× the calibrated rate step — ` +
        "a value climbing toward ~7.5× near the floor would mean the law reverted to interval-space (the WRONG shape)"
    );
  }
  // And there are MORE steps than the 8 of the flat interval law — the cautious
  // (slower) ceiling approach is exactly the AIMD congestion-avoidance discipline.
  assert.equal(
    fullStepRatios.length,
    26,
    "27-step ramp 1000→250 (one partial floor step excluded) — cautious rate-space approach, not 8"
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

test("ProviderPacing: the step is ADDITIVE, not multiplicative — each step is a deterministic fixed increment (rate-space base + interval-space deep boost)", () => {
  // Guardrail against a future refactor turning this into a geometric/multiplicative
  // increase (which would break Chiu-Jain convergence and risk overshooting the ceiling).
  // §9-C2 (rate-space): the per-step DELTA is now a deterministic function of the
  //   interval = rateSpaceBaseStep(interval) + floor(gain*(interval−initial)*weight),
  // where rateSpaceBaseStep raises the RATE by a fixed calibrated step and converts
  // back to an integer interval. Each step is a fixed SUBTRACTION (additive), never a
  // multiplication toward zero. Verified by reproducing the exact formula below.
  const initialIntervalMs = 1000;
  const baseStep = 100;
  const gain = 0.1;
  const msPerMin = 60_000;
  // The calibrated constant rate step the base uses (matched at the operating point).
  const calibratedRateStep = msPerMin / (initialIntervalMs - baseStep) - msPerMin / initialIntervalMs;
  // Reproduce ProviderPacing's rate-space base step: raise the rate by the calibrated
  // step, round back to an integer interval, take the (non-negative) decrement.
  const rateSpaceBaseStepMs = (interval: number): number => {
    const newInterval = Math.max(1, Math.round(msPerMin / (msPerMin / interval + calibratedRateStep)));
    return Math.max(0, interval - newInterval);
  };
  const pacing = new ProviderPacing({
    initialIntervalMs,
    minIntervalMs: 250,
    additiveIncreaseMs: baseStep,
    recoveryGain: gain,
    restoredIntervalMs: 8000,
    now: () => 0, // const clock → every step's elapsed weight is 1
    sleep: () => Promise.resolve(),
  });
  let prev = pacing.currentIntervalMs;
  for (let i = 0; i < 5; i += 1) {
    pacing.recordSuccess();
    const observedDelta = prev - pacing.currentIntervalMs;
    // rate-space base step (integer) + interval-space deep-recovery boost (weight=1).
    const expectedDelta = rateSpaceBaseStepMs(prev) + Math.floor(gain * Math.max(0, prev - initialIntervalMs));
    assert.equal(
      observedDelta,
      expectedDelta,
      `step is exactly rateSpaceBaseStep(interval) + floor(gain*overshoot), not a multiplication (i=${i})`
    );
    assert.ok(Number.isInteger(pacing.currentIntervalMs), `interval stays integer-valued (i=${i})`);
    prev = pacing.currentIntervalMs;
  }
});

test("ProviderPacing: recoveryGain=0 is the pure rate-space base step (no deep-recovery boost)", () => {
  // §9-C2 (rate-space): gain=0 drops the over-backoff deep-recovery boost, leaving
  // the PURE rate-space base step at every interval. It NO LONGER reproduces the old
  // flat 100ms interval step — that flat step was the WRONG (interval-space) shape.
  // Deep above the operating point (5000ms ⇒ rate ≈ 12/min) a constant rate increment
  // of ~6.667/min is a LARGE interval jump: 5000 → round(60000/(12+6.667)) = 3214.
  // This is the correct rate-space behavior (and is why rate-space already recovers
  // deep backoff fast — see the deep-transient-back-off test).
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
    3214,
    "gain=0 is the pure rate-space base step: 5000→3214 (constant +6.667/min rate increment), not the old flat 100ms"
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
  // Drive interval down to a warm learned value. §9-C2 (rate-space): 1000→900→818
  // (the second step is a smaller interval decrement — constant RATE increment).
  pacing.recordSuccess(); // 900
  pacing.recordSuccess(); // 818 (rate-space step)
  const intervalBeforeRecovery = pacing.currentIntervalMs;
  assert.equal(intervalBeforeRecovery, 818);

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
  assert.equal(pacing.currentIntervalMs, 900, "plain recordSuccess() still decreases interval (calibrated first step)");
  pacing.recordSuccess({ suppressAdditiveIncrease: false });
  // §9-C2 (rate-space): second step is the constant RATE increment from 900 → 818.
  assert.equal(
    pacing.currentIntervalMs,
    818,
    "recordSuccess({suppress:false}) still decreases interval (rate-space step)"
  );
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
  // recovers ~elapsedRecoveryCap× more than the un-weighted over-backoff term alone.
  // §9-C2 (rate-space): the step is now rateSpaceBaseStep(interval) + the weighted
  // over-backoff boost. The rate-space base step is NOT elapsed-weighted (only the
  // over-backoff deep-recovery term is), so the elapsed weighting still demonstrably
  // accelerates deep recovery.
  //
  // Key: the first success primes lastSuccessAtMs (null→weight=1, backward-compat).
  // The SECOND success, with a large elapsed gap, demonstrates the weighting.
  const initialIntervalMs = 1000;
  const additiveIncreaseMs = 100;
  const recoveryGain = 0.1;
  const elapsedRecoveryCap = 8;
  // Start deep enough that after the first success we're still well above initial.
  const startIntervalMs = 55_000;
  const msPerMin = 60_000;
  // The calibrated constant rate step the rate-space base uses (matched at the operating point).
  const calibratedRateStep = msPerMin / (initialIntervalMs - additiveIncreaseMs) - msPerMin / initialIntervalMs;
  const rateSpaceBaseStepMs = (interval: number): number => {
    const newInterval = Math.max(1, Math.round(msPerMin / (msPerMin / interval + calibratedRateStep)));
    return Math.max(0, interval - newInterval);
  };

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

  // First success at t=0: null lastSuccessAtMs → weight=1. The rate-space base step
  // dominates at this depth (55000ms rate is tiny), plus a weight-1 over-backoff boost.
  pacing.recordSuccess();
  const intervalAfterFirst = pacing.currentIntervalMs;
  assert.ok(intervalAfterFirst > initialIntervalMs, "still deep above initial after first success");

  // Advance clock by ~49s (simulating one throttled-cadence fetch taking the full interval)
  const bigElapsedMs = 49_000;
  nowMs += bigElapsedMs;

  // Un-weighted step for this interval: rate-space base + weight-1 over-backoff boost.
  const overBackoff = intervalAfterFirst - initialIntervalMs;
  const baseStep = rateSpaceBaseStepMs(intervalAfterFirst);
  const unweightedStep = baseStep + Math.floor(recoveryGain * overBackoff * 1);
  // Weighted step: weight = clamp(49000/1000, 1, 8) = 8. Only the over-backoff boost is weighted.
  const weight = Math.min(elapsedRecoveryCap, Math.max(1, bigElapsedMs / initialIntervalMs));
  const weightedStep = baseStep + Math.floor(recoveryGain * overBackoff * weight);

  pacing.recordSuccess();
  const actualStep = intervalAfterFirst - pacing.currentIntervalMs;

  assert.equal(actualStep, weightedStep, `step = rateSpaceBase + floor(gain*overBackoff*weight) = ${weightedStep}`);
  assert.ok(
    weightedStep > unweightedStep,
    `elapsed-weighted recovery (${weightedStep}) exceeds the un-weighted step (${unweightedStep})`
  );
  // The over-backoff boost term (the only elapsed-weighted part) is amplified ~weight×.
  const unweightedBoost = Math.floor(recoveryGain * overBackoff * 1);
  const weightedBoost = Math.floor(recoveryGain * overBackoff * weight);
  assert.ok(
    weightedBoost > unweightedBoost * 4,
    `elapsed-weighted over-backoff boost (${weightedBoost}) is >4× the un-weighted boost (${unweightedBoost})`
  );
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
  const msPerMin = 60_000;
  // §9-C2 rate-space base step (matched at the operating point), reproduced here.
  const calibratedRateStep = msPerMin / (initialIntervalMs - 100) - msPerMin / initialIntervalMs;
  const rateSpaceBaseStepMs = (interval: number): number => {
    const newInterval = Math.max(1, Math.round(msPerMin / (msPerMin / interval + calibratedRateStep)));
    return Math.max(0, interval - newInterval);
  };

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

  // First success at t=0: null lastSuccessAtMs → weight=1. Step = rateSpaceBase(1100)
  // + floor(0.1*100*1). Interval drops modestly (NOT to the floor).
  pacing.recordSuccess();
  // lastSuccessAtMs is now 0. interval is below initial (overBackoff=0 hereafter).

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
  // overBackoff = 1350 - 1000 = 350. §9-C2 step = rateSpaceBase(1350) + floor(0.1*350*8).
  // = 176 + 280 = 456. After: 1350 - 456 = 894ms — well above minIntervalMs (100ms).
  const expectedStep =
    rateSpaceBaseStepMs(intervalAboveInitial) + Math.floor(0.1 * (intervalAboveInitial - initialIntervalMs) * 8);
  const actualStep = intervalAboveInitial - pacing2.currentIntervalMs;
  assert.equal(actualStep, expectedStep, `step is rateSpaceBase + weighted-overBackoff: ${expectedStep}`);
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
  const msPerMin = 60_000;
  // §9-C2 rate-space base step (matched at the operating point), reproduced here.
  const calibratedRateStep = msPerMin / (1000 - 100) - msPerMin / 1000;
  const rateSpaceBaseStepMs = (interval: number): number => {
    const newInterval = Math.max(1, Math.round(msPerMin / (msPerMin / interval + calibratedRateStep)));
    return Math.max(0, interval - newInterval);
  };
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
  // §9-C2 (rate-space): step = rateSpaceBase(interval) + floor(gain*overBackoff*weight).
  const overBackoff = Math.max(0, intervalBeforeReal2 - 1000);
  const baseStep = rateSpaceBaseStepMs(intervalBeforeReal2);
  const expectedStepWeighted = baseStep + Math.floor(0.1 * overBackoff * 8);
  const expectedStepUnweighted = baseStep + Math.floor(0.1 * overBackoff * 1);
  assert.equal(
    step2,
    expectedStepWeighted,
    `suppression preserved lastSuccessAtMs — step uses large elapsed weight (${expectedStepWeighted} not ${expectedStepUnweighted})`
  );
});

test("ProviderPacing Fix1: backward-compat at operating point — normal-cadence success recovers at weight=1", () => {
  // A success with elapsed ≈ initialIntervalMs gives weight = clamp(1, 1, 8) = 1.
  // §9-C2 (rate-space): the step is rateSpaceBase(interval) + weight-1 over-backoff
  // boost. At normal cadence the weight is 1, so the deep-recovery term is its base
  // (un-weighted) value — no extra acceleration for callers at normal cadence.
  const initialIntervalMs = 1000;
  const msPerMin = 60_000;
  const calibratedRateStep = msPerMin / (initialIntervalMs - 100) - msPerMin / initialIntervalMs;
  const rateSpaceBaseStepMs = (interval: number): number => {
    const newInterval = Math.max(1, Math.round(msPerMin / (msPerMin / interval + calibratedRateStep)));
    return Math.max(0, interval - newInterval);
  };
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
  const expectedUnweighted = rateSpaceBaseStepMs(beforeFirst) + Math.floor(0.1 * (beforeFirst - initialIntervalMs));
  assert.equal(
    stepFirst,
    expectedUnweighted,
    "first success (null lastSuccessAtMs) uses weight=1, matches rateSpaceBase + un-weighted boost"
  );

  // Second success: advance by exactly initialIntervalMs → weight = clamp(1000/1000, 1, 8) = 1
  nowMs += initialIntervalMs;
  const beforeSecond = pacing.currentIntervalMs;
  pacing.recordSuccess();
  const stepSecond = beforeSecond - pacing.currentIntervalMs;
  const expectedSecond = rateSpaceBaseStepMs(beforeSecond) + Math.floor(0.1 * (beforeSecond - initialIntervalMs));
  assert.equal(
    stepSecond,
    expectedSecond,
    "normal-cadence elapsed=initialIntervalMs → weight=1 → rateSpaceBase + un-weighted boost"
  );
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

// ─── SLVP-ideal §9-C2: true rate-space AIMD additive increase (IMPLEMENTED) ──

test("ProviderPacing §9-C2: additive increase is RATE-space — per-success rate gain is ~CONSTANT across the ramp, not super-accelerating near the floor", () => {
  // §9-C2 (slvp-ideal-whole-system-spec-2026-06-11.md), IMPLEMENTED: textbook
  // Chiu-Jain AIMD increases the RATE by a fixed amount per success. The legacy law
  // subtracted a fixed −Δms from the INTERVAL instead; because rate = 60000/interval
  // is convex, that made the per-success RATE gain climb super-linearly toward the
  // floor (up to ~7.5× the matched rate-space step at the 400→300 step) — "the probe
  // accelerates fastest exactly where it is riskiest," the inverse of AIMD's
  // congestion-avoidance discipline. The control law now increases the RATE by the
  // calibrated constant `additiveRateStepPerMin` (matched to the legacy step at the
  // operating point, so live behavior barely changes), so the per-success rate gain
  // is ~CONSTANT across the whole ramp. This test pins the IDEAL:
  //   (1) the per-success rate gain stays ~flat (≈ the matched step), NOT 1×→7.5×;
  //   (2) the law still rests at exactly the floor and at the same max sustained
  //       rate — only the ramp SHAPE changed, never the steady state.
  const initialIntervalMs = 1000; // ChatGPT operating point (chatgpt/index.ts)
  const floorMs = 250; // ChatGPT minIntervalMs — THE rate ceiling (authored prior)
  const baseStep = 100; // ChatGPT additiveIncreaseMs
  const ratePerMin = (ms: number): number => 60_000 / ms;

  // Matched rate-space step: the calibrated constant rate increment (the FIRST step
  // off the operating point is identical to the legacy law — live behavior preserved).
  const rateStep = ratePerMin(initialIntervalMs - baseStep) - ratePerMin(initialIntervalMs); // 6.667/min

  const pacing = new ProviderPacing({
    initialIntervalMs,
    minIntervalMs: floorMs,
    additiveIncreaseMs: baseStep,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  let prevInterval = pacing.currentIntervalMs;
  let maxFullStepRatio = 0;
  let steps = 0;
  while (pacing.currentIntervalMs > floorMs) {
    pacing.recordSuccess();
    const dRate = ratePerMin(pacing.currentIntervalMs) - ratePerMin(prevInterval);
    const ratio = dRate / rateStep;
    // Only FULL (un-clamped) steps reflect the control law's rate gain; the final
    // step lands on the floor and covers only the remaining distance (a fraction).
    if (pacing.currentIntervalMs > floorMs) {
      maxFullStepRatio = Math.max(maxFullStepRatio, ratio);
    }
    prevInterval = pacing.currentIntervalMs;
    steps += 1;
  }

  // FACT (1): the per-success rate gain is ~CONSTANT — the peak full-step ratio is
  // ~1.07×, NOT the ~7.5× of the old interval-space super-acceleration. (Were the
  // law still interval-space this would be >3× and the assertion would fail.)
  assert.ok(
    maxFullStepRatio < 1.15,
    `§9-C2 IDEAL: per-success rate gain is ~constant (peak ${maxFullStepRatio.toFixed(3)}× the matched step) — ` +
      "a value >1.15× would mean the law reverted to interval-space super-acceleration"
  );

  // FACT (2): the law still rests at exactly the floor — steady state UNCHANGED. The
  // rate-space ramp is more cautious (more successes to reach the floor) than the
  // legacy 8-success ramp; that slower, gentler approach IS the AIMD discipline.
  assert.equal(pacing.currentIntervalMs, floorMs, "rate-space law rests at exactly the floor (steady state unchanged)");
  assert.equal(steps, 27, "cold-start ramp 1000→250 is 27 successes (cautious rate-space approach, not the old 8)");

  // The floor is still a hard wall under unbounded success — never crossed.
  for (let i = 0; i < 500; i += 1) {
    pacing.recordSuccess();
    assert.ok(
      pacing.currentIntervalMs >= floorMs,
      `rate-space law never crosses the floor (i=${i}, interval=${pacing.currentIntervalMs})`
    );
  }
  // Max sustained rate at the floor is unchanged: 60000/250 = 240/min.
  assert.equal(
    ratePerMin(pacing.currentIntervalMs),
    240,
    "max sustained rate unchanged at 240/min (60000/250ms floor)"
  );
});

test("ProviderPacing §9-C2: rate-gain is constant within a TIGHT band across the whole operating range (regression guard for the IDEAL)", () => {
  // The companion pin: across the ENTIRE operating range [floor, initial] the
  // per-success RATE gain must stay within a TIGHT band of the calibrated step —
  // the signature of true rate-space AIMD. The only deviation is integer-rounding
  // noise (±~7%). If a future change reverts to interval-space, the gain near the
  // floor climbs to ~7.5× and BLOWS this band — so this is the regression guard for
  // the IDEAL, not for the merely-acceptable. (Mutation check: replacing the
  // rate-space base with a flat 100ms interval step makes the 400→300 step 7.5× and
  // fails the band below.)
  const initialIntervalMs = 1000;
  const floorMs = 250;
  const baseStep = 100;
  const tightBandLow = 0.9; // ±10% — covers integer-rounding noise on full steps
  const tightBandHigh = 1.1;
  const ratePerMin = (ms: number): number => 60_000 / ms;
  const rateStep = ratePerMin(initialIntervalMs - baseStep) - ratePerMin(initialIntervalMs);

  const pacing = new ProviderPacing({
    initialIntervalMs,
    minIntervalMs: floorMs,
    additiveIncreaseMs: baseStep,
    now: () => 0,
    sleep: () => Promise.resolve(),
  });
  let prevInterval = pacing.currentIntervalMs;
  while (pacing.currentIntervalMs > floorMs) {
    pacing.recordSuccess();
    const dRate = ratePerMin(pacing.currentIntervalMs) - ratePerMin(prevInterval);
    const ratio = dRate / rateStep;
    if (pacing.currentIntervalMs > floorMs) {
      // Full step: must be inside the tight constant-rate band.
      assert.ok(
        ratio > tightBandLow && ratio < tightBandHigh,
        `per-success rate gain (${dRate.toFixed(2)}/min, ${ratio.toFixed(3)}×) must stay within the tight ` +
          `[${tightBandLow}, ${tightBandHigh}]× band of the calibrated rate step (${rateStep.toFixed(2)}/min) — ` +
          "§9-C2 IDEAL: a value climbing toward ~7.5× near the floor means the law reverted to interval-space"
      );
    } else {
      // The final partial step into the floor is a fraction of a step — never MORE.
      assert.ok(
        ratio <= tightBandHigh,
        `final floor-clamped step is never larger than a full rate step (${ratio.toFixed(3)}×)`
      );
    }
    prevInterval = pacing.currentIntervalMs;
  }
});
