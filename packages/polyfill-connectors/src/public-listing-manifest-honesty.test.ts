import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");
const FIXTURES_DIR = join(PACKAGE_ROOT, "fixtures");

/**
 * Allowlist for listed=true + status=proven manifests that legitimately ship
 * without a committed `fixtures/<connector>/scrubbed/pilot-real-shape/records/`
 * shape-conformance fixture. Each entry MUST document why no fixture is
 * possible or required today, and SHOULD link the work that will close the
 * gap. The default state for a proven listed connector is "ships a pilot
 * fixture" — entries here are exceptions, not defaults.
 *
 * Adding an entry is a deliberate honesty decision: it admits that schema
 * drift for this connector is not gated by a hermetic test. Remove the entry
 * the same commit that adds the fixture (and the matching
 * `pilot-fixture.test.ts` invocation under `connectors/<connector>/`).
 */
const PILOT_FIXTURE_EXEMPT: Record<string, string> = {
  notion:
    "Runtime ships without a connectors/notion/schemas.ts validator; pilot-fixture-test-helper has nothing to assert against.",
  oura: "Runtime ships without a connectors/oura/schemas.ts validator; same gap as notion.",
  strava: "Runtime ships without a connectors/strava/schemas.ts validator; same gap as notion.",
};

interface PublicListing {
  listed?: unknown;
  status?: unknown;
}

interface RefreshPolicy {
  assisted_after_owner_auth?: unknown;
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

test("manifests with listed=false declare a hidden-by-design status", () => {
  // listed=false must be paired with a status value that explains why the
  // manifest is hidden. "unproven" covers connectors we have not yet
  // exercised against a real deployment; "deprecated_upstream" covers
  // connectors whose upstream API has been shut down (e.g. Pocket after
  // Mozilla's 2025-07-08 sunset). Both are absolute: a deprecated_upstream
  // manifest also cannot be background-safe or automatic (asserted below).
  const HIDDEN_STATUSES = new Set(["unproven", "deprecated_upstream"]);
  const offenders: string[] = [];
  for (const name of MANIFEST_NAMES) {
    const listing = readManifest(name).capabilities?.public_listing;
    if (listing?.listed !== false) {
      continue;
    }
    const status = typeof listing?.status === "string" ? listing.status : null;
    if (!(status && HIDDEN_STATUSES.has(status))) {
      offenders.push(`${name} (status=${String(listing?.status)})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `manifests with listed=false must declare status="unproven" or "deprecated_upstream": ${offenders.join(", ")}`
  );
});

test("deprecated-upstream manifests are hidden, manual, and not background-safe", () => {
  // An upstream-deprecated connector cannot run at all; the manifest must
  // surface that honestly. listed=true would advertise a working
  // connector; background_safe=true or recommended_mode="automatic" would
  // queue scheduled failures against an API that no longer exists.
  const offenders: string[] = [];
  for (const name of MANIFEST_NAMES) {
    const caps = readManifest(name).capabilities;
    if (caps?.public_listing?.status !== "deprecated_upstream") {
      continue;
    }
    const listed = caps?.public_listing?.listed === true;
    const backgroundSafe = caps?.refresh_policy?.background_safe === true;
    const automatic = caps?.refresh_policy?.recommended_mode === "automatic";
    if (listed || backgroundSafe || automatic) {
      offenders.push(
        `${name} (listed=${String(caps?.public_listing?.listed)}, background_safe=${String(caps?.refresh_policy?.background_safe)}, recommended_mode=${String(caps?.refresh_policy?.recommended_mode)})`
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `manifests with status="deprecated_upstream" must be listed=false, manual, and not background-safe: ${offenders.join(", ")}`
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

test("needs-human-auth manifests require assisted-after-owner-auth posture for automatic scheduling", () => {
  // A manifest that needs human-supplied credentials, OTP, or a manual
  // browser action cannot honestly claim durable unattended auth. It may
  // still allow explicit assisted scheduling after owner auth is bootstrapped
  // when that posture is modeled in refresh_policy.
  const offenders: string[] = [];
  for (const name of MANIFEST_NAMES) {
    const caps = readManifest(name).capabilities;
    if (caps?.public_listing?.status !== "needs_human_auth") {
      continue;
    }
    const backgroundSafe = caps?.refresh_policy?.background_safe === true;
    const automatic = caps?.refresh_policy?.recommended_mode === "automatic";
    const assisted = caps?.refresh_policy?.assisted_after_owner_auth === true;
    if ((backgroundSafe || automatic) && !assisted) {
      offenders.push(
        `${name} (background_safe=${String(caps?.refresh_policy?.background_safe)}, recommended_mode=${String(caps?.refresh_policy?.recommended_mode)}, assisted_after_owner_auth=${String(caps?.refresh_policy?.assisted_after_owner_auth)})`
      );
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `manifests marked needs_human_auth must declare assisted_after_owner_auth=true before background-safe or recommended_mode="automatic": ${offenders.join(", ")}`
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

test("listed=proven manifests ship a pilot-real-shape fixture or sit on the documented exempt list", () => {
  // Listed=true + status=proven advertises a working connector to operators
  // and the dashboard. The reference protects that claim with a hermetic
  // shape-conformance gate: each proven connector commits a fixture under
  // `fixtures/<c>/scrubbed/pilot-real-shape/records/` that `pilot-fixture.test.ts`
  // replays through the runtime validator on every CI pass. A new proven
  // connector that lands without a fixture silently weakens the dashboard's
  // truthfulness, so this guard fails closed: either ship the fixture or
  // explicitly opt out via PILOT_FIXTURE_EXEMPT with a documented reason.
  const offenders: string[] = [];
  for (const name of MANIFEST_NAMES) {
    const listing = readManifest(name).capabilities?.public_listing;
    if (!(listing?.listed === true && listing?.status === "proven")) {
      continue;
    }
    const recordsDir = join(FIXTURES_DIR, name, "scrubbed", "pilot-real-shape", "records");
    if (existsSync(recordsDir)) {
      continue;
    }
    if (name in PILOT_FIXTURE_EXEMPT) {
      continue;
    }
    offenders.push(name);
  }
  assert.deepEqual(
    offenders,
    [],
    `listed=proven connectors must commit a pilot-real-shape fixture under fixtures/<c>/scrubbed/pilot-real-shape/records/ or be added to PILOT_FIXTURE_EXEMPT with a documented reason: ${offenders.join(", ")}`
  );
});

test("PILOT_FIXTURE_EXEMPT entries are still listed=proven and still missing their fixture", () => {
  // Exempt entries are temporary admissions of a gap. When the gap closes
  // (the connector ships a fixture or stops being listed=proven), the entry
  // becomes stale and misleading. Fail the build so the removal happens in
  // the same commit that resolves the gap.
  const stale: string[] = [];
  for (const name of Object.keys(PILOT_FIXTURE_EXEMPT).sort()) {
    const listing = readManifest(name).capabilities?.public_listing;
    const stillProven = listing?.listed === true && listing?.status === "proven";
    const recordsDir = join(FIXTURES_DIR, name, "scrubbed", "pilot-real-shape", "records");
    const fixtureNowExists = existsSync(recordsDir);
    if (!stillProven) {
      stale.push(`${name} (no longer listed=proven; remove from exempt list)`);
    } else if (fixtureNowExists) {
      stale.push(`${name} (now ships a pilot fixture; remove from exempt list)`);
    }
  }
  assert.deepEqual(stale, [], `PILOT_FIXTURE_EXEMPT contains stale entries: ${stale.join(", ")}`);
});
