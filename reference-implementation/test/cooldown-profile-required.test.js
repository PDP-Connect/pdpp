/**
 * §10-B "impossible by construction" — the cooldown escalation profile is
 * required, not a silent no-op.
 *
 * GAP 1 (cooldown half) from the adversarial SLVP-ideal review: `maxCooldownCycles`
 * was an OPTIONAL `ComputeCooldownOptions` field, and the two production call
 * sites (the dashboard projection in controller.ts and the scheduler dispatch in
 * scheduler.ts) passed NOTHING — so the no-progress escalation (§10-B) defaulted
 * to Infinity and NEVER fired. A dead-but-429ing provider would render
 * `cooling_off` forever (the §10-B permanent lie).
 *
 * After the fix:
 *   - `cooldownProfileForConnector` ALWAYS resolves a real profile (explicit
 *     registry override OR the safe `DEFAULT_COOLDOWN_PROFILE`) — never null,
 *     never Infinity.
 *   - `assertCooldownProfile` throws LOUD on an absent/invalid profile (the
 *     .js-seam build-error equivalent).
 *   - `computeConnectionSourcePressureCooldown` (the production entry both call
 *     sites now use) resolves + asserts the profile, so escalation is WIRED.
 *
 * Each test below FAILS against the pre-fix code (optional field → Infinity →
 * silent no-op; no resolver; no assertion).
 *
 * Ref: docs/research/slvp-ideal-whole-system-spec-2026-06-11.md §10-B, §3 rule 6
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import {
  CHATGPT_COOLDOWN_PROFILE,
  DEFAULT_COOLDOWN_PROFILE,
  assertCooldownProfile,
  computeConnectionSourcePressureCooldown,
  cooldownProfileForConnector,
} from '../runtime/scheduler-source-pressure-cooldown.ts';

// ─── The default profile is a real, declared value ──────────────────────────

test('DEFAULT_COOLDOWN_PROFILE carries a finite positive-integer maxCooldownCycles (not Infinity)', () => {
  assert.ok(
    Number.isInteger(DEFAULT_COOLDOWN_PROFILE.maxCooldownCycles) &&
      DEFAULT_COOLDOWN_PROFILE.maxCooldownCycles > 0,
    'the safe default must escalate after a real number of cycles, not "never" (Infinity)',
  );
});

// ─── cooldownProfileForConnector never returns a silently-disabling value ────

test('cooldownProfileForConnector ALWAYS resolves a real profile — never null/Infinity (GAP 1 cooldown)', () => {
  assert.equal(cooldownProfileForConnector('chatgpt'), CHATGPT_COOLDOWN_PROFILE);
  assert.equal(cooldownProfileForConnector('chatgpt:default'), CHATGPT_COOLDOWN_PROFILE);

  for (const id of ['github', 'notion', 'oura', 'spotify', 'strava', 'ynab', 'brand-new', '', null, undefined]) {
    const profile = cooldownProfileForConnector(id);
    assert.ok(profile, `cooldownProfileForConnector(${String(id)}) must return a profile`);
    assert.ok(
      Number.isFinite(profile.maxCooldownCycles) && profile.maxCooldownCycles > 0,
      `resolved cooldown profile for ${String(id)} must be a finite positive cycle budget — not "never escalate"`,
    );
  }
});

// ─── assertCooldownProfile is the loud-failure seam ──────────────────────────

test('assertCooldownProfile throws LOUD on a missing/invalid profile (no silent "never escalate")', () => {
  const pattern = /requires a per-provider profile\.maxCooldownCycles/;
  assert.throws(() => assertCooldownProfile(null), pattern, 'null profile must throw');
  assert.throws(() => assertCooldownProfile(undefined), pattern, 'undefined profile must throw');
  assert.throws(() => assertCooldownProfile({}), pattern, 'profile with no maxCooldownCycles must throw');
  assert.throws(() => assertCooldownProfile({ maxCooldownCycles: 0 }), pattern, '0 cycles must throw');
  assert.throws(() => assertCooldownProfile({ maxCooldownCycles: -1 }), pattern, 'negative cycles must throw');
  assert.throws(
    () => assertCooldownProfile({ maxCooldownCycles: Number.POSITIVE_INFINITY }),
    pattern,
    'Infinity (the old silent-disable value) must now throw',
  );
  assert.throws(() => assertCooldownProfile({ maxCooldownCycles: Number.NaN }), pattern, 'NaN must throw');

  // A valid profile passes through unchanged.
  assert.deepEqual(assertCooldownProfile({ maxCooldownCycles: 8 }), { maxCooldownCycles: 8 });
});

// ─── The production entry WIRES escalation (was dead before) ─────────────────

test('computeConnectionSourcePressureCooldown WIRES §10-B escalation: a dead-but-429ing connection reaches needs_attention', () => {
  // A pressure gap that has survived many cooldown cycles with no recovery
  // (attemptCount high) on a connector whose profile escalates. Before the fix
  // the call sites supplied no profile, so this could NEVER escalate.
  const deadGaps = [{ reason: 'upstream_pressure', attemptCount: 50 }];
  const decision = computeConnectionSourcePressureCooldown('chatgpt', deadGaps, 1000, Date.now() - 100_000, {
    consecutiveCooldownCycles: CHATGPT_COOLDOWN_PROFILE.maxCooldownCycles,
  });
  assert.equal(decision.cooldownApplied, true);
  assert.equal(
    decision.recommendedHealthState,
    'needs_attention',
    'a connection past its no-progress cycle budget MUST escalate — not stay cooling_off forever',
  );
});

test('computeConnectionSourcePressureCooldown: a still-recovering connection stays cooling_off (below the cycle budget)', () => {
  const recoveringGaps = [{ reason: 'rate_limited', attemptCount: 1 }];
  const decision = computeConnectionSourcePressureCooldown('chatgpt', recoveringGaps, 1000, Date.now() - 10_000, {
    consecutiveCooldownCycles: 1,
  });
  assert.equal(decision.cooldownApplied, true);
  assert.equal(decision.recommendedHealthState, 'cooling_off', 'below the budget stays cooling_off');
});

test('computeConnectionSourcePressureCooldown: an UNAUDITED connector still escalates via the default profile (no silent no-op)', () => {
  // The key GAP 1 guarantee: a connector with no explicit profile does NOT opt
  // out of escalation — it escalates via DEFAULT_COOLDOWN_PROFILE.
  const deadGaps = [{ reason: 'upstream_pressure', attemptCount: DEFAULT_COOLDOWN_PROFILE.maxCooldownCycles + 5 }];
  const decision = computeConnectionSourcePressureCooldown('some-unaudited-connector', deadGaps, 1000, Date.now() - 100_000, {
    consecutiveCooldownCycles: DEFAULT_COOLDOWN_PROFILE.maxCooldownCycles,
  });
  assert.equal(
    decision.recommendedHealthState,
    'needs_attention',
    'an unaudited connector that goes dead must still escalate — absence of an explicit profile is NOT a silent disable',
  );
});

// ─── ChatGPT live numbers preserved ──────────────────────────────────────────

test('CHATGPT_COOLDOWN_PROFILE.maxCooldownCycles is unchanged at 8 (live-number preservation)', () => {
  assert.equal(CHATGPT_COOLDOWN_PROFILE.maxCooldownCycles, 8, 'ChatGPT cooldown cycle budget must stay 8');
});

// ─── Convention guard: production must use the GUARDED wrapper, not the bare fn ──
//
// The low-level `computeSourcePressureCooldown` tolerates an absent
// maxCooldownCycles (→ Infinity = no escalation) so unit tests can exercise the
// pure math. The latent foot-gun: a future production caller could use the bare
// function and silently disable §10-B escalation. This test makes the
// "production uses computeConnectionSourcePressureCooldown only" contract
// enforced-by-test, not enforced-by-hope — it fails red if any runtime/ or
// server/ source file references the bare function.
test('no production source calls the bare computeSourcePressureCooldown (only the guarded wrapper)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, '..');
  const offenders = [];
  const BARE = /\bcomputeSourcePressureCooldown\b/;
  const WRAPPED = /\bcomputeConnectionSourcePressureCooldown\b/;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'test') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|js)$/.test(entry.name)) continue;
      // The definition file legitimately names the bare fn; skip it.
      if (entry.name === 'scheduler-source-pressure-cooldown.ts') continue;
      const src = readFileSync(full, 'utf8');
      // A reference is an offense only if it's the BARE name, not a substring
      // of the wrapped name. Strip wrapped references, then test for bare.
      const stripped = src.replace(new RegExp(WRAPPED.source, 'g'), '');
      if (BARE.test(stripped)) offenders.push(full.slice(root.length + 1));
    }
  };
  walk(join(root, 'runtime'));
  walk(join(root, 'server'));
  assert.deepEqual(
    offenders,
    [],
    `production files must call computeConnectionSourcePressureCooldown (guarded), not the bare computeSourcePressureCooldown — offenders: ${offenders.join(', ')}`
  );
});
