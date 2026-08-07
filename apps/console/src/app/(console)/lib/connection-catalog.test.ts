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
  buildOwnerConnectorCatalog,
  type CatalogManifestLike,
  catalogModalityFromManifest,
  deploymentBlockedEntries,
  localCollectorEntries,
  localCollectorUnprovenEntries,
  manualUploadConnectEntries,
  manualUploadPendingEntries,
  type OwnerConnectorTemplateLike,
  providerAuthConnectEntries,
  staticSecretConnectEntries,
  unsupportedNetworkEntries,
} from "./connection-catalog.ts";
import {
  sourceSetupAction,
  sourceSetupAvailability,
  sourceSetupContext,
  sourceSetupGuidance,
  sourceSetupSecondaryAction,
  sourceSetupStatus,
} from "./source-setup-presentation.ts";

const FIRST_PARTY_REGISTRY_PREFIX = "https://registry.pdpp.org/connectors/";
const TRAILING_SLASH_RE = /\/$/;
const SECURE_BROWSER_RE = /secure browser/i;
const SAVE_SIGN_IN_DETAILS_RE = /sign-in details/i;
const DATA_PORTABILITY_SEPARATE_RE = /separate from Google Maps Timeline Import/;
const TIMELINE_API_DISTINCTION_RE = /not exposed by Google's documented Data Portability API/i;
const TIMELINE_NO_SIGN_IN_RE = /no Google account sign-in is used/i;
const GOOGLE_DEPLOYMENT_BLOCKER_RE = /GOOGLE_DATAPORTABILITY_CLIENT_ID/;
const PROVIDER_BROWSER_GUIDANCE_RE = /provider's browser/;
const OWNER_INTENT_URL_RE = /\/v1\/owner\/connections\/intents$/;

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
  const jsonFiles = files.filter((file) => file.endsWith(".json"));
  const parsed = await Promise.all(
    jsonFiles.map(async (file) => {
      const raw = await readFile(fileURLToPath(new URL(file, manifestsDir)), "utf8");
      return JSON.parse(raw) as CatalogManifestLike;
    })
  );
  return parsed.filter((m) => m.connector_id);
}

function ownerTemplate(
  args: {
    actionMethod?: string | null;
    actionStatus?: string;
    actionUrl?: string | null;
    connectorKey?: string;
    connectorModality?: string;
    disposition?: string;
    listingStatus?: string;
    nextStepKind?: string;
    ownerActionable?: boolean;
    proofGate?: string | null;
    setupModality?: string;
    supportState?: string;
  } = {}
): OwnerConnectorTemplateLike {
  const connectorKey = args.connectorKey ?? "test-provider";
  return {
    connector_key: connectorKey,
    connector_modality: args.connectorModality ?? "api_network",
    display_name: connectorKey,
    public_listing: { listed: true, status: args.listingStatus ?? "proven" },
    registration_status: "registered",
    setup_plan: {
      catalog_disposition: args.disposition ?? "provider_auth_connect",
      deployment_readiness: { blockers: [], guidance: null, state: "ready" },
      enrollment_key: null,
      next_step_kind: args.nextStepKind ?? "open_provider_auth",
      owner_actionable: args.ownerActionable ?? true,
      proof_gate: args.proofGate ?? null,
      runbook_path: null,
      setup_modality: args.setupModality ?? "provider_authorization",
      support_state: args.supportState ?? "supported",
    },
    supported_actions: [
      {
        family: "initiate_connection",
        method: args.actionMethod === undefined ? "POST" : args.actionMethod,
        status: args.actionStatus ?? "supported",
        url: args.actionUrl === undefined ? "https://reference.test/v1/owner/connections/intents" : args.actionUrl,
      },
    ],
  };
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

test("unproven browser-bound static-secret entries fail closed", async () => {
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  const heb = catalog.find((entry) => entry.connectorKey === "heb");
  if (!heb) {
    assert.fail("heb must be present in the catalog");
  }
  assert.equal(heb.modality, "browser_bound");
  assert.equal(heb.setupModality, "static_secret");
  assert.equal(heb.disposition, "static_secret_connect");
  assert.equal(heb.enrollmentKey, undefined);
  assert.equal(heb.supportState, "proof_gated");
  assert.equal(heb.proofGate, "static_secret_live_proof_missing");
  assert.equal(sourceSetupStatus(heb).label, "Not available here");
  assert.equal(sourceSetupAction(heb), null);
  assert.equal(sourceSetupSecondaryAction(heb), null);
  assert.doesNotMatch(sourceSetupGuidance(heb), SECURE_BROWSER_RE);
  assert.doesNotMatch(sourceSetupGuidance(heb), SAVE_SIGN_IN_DETAILS_RE);
  assert.deepEqual(browserCollectorEntries(catalog), []);
});

test("browser-bound static-secret capability is not enough to create an account", () => {
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
  assert.equal(sourceSetupAction(entry), null);
  assert.equal(sourceSetupSecondaryAction(entry), null);
  assert.equal(sourceSetupStatus(entry).label, "Not available here");
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
  assert.equal(sourceSetupAction(entry), null);
  assert.equal(sourceSetupAvailability(entry), "requires_server_setup");
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
  assert.equal(sourceSetupAction(entry), null, "provider settings must not link to diagnostics as a setup CTA");
  assert.match(sourceSetupGuidance(entry), GOOGLE_DEPLOYMENT_BLOCKER_RE);
  assert.match(sourceSetupContext(entry) ?? "", DATA_PORTABILITY_SEPARATE_RE);
  assert.ok(entry.externalDocs.length >= 1, "provider-auth manifest documentation should remain available");
  assert.equal(entry.enrollmentKey, undefined);
});

test("Google Maps Timeline keeps its import/API distinction visible in the catalog", async () => {
  const catalog = buildConnectorCatalog(await loadCommittedManifests());
  const entry = catalog.find((candidate) => candidate.connectorKey === "google-maps");
  assert.ok(entry, "google-maps must be in the committed catalog");
  assert.match(sourceSetupContext(entry) ?? "", TIMELINE_API_DISTINCTION_RE);
  assert.match(sourceSetupContext(entry) ?? "", TIMELINE_NO_SIGN_IN_RE);
});

test("configured Google provider readiness exposes the existing owner authorization action", async () => {
  const catalog = buildConnectorCatalog(await loadCommittedManifests(), ["google-maps-data-portability"]);
  const entry = catalog.find((candidate) => candidate.connectorKey === "google-maps-data-portability");
  assert.ok(entry, "google-maps-data-portability must be in the committed catalog");
  assert.equal(entry.deploymentReadiness.state, "ready");
  assert.equal(entry.nextStepKind, "open_provider_auth");
  assert.equal(entry.supportState, "supported");
  assert.equal(entry.disposition, "provider_auth_connect");
  assert.equal(sourceSetupStatus(entry).label, "Authorize account");
  assert.match(sourceSetupGuidance(entry), PROVIDER_BROWSER_GUIDANCE_RE);
  assert.deepEqual(sourceSetupAction(entry), {
    href: "/connect/provider-auth/google-maps-data-portability",
    label: "Authorize account",
  });
  assert.equal(sourceSetupAvailability(entry), "available_now");
  assert.deepEqual(providerAuthConnectEntries(catalog), [entry]);
});

test("owner catalog fails closed for local-only, listed-unproven, and proof-gated static-secret entries", () => {
  const staleLocalManifest: CatalogManifestLike = {
    capabilities: { public_listing: { listed: true, status: "proven" } },
    connector_id: "stale-local-only",
    display_name: "Stale local-only",
    runtime_requirements: { bindings: { network: {} } },
  };
  assert.deepEqual(buildOwnerConnectorCatalog([staleLocalManifest], []), [], "local-only entries are not listed");

  const listedUnproven = buildOwnerConnectorCatalog(
    [],
    [
      ownerTemplate({
        connectorKey: "listed-unproven",
        connectorModality: "local_collector",
        disposition: "local_collector_enroll",
        listingStatus: "unproven",
        nextStepKind: "enroll_local_collector",
        ownerActionable: false,
        setupModality: "local_collector",
        actionMethod: null,
        actionStatus: "unsupported",
        actionUrl: null,
      }),
    ]
  );
  const [listedUnprovenEntry] = listedUnproven;
  assert.ok(listedUnprovenEntry, "server listing status controls visibility");
  assert.equal(listedUnprovenEntry.ownerActionable, false);
  assert.equal(sourceSetupAction(listedUnprovenEntry), null);
  assert.equal(sourceSetupAvailability(listedUnprovenEntry), "not_available_here");

  const proofGatedStaticSecret = buildOwnerConnectorCatalog(
    [],
    [
      ownerTemplate({
        connectorKey: "unproven-static-secret",
        disposition: "static_secret_connect",
        nextStepKind: "capture_static_secret",
        ownerActionable: false,
        proofGate: "static_secret_live_proof_missing",
        setupModality: "static_secret",
        supportState: "proof_gated",
        actionMethod: null,
        actionStatus: "unsupported",
        actionUrl: null,
      }),
    ]
  );
  const [proofGatedEntry] = proofGatedStaticSecret;
  assert.ok(proofGatedEntry, "proof-gated static-secret template should remain visible");
  assert.equal(proofGatedEntry.supportState, "proof_gated");
  assert.equal(sourceSetupStatus(proofGatedEntry).label, "Not available here");
  assert.equal(sourceSetupAction(proofGatedEntry), null);
  assert.equal(sourceSetupAvailability(proofGatedEntry), "not_available_here");
});

test("a supported owner action has an invariant actionable provider projection", () => {
  const catalog = buildOwnerConnectorCatalog(
    [
      {
        connector_id: "test-provider",
        display_name: "Provider display from manifest",
        external_docs: [{ label: "Provider docs", url: "https://example.test/docs" }],
      },
    ],
    [ownerTemplate({ connectorKey: "test-provider", listingStatus: "needs_human_auth" })]
  );
  const [entry] = catalog;
  assert.ok(entry);
  assert.equal(entry.ownerActionable, true);
  assert.equal(entry.disposition, "provider_auth_connect");
  assert.equal(entry.supportState, "supported");
  assert.equal(entry.proofGate, null);
  assert.equal(entry.ownerActionMethod, "POST");
  assert.match(entry.ownerActionUrl ?? "", OWNER_INTENT_URL_RE);
  assert.equal(sourceSetupAvailability(entry), "available_now");
  assert.deepEqual(sourceSetupAction(entry), {
    href: "/connect/provider-auth/test-provider",
    label: "Authorize account",
  });
  assert.deepEqual(entry.externalDocs, [{ label: "Provider docs", url: "https://example.test/docs" }]);
  assert.equal(entry.displayName, "test-provider");
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
    providerAuthConnectEntries(catalog),
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
