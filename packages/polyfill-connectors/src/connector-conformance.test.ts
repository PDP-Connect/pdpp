/**
 * Conformance gate over the existing manifest/listing contract — no new
 * manifest field. Proves the production-ready roster
 * (`connector-conformance-roster.ts`) hasn't drifted from
 * `capabilities.public_listing.listed`, that every roster entry names a real
 * test file, and that known scaffold connectors stay unlisted. This closes
 * the structural blind spot `coverage-policy-manifest-honesty.test.ts` can't
 * see: a connector that is `required: true` with no `coverage_policy` but
 * never emits a real record is invisible to that test, but IS visible here
 * as a listing/roster mismatch.
 *
 * This test does not run any connector's `collect()` or reprove its
 * behavior — each connector's own named test file (parsers/integration/
 * schemas) remains the sole behavioral oracle for whether it really
 * collects real data. This gate only proves the roster and the manifest
 * listing state agree, and that the named oracle file exists.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { KNOWN_SCAFFOLD_CONNECTORS, PRODUCTION_READY_CONNECTORS } from "./connector-conformance-roster.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

function isListed(connectorKey: string): boolean {
  const manifestPath = join(MANIFESTS_DIR, `${connectorKey}.json`);
  if (!existsSync(manifestPath)) {
    return false;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    capabilities?: { public_listing?: { listed?: unknown } };
  };
  return manifest.capabilities?.public_listing?.listed === true;
}

function allManifestConnectorKeys(): string[] {
  return readdirSync(MANIFESTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

test("every publicly-listed connector is in the production-ready roster, and vice versa", () => {
  const listedKeys = allManifestConnectorKeys().filter(isListed).sort();
  const rosterKeys = Object.keys(PRODUCTION_READY_CONNECTORS).sort();

  const listedButNotRostered = listedKeys.filter((k) => !rosterKeys.includes(k));
  const rosteredButNotListed = rosterKeys.filter((k) => !listedKeys.includes(k));

  assert.deepEqual(
    listedButNotRostered,
    [],
    `connector(s) declare public_listing.listed:true but are missing from PRODUCTION_READY_CONNECTORS: ${listedButNotRostered.join(", ")}. Add a roster entry naming its behavioral-oracle test file, or the listing is unproven.`
  );
  assert.deepEqual(
    rosteredButNotListed,
    [],
    `roster entries no longer match a public_listing.listed:true manifest: ${rosteredButNotListed.join(", ")}. Update the roster or restore the manifest's listing.`
  );
});

test("every production-ready roster entry names a test file that exists", () => {
  const missing = Object.entries(PRODUCTION_READY_CONNECTORS)
    .filter(([, { testFile }]) => !existsSync(join(PACKAGE_ROOT, testFile)))
    .map(([key, { testFile }]) => `${key} -> ${testFile}`);

  assert.deepEqual(missing, [], `roster entries name a test file that does not exist: ${missing.join("; ")}`);
});

test("known scaffold connectors are not in the production-ready roster", () => {
  const overlap = KNOWN_SCAFFOLD_CONNECTORS.filter((key) => key in PRODUCTION_READY_CONNECTORS);
  assert.deepEqual(
    overlap,
    [],
    `scaffold connector(s) present in PRODUCTION_READY_CONNECTORS: ${overlap.join(", ")} — a scaffold must prove real collection before joining the roster`
  );
});

test("known scaffold connectors are not publicly listed", () => {
  const listedScaffolds = KNOWN_SCAFFOLD_CONNECTORS.filter(isListed);
  assert.deepEqual(
    listedScaffolds,
    [],
    `scaffold connector(s) are public_listing.listed:true: ${listedScaffolds.join(", ")} — a scaffold must not be owner-selectable`
  );
});

test("every manifest connector key is accounted for as either production-ready or a known scaffold, or is intentionally unlisted-but-real", () => {
  // Not every non-listed connector is a scaffold (e.g. apple_health, pocket,
  // spotify, imessage, twitter_archive, google_takeout are real connectors
  // that are simply not yet publicly listed). This test only proves the two
  // rosters that DO carry a hard invariant — production-ready and known
  // -scaffold — never overlap with each other's manifest set, which the
  // tests above already assert per-key. This test guards the roster
  // maintenance contract itself: every key in either roster must resolve to
  // a real manifest file, so a typo'd connector key fails loudly.
  const allKeys = new Set(allManifestConnectorKeys());
  const rosterKeys = [...Object.keys(PRODUCTION_READY_CONNECTORS), ...KNOWN_SCAFFOLD_CONNECTORS];
  const unknownKeys = rosterKeys.filter((k) => !allKeys.has(k));
  assert.deepEqual(
    unknownKeys,
    [],
    `roster references connector key(s) with no manifest file: ${unknownKeys.join(", ")}`
  );
});
