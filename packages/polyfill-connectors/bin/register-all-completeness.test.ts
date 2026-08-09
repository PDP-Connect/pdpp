// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves `bin/register-all.ts`'s smoke-test connector set can never silently
 * drift from the orchestrator's connector registry (`KNOWN_CONNECTOR_NAMES`
 * in src/orchestrator.ts) — the same registry the runtime and every
 * connector's own paths resolve against.
 *
 * `selectRegisterAllConnectors` (src/orchestrator.ts) is the actual
 * selection logic register-all.ts calls in production. This test calls that
 * same function directly and asserts full equality against
 * KNOWN_CONNECTOR_NAMES minus manifest-declared deprecated_upstream entries
 * — a behavioral test of the real function, not a parse of register-all.ts's
 * source text. A stale hardcoded array in register-all.ts previously omitted
 * groupme, jellyfin, chase, netflix_export, and steam with no CI signal.
 *
 * Scope note: this does not assert anything about fresh-instance/first-boot
 * registration. That path is independent —
 * `reference-implementation/server/polyfill-manifest-reconcile.ts`, driven
 * by `manifests/*.json` + `capabilities.public_listing.listed` — and was
 * already correct; register-all.ts is a developer smoke-test/seed utility.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { KNOWN_CONNECTOR_NAMES, MANIFEST_DIR, selectRegisterAllConnectors } from "../src/orchestrator.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function manifestStatus(name: string): string | undefined {
  const manifest = JSON.parse(readFileSync(join(MANIFEST_DIR, `${name}.json`), "utf8")) as {
    capabilities?: { public_listing?: { status?: string } };
  };
  return manifest.capabilities?.public_listing?.status;
}

function readManifestStub(name: string) {
  return JSON.parse(readFileSync(join(MANIFEST_DIR, `${name}.json`), "utf8"));
}

test("selectRegisterAllConnectors equals KNOWN_CONNECTOR_NAMES minus deprecated_upstream manifests", () => {
  const actual = selectRegisterAllConnectors(KNOWN_CONNECTOR_NAMES, readManifestStub).sort((a, b) =>
    a.localeCompare(b)
  );
  const expected = KNOWN_CONNECTOR_NAMES.filter((name) => manifestStatus(name) !== "deprecated_upstream").sort((a, b) =>
    a.localeCompare(b)
  );

  assert.deepEqual(
    actual,
    expected,
    "selectRegisterAllConnectors must register every known connector except deprecated-upstream manifests"
  );

  for (const advertised of ["groupme", "jellyfin", "chase", "netflix_export", "steam"]) {
    assert.ok(
      actual.includes(advertised),
      `${advertised} is a known, non-deprecated connector and must be onboarded by register-all's smoke sweep`
    );
  }
  assert.ok(!actual.includes("pocket"), "pocket is deprecated_upstream and must stay excluded");

  // Preserve manual/local-device/unlisted categories exactly: unaffected by
  // the deprecated_upstream filter, they must remain included as before.
  for (const preserved of ["claude_code", "spotify", "uber", "linkedin", "imessage"]) {
    assert.ok(
      actual.includes(preserved),
      `${preserved} (manual/local-device/unlisted category) must stay included in register-all's smoke sweep`
    );
  }
});

test("register-all.ts wires CONNECTORS from selectRegisterAllConnectors, not a hand-maintained array", () => {
  const source = readFileSync(join(__dirname, "register-all.ts"), "utf8");
  assert.match(
    source,
    /const CONNECTORS = selectRegisterAllConnectors\(/,
    "register-all.ts must call the shared, directly-tested selectRegisterAllConnectors rather than " +
      "reintroducing a second hand-maintained connector array"
  );
});
