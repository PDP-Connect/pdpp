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
  experimentalEntries,
  isOwnerActionableEntry,
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
    enrollmentKey?: string | null;
    listed?: boolean;
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
    public_listing: { listed: args.listed ?? true, status: args.listingStatus ?? "proven" },
    registration_status: "registered",
    setup_plan: {
      catalog_disposition: args.disposition ?? "provider_auth_connect",
      deployment_readiness: { blockers: [], guidance: null, state: "ready" },
      enrollment_key: args.enrollmentKey ?? null,
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

test("YNAB static-secret entry shows as actionable with draft-create path", async () => {
  const manifests = await loadCommittedManifests();
  const catalog = buildConnectorCatalog(manifests);
  const ynab = catalog.find((entry) => entry.connectorKey === "ynab");
  assert.ok(ynab, "ynab must be present in the catalog");
  assert.equal(ynab.modality, "api_network");
  assert.equal(ynab.setupModality, "static_secret");
  assert.equal(ynab.disposition, "static_secret_connect");
  assert.equal(ynab.enrollmentKey, undefined);
  assert.equal(ynab.supportState, "supported");
  assert.equal(ynab.proofGate, null);
  assert.equal(sourceSetupStatus(ynab).label, "Add account");
  assert.equal(sourceSetupAction(ynab)?.href, "/connect/static-secret/ynab");
  assert.equal(sourceSetupSecondaryAction(ynab), null);
  assert.equal(sourceSetupAvailability(ynab), "available_now");
  assert.ok(sourceSetupGuidance(ynab).includes("protected setup form"));
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
          entry.disposition === "static_secret_experimental" ||
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

test("static-secret manifests are connect or experimental entries, never flatly unsupported", async () => {
  // Static-secret connectors declare their setup form in the connector manifest.
  // The catalog must route every such manifest to static_secret_connect (live
  // proven) or static_secret_experimental (real form, unproven) — never an
  // unsupported or enrollment bucket — without naming the current providers in
  // Console code. Runtime modality can still be filesystem for hybrid
  // connectors such as Slack; setup is the owner credential-capture path, not
  // local-device enrollment.
  const manifests = await loadCommittedManifests();
  const staticSecretKeys = staticSecretManifestKeys(manifests);
  assert.ok(staticSecretKeys.length >= 1, "expected at least one committed static-secret manifest");
  const catalog = buildConnectorCatalog(manifests);
  for (const key of staticSecretKeys) {
    const entry = catalog.find((e) => e.connectorKey === key);
    assert.ok(entry, `${key} must be in the catalog`);
    assert.ok(
      entry.disposition === "static_secret_connect" || entry.disposition === "static_secret_experimental",
      `${key}: expected static_secret_connect or static_secret_experimental, got ${entry.disposition}`
    );
    assert.equal(entry.enrollmentKey, undefined, `${key} must not deep-link into enrollment`);
  }
});

test("wave-0807 static-secret connectors (Steam, Jellyfin, Apple Contacts) are experimental, not calm-list supported", async () => {
  // Direct regression guard: these three ship with a real credential_capture
  // block but no live proof run yet. They must appear as experimental — never
  // silently promoted to the same "supported" bucket as gmail/github/slack/ynab,
  // and never demoted to "not available here" hiding a working form.
  const manifests = await loadCommittedManifests();
  const catalog = buildConnectorCatalog(manifests);
  for (const key of ["steam", "jellyfin", "apple_contacts"]) {
    const entry = catalog.find((e) => e.connectorKey === key);
    assert.ok(entry, `${key} must be in the catalog`);
    assert.equal(entry.disposition, "static_secret_experimental", `${key}: disposition`);
    assert.equal(entry.supportState, "experimental", `${key}: supportState`);
    assert.notEqual(entry.supportState, "supported", `${key}: must not read as a normal supported source`);
    assert.equal(sourceSetupAvailability(entry), "experimental_opt_in", `${key}: sourceSetupAvailability`);
    assert.notEqual(
      sourceSetupAvailability(entry),
      "available_now",
      `${key}: must not appear in the calm "available now" list`
    );
    const action = sourceSetupAction(entry);
    assert.ok(action, `${key}: experimental entry must still have a real opt-in action`);
    assert.equal(action.href, `/connect/static-secret/${key}`, `${key}: reuses the existing generic capture route`);
  }
});

test("requested-connector reachability: Steam/Jellyfin/Apple Contacts/GroupMe never render actionless or unavailable", async () => {
  // Discrimination guard for the static-secret injection-registry fix: these
  // four connectors declare a real static_secret setup and are present in
  // STATIC_SECRET_CONNECTOR_REGISTRY (packages/polyfill-connectors/src/
  // static-secret-injection.ts). If either the manifest or the registry drift,
  // Add Source must not silently strand them with no route or a "not
  // available" verdict.
  const manifests = await loadCommittedManifests();
  const catalog = buildConnectorCatalog(manifests);
  const { STATIC_SECRET_CONNECTOR_REGISTRY } = await import(
    "../../../../../../packages/polyfill-connectors/src/static-secret-injection.ts"
  );
  for (const key of ["steam", "jellyfin", "apple_contacts", "groupme"]) {
    const entry = catalog.find((e) => e.connectorKey === key);
    assert.ok(entry, `${key} must be in the catalog`);
    assert.ok(
      Object.hasOwn(STATIC_SECRET_CONNECTOR_REGISTRY, key),
      `${key} must be present in STATIC_SECRET_CONNECTOR_REGISTRY for credential injection to work`
    );
    assert.notEqual(sourceSetupAvailability(entry), "not_available_here", `${key}: must not render as unavailable`);
    const action = sourceSetupAction(entry);
    assert.ok(action, `${key}: must have a real, non-null setup action`);
    assert.ok(action.href.length > 0, `${key}: setup action must target a real route`);
  }
  // GroupMe is the pre-existing regression control. In this synthetic
  // (no-owner-proof-state) catalog build it lands in the same experimental
  // bucket as steam/jellyfin/apple_contacts; the live owner catalog is what
  // ultimately decides "proven" vs "experimental" from real proof state. The
  // guard here is narrower: GroupMe must never regress to unreachable.
  const groupme = catalog.find((e) => e.connectorKey === "groupme");
  assert.ok(groupme);
  assert.ok(
    groupme.disposition === "static_secret_connect" || groupme.disposition === "static_secret_experimental",
    `groupme: expected an actionable static-secret disposition, got '${groupme.disposition}'`
  );
});

test("requested-connector reachability: Google Takeout is bundled into @pdpp/local-collector, not manual-upload or unproven", async () => {
  // Google Takeout Photos reads an already-extracted GOOGLE_TAKEOUT_DIR on the
  // local filesystem — exactly the local-collector shape (runs on the machine
  // that has the extracted archive), not a browser-upload connector. It is
  // bundled into @pdpp/local-collector's SUPPORTED_LOCAL_COLLECTOR_CONNECTORS,
  // so it must classify as the proven, actionable local-collector disposition.
  const manifests = await loadCommittedManifests();
  const catalog = buildConnectorCatalog(manifests);
  const entry = catalog.find((e) => e.connectorKey === "google-takeout");
  assert.ok(entry, "google-takeout must be in the catalog");
  assert.equal(entry.setupModality, "local_collector");
  assert.equal(entry.disposition, "local_collector_enroll");
  assert.notEqual(entry.disposition, "local_collector_unproven");
});

test("requested-connector reachability: Google Calendar/Contacts show honest non-dead-end guidance, no rejecting CTA", async () => {
  const manifests = await loadCommittedManifests();
  for (const key of ["google-calendar", "google-contacts"]) {
    const manifest = manifests.find((m) => m.connector_id.endsWith(`/${key}`) || m.connector_key === key);
    assert.ok(manifest, `${key} manifest must be committed`);
    for (const configured of [[], [key]]) {
      const catalog = buildConnectorCatalog(manifests, configured);
      const entry = catalog.find((e) => e.connectorKey === key);
      assert.ok(entry, `${key} must be in the catalog`);
      assert.ok(
        entry.disposition === "provider_auth_deployment_blocked" || entry.disposition === "provider_auth_proof_gated",
        `${key}: expected a provider-auth gated disposition, got '${entry.disposition}'`
      );
      // No CTA yet — a real shared Google owner-account adapter now exists
      // and is route-tested (reference-implementation/test/google-owner-account-provider-auth.test.ts,
      // google-provider-auth-composite-dispatch.test.ts), but google-calendar/
      // google-contacts are deliberately NOT in
      // PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS yet — promotion to a
      // live CTA is a separate commit once proven against a real account, per
      // repo convention (STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS's precedent).
      assert.equal(
        sourceSetupAction(entry),
        null,
        `${key}: must not offer a CTA before the adapter is promoted to live-proven`
      );
      const guidance = sourceSetupGuidance(entry);
      assert.notEqual(guidance, "This dashboard cannot add this source yet.", `${key}: must not be silently generic`);
      assert.ok(guidance.length > 0, `${key}: guidance must be non-empty`);
      if (entry.disposition === "provider_auth_proof_gated") {
        // Copy must be accurate: the flow is code-complete/tested, not "not
        // shipped" — and must not claim a live account was tested.
        assert.match(guidance, /live validation/i);
        assert.doesNotMatch(guidance, /does not yet ship/i);
      }
    }
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

test("owner catalog exposes browser owner-session actions without inventing an owner-agent REST action", () => {
  const catalog = buildOwnerConnectorCatalog(
    [],
    [
      ownerTemplate({
        connectorKey: "chatgpt",
        connectorModality: "browser_bound",
        disposition: "static_secret_connect",
        nextStepKind: "capture_static_secret",
        ownerActionable: true,
        proofGate: "static_secret_live_proof_missing",
        setupModality: "static_secret",
        supportState: "proof_gated",
        actionMethod: null,
        actionStatus: "owner_mediated",
        actionUrl: null,
      }),
      ownerTemplate({
        connectorKey: "chase",
        connectorModality: "browser_bound",
        disposition: "browser_collector_manual",
        enrollmentKey: "chase",
        nextStepKind: "enroll_browser_collector",
        ownerActionable: true,
        proofGate: "browser_collector_live_proof_missing",
        setupModality: "browser_bound",
        supportState: "proof_gated",
        actionMethod: null,
        actionStatus: "owner_mediated",
        actionUrl: null,
      }),
      ownerTemplate({
        connectorKey: "doordash",
        connectorModality: "browser_bound",
        disposition: "browser_bound_runbook",
        nextStepKind: "manual_runbook",
        ownerActionable: false,
        proofGate: "browser_collector_live_proof_missing",
        setupModality: "browser_bound",
        supportState: "proof_gated",
        actionMethod: null,
        actionStatus: "unsupported",
        actionUrl: null,
      }),
    ]
  );

  const chatgpt = catalog.find((entry) => entry.connectorKey === "chatgpt");
  assert.ok(chatgpt);
  assert.equal(chatgpt.ownerActionable, true);
  assert.equal(chatgpt.ownerActionMethod, null);
  assert.equal(chatgpt.ownerActionUrl, null);
  assert.equal(sourceSetupAvailability(chatgpt), "available_now");
  assert.deepEqual(sourceSetupAction(chatgpt), {
    href: "/connect/browser-session/chatgpt",
    label: "Connect account",
  });

  const chase = catalog.find((entry) => entry.connectorKey === "chase");
  assert.ok(chase);
  assert.equal(chase.ownerActionable, true);
  assert.equal(sourceSetupAvailability(chase), "available_now");
  assert.deepEqual(sourceSetupAction(chase), {
    href: "/connect/browser-session/chase",
    label: "Connect account",
  });

  const doordash = catalog.find((entry) => entry.connectorKey === "doordash");
  assert.ok(doordash);
  assert.equal(doordash.ownerActionable, false);
  assert.equal(sourceSetupAvailability(doordash), "not_available_here");
  assert.equal(sourceSetupAction(doordash), null);
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
    experimentalEntries(catalog),
    manualUploadConnectEntries(catalog),
    manualUploadPendingEntries(catalog),
    deploymentBlockedEntries(catalog),
    providerAuthConnectEntries(catalog),
    unsupportedNetworkEntries(catalog),
  ];
  const total = groups.reduce((sum, g) => sum + g.length, 0);
  assert.equal(total, catalog.length, "every entry must land in exactly one render group");
  // At least one of each supported path class that still has committed entries.
  assert.ok(
    localCollectorEntries(catalog).length >= 6,
    "claude_code + codex + google_takeout + imessage + apple_photos + google_messages"
  );
  assert.equal(browserCollectorEntries(catalog).length, 0, "heb now routes through browser-bound static-secret setup");
  assert.ok(browserBoundRunbookEntries(catalog).length >= 1);
  assert.ok(experimentalEntries(catalog).length >= 1, "wave-0807 experimental static-secret connectors");
  assert.equal(
    staticSecretConnectEntries(catalog).length + experimentalEntries(catalog).length,
    staticSecretManifestKeys(await loadCommittedManifests()).length,
    "every manifest-authored static-secret connector is either live-proven or experimental"
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

test("owner catalog admits an unlisted (listed:false) template only when support_state is experimental", () => {
  // Regression guard for the Steam UAT gap: Steam ships public_listing.listed
  // false today, but its static-secret credential-capture form is real. The
  // Experimental section is itself the explicit opt-in, so an unlisted
  // experimental template must still surface there — while an unlisted
  // template with any OTHER support_state must stay dropped exactly as
  // before, so the normal picker never gains a silent extra source.
  const catalog = buildOwnerConnectorCatalog(
    [],
    [
      ownerTemplate({
        connectorKey: "steam",
        disposition: "static_secret_experimental",
        listed: false,
        nextStepKind: "capture_static_secret",
        ownerActionable: false,
        setupModality: "static_secret",
        supportState: "experimental",
        actionMethod: null,
        actionStatus: "experimental",
        actionUrl: null,
      }),
      ownerTemplate({
        connectorKey: "unlisted-proof-gated",
        disposition: "static_secret_connect",
        listed: false,
        nextStepKind: "capture_static_secret",
        ownerActionable: false,
        setupModality: "static_secret",
        supportState: "proof_gated",
        actionMethod: null,
        actionStatus: "unsupported",
        actionUrl: null,
      }),
    ]
  );
  const steam = catalog.find((e) => e.connectorKey === "steam");
  assert.ok(steam, "an unlisted experimental template must still be admitted into the catalog");
  assert.equal(steam.supportState, "experimental");
  assert.equal(sourceSetupAvailability(steam), "experimental_opt_in");
  const unlistedProofGated = catalog.find((e) => e.connectorKey === "unlisted-proof-gated");
  assert.equal(unlistedProofGated, undefined, "an unlisted non-experimental template must stay dropped");
});

test("ownerActionable field is the sole authority for live owner catalogs", () => {
  // Live owner catalogs always compute ownerActionable once in
  // buildOwnerConnectorCatalog and store it. isOwnerActionableEntry must
  // trust that field, not re-derive it.
  const catalog = buildOwnerConnectorCatalog(
    [],
    [
      ownerTemplate({
        connectorKey: "actionable-api",
        disposition: "provider_auth_connect",
        ownerActionable: true,
      }),
      ownerTemplate({
        connectorKey: "blocked-api",
        disposition: "provider_auth_connect",
        ownerActionable: false,
      }),
      ownerTemplate({
        connectorKey: "actionable-static-secret",
        connectorModality: "browser_bound",
        disposition: "static_secret_connect",
        setupModality: "static_secret",
        nextStepKind: "capture_static_secret",
        ownerActionable: true,
        actionMethod: null,
        actionStatus: "owner_mediated",
        actionUrl: null,
      }),
      ownerTemplate({
        connectorKey: "blocked-static-secret",
        connectorModality: "browser_bound",
        disposition: "static_secret_connect",
        setupModality: "static_secret",
        nextStepKind: "capture_static_secret",
        ownerActionable: false,
        actionMethod: null,
        actionStatus: "unsupported",
        actionUrl: null,
      }),
    ]
  );

  for (const entry of catalog) {
    const actionable = isOwnerActionableEntry(entry);
    assert.equal(
      actionable,
      entry.ownerActionable,
      `isOwnerActionableEntry(${entry.connectorKey}) must return the ownerActionable field: ${entry.ownerActionable}`
    );
  }
});

test("isOwnerActionableEntry respects demo/test fallback rules when ownerActionable is undefined", async () => {
  // Pure manifest catalogs (buildConnectorCatalog) have no ownerActionable field.
  // isOwnerActionableEntry must apply fallback rules for testing. YNAB is proven
  // to be supported (not proof-gated), so it serves as a good fallback test.
  const manifests = await loadCommittedManifests();
  const catalog = buildConnectorCatalog(manifests);

  const ynab = catalog.find((e) => e.connectorKey === "ynab");
  assert.ok(ynab);
  assert.equal(ynab.ownerActionable, undefined);
  assert.equal(ynab.setupModality, "static_secret");
  assert.equal(ynab.supportState, "supported");
  assert.equal(ynab.proofGate, null);
  // Fallback rule: static_secret dispositions are actionable if supported and not proof-gated
  assert.equal(isOwnerActionableEntry(ynab), true);
});

test("presentation consistency: helper functions agree with ownerActionable authority", async () => {
  // Every fixture in the presentation test suite must have presentation functions
  // that agree with isOwnerActionableEntry. This is the core maintainability check.
  //
  // Exception: an experimental entry (supportState === "experimental") always
  // has a real action (the same generic capture form a proven connector uses)
  // even though isOwnerActionableEntry is deliberately false for it — that
  // false is what keeps it out of the calm "available now" list and every
  // owner-agent REST/actionability surface; the explicit Experimental opt-in
  // section is the only place its action renders.
  const manifests = await loadCommittedManifests();
  const catalog = buildConnectorCatalog(manifests);

  for (const entry of catalog) {
    const isActionable = isOwnerActionableEntry(entry);
    const hasAction = sourceSetupAction(entry) !== null;

    if (entry.supportState === "experimental") {
      assert.equal(isActionable, false, `${entry.connectorKey}: experimental must not be owner-actionable`);
      assert.equal(hasAction, true, `${entry.connectorKey}: experimental must still expose its opt-in action`);
      continue;
    }

    // The invariant: if isOwnerActionableEntry returns true, sourceSetupAction
    // must have a non-null result. Mutations to either would break this.
    assert.equal(
      hasAction,
      isActionable,
      `${entry.connectorKey}: sourceSetupAction must match isOwnerActionableEntry. ` +
        `Helper says ${isActionable}, action is ${hasAction ? "set" : "null"}`
    );
  }
});

test("owner catalog: presentation consistency between actionability and availability", () => {
  // For owner catalogs, ownerActionable gates both sourceSetupAvailability and
  // sourceSetupAction. They must converge.
  const catalog = buildOwnerConnectorCatalog(
    [],
    [
      ownerTemplate({
        connectorKey: "available",
        disposition: "provider_auth_connect",
        ownerActionable: true,
      }),
      ownerTemplate({
        connectorKey: "not-available",
        disposition: "provider_auth_proof_gated",
        ownerActionable: false,
        proofGate: "missing_proof",
      }),
      ownerTemplate({
        connectorKey: "deployment-blocked",
        disposition: "provider_auth_deployment_blocked",
        ownerActionable: false,
      }),
    ]
  );

  const available = catalog.find((e) => e.connectorKey === "available");
  assert.ok(available);
  assert.equal(isOwnerActionableEntry(available), true);
  assert.equal(sourceSetupAction(available) !== null, true);
  assert.equal(sourceSetupAvailability(available), "available_now");

  const notAvailable = catalog.find((e) => e.connectorKey === "not-available");
  assert.ok(notAvailable);
  assert.equal(isOwnerActionableEntry(notAvailable), false);
  assert.equal(sourceSetupAction(notAvailable), null);
  assert.equal(sourceSetupAvailability(notAvailable), "not_available_here");

  const deploymentBlocked = catalog.find((e) => e.connectorKey === "deployment-blocked");
  assert.ok(deploymentBlocked);
  assert.equal(isOwnerActionableEntry(deploymentBlocked), false);
  assert.equal(sourceSetupAction(deploymentBlocked), null);
  // Special case: deployment_blocked gets "requires_server_setup", not "not_available_here"
  assert.equal(sourceSetupAvailability(deploymentBlocked), "requires_server_setup");
});
