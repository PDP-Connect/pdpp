// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
import {
  sourceSetupAction,
  sourceSetupGuidance,
  sourceSetupSecondaryAction,
  sourceSetupStatus,
} from "./source-setup-presentation.ts";

const FIRST_PARTY_REGISTRY_PREFIX = "https://registry.pdpp.org/connectors/";
const TRAILING_SLASH_RE = /\/$/;
const SECURE_BROWSER_SESSION_RE = /secure browser session/i;
const SAVE_SIGN_IN_DETAILS_RE = /save sign-in details/i;

function canonicalKeyFromManifestId(connectorId: string): string {
  if (connectorId.startsWith(FIRST_PARTY_REGISTRY_PREFIX)) {
    return connectorId.slice(FIRST_PARTY_REGISTRY_PREFIX.length).replace(TRAILING_SLASH_RE, "");
  }
  return connectorId;
}

async function loadCommittedManifests(): Promise<CatalogManifestLike[]> {
  // This test file lives at apps/console/src/app/(console)/lib/; the repo root is
  // six segments up (lib → dashboard → app → src → console → apps → root).
  const repoRoot = new URL("../../../../../../", import.meta.url);
  const manifestsDir = new URL("packages/polyfill-connectors/manifests/", repoRoot);
  const files = await readdir(fileURLToPath(manifestsDir));
  const manifests = await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        const raw = await readFile(fileURLToPath(new URL(file, manifestsDir)), "utf8");
        const m = JSON.parse(raw) as CatalogManifestLike;
        return m.connector_id ? m : null;
      })
  );
  return manifests.filter((manifest): manifest is CatalogManifestLike => manifest !== null);
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
      runtime_requirements: { bindings: { browser: {}, filesystem: {} } },
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

test("heb is cataloged as a browser-bound static-secret-capable source with both setup choices", async () => {
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  const heb = catalog.find((entry) => entry.connectorKey === "heb");
  if (!heb) {
    assert.fail("heb must be present in the catalog");
  }
  assert.equal(heb.modality, "browser_bound");
  assert.equal(heb.setupModality, "static_secret");
  assert.equal(heb.disposition, "static_secret_connect");
  assert.equal(heb.enrollmentKey, undefined);
  assert.equal(sourceSetupStatus(heb).label, "Connect account");
  assert.equal(sourceSetupAction(heb)?.href, "/connect/browser-session/heb");
  assert.equal(sourceSetupAction(heb)?.label, "Connect account");
  assert.equal(sourceSetupSecondaryAction(heb)?.href, "/connect/static-secret/heb");
  assert.equal(sourceSetupSecondaryAction(heb)?.label, "Save sign-in details");
  assert.match(sourceSetupGuidance(heb), SECURE_BROWSER_SESSION_RE);
  assert.match(sourceSetupGuidance(heb), SAVE_SIGN_IN_DETAILS_RE);
  assert.deepEqual(browserCollectorEntries(catalog), []);
});

test("browser-bound static-secret-capable connectors get the same dual choice generically", () => {
  const catalog = buildConnectorCatalog([
    {
      connector_id: "https://registry.pdpp.org/connectors/browser-sample",
      display_name: "Browser Sample",
      runtime_requirements: { bindings: { browser: { required: true } } },
      setup: {
        credential_capture: {
          fields: [{ label: "Provider secret", name: "secret", required: true, secret: true }],
          kind: "username_password",
          label: "Browser sign-in",
        },
        modality: "static_secret",
      },
    } as CatalogManifestLike,
  ]);
  const [entry] = catalog;
  assert.ok(entry, "synthetic browser-bound static-secret connector should produce a catalog entry");
  assert.equal(entry.modality, "browser_bound");
  assert.equal(entry.setupModality, "static_secret");
  assert.equal(entry.disposition, "static_secret_connect");
  assert.equal(sourceSetupAction(entry)?.href, "/connect/browser-session/browser-sample");
  assert.equal(sourceSetupSecondaryAction(entry)?.href, "/connect/static-secret/browser-sample");
  assert.equal(sourceSetupStatus(entry).label, "Connect account");
});

test("non-browser static-secret connectors keep the existing single capture path", () => {
  const catalog = buildConnectorCatalog([
    {
      connector_id: "https://registry.pdpp.org/connectors/gmail",
      display_name: "Gmail",
      runtime_requirements: { bindings: { network: { required: true } } },
      setup: {
        credential_capture: {
          fields: [{ label: "Provider secret", name: "secret", required: true, secret: true }],
          kind: "app_password",
          label: "Gmail app password",
        },
        modality: "static_secret",
      },
    } as CatalogManifestLike,
  ]);
  const [entry] = catalog;
  assert.ok(entry, "synthetic static-secret connector should produce a catalog entry");
  assert.equal(entry.modality, "api_network");
  assert.equal(entry.setupModality, "static_secret");
  assert.equal(entry.disposition, "static_secret_connect");
  assert.equal(sourceSetupAction(entry)?.href, "/connect/static-secret/gmail");
  assert.equal(sourceSetupSecondaryAction(entry), null);
  assert.equal(sourceSetupStatus(entry).label, "Add account");
});

test("no browser-bound or API/network connector is one-click-creatable", async () => {
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  for (const entry of catalog) {
    if (entry.modality === "browser_bound" && entry.disposition !== "browser_collector_manual") {
      assert.ok(
        entry.disposition === "browser_bound_runbook" || entry.disposition === "static_secret_connect",
        `${entry.connectorKey} must be browser runbook or source-scoped credential capture, got ${entry.disposition}`
      );
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
      const setup = manifest.setup as { credential_capture?: unknown } | null | undefined;
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
      manual_or_upload: {
        accepted_file_names: ["Timeline.json"],
        acquisition_methods: [
          {
            detail: "Use the phone export and upload the JSON file.",
            help_url: "https://example.com/timeline",
            label: "Export from phone",
            platform: "mobile",
            posture: "primary",
          },
          {
            detail: "Use a server-side import folder for large files.",
            label: "Import-folder handoff",
            platform: "server",
            posture: "advanced",
          },
        ],
        import_dir_env_var: "GOOGLE_MAPS_TIMELINE_DIR",
        label: "Timeline export",
      },
      modality: "manual_or_upload",
    },
  };
}

test("static-secret manifests are connect entries, not flatly unsupported", async () => {
  // Static-secret connectors declare their setup form in the connector manifest.
  // The catalog must route every such manifest to the static_secret_connect
  // disposition — never an unsupported or enrollment bucket — without naming the
  // current providers in Console code. Runtime modality can still be filesystem
  // for hybrid connectors such as Slack; setup is the owner credential-capture
  // path, not local-device enrollment.
  const manifests = await loadCommittedManifests();
  const staticSecretKeys = staticSecretManifestKeys(manifests);
  assert.ok(staticSecretKeys.length >= 1, "expected at least one committed static-secret manifest");
  const catalog = buildConnectorCatalog(manifests);
  for (const key of staticSecretKeys) {
    const entry = catalog.find((e) => e.connectorKey === key);
    assert.ok(entry, `${key} must be in the catalog`);
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
  assert.deepEqual(entry.acquisitionPaths, [
    {
      detail: "Use the phone export and upload the JSON file.",
      helpUrl: "https://example.com/timeline",
      label: "Export from phone",
      platform: "mobile",
      posture: "primary",
    },
    {
      detail: "Use a server-side import folder for large files.",
      helpUrl: null,
      label: "Import-folder handoff",
      platform: "server",
      posture: "advanced",
    },
  ]);
  assert.deepEqual(manualUploadConnectEntries(catalog), [entry]);
  assert.deepEqual(manualUploadPendingEntries(catalog), []);
  assert.deepEqual(localCollectorUnprovenEntries(catalog), []);
});

test("committed owner-artifact sources expose manifest-authored acquisition paths", async () => {
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  const googleTimeline = catalog.find((e) => e.connectorKey === "google-maps");
  const whatsapp = catalog.find((e) => e.connectorKey === "whatsapp");
  assert.ok(googleTimeline, "Google Timeline import must be in the catalog");
  assert.ok(whatsapp, "WhatsApp chat export must be in the catalog");
  assert.ok(
    googleTimeline.acquisitionPaths.some((path) => path.label === "Export from Android" && path.posture === "primary"),
    "Google Timeline must expose phone export as a primary acquisition path"
  );
  assert.ok(
    whatsapp.acquisitionPaths.some(
      (path) => path.label === "Export one chat from WhatsApp" && path.posture === "primary"
    ),
    "WhatsApp must expose per-chat export as a primary acquisition path"
  );
  assert.ok(
    whatsapp.acquisitionPaths.some((path) => path.label === "Media folder sync" && path.posture === "advanced"),
    "WhatsApp must keep media sync visible as a distinct advanced path"
  );
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
      capabilities: {
        auth: {
          deployment_config: ["FITNESS_OAUTH_CLIENT_ID", "FITNESS_OAUTH_CLIENT_SECRET"],
          kind: "oauth",
        },
      },
      connector_id: "fitness_oauth",
      display_name: "Fitness OAuth",
      runtime_requirements: { bindings: { network: { required: true } } },
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

test("Google Maps Data Portability is the API-backed provider-auth source, not Timeline import", async () => {
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  const entry = catalog.find((candidate) => candidate.connectorKey === "google-maps-data-portability");
  assert.ok(entry, "google-maps-data-portability must be in the committed catalog");
  assert.equal(entry.displayName, "Google Maps Data Portability");
  assert.equal(entry.modality, "api_network");
  assert.equal(entry.setupModality, "provider_authorization");
  assert.equal(entry.supportState, "needs_deployment_config");
  assert.equal(entry.disposition, "provider_auth_deployment_blocked");
  assert.equal(entry.nextStepKind, "needs_deployment_config");
  assert.equal(entry.proofGate, "provider_app_deployment_config_missing");
  assert.deepEqual(
    entry.deploymentReadiness.blockers.map((blocker) => blocker.key),
    ["GOOGLE_DATAPORTABILITY_CLIENT_ID", "GOOGLE_DATAPORTABILITY_CLIENT_SECRET", "GOOGLE_DATAPORTABILITY_REDIRECT_URI"]
  );
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

test("amazon defaults to source-scoped credential capture, not manual browser enrollment", async () => {
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  const amazon = catalog.find((e) => e.connectorKey === "amazon");
  assert.ok(amazon, "amazon must be in the catalog");
  assert.equal(amazon.modality, "browser_bound");
  assert.equal(amazon.disposition, "static_secret_connect");
  assert.equal(amazon.enrollmentKey, undefined);
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
  // At least one of each supported path class that still has committed entries.
  assert.ok(localCollectorEntries(catalog).length >= 2, "claude_code + codex");
  assert.equal(browserCollectorEntries(catalog).length, 0, "heb now routes through browser-bound static-secret setup");
  assert.ok(browserBoundRunbookEntries(catalog).length >= 1);
  assert.equal(
    staticSecretConnectEntries(catalog).length,
    staticSecretManifestKeys(await loadCommittedManifests()).length,
    "every manifest-authored static-secret connector"
  );
  assert.ok(manualUploadConnectEntries(catalog).length >= 1, "file/import connectors");
  assert.ok(deploymentBlockedEntries(catalog).length >= 1, "provider-auth API connectors");
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
