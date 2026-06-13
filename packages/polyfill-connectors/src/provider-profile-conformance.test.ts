import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createConnectorHttpGovernor } from "./connector-http-governor.ts";
import {
  type ProviderPacingProfile,
  UNAUDITED_CONSERVATIVE_PACING_MIN_INTERVAL_MS,
  unauditedConservativePacingProfile,
} from "./provider-profile.ts";

/**
 * ProviderProfile conformance (SLVP-ideal spec §3, §9-C5).
 *
 * The spec's bar is: "every provider-specific quantity is a declared
 * ProviderProfile field with no shared default — a missing field is a BUILD
 * ERROR, not a silent borrow of ChatGPT's number." This suite PINS that bar for
 * the governor-using (API) connectors. It is the test that fails if the
 * requirement is ever weakened back to an optional field with a shared default.
 *
 * Two enforcement layers are proven here:
 *   1. COMPILE-TIME (the primary mechanism): `profile` is a required field on
 *      `ConnectorHttpGovernorOptions`, so a bare `createConnectorHttpGovernor
 *      ({ name })` is a `tsc` error. The `@ts-expect-error` below is the
 *      executable proof — if the field is ever made optional again, the
 *      suppression becomes unused and `tsc --noEmit` fails. (The terminal-gap
 *      and cooldown slices are .js seams; their build-error equivalent is the
 *      loud throw + their own conformance assertions in the reference-
 *      implementation SLVP suites.)
 *   2. RUNTIME BACKSTOP: a JS caller (no tsc) that omits the profile must fail
 *      LOUD, never silently borrow a shared default.
 *
 * Plus a registry conformance over each governor-using connector's SOURCE: the
 * scan is static (no module import) so it is hang-proof — importing real
 * connector modules leaves keep-alive sockets open and would wedge the runner.
 * The static scan + the compile-time required field together guarantee every
 * shipped connector that uses the shared governor declares a ProviderProfile.
 */

const THIS_DIR = dirname(fileURLToPath(import.meta.url));
const CONNECTORS_DIR = join(THIS_DIR, "..", "connectors");

// Hand-maintained roster of governor-using (API) connectors. Each MUST declare a
// ProviderProfile. This list is NOT the source of truth — it is cross-checked
// against the FILESYSTEM-DERIVED set below, so a new governor-using connector
// added without updating this list FAILS the conformance suite (roster hardening
// from the adversarial review: the static scan was foolable + the roster was
// hand-maintained; this closes the "added but unlisted" hole).
const GOVERNOR_USING_CONNECTORS = ["github", "notion", "oura", "spotify", "strava", "ynab"] as const;

/**
 * Derive the set of connectors that construct the shared HTTP governor by
 * scanning each connector's `index.ts` source for a `createConnectorHttpGovernor`
 * call. This is the source of truth the hand-maintained roster is checked
 * against — so the roster can never silently drift from reality.
 */
function deriveGovernorUsingConnectors(): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(CONNECTORS_DIR)) {
    const indexPath = join(CONNECTORS_DIR, entry, "index.ts");
    let source: string;
    try {
      if (!statSync(indexPath).isFile()) {
        continue;
      }
      source = readFileSync(indexPath, "utf8");
    } catch {
      continue; // no index.ts (e.g. a fixtures-only dir) — not a governor-using connector
    }
    if (/createConnectorHttpGovernor\s*\(/.test(source)) {
      names.push(entry);
    }
  }
  return names.sort();
}

/**
 * Connectors still pointing at the UNAUDITED 1000ms conservative pacing
 * placeholder (`unauditedConservativePacingProfile()` /
 * `UNAUDITED_CONSERVATIVE_PACING_MIN_INTERVAL_MS`). Derived from source so the
 * list cannot ossify silently. This is the GAP 3 forcing function's input.
 */
function deriveUnauditedPlaceholderConnectors(): string[] {
  const names: string[] = [];
  for (const name of deriveGovernorUsingConnectors()) {
    const source = readFileSync(join(CONNECTORS_DIR, name, "index.ts"), "utf8");
    if (/unauditedConservativePacingProfile\s*\(|UNAUDITED_CONSERVATIVE_PACING_MIN_INTERVAL_MS/.test(source)) {
      names.push(name);
    }
  }
  return names;
}

// GAP 3 forcing function: the connectors KNOWN to still be on the unaudited
// 1000ms placeholder, pending the per-connector behavioral audit
// (generalize-adaptive-collection-governor task 7b — §9-C5 / §3 pressureSignal +
// servedBackoffCostMs). This roster is the forcing function: when a connector is
// audited and its placeholder is replaced with a real per-provider ceiling, the
// derived set below stops matching this list and the test goes RED — forcing the
// author to remove the connector from this roster (a conscious "this one is
// audited now" acknowledgement) and re-read task 7b. The placeholder therefore
// cannot silently become permanent.
const STILL_ON_UNAUDITED_PLACEHOLDER = ["github", "notion", "oura", "spotify", "strava", "ynab"] as const;

// ─── 1. Compile-time: missing profile is a BUILD ERROR ───────────────────────

test("a governor wired WITHOUT a declared profile is a compile-time error (the spec's build-error bar)", () => {
  // @ts-expect-error — `profile` is REQUIRED on ConnectorHttpGovernorOptions
  // (spec §3 rule 6). Omitting it must be a tsc error. If this suppression ever
  // becomes unused, the field has been weakened back to optional and tsc fails.
  const omitProfile = () => createConnectorHttpGovernor({ name: "no-profile" });
  assert.equal(typeof omitProfile, "function", "type-level assertion compiled");
});

// ─── 2. Runtime backstop: a JS caller cannot silently borrow a default ───────

test("the runtime backstop throws LOUD when a profile is omitted (no silent shared default)", () => {
  const ceilingPattern = /requires a per-provider profile\.pacingMinIntervalMs/;
  assert.throws(
    // @ts-expect-error — exercising the JS-caller path that bypasses tsc.
    () => createConnectorHttpGovernor({ name: "no-profile" }),
    ceilingPattern,
    "an omitted safety ceiling must fail loud, never borrow ChatGPT's number"
  );
});

test("the runtime backstop also rejects a non-positive / non-finite ceiling", () => {
  const ceilingPattern = /requires a per-provider profile\.pacingMinIntervalMs/;
  const bad: ProviderPacingProfile[] = [
    { pacingMinIntervalMs: 0 },
    { pacingMinIntervalMs: -1 },
    { pacingMinIntervalMs: Number.POSITIVE_INFINITY },
    { pacingMinIntervalMs: Number.NaN },
  ];
  for (const profile of bad) {
    assert.throws(
      () => createConnectorHttpGovernor({ name: "bad-ceiling", profile }),
      ceilingPattern,
      `ceiling ${profile.pacingMinIntervalMs} must be rejected`
    );
  }
});

// ─── 3. Registry conformance: every governor-using connector declares one ────

for (const name of GOVERNOR_USING_CONNECTORS) {
  test(`registry conformance: ${name} declares a ProviderProfile on its shared governor`, () => {
    const source = readFileSync(join(CONNECTORS_DIR, name, "index.ts"), "utf8");

    // Every createConnectorHttpGovernor call in the connector must pass a
    // `profile`. A bare call would inherit nothing (the field is required) — the
    // static scan pins that no such bare call slips in.
    const callPattern = /createConnectorHttpGovernor\(\s*\{([\s\S]*?)\}\s*\)/g;
    const calls = [...source.matchAll(callPattern)];
    assert.ok(calls.length > 0, `${name} must construct the shared governor (it is a governor-using connector)`);
    for (const match of calls) {
      const body = match[1];
      assert.ok(body, `${name}: governor call body must be captured`);
      assert.match(
        body,
        /profile:/,
        `${name}: every createConnectorHttpGovernor call must declare a profile (spec §3 — no shared default)`
      );
    }

    // And it must NOT borrow ChatGPT's audited 250ms ceiling: the unaudited
    // connectors point at the conservative profile, never a 250 literal.
    assert.doesNotMatch(
      source,
      /pacingMinIntervalMs:\s*250\b/,
      `${name} must NOT hard-code ChatGPT's 250ms ceiling — declare a per-provider value (§9-C5)`
    );
  });
}

// ─── 4. The conservative placeholder is a real, declared, non-ChatGPT value ──

test("the unaudited conservative profile is a deliberate declaration, slower than ChatGPT's audited 250ms (no borrow)", () => {
  const profile = unauditedConservativePacingProfile();
  assert.equal(typeof profile.pacingMinIntervalMs, "number");
  assert.ok(
    profile.pacingMinIntervalMs > 250,
    "the unaudited placeholder must be SLOWER than ChatGPT's account-tuned 250ms — a polite default, not a borrow (§9-C5)"
  );
});

// ─── 5. Roster hardening: the hand-maintained list cannot drift from reality ──
//
// The adversarial review flagged the hand-maintained roster as foolable. This
// derives the governor-using set from source and fails if it diverges — so a new
// governor-using connector added without being listed (or a connector that drops
// the governor) is caught immediately.

test("the hand-maintained GOVERNOR_USING_CONNECTORS roster matches the filesystem-derived set (no silent drift)", () => {
  const derived = deriveGovernorUsingConnectors();
  const declared = [...GOVERNOR_USING_CONNECTORS].sort();
  assert.deepEqual(
    derived,
    declared,
    "a connector that constructs createConnectorHttpGovernor must be in GOVERNOR_USING_CONNECTORS.\n" +
      `  derived from source: ${JSON.stringify(derived)}\n` +
      `  hand-maintained:     ${JSON.stringify(declared)}\n` +
      "If you added a governor-using connector, add it to GOVERNOR_USING_CONNECTORS (and give it a ProviderProfile)."
  );
});

// ─── 6. GAP 3 forcing function: the 1000ms placeholder cannot ossify silently ──
//
// The unaudited 1000ms shared placeholder is acceptable PENDING the per-connector
// audit (task 7b), but nothing forced it to be replaced — it could ossify. This
// test makes the placeholder VISIBLE and un-ossifiable: it pins exactly which
// connectors are still on it. When a connector is audited (its placeholder
// replaced by a real per-provider ceiling), this test goes RED until the author
// removes it from STILL_ON_UNAUDITED_PLACEHOLDER — a forced, conscious update.

test("GAP 3 forcing function: connectors still on the 1000ms unaudited placeholder are explicitly tracked (task 7b)", () => {
  const derived = deriveUnauditedPlaceholderConnectors().sort();
  const tracked = [...STILL_ON_UNAUDITED_PLACEHOLDER].sort();
  assert.deepEqual(
    derived,
    tracked,
    `The set of connectors still on the unaudited ${UNAUDITED_CONSERVATIVE_PACING_MIN_INTERVAL_MS}ms placeholder drifted.\n` +
      `  derived from source: ${JSON.stringify(derived)}\n` +
      `  tracked roster:      ${JSON.stringify(tracked)}\n` +
      "This is the forcing function for the per-connector behavioral audit\n" +
      "(generalize-adaptive-collection-governor task 7b — §9-C5). If you AUDITED a\n" +
      "connector and replaced its placeholder, REMOVE it from STILL_ON_UNAUDITED_PLACEHOLDER.\n" +
      "If you added a new governor-using connector still on the placeholder, ADD it.\n" +
      "The placeholder must never silently become permanent."
  );
  // Sanity: every tracked connector is also a governor-using connector.
  for (const name of tracked) {
    assert.ok(
      (GOVERNOR_USING_CONNECTORS as readonly string[]).includes(name),
      `${name} is tracked as placeholder-using but is not a governor-using connector`
    );
  }
});

test("GAP 3 forcing function is non-empty until task 7b lands (visibility that work remains)", () => {
  // A green-but-empty forcing function would be invisible. Until task 7b audits
  // every connector, this asserts there is still placeholder work to do — so the
  // forcing function is alive, not a no-op. When the LAST connector is audited,
  // this assertion flips and the author removes both this test and the roster
  // (the placeholder mechanism itself can then be deleted).
  const derived = deriveUnauditedPlaceholderConnectors();
  assert.ok(
    derived.length > 0,
    "expected at least one connector still on the unaudited placeholder; if task 7b is fully done, retire this forcing function + the placeholder helper"
  );
});
