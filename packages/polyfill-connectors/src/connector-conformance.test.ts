// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Conformance gate over the existing manifest/listing contract — no new
 * manifest field. Proves the production-ready roster
 * (`connector-conformance-roster.ts`) hasn't drifted from
 * owner-visible lifecycle tiers, that every roster entry names a real
 * test file, and that known scaffold connectors stay unlisted. This closes
 * the structural blind spot `coverage-policy-manifest-honesty.test.ts` can't
 * see: a connector that is `required: true` with no `coverage_policy` but
 * never emits a real record is invisible to that test, but IS visible here
 * as a listing/roster mismatch.
 *
 * Every manifest connector key MUST resolve to exactly one of four disjoint
 * buckets: `PRODUCTION_READY_CONNECTORS` (Supported or Preview, real),
 * `REAL_UNLISTED_CONNECTORS` (Development, real), or
 * `KNOWN_SCAFFOLD_CONNECTORS` (Development, unconditional SKIP_RESULT stub).
 * Every manifest must join one bucket; Development is not a silent opt-out.
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

function publicTier(connectorKey: string): string | null {
  const manifest = readManifest(connectorKey) as {
    capabilities?: { public_listing?: { tier?: unknown } };
  } | null;
  const tier = manifest?.capabilities?.public_listing?.tier;
  return typeof tier === "string" ? tier : null;
}

function isOwnerVisible(connectorKey: string): boolean {
  const tier = publicTier(connectorKey);
  return tier === "supported" || tier === "preview";
}

function allManifestConnectorKeys(): string[] {
  return readdirSync(MANIFESTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

test("every publicly-listed connector is in the production-ready roster, and vice versa", () => {
  const listedKeys = allManifestConnectorKeys()
    .filter(isOwnerVisible)
    .sort((a, b) => {
      if (a < b) {
        return -1;
      }
      return a > b ? 1 : 0;
    });
  const rosterKeys = Object.keys(PRODUCTION_READY_CONNECTORS).sort();

  const listedButNotRostered = listedKeys.filter((k) => !rosterKeys.includes(k));
  const rosteredButNotListed = rosterKeys.filter((k) => !listedKeys.includes(k));

  assert.deepEqual(
    listedButNotRostered,
    [],
    `owner-visible connector(s) are missing from PRODUCTION_READY_CONNECTORS: ${listedButNotRostered.join(", ")}. Add a roster entry naming its behavioral-oracle test file, or demote the lifecycle tier.`
  );
  assert.deepEqual(
    rosteredButNotListed,
    [],
    `production-ready roster entries are no longer Supported or Preview: ${rosteredButNotListed.join(", ")}. Update the roster or restore the lifecycle tier.`
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
  const listedScaffolds = KNOWN_SCAFFOLD_CONNECTORS.filter(isOwnerVisible);
  assert.deepEqual(
    listedScaffolds,
    [],
    `scaffold connector(s) have an owner-visible lifecycle tier: ${listedScaffolds.join(", ")} — a scaffold must remain Development`
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
  const listed = Object.keys(REAL_UNLISTED_CONNECTORS).filter(isOwnerVisible);
  assert.deepEqual(
    listed,
    [],
    `Development roster entry(ies) are owner-visible, so they belong in PRODUCTION_READY_CONNECTORS instead: ${listed.join(", ")}`
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
  // A new connector cannot ship invisible to every conformance category: it
  // must explicitly join the owner-visible, Development, or scaffold roster.
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
      "Add an owner-visible connector to PRODUCTION_READY_CONNECTORS, a Development collector to REAL_UNLISTED_CONNECTORS, " +
      "or an unconditional stub to KNOWN_SCAFFOLD_CONNECTORS."
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
