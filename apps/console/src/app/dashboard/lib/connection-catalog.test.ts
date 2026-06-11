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
  manualUploadConnectEntries,
  manualUploadPendingEntries,
  staticSecretConnectEntries,
  unsupportedNetworkEntries,
} from "./connection-catalog.ts";

const FIRST_PARTY_REGISTRY_PREFIX = "https://registry.pdpp.org/connectors/";
const TRAILING_SLASH_RE = /\/$/;

function canonicalKeyFromManifestId(connectorId: string): string {
  if (connectorId.startsWith(FIRST_PARTY_REGISTRY_PREFIX)) {
    return connectorId.slice(FIRST_PARTY_REGISTRY_PREFIX.length).replace(TRAILING_SLASH_RE, "");
  }
  return connectorId;
}

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
      // A network-class connector is either flatly unsupported OR a
      // manifest-authored static-secret connector with a draft-create path OR a
      // provider-authorization connector blocked/proof-gated by the shared
      // planner. None is one-click-creatable from the console (no enrollment
      // deep-link).
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

function staticSecretManifestKeys(manifests: readonly CatalogManifestLike[]): string[] {
  return manifests
    .filter((manifest) => {
      const setup = manifest.setup as ({ credential_capture?: unknown } | null | undefined);
      return typeof setup?.credential_capture === "object" && setup.credential_capture !== null;
    })
    .map((manifest) => manifest.connector_key ?? manifest.connector_id)
    .filter((key): key is string => typeof key === "string" && key.length > 0)
    .map(canonicalKeyFromManifestId);
}

function manualUploadManifest(connectorId: string): CatalogManifestLike {
  return {
    connector_id: connectorId,
    display_name: connectorId,
    runtime_requirements: { bindings: { filesystem: { required: true } } },
    setup: { modality: "manual_or_upload" },
  };
}

function manualUploadConnectManifest(connectorId: string): CatalogManifestLike {
  return {
    ...manualUploadManifest(connectorId),
    setup: {
      modality: "manual_or_upload",
      manual_or_upload: {
        accepted_file_names: ["Timeline.json"],
        import_dir_env_var: "GOOGLE_MAPS_TIMELINE_DIR",
        label: "Timeline export",
      },
    },
  };
}

test("static-secret manifests are connect entries, not flatly unsupported", async () => {
  // Static-secret connectors declare their setup form in the connector manifest.
  // The catalog must route every such manifest to the static_secret_connect
  // disposition — never the api_network_unsupported bucket — without naming the
  // current providers in Console code.
  const manifests = await loadCommittedManifests();
  const staticSecretKeys = staticSecretManifestKeys(manifests);
  assert.ok(staticSecretKeys.length >= 1, "expected at least one committed static-secret manifest");
  const catalog = buildConnectorCatalog(manifests);
  for (const key of staticSecretKeys) {
    const entry = catalog.find((e) => e.connectorKey === key);
    assert.ok(entry, `${key} must be in the catalog`);
    assert.equal(entry.modality, "api_network");
    assert.equal(entry.disposition, "static_secret_connect");
    assert.equal(entry.enrollmentKey, undefined, `${key} must not deep-link into enrollment`);
  }
});

test("manual/upload manifests are import-pending entries, not unproven local collectors", () => {
  const catalog = buildConnectorCatalog([manualUploadManifest("google-maps")]);
  const [entry] = catalog;
  assert.ok(entry, "synthetic manual/upload manifest should produce a catalog entry");
  assert.equal(entry.connectorKey, "google-maps");
  assert.equal(entry.modality, "local_collector");
  assert.equal(entry.setupModality, "manual_or_upload");
  assert.equal(entry.supportState, "proof_gated");
  assert.equal(entry.disposition, "manual_upload_pending");
  assert.equal(entry.nextStepKind, "provide_import_file");
  assert.equal(entry.proofGate, "manual_upload_capture_missing");
  assert.equal(entry.enrollmentKey, undefined);
  assert.deepEqual(manualUploadPendingEntries(catalog), [entry]);
  assert.deepEqual(localCollectorUnprovenEntries(catalog), []);
});

test("manual/upload manifests with import env bindings are self-service import entries", () => {
  const catalog = buildConnectorCatalog([manualUploadConnectManifest("google-maps")]);
  const [entry] = catalog;
  assert.ok(entry, "synthetic manual/upload manifest should produce a catalog entry");
  assert.equal(entry.connectorKey, "google-maps");
  assert.equal(entry.modality, "local_collector");
  assert.equal(entry.setupModality, "manual_or_upload");
  assert.equal(entry.supportState, "supported");
  assert.equal(entry.disposition, "manual_upload_connect");
  assert.equal(entry.nextStepKind, "provide_import_file");
  assert.equal(entry.proofGate, null);
  assert.equal(entry.enrollmentKey, undefined);
  assert.deepEqual(manualUploadConnectEntries(catalog), [entry]);
  assert.deepEqual(manualUploadPendingEntries(catalog), []);
  assert.deepEqual(localCollectorUnprovenEntries(catalog), []);
});

test("other network connectors stay flatly api_network_unsupported", async () => {
  // Network-class connectors without static-secret or provider-auth setup
  // metadata still have no owner connect route and must stay in the honest
  // api_network_unsupported bucket.
  const manifests = await loadCommittedManifests();
  const staticSecretKeys = new Set(staticSecretManifestKeys(manifests));
  const catalog = buildConnectorCatalog(manifests);
  const stillUnsupported = catalog.filter(
    (e) => e.modality === "api_network" && e.disposition === "api_network_unsupported"
  );
  assert.ok(stillUnsupported.length >= 1, "expected non-static-secret network connectors to remain unsupported");
  for (const entry of stillUnsupported) {
    assert.equal(staticSecretKeys.has(entry.connectorKey), false);
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
    manualUploadConnectEntries(catalog),
    manualUploadPendingEntries(catalog),
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
  assert.ok(manualUploadConnectEntries(catalog).length >= 1, "file/import connectors");
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
