// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 * Every manifest connector key MUST resolve to exactly one of four disjoint
 * buckets: `PRODUCTION_READY_CONNECTORS` (listed, real), `REAL_UNLISTED_CONNECTORS`
 * (real, not yet listed), `KNOWN_SCAFFOLD_CONNECTORS` (unconditional
 * SKIP_RESULT stub), or the manifest-derived deprecated-upstream set. Closing
 * `public_listing.listed: false`/absent as a silent opt-out from all
 * conformance roster categories was the exact gap this test previously left
 * open — a new scaffold connector that simply never set `listed: true` had
 * no roster gate at all.
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
import {
  DEPRECATED_UPSTREAM_STATUS,
  KNOWN_SCAFFOLD_CONNECTORS,
  PRODUCTION_READY_CONNECTORS,
  REAL_UNLISTED_CONNECTORS,
} from "./connector-conformance-roster.ts";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

function readManifest(connectorKey: string): Record<string, unknown> | null {
  const manifestPath = join(MANIFESTS_DIR, `${connectorKey}.json`);
  if (!existsSync(manifestPath)) {
    return null;
  }
  return JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
}

function isListed(connectorKey: string): boolean {
  const manifest = readManifest(connectorKey) as {
    capabilities?: { public_listing?: { listed?: unknown } };
  } | null;
  return manifest?.capabilities?.public_listing?.listed === true;
}

function publicListingStatus(connectorKey: string): string | null {
  const manifest = readManifest(connectorKey) as {
    capabilities?: { public_listing?: { status?: unknown } };
  } | null;
  const status = manifest?.capabilities?.public_listing?.status;
  return typeof status === "string" ? status : null;
}

function isDeprecatedUpstream(connectorKey: string): boolean {
  return publicListingStatus(connectorKey) === DEPRECATED_UPSTREAM_STATUS;
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

test("every REAL_UNLISTED_CONNECTORS entry names a test file that exists", () => {
  const missing = Object.entries(REAL_UNLISTED_CONNECTORS)
    .filter(([, { testFile }]) => !existsSync(join(PACKAGE_ROOT, testFile)))
    .map(([key, { testFile }]) => `${key} -> ${testFile}`);

  assert.deepEqual(
    missing,
    [],
    `REAL_UNLISTED_CONNECTORS entries name a test file that does not exist: ${missing.join("; ")}`
  );
});

test("REAL_UNLISTED_CONNECTORS entries are not publicly listed", () => {
  const listed = Object.keys(REAL_UNLISTED_CONNECTORS).filter(isListed);
  assert.deepEqual(
    listed,
    [],
    `REAL_UNLISTED_CONNECTORS entry(ies) are public_listing.listed:true, so they belong in PRODUCTION_READY_CONNECTORS instead: ${listed.join(", ")}`
  );
});

test("known scaffold connectors do not appear in REAL_UNLISTED_CONNECTORS", () => {
  const overlap = KNOWN_SCAFFOLD_CONNECTORS.filter((key) => key in REAL_UNLISTED_CONNECTORS);
  assert.deepEqual(
    overlap,
    [],
    `scaffold connector(s) present in REAL_UNLISTED_CONNECTORS: ${overlap.join(", ")} — a scaffold must prove real collection before claiming to be real-but-unlisted`
  );
});

test("every manifest connector key resolves to exactly one conformance roster bucket", () => {
  // Every bucket is disjoint from every other; a connector key MUST land in
  // exactly one. This is the exhaustiveness gate closing the prior
  // `public_listing.listed: false`-as-silent-opt-out hole: a new connector
  // cannot ship invisible to every conformance category just by never
  // setting `listed: true` — it must explicitly join PRODUCTION_READY_CONNECTORS,
  // REAL_UNLISTED_CONNECTORS, KNOWN_SCAFFOLD_CONNECTORS, or its manifest must
  // carry public_listing.status: "deprecated_upstream".
  const productionReadyKeys = new Set(Object.keys(PRODUCTION_READY_CONNECTORS));
  const realUnlistedKeys = new Set(Object.keys(REAL_UNLISTED_CONNECTORS));
  const scaffoldKeys = new Set<string>(KNOWN_SCAFFOLD_CONNECTORS);

  const allKeys = allManifestConnectorKeys();
  const unaccountedFor: string[] = [];
  const inMultipleBuckets: string[] = [];

  for (const key of allKeys) {
    const buckets = [
      productionReadyKeys.has(key) && "production_ready",
      realUnlistedKeys.has(key) && "real_unlisted",
      scaffoldKeys.has(key) && "known_scaffold",
      isDeprecatedUpstream(key) && "deprecated_upstream",
    ].filter((bucket): bucket is string => Boolean(bucket));

    if (buckets.length === 0) {
      unaccountedFor.push(key);
    } else if (buckets.length > 1) {
      inMultipleBuckets.push(`${key} (${buckets.join(", ")})`);
    }
  }

  assert.deepEqual(
    unaccountedFor,
    [],
    `connector(s) with a manifest but no conformance roster bucket: ${unaccountedFor.join(", ")}. ` +
      "Add to PRODUCTION_READY_CONNECTORS (if listed:true), REAL_UNLISTED_CONNECTORS (real collector, not yet listed), " +
      'KNOWN_SCAFFOLD_CONNECTORS (unconditional SKIP_RESULT), or set public_listing.status: "deprecated_upstream".'
  );
  assert.deepEqual(
    inMultipleBuckets,
    [],
    `connector(s) claimed by more than one conformance roster bucket: ${inMultipleBuckets.join("; ")}`
  );

  // Guards the roster maintenance contract itself: every key in every roster
  // must resolve to a real manifest file, so a typo'd connector key fails
  // loudly instead of silently never being checked.
  const allKeysSet = new Set(allKeys);
  const rosterKeys = [...productionReadyKeys, ...realUnlistedKeys, ...scaffoldKeys];
  const unknownKeys = rosterKeys.filter((k) => !allKeysSet.has(k));
  assert.deepEqual(
    unknownKeys,
    [],
    `roster references connector key(s) with no manifest file: ${unknownKeys.join(", ")}`
  );
});
