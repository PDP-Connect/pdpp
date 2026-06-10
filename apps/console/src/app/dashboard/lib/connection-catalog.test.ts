/**
 * Unit + consistency tests for the console connector-catalog model.
 *
 * The module is pure TS (no JSX), so it imports directly in node --test. These
 * tests pin the catalog against the committed manifests so the picker can never:
 *   1. silently drop a shipped connector (coverage == manifest count),
 *   2. mark a gated connector one-click-creatable (no enrollmentKey on
 *      browser-bound/API/network/unknown entries),
 *   3. drift from the binding-derived modality the backend intent route uses.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  browserBoundRunbookEntries,
  browserCollectorEntries,
  buildConnectorCatalog,
  type CatalogManifestLike,
  catalogModalityFromManifest,
  deploymentBlockedEntries,
  localCollectorEntries,
  localCollectorUnprovenEntries,
  staticSecretConnectEntries,
  unsupportedNetworkEntries,
} from "./connection-catalog.ts";

async function loadCommittedManifests(): Promise<CatalogManifestLike[]> {
  // This test file lives at apps/console/src/app/dashboard/lib/; the repo root is
  // six segments up (lib → dashboard → app → src → console → apps → root).
  const repoRoot = new URL("../../../../../../", import.meta.url);
  const manifestsDir = new URL("packages/polyfill-connectors/manifests/", repoRoot);
  const files = await readdir(fileURLToPath(manifestsDir));
  const manifests: CatalogManifestLike[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const raw = await readFile(fileURLToPath(new URL(file, manifestsDir)), "utf8");
    const m = JSON.parse(raw) as CatalogManifestLike;
    if (m.connector_id) {
      manifests.push(m);
    }
  }
  return manifests;
}

test("catalogModalityFromManifest mirrors the filesystem>browser>network precedence", () => {
  assert.equal(catalogModalityFromManifest({ connector_id: "x", runtime_requirements: { bindings: {} } }), "unknown");
  assert.equal(
    catalogModalityFromManifest({ connector_id: "x", runtime_requirements: { bindings: { network: {} } } }),
    "api_network"
  );
  assert.equal(
    catalogModalityFromManifest({
      connector_id: "x",
      runtime_requirements: { bindings: { browser: {}, network: {} } },
    }),
    "browser_bound"
  );
  assert.equal(
    catalogModalityFromManifest({
      connector_id: "x",
      runtime_requirements: { bindings: { filesystem: {}, browser: {} } },
    }),
    "local_collector"
  );
  assert.equal(catalogModalityFromManifest({ connector_id: "x" }), "unknown");
});

test("catalog covers every committed manifest exactly once", async () => {
  const manifests = await loadCommittedManifests();
  const catalog = buildConnectorCatalog(manifests);
  assert.equal(catalog.length, manifests.length, "every shipped manifest must appear as a catalog entry");
  const keys = new Set(catalog.map((e) => e.connectorKey));
  assert.equal(keys.size, catalog.length, "catalog keys must be unique");
});

test("catalog is sorted by display name for a stable picker", async () => {
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  const names = catalog.map((e) => e.displayName);
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(names, sorted);
});

test("only proven-creatable dispositions carry an enrollment deep-link key", async () => {
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  for (const entry of catalog) {
    const creatable =
      entry.disposition === "local_collector_enroll" || entry.disposition === "browser_collector_manual";
    if (creatable) {
      assert.ok(entry.enrollmentKey, `${entry.connectorKey} (${entry.disposition}) must carry an enrollmentKey`);
    } else {
      assert.equal(
        entry.enrollmentKey,
        undefined,
        `${entry.connectorKey} (${entry.disposition}) must NOT carry an enrollmentKey`
      );
    }
  }
});

test("no browser-bound or API/network connector is one-click-creatable", async () => {
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  for (const entry of catalog) {
    if (entry.modality === "browser_bound" && entry.disposition !== "browser_collector_manual") {
      assert.equal(entry.disposition, "browser_bound_runbook");
      assert.equal(entry.enrollmentKey, undefined);
    }
    if (entry.modality === "api_network") {
      // A network-class connector is either flatly unsupported OR a static-secret
      // connector with a draft-create path OR a provider-authorization connector
      // blocked/proof-gated by the shared planner. None is one-click-creatable
      // from the console (no enrollment deep-link).
      assert.ok(
        entry.disposition === "api_network_unsupported" ||
          entry.disposition === "static_secret_connect" ||
          entry.disposition === "provider_auth_deployment_blocked" ||
          entry.disposition === "provider_auth_proof_gated",
        `${entry.connectorKey} must be a non-deeplink network disposition, got ${entry.disposition}`
      );
      assert.equal(entry.enrollmentKey, undefined);
    }
  }
});

test("gmail and github are static-secret connect entries, not flatly unsupported", async () => {
  // Gmail/GitHub gained an owner-session static-secret draft-create path. They
  // must route to the static_secret_connect disposition (real path, runbook,
  // live-proof-gated) — never the api_network_unsupported "appears only after
  // first ingest" bucket, which is now false for them. They must NOT deep-link.
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  for (const key of ["gmail", "github"]) {
    const entry = catalog.find((e) => e.connectorKey === key);
    assert.ok(entry, `${key} must be in the catalog`);
    assert.equal(entry.modality, "api_network");
    assert.equal(entry.disposition, "static_secret_connect");
    assert.equal(entry.enrollmentKey, undefined, `${key} must not deep-link into enrollment`);
  }
});

test("other network connectors stay flatly api_network_unsupported", async () => {
  // Only gmail/github are static-secret. The remaining network-class connectors
  // (notion, oura, pocket, spotify, strava, ynab) still have no owner connect
  // route and must stay in the honest api_network_unsupported bucket.
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  const stillUnsupported = catalog.filter(
    (e) => e.modality === "api_network" && e.disposition === "api_network_unsupported"
  );
  assert.ok(stillUnsupported.length >= 1, "expected non-static-secret network connectors to remain unsupported");
  for (const entry of stillUnsupported) {
    assert.equal(entry.connectorKey === "gmail" || entry.connectorKey === "github", false);
  }
});

test("provider-authorization deployment blockers are separate from unsupported network entries", () => {
  const catalog = buildConnectorCatalog([
    {
      connector_id: "fitness_oauth",
      display_name: "Fitness OAuth",
      runtime_requirements: { bindings: { network: { required: true } } },
      capabilities: {
        auth: {
          kind: "oauth",
          deployment_config: ["FITNESS_OAUTH_CLIENT_ID", "FITNESS_OAUTH_CLIENT_SECRET"],
        },
      },
    },
  ]);
  const [entry] = catalog;
  assert.ok(entry, "synthetic provider authorization manifest should produce a catalog entry");
  assert.equal(entry.connectorKey, "fitness_oauth");
  assert.equal(entry.setupModality, "provider_authorization");
  assert.equal(entry.supportState, "needs_deployment_config");
  assert.equal(entry.disposition, "provider_auth_deployment_blocked");
  assert.equal(entry.deploymentReadiness.state, "needs_config");
  assert.deepEqual(
    entry.deploymentReadiness.blockers.map((blocker) => blocker.key),
    ["FITNESS_OAUTH_CLIENT_ID", "FITNESS_OAUTH_CLIENT_SECRET"]
  );
  assert.deepEqual(deploymentBlockedEntries(catalog), [entry]);
  assert.deepEqual(unsupportedNetworkEntries(catalog), []);
  assert.equal(entry.enrollmentKey, undefined);
});

test("claude-code manifest slug maps to the claude_code enrollment key", async () => {
  // The manifest slug is `claude-code` (hyphen); the proven enrollment path and
  // the form's COLLECTOR_RUN_CONNECTORS literal use `claude_code` (underscore).
  // The deep-link key must be the form's value or the prefill is rejected.
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  const claudeCode = catalog.find((e) => e.connectorKey === "claude-code");
  assert.ok(claudeCode, "claude-code must be in the catalog");
  assert.equal(claudeCode.disposition, "local_collector_enroll");
  assert.equal(claudeCode.enrollmentKey, "claude_code");
});

test("amazon is the manual browser-collector entry with a deep-link", async () => {
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  const amazon = catalog.find((e) => e.connectorKey === "amazon");
  assert.ok(amazon, "amazon must be in the catalog");
  assert.equal(amazon.modality, "browser_bound");
  assert.equal(amazon.disposition, "browser_collector_manual");
  assert.equal(amazon.enrollmentKey, "amazon");
});

test("the grouping helpers partition the catalog without overlap or loss", async () => {
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  const groups = [
    localCollectorEntries(catalog),
    localCollectorUnprovenEntries(catalog),
    browserCollectorEntries(catalog),
    browserBoundRunbookEntries(catalog),
    staticSecretConnectEntries(catalog),
    deploymentBlockedEntries(catalog),
    unsupportedNetworkEntries(catalog),
  ];
  const total = groups.reduce((sum, g) => sum + g.length, 0);
  assert.equal(total, catalog.length, "every entry must land in exactly one render group");
  // At least one of each proven path so the picker demonstrably shows both.
  assert.ok(localCollectorEntries(catalog).length >= 2, "claude_code + codex");
  assert.equal(browserCollectorEntries(catalog).length, 1, "amazon only");
  assert.ok(browserBoundRunbookEntries(catalog).length >= 1);
  // Exactly the two static-secret connectors (gmail, github).
  assert.equal(staticSecretConnectEntries(catalog).length, 2, "gmail + github");
  assert.ok(unsupportedNetworkEntries(catalog).length >= 1);
});

test("filesystem connectors outside the proven set are local-collector-unproven, not API/network", async () => {
  // A filesystem-class connector (e.g. slack, apple-health) that is not in the
  // proven enrollment set must not be lumped into the API/network bucket — that
  // would mislabel it as "needs an API connection flow". It belongs in its own
  // honest local-collector-unproven group, named, with no deep-link.
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  const unproven = localCollectorUnprovenEntries(catalog);
  assert.ok(unproven.length >= 1, "expected at least one unproven filesystem connector");
  for (const entry of unproven) {
    assert.equal(entry.modality, "local_collector");
    assert.equal(entry.enrollmentKey, undefined, `${entry.connectorKey} must not deep-link`);
  }
  // And none of them leaked into the API/network bucket.
  const network = unsupportedNetworkEntries(catalog);
  for (const entry of network) {
    assert.notEqual(entry.modality, "local_collector");
  }
});
