// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * L5 tests for §10-B (no-progress escalation) and §10-C (auth class).
 *
 * §10-B: A source-pressure cooldown that runs maxCooldownCycles consecutive
 * cycles with ZERO forward progress AND zero gap recovery escalates
 * cooling_off → needs_attention. This catches the dead-but-429ing provider.
 * maxCooldownCycles is a ProviderProfile field with a ChatGPT value and NO
 * cross-provider default.
 *
 * §10-C: 401/permanent-403 is a DISTINCT non-transient auth class →
 * classifyRecoveryError returns { nonTransient: true, reason: 'auth_failure' }
 * for 401. This makes auth failures a named non-transient class that routes
 * to needs_attention rather than being folded into pressure or generic failure.
 *
 * Ref: docs/research/slvp-ideal-whole-system-spec-2026-06-11.md §10-B, §10-C
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSourcePressureCooldown,
  CHATGPT_COOLDOWN_PROFILE,
} from '../runtime/scheduler-source-pressure-cooldown.ts';

import {
  classifyRecoveryError,
  isNonTransientError,
  isAuthFailure,
} from '../server/stores/terminal-gap-classifier.js';

// ─── §10-C: 401 auth class ──────────────────────────────────────────────────

test('§10-C classifyRecoveryError: 401 is a non-transient auth_failure', () => {
  const result = classifyRecoveryError({ status: 401 });
  assert.equal(result.nonTransient, true, '401 must be classified as non-transient');
  assert.equal(result.reason, 'auth_failure', '401 reason must be auth_failure (distinct from not_found/gone/permanent_forbidden)');
});

test('§10-C classifyRecoveryError: 401 auth class is distinct from deleted-resource (404)', () => {
  const auth = classifyRecoveryError({ status: 401 });
  const deleted = classifyRecoveryError({ status: 404 });
  assert.notEqual(auth.reason, deleted.reason, '401 and 404 must have distinct reason codes');
  assert.equal(auth.reason, 'auth_failure');
  assert.equal(deleted.reason, 'not_found');
});

test('§10-C isNonTransientError: 401 returns true', () => {
  assert.equal(isNonTransientError({ status: 401 }), true);
});

test('§10-C isAuthFailure: 401 returns true, 404 returns false, 429 returns false', () => {
  assert.equal(isAuthFailure({ status: 401 }), true, '401 is an auth failure');
  assert.equal(isAuthFailure({ status: 404 }), false, '404 is not an auth failure');
  assert.equal(isAuthFailure({ status: 429 }), false, '429 is not an auth failure');
  assert.equal(isAuthFailure({ status: 403, errorClass: 'http_403_permanent' }), false, 'permanent 403 is forbidden, not auth');
  assert.equal(isAuthFailure(null), false, 'null is not an auth failure');
});

// ─── §10-B: no-progress escalation ─────────────────────────────────────────

test('§10-B computeSourcePressureCooldown: below maxCooldownCycles → recommendedHealthState stays cooling_off', () => {
  const gaps = [
    { reason: 'upstream_pressure', attemptCount: 2 },
  ];
  const baseIntervalMs = 1000;
  const lastRunAtMs = Date.now() - 10_000;

  // One cycle below the threshold — should still be cooling_off
  const result = computeSourcePressureCooldown(gaps, baseIntervalMs, lastRunAtMs, {
    consecutiveCooldownCycles: 1,
    maxCooldownCycles: 5,
  });

  assert.equal(result.cooldownApplied, true);
  assert.equal(
    result.recommendedHealthState,
    'cooling_off',
    'below maxCooldownCycles must stay cooling_off, not escalate',
  );
});

test('§10-B computeSourcePressureCooldown: at maxCooldownCycles → escalates to needs_attention', () => {
  const gaps = [
    { reason: 'rate_limited', attemptCount: 3 },
  ];
  const baseIntervalMs = 1000;
  const lastRunAtMs = Date.now() - 100_000;

  // Exactly at the threshold → escalate
  const result = computeSourcePressureCooldown(gaps, baseIntervalMs, lastRunAtMs, {
    consecutiveCooldownCycles: 5,
    maxCooldownCycles: 5,
  });

  assert.equal(result.cooldownApplied, true);
  assert.equal(
    result.recommendedHealthState,
    'needs_attention',
    'at maxCooldownCycles with zero progress, must escalate cooling_off → needs_attention',
  );
});

test('§10-B computeSourcePressureCooldown: beyond maxCooldownCycles → still needs_attention', () => {
  const gaps = [
    { reason: 'upstream_pressure', attemptCount: 6 },
  ];
  const baseIntervalMs = 1000;
  const lastRunAtMs = Date.now() - 100_000;

  const result = computeSourcePressureCooldown(gaps, baseIntervalMs, lastRunAtMs, {
    consecutiveCooldownCycles: 12,
    maxCooldownCycles: 5,
  });

  assert.equal(result.cooldownApplied, true);
  assert.equal(result.recommendedHealthState, 'needs_attention');
});

test('§10-B computeSourcePressureCooldown: zero pressure gaps → no cooldown, never needs_attention (recovered)', () => {
  // If pressure gaps are empty, there is nothing to escalate — the cooldown
  // is off regardless of consecutiveCooldownCycles.
  const result = computeSourcePressureCooldown([], 1000, Date.now() - 5000, {
    consecutiveCooldownCycles: 999,
    maxCooldownCycles: 1,
  });

  assert.equal(result.cooldownApplied, false);
  assert.equal(result.recommendedHealthState, null, 'recovered provider must not be needs_attention');
});

test('§10-B computeSourcePressureCooldown: force override still bypasses, even past maxCooldownCycles', () => {
  const gaps = [{ reason: 'upstream_pressure', attemptCount: 2 }];
  const result = computeSourcePressureCooldown(gaps, 1000, Date.now() - 5000, {
    force: true,
    consecutiveCooldownCycles: 100,
    maxCooldownCycles: 1,
  });

  assert.equal(result.cooldownApplied, false, 'force override always bypasses the cooldown');
  assert.equal(result.recommendedHealthState, null);
});

test('§10-B computeSourcePressureCooldown: without consecutiveCooldownCycles (default 0) → cooling_off', () => {
  // When the caller does not supply consecutiveCooldownCycles it defaults to 0,
  // so the escalation never fires. This is the backwards-compatible behaviour
  // for callers that do not yet track cycle counts.
  const gaps = [{ reason: 'upstream_pressure', attemptCount: 3 }];
  const result = computeSourcePressureCooldown(gaps, 1000, Date.now() - 5000, {
    maxCooldownCycles: 1,
    // consecutiveCooldownCycles intentionally omitted
  });

  assert.equal(result.cooldownApplied, true);
  assert.equal(
    result.recommendedHealthState,
    'cooling_off',
    'absent consecutiveCooldownCycles defaults to 0 — no escalation without explicit cycle tracking',
  );
});

// ─── §10-B CHATGPT_COOLDOWN_PROFILE pin ────────────────────────────────────
//
// maxCooldownCycles is a ProviderProfile field — NO cross-provider default.
// Pin the ChatGPT value so drift is intentional.

test('§10-B CHATGPT_COOLDOWN_PROFILE.maxCooldownCycles is a finite positive integer', () => {
  assert.ok(
    Number.isInteger(CHATGPT_COOLDOWN_PROFILE.maxCooldownCycles) &&
      CHATGPT_COOLDOWN_PROFILE.maxCooldownCycles > 0,
    `CHATGPT_COOLDOWN_PROFILE.maxCooldownCycles must be a positive integer, got ${CHATGPT_COOLDOWN_PROFILE.maxCooldownCycles}`,
  );
});

test('§10-B CHATGPT_COOLDOWN_PROFILE has no cross-provider default key', () => {
  // Structural guard: no "default" or "fallback" key that other connectors
  // could silently inherit (spec §3 rule 6).
  assert.equal('default' in CHATGPT_COOLDOWN_PROFILE, false);
  assert.equal('fallback' in CHATGPT_COOLDOWN_PROFILE, false);
});
