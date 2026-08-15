import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const MANIFESTS_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "manifests");
const names = readdirSync(MANIFESTS_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort();
const tiers = new Set(["supported", "preview", "development"]);
interface Manifest {
  capabilities?: { public_listing?: { tier?: string; listed?: unknown; status?: unknown } };
}

function isManifest(value: unknown): value is Manifest {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function manifest(name: string): Manifest {
  const value: unknown = JSON.parse(readFileSync(join(MANIFESTS_DIR, name), "utf8"));
  assert.ok(isManifest(value), `${name} must contain a manifest object`);
  return value;
}

test("every shipped manifest declares exactly one typed public lifecycle tier", () => {
  assert.equal(names.length, 44);
  for (const name of names) {
    const { capabilities } = manifest(name);
    const { public_listing: listing } = capabilities ?? {};
    assert.ok(listing, `${name} must declare public_listing`);
    assert.ok(!Object.hasOwn(listing ?? {}, "listed"), `${name} must not declare legacy listed`);
    assert.ok(!Object.hasOwn(listing ?? {}, "status"), `${name} must not declare legacy status`);
    assert.ok(
      typeof listing.tier === "string" && tiers.has(listing.tier),
      `${name} has invalid tier ${String(listing.tier)}`
    );
  }
});

test("development is the only non-offered lifecycle tier", () => {
  for (const name of names) {
    const { capabilities } = manifest(name);
    const { public_listing: listing } = capabilities ?? {};
    assert.ok(listing?.tier, `${name} must declare a tier`);
    const { tier } = listing;
    assert.ok(tiers.has(tier));
  }
});

test("recent or non-repeatable live evidence stays Preview", () => {
  for (const name of ["apple_contacts.json", "groupme.json"]) {
    const { capabilities } = manifest(name);
    const { public_listing: listing } = capabilities ?? {};
    assert.equal(listing?.tier, "preview");
  }
});
