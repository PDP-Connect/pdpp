// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 *   - `cooldownProfileForConnector` ALWAYS resolves a real profile (the
 *     connector's own manifest-declared `capabilities.refresh_policy.
 *     max_cooldown_cycles`, clamped to `RI_MAX_COOLDOWN_CYCLES_CEILING`, OR
 *     the safe `DEFAULT_COOLDOWN_PROFILE`) — never null, never Infinity.
 *   - `assertCooldownProfile` throws LOUD on an absent/invalid profile (the
 *     .js-seam build-error equivalent).
 *   - `computeConnectionSourcePressureCooldown` (the production entry both call
 *     sites now use) resolves + asserts the profile, so escalation is WIRED.
 *
 * Each test below FAILS against the pre-fix code (optional field → Infinity →
 * silent no-op; no resolver; no assertion).
 *
 * A connector-declared `max_cooldown_cycles` is a SCHEDULING budget, never a
 * classification override — it can only make escalation slower, never disable
 * it. The malicious-value section proves the RI hard-ceiling clamp holds even
 * for an extreme/malformed manifest-declared value.
 *
 * Ref: docs/research/slvp-ideal-whole-system-spec-2026-06-11.md §10-B, §3 rule 6
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { registerConnector } from "../server/auth.ts";
import { closeDb, initDb } from "../server/db.ts";
import {
  assertCooldownProfile,
  computeConnectionSourcePressureCooldown,
  cooldownProfileForConnector,
  DEFAULT_COOLDOWN_PROFILE,
  RI_MAX_COOLDOWN_CYCLES_CEILING,
} from "../runtime/scheduler-source-pressure-cooldown.ts";

const TOP_LEVEL_REGEX_1 = /requires a per-provider profile\.maxCooldownCycles/;
const TOP_LEVEL_REGEX_2 = /\bcomputeSourcePressureCooldown\b/;
const TOP_LEVEL_REGEX_3 = /\bcomputeConnectionSourcePressureCooldown\b/;
const TOP_LEVEL_REGEX_4 = /\.(ts|js)$/;

const __dirname = dirname(fileURLToPath(import.meta.url));
const MANIFESTS_DIR = join(__dirname, "..", "..", "packages", "polyfill-connectors", "manifests");

function loadRawManifest(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, `${name}.json`), "utf8")) as Record<string, unknown>;
}

function withTempDb(fn: () => Promise<void>) {
  return async () => {
    initDb(":memory:");
    try {
      await fn();
    } finally {
      closeDb();
    }
  };
}

// ─── The default profile is a real, declared value ──────────────────────────

test("DEFAULT_COOLDOWN_PROFILE carries a finite positive-integer maxCooldownCycles (not Infinity)", () => {
  assert.ok(
    Number.isInteger(DEFAULT_COOLDOWN_PROFILE.maxCooldownCycles) && DEFAULT_COOLDOWN_PROFILE.maxCooldownCycles > 0,
    'the safe default must escalate after a real number of cycles, not "never" (Infinity)'
  );
});

// ─── cooldownProfileForConnector never returns a silently-disabling value ────

test(
  "cooldownProfileForConnector ALWAYS resolves a real profile — never null/Infinity (GAP 1 cooldown)",
  withTempDb(async () => {
    await registerConnector(loadRawManifest("chatgpt"));
    assert.deepEqual(await cooldownProfileForConnector("chatgpt"), { maxCooldownCycles: 8 });
    assert.deepEqual(await cooldownProfileForConnector("chatgpt:default"), { maxCooldownCycles: 8 });

    for (const id of ["github", "notion", "oura", "spotify", "strava", "ynab", "brand-new", "", null, undefined]) {
      const profile = await cooldownProfileForConnector(id);
      assert.ok(profile, `cooldownProfileForConnector(${String(id)}) must return a profile`);
      assert.ok(
        Number.isFinite(profile.maxCooldownCycles) && profile.maxCooldownCycles > 0,
        `resolved cooldown profile for ${String(id)} must be a finite positive cycle budget — not "never escalate"`
      );
    }
  })
);

// ─── assertCooldownProfile is the loud-failure seam ──────────────────────────

test('assertCooldownProfile throws LOUD on a missing/invalid profile (no silent "never escalate")', () => {
  const pattern = TOP_LEVEL_REGEX_1;
  assert.throws(() => assertCooldownProfile(null), pattern, "null profile must throw");
  assert.throws(() => assertCooldownProfile(undefined), pattern, "undefined profile must throw");
  assert.throws(() => assertCooldownProfile({}), pattern, "profile with no maxCooldownCycles must throw");
  assert.throws(() => assertCooldownProfile({ maxCooldownCycles: 0 }), pattern, "0 cycles must throw");
  assert.throws(() => assertCooldownProfile({ maxCooldownCycles: -1 }), pattern, "negative cycles must throw");
  assert.throws(
    () => assertCooldownProfile({ maxCooldownCycles: Number.POSITIVE_INFINITY }),
    pattern,
    "Infinity (the old silent-disable value) must now throw"
  );
  assert.throws(() => assertCooldownProfile({ maxCooldownCycles: Number.NaN }), pattern, "NaN must throw");

  // A valid profile passes through unchanged.
  assert.deepEqual(assertCooldownProfile({ maxCooldownCycles: 8 }), { maxCooldownCycles: 8 });
});

// ─── The production entry WIRES escalation (was dead before) ─────────────────

test(
  "computeConnectionSourcePressureCooldown WIRES §10-B escalation: a dead-but-429ing connection reaches needs_attention",
  withTempDb(async () => {
    await registerConnector(loadRawManifest("chatgpt"));
    // A pressure gap that has survived many cooldown cycles with no recovery
    // (attemptCount high) on a connector whose profile escalates. Before the fix
    // the call sites supplied no profile, so this could NEVER escalate.
    const deadGaps = [{ attemptCount: 50, reason: "upstream_pressure" }];
    const decision = await computeConnectionSourcePressureCooldown("chatgpt", deadGaps, 1000, Date.now() - 100_000, {
      consecutiveCooldownCycles: 8,
    });
    assert.equal(decision.cooldownApplied, true);
    assert.equal(
      decision.recommendedHealthState,
      "needs_attention",
      "a connection past its no-progress cycle budget MUST escalate — not stay cooling_off forever"
    );
  })
);

test(
  "computeConnectionSourcePressureCooldown: a still-recovering connection stays cooling_off (below the cycle budget)",
  withTempDb(async () => {
    await registerConnector(loadRawManifest("chatgpt"));
    const recoveringGaps = [{ attemptCount: 1, reason: "rate_limited" }];
    const decision = await computeConnectionSourcePressureCooldown(
      "chatgpt",
      recoveringGaps,
      1000,
      Date.now() - 10_000,
      { consecutiveCooldownCycles: 1 }
    );
    assert.equal(decision.cooldownApplied, true);
    assert.equal(decision.recommendedHealthState, "cooling_off", "below the budget stays cooling_off");
  })
);

test(
  "computeConnectionSourcePressureCooldown: an UNAUDITED connector still escalates via the default profile (no silent no-op)",
  withTempDb(async () => {
    // The key GAP 1 guarantee: a connector with no declared manifest value does
    // NOT opt out of escalation — it escalates via DEFAULT_COOLDOWN_PROFILE.
    const deadGaps = [{ attemptCount: DEFAULT_COOLDOWN_PROFILE.maxCooldownCycles + 5, reason: "upstream_pressure" }];
    const decision = await computeConnectionSourcePressureCooldown(
      "some-unaudited-connector",
      deadGaps,
      1000,
      Date.now() - 100_000,
      { consecutiveCooldownCycles: DEFAULT_COOLDOWN_PROFILE.maxCooldownCycles }
    );
    assert.equal(
      decision.recommendedHealthState,
      "needs_attention",
      "an unaudited connector that goes dead must still escalate — absence of a declared value is NOT a silent disable"
    );
  })
);

// ─── ChatGPT live numbers preserved ──────────────────────────────────────────

test(
  "ChatGPT's manifest-declared max_cooldown_cycles is unchanged at 8 (live-number preservation)",
  withTempDb(async () => {
    await registerConnector(loadRawManifest("chatgpt"));
    const profile = await cooldownProfileForConnector("chatgpt");
    assert.equal(profile.maxCooldownCycles, 8, "ChatGPT cooldown cycle budget must stay 8");
  })
);

// ─── Malicious/extreme manifest-declared value: the RI ceiling holds ────────
//
// max_cooldown_cycles is a SCHEDULING budget a connector self-attests via its
// manifest — it must never let a connector opt out of §10-B escalation by
// declaring an absurd value. Manifest validation
// (connector-manifest-validation.ts) rejects an out-of-range declaration at
// registration time; this section proves that gate AND proves the read-site
// clamp (`RI_MAX_COOLDOWN_CYCLES_CEILING`) independently holds as
// defense-in-depth even for a value that somehow reached this code.

test(
  "registerConnector REJECTS an absurd max_cooldown_cycles at manifest-validation time",
  withTempDb(async () => {
    const malicious = loadRawManifest("chatgpt");
    (malicious.capabilities as { refresh_policy: Record<string, unknown> }).refresh_policy.max_cooldown_cycles =
      999_999_999;
    await assert.rejects(
      () => registerConnector(malicious),
      /max_cooldown_cycles must be an integer between/,
      "an absurd cooldown-cycle budget must be rejected at registration, not silently accepted"
    );
  })
);

test(
  "registerConnector REJECTS a negative/zero/non-integer max_cooldown_cycles at manifest-validation time",
  withTempDb(async () => {
    for (const badValue of [-5, 0, 1.5, Number.POSITIVE_INFINITY, Number.NaN]) {
      const malicious = loadRawManifest("chatgpt");
      (malicious.capabilities as { refresh_policy: Record<string, unknown> }).refresh_policy.max_cooldown_cycles =
        badValue;
      // biome-ignore lint/performance/noAwaitInLoops: each iteration is an independent assertion against a fresh manifest object.
      await assert.rejects(
        () => registerConnector(malicious),
        /max_cooldown_cycles must be an integer between/,
        `max_cooldown_cycles=${badValue} must be rejected`
      );
    }
  })
);

test("RI_MAX_COOLDOWN_CYCLES_CEILING is a finite positive integer bound, not Infinity", () => {
  assert.ok(
    Number.isInteger(RI_MAX_COOLDOWN_CYCLES_CEILING) && RI_MAX_COOLDOWN_CYCLES_CEILING > 0,
    "the RI hard ceiling itself must be a real, finite bound"
  );
});

test(
  "even at the maximum value manifest validation allows, a connection STILL reaches needs_attention (the ceiling is a real ceiling, not just documentation)",
  withTempDb(async () => {
    const maxAllowed = loadRawManifest("chatgpt");
    (maxAllowed.capabilities as { refresh_policy: Record<string, unknown> }).refresh_policy.max_cooldown_cycles =
      RI_MAX_COOLDOWN_CYCLES_CEILING;
    await registerConnector(maxAllowed);

    const profile = await cooldownProfileForConnector("chatgpt");
    assert.equal(
      profile.maxCooldownCycles,
      RI_MAX_COOLDOWN_CYCLES_CEILING,
      "a manifest-declared value exactly at the ceiling passes through unclamped-but-bounded"
    );

    // Prove the ceiling is a real ceiling: a connection with attemptCount and
    // consecutiveCooldownCycles at the ceiling STILL escalates — the maxed-out
    // budget delays escalation, it does not disable it.
    const deadGaps = [{ attemptCount: RI_MAX_COOLDOWN_CYCLES_CEILING + 10, reason: "upstream_pressure" }];
    const decision = await computeConnectionSourcePressureCooldown(
      "chatgpt",
      deadGaps,
      1000,
      Date.now() - 1_000_000,
      { consecutiveCooldownCycles: RI_MAX_COOLDOWN_CYCLES_CEILING }
    );
    assert.equal(
      decision.recommendedHealthState,
      "needs_attention",
      "even the maximum allowed cooldown budget must still eventually escalate to needs_attention"
    );
  })
);

// ─── Convention guard: production must use the GUARDED wrapper, not the bare fn ──
//
// The low-level `computeSourcePressureCooldown` tolerates an absent
// maxCooldownCycles (→ Infinity = no escalation) so unit tests can exercise the
// pure math. The latent foot-gun: a future production caller could use the bare
// function and silently disable §10-B escalation. This test makes the
// "production uses computeConnectionSourcePressureCooldown only" contract
// enforced-by-test, not enforced-by-hope — it fails red if any runtime/ or
// server/ source file references the bare function.
test("no production source calls the bare computeSourcePressureCooldown (only the guarded wrapper)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = join(here, "..");
  const offenders: string[] = [];
  const BARE = TOP_LEVEL_REGEX_2;
  const WRAPPED = TOP_LEVEL_REGEX_3;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "test") {
          continue;
        }
        walk(full);
        continue;
      }
      if (!TOP_LEVEL_REGEX_4.test(entry.name)) {
        continue;
      }
      // The definition file legitimately names the bare fn; skip it.
      if (entry.name === "scheduler-source-pressure-cooldown.ts") {
        continue;
      }
      const src = readFileSync(full, "utf8");
      // A reference is an offense only if it's the BARE name, not a substring
      // of the wrapped name. Strip wrapped references, then test for bare.
      const stripped = src.replace(new RegExp(WRAPPED.source, "g"), "");
      if (BARE.test(stripped)) {
        offenders.push(full.slice(root.length + 1));
      }
    }
  };
  walk(join(root, "runtime"));
  walk(join(root, "server"));
  assert.deepEqual(
    offenders,
    [],
    `production files must call computeConnectionSourcePressureCooldown (guarded), not the bare computeSourcePressureCooldown — offenders: ${offenders.join(", ")}`
  );
});
