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
  assert.equal(names.length, 45);
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
  for (const name of ["apple_contacts.json"]) {
    const { capabilities } = manifest(name);
    const { public_listing: listing } = capabilities ?? {};
    assert.equal(listing?.tier, "preview");
  }
});

test("connectors demoted for unproven freeze-era reliability stay unlisted or Preview", () => {
  // heb: experimental-equivalent (Preview) until a bounded live run accounts
  //   for every declared item, or provider-boundary evidence exists for each
  //   short order (owner run last measured 1,363 declared vs 918 collected).
  // usaa: Preview until a live 4/4 coverage remeasure completes on the
  //   repaired code (independent review found real selector shape/timing
  //   unproved without a live run).
  // gmail: Preview until final-head live evidence for the new
  //   message_bodies STREAM_EVIDENCE emitter is proven end to end.
  // groupme: Development (unlisted) until GroupMe's direct-message
  //   confirmation semantics are ratified and live-proven; group collection
  //   alone does not justify owner-facing listing.
  const expected: Record<string, string> = {
    "heb.json": "preview",
    "usaa.json": "preview",
    "gmail.json": "preview",
    "groupme.json": "development",
  };
  for (const [name, expectedTier] of Object.entries(expected)) {
    const { capabilities } = manifest(name);
    const { public_listing: listing } = capabilities ?? {};
    assert.equal(
      listing?.tier,
      expectedTier,
      `${name} must stay at lifecycle tier "${expectedTier}" until its freeze condition is proven`
    );
  }
});
