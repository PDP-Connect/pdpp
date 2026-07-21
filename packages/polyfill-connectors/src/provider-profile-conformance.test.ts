import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createConnectorHttpGovernor } from "./connector-http-governor.ts";
import type { ProviderPacingProfile } from "./provider-profile.ts";

/**
 * ProviderProfile conformance (SLVP-ideal spec §3, §9-C5).
 *
 * The spec's bar is: "every provider-specific quantity is a declared
 * ProviderProfile field with no shared default — a missing field is a BUILD
 * ERROR, not a silent borrow of ChatGPT's number." This suite PINS that bar for
 * the governor-using (API) connectors. It is the test that fails if the
 * requirement is ever weakened back to an optional field with a shared default.
 *
 * WI-1b status: all six governor-using connectors are now AUDITED — each declares
 * a per-connector pacing ceiling derived from its provider's documented limit
 * (src/provider-profile.ts, doc-cited; derivations in
 * docs/research/per-connector-rate-profiles-2026-06-13.md). The unaudited 1000ms
 * placeholder helper and its GAP-3 forcing function (which existed only to keep
 * the placeholder from ossifying) have been RETIRED now that the audit is
 * complete. The structural conformance below — required `profile`, no 250 borrow,
 * no roster drift — is permanent and outlives the audit.
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

// ─── 4. WI-1b: the shared unaudited placeholder is RETIRED (every connector audited) ──
//
// The 1000ms `unauditedConservativePacingProfile()` helper existed only as a
// deliberate-but-unaudited stopgap. WI-1b audited all six connectors against
// their documented provider limits, so the shared placeholder is gone. This test
// pins that retirement: no connector references the old placeholder helper, and
// the helper/constant no longer exist in `provider-profile.ts` (its absence is
// what makes the import at the top of this file impossible to restore silently).

test("WI-1b: no connector references the retired unaudited placeholder helper (every connector is audited)", () => {
  for (const name of GOVERNOR_USING_CONNECTORS) {
    const source = readFileSync(join(CONNECTORS_DIR, name, "index.ts"), "utf8");
    assert.doesNotMatch(
      source,
      /unauditedConservativePacingProfile|UNAUDITED_CONSERVATIVE_PACING_MIN_INTERVAL_MS/,
      `${name} still references the retired unaudited placeholder — it must declare an AUDITED per-provider profile (WI-1b / §9-C5)`
    );
  }
  // The helper/constant must be gone from the profile module too (no silent revival).
  const profileSource = readFileSync(join(THIS_DIR, "provider-profile.ts"), "utf8");
  assert.doesNotMatch(
    profileSource,
    /unauditedConservativePacingProfile|UNAUDITED_CONSERVATIVE_PACING_MIN_INTERVAL_MS/,
    "the unaudited placeholder helper/constant must be retired from provider-profile.ts now that every connector is audited (WI-1b)"
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

// ─── 6. WI-1b complete: every governor-using connector declares an audited ceiling ──
//
// The GAP-3 forcing function (which tracked the connectors still on the 1000ms
// placeholder, going RED as each was audited) has done its job and is retired now
// that all six are audited. This replaces it with the steady-state invariant: a
// governor-using connector's index.ts must declare a positive `pacingMinIntervalMs`
// — either inline or via an imported per-connector profile factory — so the
// declaration is always present and grep-able. A new connector added on the old
// placeholder would fail §4 above (the helper no longer exists to import).

test("WI-1b complete: every governor-using connector declares a per-provider pacing profile factory", () => {
  for (const name of GOVERNOR_USING_CONNECTORS) {
    const source = readFileSync(join(CONNECTORS_DIR, name, "index.ts"), "utf8");
    // Each connector imports a named `<name>PacingProfile` factory from the
    // profile module (the audited per-connector declaration). This pins that the
    // profile is sourced from the ONE declared home, not hand-rolled inline.
    assert.match(
      source,
      new RegExp(`${name}PacingProfile`),
      `${name} must import and use its audited ${name}PacingProfile from provider-profile.ts (WI-1b — §3, §9-C5)`
    );
  }
});
