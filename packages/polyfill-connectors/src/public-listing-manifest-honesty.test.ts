import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");

interface PublicListing {
  listed?: unknown;
  status?: unknown;
}

interface RefreshPolicy {
  background_safe?: unknown;
  recommended_mode?: unknown;
}

interface Manifest {
  capabilities?: {
    public_listing?: PublicListing;
    refresh_policy?: RefreshPolicy;
  };
  runtime_requirements?: {
    bindings?: { local_device?: { required?: unknown } };
  };
}

function listManifestNames(): string[] {
  return readdirSync(MANIFESTS_DIR)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, ""))
    .sort();
}

function readManifest(name: string): Manifest {
  return JSON.parse(readFileSync(join(MANIFESTS_DIR, `${name}.json`), "utf8")) as Manifest;
}

const MANIFEST_NAMES = listManifestNames();

test("manifest set is non-empty", () => {
  assert.ok(MANIFEST_NAMES.length > 0, "expected at least one first-party manifest");
});

test("every manifest declares capabilities.public_listing.listed as a boolean", () => {
  const missing: string[] = [];
  for (const name of MANIFEST_NAMES) {
    const m = readManifest(name);
    if (typeof m.capabilities?.public_listing?.listed !== "boolean") {
      missing.push(name);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `manifests missing capabilities.public_listing.listed (boolean): ${missing.join(", ")}`
  );
});

test('manifests with listed=false declare status="unproven"', () => {
  const offenders: string[] = [];
  for (const name of MANIFEST_NAMES) {
    const listing = readManifest(name).capabilities?.public_listing;
    if (listing?.listed === false && listing?.status !== "unproven") {
      offenders.push(`${name} (status=${String(listing?.status)})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `manifests with listed=false must declare status="unproven": ${offenders.join(", ")}`
  );
});

test("hidden manifests are not background-safe", () => {
  const offenders: string[] = [];
  for (const name of MANIFEST_NAMES) {
    const caps = readManifest(name).capabilities;
    const listed = caps?.public_listing?.listed === true;
    const backgroundSafe = caps?.refresh_policy?.background_safe === true;
    if (!listed && backgroundSafe) {
      offenders.push(name);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `manifests must not be hidden and background-safe at the same time: ${offenders.join(", ")}`
  );
});

test("broken-in-current-deployment manifests are not background-safe or auto-scheduled", () => {
  const offenders: string[] = [];
  for (const name of MANIFEST_NAMES) {
    const caps = readManifest(name).capabilities;
    if (caps?.public_listing?.status !== "broken_in_current_deployment") {
      continue;
    }
    const backgroundSafe = caps?.refresh_policy?.background_safe === true;
    const automatic = caps?.refresh_policy?.recommended_mode === "automatic";
    if (backgroundSafe || automatic) {
      offenders.push(
        `${name} (background_safe=${String(caps?.refresh_policy?.background_safe)}, recommended_mode=${String(caps?.refresh_policy?.recommended_mode)})`
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `manifests marked broken_in_current_deployment must not be background-safe or recommended_mode="automatic": ${offenders.join(", ")}`
  );
});

test("needs-human-auth manifests are not background-safe or auto-scheduled", () => {
  // A manifest that needs human-supplied credentials, OTP, or a manual
  // browser action cannot honestly run unattended. The reference today has
  // no modeled durable no-human unattended auth capability, so this rule
  // is absolute: if public_listing.status is "needs_human_auth" the
  // manifest MUST stay manual and MUST NOT be background-safe.
  const offenders: string[] = [];
  for (const name of MANIFEST_NAMES) {
    const caps = readManifest(name).capabilities;
    if (caps?.public_listing?.status !== "needs_human_auth") {
      continue;
    }
    const backgroundSafe = caps?.refresh_policy?.background_safe === true;
    const automatic = caps?.refresh_policy?.recommended_mode === "automatic";
    if (backgroundSafe || automatic) {
      offenders.push(
        `${name} (background_safe=${String(caps?.refresh_policy?.background_safe)}, recommended_mode=${String(caps?.refresh_policy?.recommended_mode)})`
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `manifests marked needs_human_auth must not be background-safe or recommended_mode="automatic": ${offenders.join(", ")}`
  );
});

test("iMessage local-device binding stays hidden and not background-safe", () => {
  const imessage = readManifest("imessage");
  assert.equal(imessage.runtime_requirements?.bindings?.local_device?.required, true);
  assert.equal(imessage.capabilities?.public_listing?.listed, false);
  assert.equal(imessage.capabilities?.public_listing?.status, "unproven");
  assert.equal(imessage.capabilities?.refresh_policy?.recommended_mode, "manual");
  assert.equal(imessage.capabilities?.refresh_policy?.background_safe, false);
});

test("Spotify stays hidden and not background-safe until a credentialed run proves records", () => {
  const spotify = readManifest("spotify");
  assert.equal(spotify.capabilities?.public_listing?.listed, false);
  assert.equal(spotify.capabilities?.public_listing?.status, "unproven");
  assert.equal(spotify.capabilities?.refresh_policy?.recommended_mode, "manual");
  assert.equal(spotify.capabilities?.refresh_policy?.background_safe, false);
});
