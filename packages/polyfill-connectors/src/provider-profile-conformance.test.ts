import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createConnectorHttpGovernor } from "./connector-http-governor.ts";
import { type ProviderPacingProfile, unauditedConservativePacingProfile } from "./provider-profile.ts";

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

// Every connector that constructs the shared HTTP governor at module load. Each
// MUST declare a ProviderProfile; this list is the conformance roster.
const GOVERNOR_USING_CONNECTORS = ["github", "notion", "oura", "spotify", "strava", "ynab"] as const;

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
