import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_COOLDOWN_MIN_MULTIPLIER,
  DEFAULT_MAX_COOLDOWN_EXP,
  DEFAULT_MAX_COOLDOWN_MS,
  SOURCE_PRESSURE_GAP_REASONS,
  computeSourcePressureCooldown,
} from '../runtime/scheduler-source-pressure-cooldown.ts';

// ─── Test helpers ──────────────────────────────────────────────────────────

const BASE_INTERVAL_MS = 60_000; // 1 minute
const T0 = 1_700_000_000_000; // arbitrary fixed epoch

function gap(overrides = {}) {
  const { reason = 'upstream_pressure', attemptCount = 0, nextAttemptAfter = null } = overrides;
  return { reason, attemptCount, nextAttemptAfter };
}

// ─── No pressure / empty ─────────────────────────────────────────────────

test('no pending gaps yields no cooldown and a nextRunAt of lastRun + base interval', () => {
  const decision = computeSourcePressureCooldown([], BASE_INTERVAL_MS, T0);
  assert.equal(decision.cooldownApplied, false);
  assert.equal(decision.pendingPressureGapCount, 0);
  assert.equal(decision.identity, null);
  assert.equal(decision.recommendedHealthState, null);
  assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS);
  assert.equal(decision.nextRunAt, new Date(T0 + BASE_INTERVAL_MS).toISOString());
});

test('a recovered run (pending pressure set becomes empty) clears cooldown — never stuck', () => {
  // Same connection that was cooling now has zero pending pressure gaps.
  const decision = computeSourcePressureCooldown([], BASE_INTERVAL_MS, T0);
  assert.equal(decision.cooldownApplied, false);
  assert.equal(decision.recommendedHealthState, null);
});

// ─── Pressure engages cooldown ───────────────────────────────────────────

test('a single freshly-observed pressure gap engages cooldown at the floor multiplier (1x)', () => {
  const decision = computeSourcePressureCooldown([gap({ attemptCount: 0 })], BASE_INTERVAL_MS, T0);
  assert.equal(decision.cooldownApplied, true);
  assert.equal(decision.pendingPressureGapCount, 1);
  assert.equal(decision.maxAttemptCount, 0);
  // attempt 0 → 2^0 = 1, floored at minMultiplier(1) → 1x base
  assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS);
  assert.equal(decision.nextRunAt, new Date(T0 + BASE_INTERVAL_MS).toISOString());
  assert.equal(decision.recommendedHealthState, 'cooling_off');
  assert.ok(decision.identity?.startsWith('source_pressure:upstream_pressure:'));
});

test('rate_limited is also a pressure reason', () => {
  const decision = computeSourcePressureCooldown([gap({ reason: 'rate_limited' })], BASE_INTERVAL_MS, T0);
  assert.equal(decision.cooldownApplied, true);
  assert.match(decision.identity || '', /rate_limited/);
});

// ─── Decay / growth with persistence ─────────────────────────────────────

test('cooldown grows exponentially with the gaps max recovery attempt count', () => {
  // attempt 1 → 2^1 = 2x
  const d1 = computeSourcePressureCooldown([gap({ attemptCount: 1 })], BASE_INTERVAL_MS, T0);
  assert.equal(d1.effectiveIntervalMs, BASE_INTERVAL_MS * 2);
  // attempt 2 → 2^2 = 4x
  const d2 = computeSourcePressureCooldown([gap({ attemptCount: 2 })], BASE_INTERVAL_MS, T0);
  assert.equal(d2.effectiveIntervalMs, BASE_INTERVAL_MS * 4);
  // attempt 3 → 2^3 = 8x
  const d3 = computeSourcePressureCooldown([gap({ attemptCount: 3 })], BASE_INTERVAL_MS, T0);
  assert.equal(d3.effectiveIntervalMs, BASE_INTERVAL_MS * 8);
});

test('the max attempt count across gaps drives growth (most-persistent gap wins)', () => {
  const decision = computeSourcePressureCooldown(
    [gap({ attemptCount: 0 }), gap({ attemptCount: 4 }), gap({ attemptCount: 1 })],
    BASE_INTERVAL_MS,
    T0,
  );
  assert.equal(decision.maxAttemptCount, 4);
  assert.equal(decision.pendingPressureGapCount, 3);
  assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS * 16); // 2^4
});

test('the identity changes as persistence grows so the audit line re-arms', () => {
  const d0 = computeSourcePressureCooldown([gap({ attemptCount: 0 })], BASE_INTERVAL_MS, T0);
  const d1 = computeSourcePressureCooldown([gap({ attemptCount: 1 })], BASE_INTERVAL_MS, T0);
  assert.notEqual(d0.identity, d1.identity);
});

// ─── Caps ──────────────────────────────────────────────────────────────

test('the cooldown exponent is capped by maxCooldownExp', () => {
  // attempt 10 with default maxExp=6 → 2^6 = 64x, not 2^10
  const decision = computeSourcePressureCooldown([gap({ attemptCount: 10 })], BASE_INTERVAL_MS, T0);
  // 64 * 60_000 = 3_840_000ms = 64 min, under the 6h ms cap
  assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS * 64);
});

test('the cooldown is capped by maxCooldownMs (6h default)', () => {
  // Large base interval + high attempt would blow past 6h; cap binds.
  const bigBase = 60 * 60 * 1000; // 1h base
  const decision = computeSourcePressureCooldown([gap({ attemptCount: 6 })], bigBase, T0);
  // 2^6 = 64 * 1h = 64h → capped to 6h
  assert.equal(decision.effectiveIntervalMs, DEFAULT_MAX_COOLDOWN_MS);
});

test('explicit small maxCooldownMs caps the effective interval', () => {
  const cap = BASE_INTERVAL_MS * 3;
  const decision = computeSourcePressureCooldown([gap({ attemptCount: 5 })], BASE_INTERVAL_MS, T0, {
    maxCooldownMs: cap,
  });
  assert.equal(decision.effectiveIntervalMs, cap);
});

// ─── Non-pressure reasons are ignored ─────────────────────────────────────

test('non-pressure gap reasons do not engage cooldown (no accidental throttle)', () => {
  const decision = computeSourcePressureCooldown(
    [
      gap({ reason: 'retry_exhausted' }),
      gap({ reason: 'temporary_unavailable' }),
      gap({ reason: 'missing_mapping' }),
      gap({ reason: null }),
    ],
    BASE_INTERVAL_MS,
    T0,
  );
  assert.equal(decision.cooldownApplied, false);
  assert.equal(decision.pendingPressureGapCount, 0);
});

test('mixed gaps count only the pressure-reason subset', () => {
  const decision = computeSourcePressureCooldown(
    [gap({ reason: 'upstream_pressure' }), gap({ reason: 'retry_exhausted' }), gap({ reason: 'rate_limited' })],
    BASE_INTERVAL_MS,
    T0,
  );
  assert.equal(decision.cooldownApplied, true);
  assert.equal(decision.pendingPressureGapCount, 2);
});

// ─── next_attempt_after floor ─────────────────────────────────────────────

test('an explicit next_attempt_after later than the computed cooldown is honoured as the floor', () => {
  const farFuture = new Date(T0 + BASE_INTERVAL_MS * 100).toISOString();
  const decision = computeSourcePressureCooldown(
    [gap({ attemptCount: 0, nextAttemptAfter: farFuture })],
    BASE_INTERVAL_MS,
    T0,
  );
  assert.equal(decision.nextRunAt, farFuture);
  assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS * 100);
});

test('an explicit next_attempt_after earlier than the computed cooldown does not shorten it', () => {
  const nearPast = new Date(T0 - BASE_INTERVAL_MS).toISOString();
  const decision = computeSourcePressureCooldown(
    [gap({ attemptCount: 2, nextAttemptAfter: nearPast })],
    BASE_INTERVAL_MS,
    T0,
  );
  // computed = T0 + 4x base; the earlier floor must not pull it in.
  assert.equal(decision.nextRunAt, new Date(T0 + BASE_INTERVAL_MS * 4).toISOString());
});

// ─── Manual override ─────────────────────────────────────────────────────

test('manual: true bypasses cooldown even with deep persistent pressure', () => {
  const decision = computeSourcePressureCooldown([gap({ attemptCount: 6 })], BASE_INTERVAL_MS, T0, {
    manual: true,
  });
  assert.equal(decision.cooldownApplied, false);
  assert.equal(decision.pendingPressureGapCount, 0);
  assert.equal(decision.identity, null);
  assert.equal(decision.effectiveIntervalMs, 0);
});

// ─── Robustness ──────────────────────────────────────────────────────────

test('malformed timing inputs do not throw or emit invalid timestamps', () => {
  const cases = [
    { baseIntervalMs: Number.NaN, lastRunAtMs: T0 },
    { baseIntervalMs: Number.POSITIVE_INFINITY, lastRunAtMs: T0 },
    { baseIntervalMs: BASE_INTERVAL_MS, lastRunAtMs: Number.POSITIVE_INFINITY },
    { baseIntervalMs: -1, lastRunAtMs: -1 },
  ];
  for (const c of cases) {
    const decision = computeSourcePressureCooldown([gap({ attemptCount: 2 })], c.baseIntervalMs, c.lastRunAtMs);
    assert.equal(Number.isFinite(decision.effectiveIntervalMs), true);
    assert.equal(Number.isNaN(Date.parse(decision.nextRunAt)), false);
  }
});

test('malformed attemptCount falls back to 0 (floor multiplier)', () => {
  const decision = computeSourcePressureCooldown(
    [gap({ attemptCount: Number.NaN }), gap({ attemptCount: -5 })],
    BASE_INTERVAL_MS,
    T0,
  );
  assert.equal(decision.maxAttemptCount, 0);
  assert.equal(decision.effectiveIntervalMs, BASE_INTERVAL_MS);
});

// ─── Pinned constants ─────────────────────────────────────────────────────

test('pressure reasons are exactly upstream_pressure and rate_limited', () => {
  assert.deepEqual([...SOURCE_PRESSURE_GAP_REASONS].sort(), ['rate_limited', 'upstream_pressure']);
});

test('default tunables are pinned so drift is intentional', () => {
  assert.equal(DEFAULT_COOLDOWN_MIN_MULTIPLIER, 1);
  assert.equal(DEFAULT_MAX_COOLDOWN_EXP, 6);
  assert.equal(DEFAULT_MAX_COOLDOWN_MS, 6 * 60 * 60 * 1000);
});
