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
  isRunnableAddOffer,
  publicTierLabel,
  sourceSetupAction,
  sourceSetupAvailability,
  sourceSetupContext,
  sourceSetupGuidance,
  sourceSetupSecondaryAction,
  sourceSetupStatus,
} from "./source-setup-presentation.ts";

const FIRST_PARTY_REGISTRY_PREFIX = "https://registry.pdpp.dev/connectors/";
test("public connector tiers use the manifest declaration and exact public labels", () => {
  assert.deepEqual(["supported", "preview", "development"].map((tier) => publicTierLabel(tier as "supported" | "preview" | "development")), [
    "Supported",
    "Preview",
    "Development",
  ]);
});

test("generic catalog tier code contains no connector names", async () => {
  const source = await readFile(new URL("./connection-catalog.ts", import.meta.url), "utf8");
  for (const connectorName of ["amazon", "google_calendar", "google_contacts", "jellyfin", "notion", "spotify", "steam"]) {
    assert.doesNotMatch(source, new RegExp(`(?:===|includes|has|case)\\s*[\\(]?['\"]${connectorName}['\"]`));
  }
});

test("development and unavailable entries cannot become runnable add offers", () => {
  const catalog = buildConnectorCatalog([
    { connector_id: "https://registry.pdpp.dev/connectors/development", connector_key: "development", capabilities: { public_listing: { tier: "development" } } },
    { connector_id: "https://registry.pdpp.dev/connectors/supported", connector_key: "supported", capabilities: { public_listing: { tier: "supported" } }, runtime_requirements: { bindings: { network: {} } } },
  ]);
  const development = catalog.find((entry) => entry.connectorKey === "development");
  assert.ok(development);
  assert.equal(development.publicTier, "development");
  assert.equal(isRunnableAddOffer(development), false);
});

const TRAILING_SLASH_RE = /\/$/;
const SECURE_BROWSER_RE = /secure browser/i;
const SAVE_SIGN_IN_DETAILS_RE = /sign-in details/i;
const DATA_PORTABILITY_SEPARATE_RE = /separate from Google Maps Timeline Import/;
const TIMELINE_API_DISTINCTION_RE = /not exposed by Google's documented Data Portability API/i;
const TIMELINE_NO_SIGN_IN_RE = /no Google account sign-in is used/i;
const GOOGLE_DEPLOYMENT_BLOCKER_RE = /GOOGLE_DATAPORTABILITY_CLIENT_ID/;
const PROVIDER_BROWSER_GUIDANCE_RE = /provider's browser/;
const OWNER_INTENT_URL_RE = /\/v1\/owner\/connections\/intents$/;
const LIVE_VALIDATION_RE = /live validation/i;
const NOT_YET_SHIPPED_RE = /does not yet ship/i;

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
    tier?: "supported" | "preview" | "development";
    nextStepKind?: string;
    ownerActionable?: boolean;
    proofGate?: string | null;
    setupModality?: string;
    supportState?: string;
    uat_expose_unlisted_connectors?: boolean | null;
  } = {}
): OwnerConnectorTemplateLike {
  const connectorKey = args.connectorKey ?? "test-provider";
  return {
    connector_key: connectorKey,
    connector_modality: args.connectorModality ?? "api_network",
    display_name: connectorKey,
    public_listing: {
      tier: args.tier ?? "supported",
    },
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
    uat_expose_unlisted_connectors: args.uat_expose_unlisted_connectors ?? null,
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
  assert.equal(
    browserCollectorEntries(catalog).some((entry) => entry.connectorKey === "heb"),
    false,
    "heb must not also appear in browser-collector enrollment"
  );
});

test("browser-bound static-secret capability is not enough to create an account", () => {
  const catalog = buildConnectorCatalog([
    {
      capabilities: { public_listing: { tier: "supported" } },
      connector_id: "https://registry.pdpp.dev/connectors/browser-sample",
      display_name: "Browser Sample",
      runtime_requirements: { bindings: { browser: { required: true } } },
      setup: {
        credential_capture: {
          fields: [
            { env: ["BROWSER_SAMPLE_SECRET"], label: "Provider secret", name: "secret", required: true, secret: true },
          ],
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
      // No public_listing declared -> defaults to Development (the same
      // fixture shape this test always used). "gmail" is a real,
      // live-proven connector key (STATIC_SECRET_LIVE_PROVEN_KEYS), so the
      // shared planner resolves static_secret_connect purely from the
      // connector key regardless of this synthetic manifest's declared tier.
      connector_id: "https://registry.pdpp.dev/connectors/gmail",
      display_name: "Gmail",
      runtime_requirements: { bindings: { network: { required: true } } },
      setup: {
        credential_capture: {
          fields: [
            { env: ["GMAIL_APP_PASSWORD"], label: "Provider secret", name: "secret", required: true, secret: true },
          ],
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
  // "gmail" is real (not a known scaffold) and its disposition
  // (static_secret_connect) IS in the Development disclosure's self-test
  // allowlist, so it gets a self-test action in the Development disclosure
  // even though it is not owner-actionable (the whole Development tier is
  // hard-excluded from ownerActionable).
  assert.equal(entry.isKnownScaffold, false);
  assert.equal(sourceSetupAction(entry) !== null, true, "a real development entry gets a self-test action");
  assert.equal(sourceSetupSecondaryAction(entry), null);
  assert.equal(sourceSetupStatus(entry).label, "Development");
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
  assert.equal(sourceSetupStatus(ynab).label, "Supported");
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
      // The shared manifest-driven OAuth adapter is proven, but an owner CTA
      // remains unavailable until this deployment supplies the Google app
      // configuration declared by the connector manifest.
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
        assert.match(guidance, LIVE_VALIDATION_RE);
        assert.doesNotMatch(guidance, NOT_YET_SHIPPED_RE);
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
  assert.equal(sourceSetupAvailability(entry), "not_available_here");
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
  // "Configured" means the manifest's declared deployment settings are
  // actually present in the environment — readiness is measured, not asserted
  // by connector identity.
  const catalog = buildConnectorCatalog(await loadCommittedManifests(), ["google-maps-data-portability"], {
    GOOGLE_DATAPORTABILITY_CLIENT_ID: "test-client-id",
    GOOGLE_DATAPORTABILITY_CLIENT_SECRET: "test-client-secret",
    GOOGLE_DATAPORTABILITY_REDIRECT_URI: "https://example.test/callback",
  });
  const entry = catalog.find((candidate) => candidate.connectorKey === "google-maps-data-portability");
  assert.ok(entry, "google-maps-data-portability must be in the committed catalog");
  assert.equal(entry.deploymentReadiness.state, "ready");
  assert.equal(entry.nextStepKind, "open_provider_auth");
  assert.equal(entry.supportState, "supported");
  assert.equal(entry.disposition, "provider_auth_connect");
  assert.equal(sourceSetupStatus(entry).label, "Development");
  // google-maps-data-portability is real, not a known scaffold (its own
  // manifest documents exactly what is and is not implemented via
  // public_listing.proof_gate), and provider_auth_connect IS in the
  // Development disclosure's self-test allowlist -- so this configured,
  // ready-to-authorize entry gets a self-test action even though it is not
  // owner-actionable (the whole Development tier is hard-excluded from
  // ownerActionable, and sourceSetupAvailability stays "not_available_here").
  assert.equal(entry.isKnownScaffold, false);
  assert.equal(sourceSetupAction(entry) !== null, true, "a real development entry gets a self-test action");
  assert.equal(sourceSetupAvailability(entry), "not_available_here");
  assert.deepEqual(providerAuthConnectEntries(catalog), [entry]);
});

test("owner catalog fails closed for local-only, listed-unproven, and proof-gated static-secret entries", () => {
  const staleLocalManifest: CatalogManifestLike = {
    capabilities: { public_listing: { tier: "supported" } },
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
  assert.ok(
    browserCollectorEntries(catalog).some((entry) => entry.connectorKey === "whoop"),
    "whoop uses browser-collector enrollment"
  );
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

test("owner catalog never offers a development template as a runnable add offer, whatever its setup state", () => {
  // A Development-tier template must never be a runnable OFFER (the main
  // list or the Preview disclosure), and `experimental` is not an exception:
  // the Experimental section presents what is already offered rather than
  // acting as a second door into the catalog. Both an experimental and a
  // non-experimental unlisted template are asserted here so the gate cannot
  // be reopened for one support_state alone. Unlike the pre-Development-
  // disclosure contract, these rows DO now appear in the raw catalog array
  // (see connection-catalog.ts) so the owner can see them in the Development
  // disclosure -- `isRunnableAddOffer` is the authority for "offered", not
  // catalog membership.
  const catalog = buildOwnerConnectorCatalog(
    [],
    [
      ownerTemplate({
        connectorKey: "unlisted-experimental",
        disposition: "static_secret_experimental",
        tier: "development",
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
        tier: "development",
        nextStepKind: "capture_static_secret",
        ownerActionable: false,
        setupModality: "static_secret",
        supportState: "proof_gated",
        actionMethod: null,
        actionStatus: "unsupported",
        actionUrl: null,
      }),
      ownerTemplate({
        connectorKey: "listed-experimental",
        disposition: "static_secret_experimental",
        tier: "preview",
        nextStepKind: "capture_static_secret",
        ownerActionable: false,
        setupModality: "static_secret",
        supportState: "experimental",
        actionMethod: null,
        actionStatus: "experimental",
        actionUrl: null,
      }),
    ]
  );
  const unlistedExperimental = catalog.find((e) => e.connectorKey === "unlisted-experimental");
  assert.ok(unlistedExperimental, "development rows are visible in the catalog for the Development disclosure");
  assert.equal(
    isRunnableAddOffer(unlistedExperimental),
    false,
    "an unlisted experimental template must not be a runnable add offer"
  );

  const unlistedProofGated = catalog.find((e) => e.connectorKey === "unlisted-proof-gated");
  assert.ok(unlistedProofGated, "development rows are visible in the catalog for the Development disclosure");
  assert.equal(
    isRunnableAddOffer(unlistedProofGated),
    false,
    "an unlisted non-experimental template must not be a runnable add offer"
  );

  // The listing gate must not swallow the Experimental section itself: a
  // connector the operator HAS listed still reaches it.
  const listedExperimental = catalog.find((e) => e.connectorKey === "listed-experimental");
  assert.ok(listedExperimental, "a preview experimental template must still be offered");
  assert.equal(isRunnableAddOffer(listedExperimental), true, "a preview experimental template is a runnable offer");
  assert.equal(sourceSetupAvailability(listedExperimental), "experimental_opt_in");
  assert.ok(sourceSetupAction(listedExperimental), "a listed experimental template keeps its add action");
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

/**
 * A real (non-scaffold) Development entry whose disposition resolves to one
 * of `sourceSetupAction`'s runnable dispositions gets a self-test action even
 * though it is not owner-actionable (the server hard-disables
 * `ownerActionable` for the whole Development tier). This mirrors the exact
 * disposition set `sourceSetupAction` itself special-cases; kept here as an
 * independent literal (not an import) so a drift between the two would fail
 * this test rather than silently agreeing with itself.
 */
const DEVELOPMENT_SELF_TEST_DISPOSITIONS = new Set([
  "local_collector_enroll",
  "static_secret_connect",
  "static_secret_experimental",
  "manual_upload_connect",
  "browser_collector_manual",
  "provider_auth_connect",
]);

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
  //
  // Exception: a real (non-scaffold) Development entry with a runnable
  // disposition also has a real action -- the Development disclosure's own
  // self-test opt-in -- even though isOwnerActionableEntry is false for the
  // whole tier. A KNOWN scaffold never gets an action regardless of
  // disposition: clicking it can never collect anything.
  const manifests = await loadCommittedManifests();
  const catalog = buildConnectorCatalog(manifests);

  for (const entry of catalog) {
    const isActionable = isOwnerActionableEntry(entry);
    const hasAction = sourceSetupAction(entry) !== null;
    const isDevelopmentSelfTestable =
      entry.publicTier === "development" && !entry.isKnownScaffold && DEVELOPMENT_SELF_TEST_DISPOSITIONS.has(entry.disposition);

    if (entry.supportState === "experimental") {
      assert.equal(isActionable, false, `${entry.connectorKey}: experimental must not be owner-actionable`);
      assert.equal(
        hasAction,
        entry.publicTier !== "development" || isDevelopmentSelfTestable,
        `${entry.connectorKey}: only preview experimental entries (or a self-testable development entry) expose an opt-in action`
      );
      continue;
    }

    // The invariant: if isOwnerActionableEntry returns true, sourceSetupAction
    // must have a non-null result. Mutations to either would break this. A
    // development entry is the one deliberate exception: it can have an
    // action while isOwnerActionableEntry stays false for the tier.
    assert.equal(
      hasAction,
      (isActionable && entry.publicTier !== "development") || isDevelopmentSelfTestable,
      `${entry.connectorKey}: sourceSetupAction must match isOwnerActionableEntry (or the development self-test exception). ` +
        `Helper says ${isActionable}, action is ${hasAction ? "set" : "null"}, isDevelopmentSelfTestable=${isDevelopmentSelfTestable}`
    );

    // A KNOWN scaffold must NEVER get an action, regardless of disposition:
    // it cannot collect anything, so an add button would be a dead end.
    if (entry.publicTier === "development" && entry.isKnownScaffold) {
      assert.equal(hasAction, false, `${entry.connectorKey}: a known scaffold must never expose an action`);
    }
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

const ENDS_IN_REFUSAL_RE = /cannot add this source yet\.$/;
const OPERATOR_RE = /operator/i;
const DATA_SAFE_RE = /existing collection keeps working/i;
const ENV_VARS_RE = /environment variables/i;
const RESTART_RE = /restart/i;

/**
 * The unclassified-disposition fallback must never be a dead end.
 *
 * "This dashboard cannot add this source yet." told the owner nothing about
 * where to act — the exact complaint that produced the shipped server-settings
 * copy ("Each source below lists the exact settings it is waiting on"). This
 * branch is latent today (no shipped connector reaches it, which the
 * no-silent-fallthrough guard above enforces), but a future unclassified
 * connector would land on it, so it has to clear the same bar: name what is
 * unknown, and name who can act next.
 */
test("an unclassified disposition gets actionable guidance, never the old dead-end line", () => {
  const catalog = buildOwnerConnectorCatalog(
    [],
    [
      ownerTemplate({
        connectorKey: "future-unclassified",
        disposition: "unknown_unsupported",
        nextStepKind: "unsupported",
        ownerActionable: false,
      }),
    ]
  );
  const entry = catalog.find((e) => e.connectorKey === "future-unclassified");
  assert.ok(entry, "an unclassified template must still be listed, never silently dropped");

  const guidance = sourceSetupGuidance(entry);
  assert.notEqual(guidance, "This dashboard cannot add this source yet.", "the dead-end line must not survive");
  assert.doesNotMatch(guidance, ENDS_IN_REFUSAL_RE, "guidance must not end at a refusal");
  // Names the source it cannot classify, so an operator can find it.
  assert.ok(guidance.includes("future-unclassified"), "guidance must name the connector key an operator must look up");
  // Says what the owner can do next, and reassures that data is unaffected.
  assert.match(guidance, OPERATOR_RE, "guidance must name who can act next");
  assert.match(guidance, DATA_SAFE_RE, "guidance must not imply existing data is at risk");
});

test("an unclassified disposition carrying real deployment blockers names those settings", () => {
  const template = ownerTemplate({
    connectorKey: "future-blocked",
    disposition: "unknown_unsupported",
    nextStepKind: "unsupported",
    ownerActionable: false,
  });
  const blockedTemplate = {
    ...template,
    setup_plan: {
      ...template.setup_plan,
      deployment_readiness: {
        blockers: [{ key: "PDPP_FUTURE_CLIENT_ID", label: "PDPP_FUTURE_CLIENT_ID", secret: false }],
        guidance: null,
        state: "needs_config" as const,
      },
    },
  };
  const catalog = buildOwnerConnectorCatalog([], [blockedTemplate]);
  const entry = catalog.find((e) => e.connectorKey === "future-blocked");
  assert.ok(entry);

  const guidance = sourceSetupGuidance(entry);
  // Same shape as the shipped provider_auth_deployment_blocked copy: name the
  // exact env vars, say where to set them, say what happens next.
  assert.ok(guidance.includes("PDPP_FUTURE_CLIENT_ID"), "guidance must name the exact setting that is missing");
  assert.match(guidance, ENV_VARS_RE, "guidance must say where the setting goes");
  assert.match(guidance, RESTART_RE, "guidance must say what makes the setting take effect");
});

test("deployment readiness is measured from manifest-declared settings against the observed environment", () => {
  // The unavailability of a provider-authorization source must derive from
  // what its manifest DECLARES plus what the deployment actually SUPPLIES, so
  // any future connector with unmet prerequisites behaves identically without
  // the reference implementation learning its name. A synthetic connector key
  // is used here precisely because no connector may be special-cased.
  const manifest: CatalogManifestLike = {
    capabilities: {
      auth: { deployment_config: ["ACME_OAUTH_CLIENT_ID", "ACME_OAUTH_CLIENT_SECRET"], kind: "oauth" },
      public_listing: { tier: "supported" },
    },
    connector_id: "acme-widgets",
    display_name: "Acme Widgets",
    runtime_requirements: { bindings: { network: { required: true } } },
    setup: {
      deployment_config: ["ACME_OAUTH_CLIENT_ID", "ACME_OAUTH_CLIENT_SECRET"],
      modality: "provider_authorization",
    },
  } as CatalogManifestLike;
  const readinessFor = (deploymentEnv: Readonly<Record<string, string | undefined>>) => {
    const entry = buildConnectorCatalog([manifest], [], deploymentEnv).find(
      (candidate) => candidate.connectorKey === "acme-widgets"
    );
    assert.ok(entry, "a listed provider-authorization manifest must reach the catalog");
    return entry;
  };

  // Nothing supplied: blocked, and BOTH declared settings are named so the
  // owner can see exactly what this deployment is missing.
  const missing = readinessFor({});
  assert.equal(missing.deploymentReadiness.state, "needs_config");
  assert.deepEqual(
    missing.deploymentReadiness.blockers.map((blocker) => blocker.key),
    ["ACME_OAUTH_CLIENT_ID", "ACME_OAUTH_CLIENT_SECRET"]
  );
  assert.equal(sourceSetupAvailability(missing), "requires_server_setup");
  assert.ok(
    sourceSetupGuidance(missing).includes("ACME_OAUTH_CLIENT_SECRET"),
    "guidance must name the exact settings this deployment is waiting on"
  );

  // Partially supplied: only the setting still absent is reported, never a
  // blanket re-listing of every declared key.
  assert.deepEqual(
    readinessFor({ ACME_OAUTH_CLIENT_ID: "supplied" }).deploymentReadiness.blockers.map((blocker) => blocker.key),
    ["ACME_OAUTH_CLIENT_SECRET"]
  );

  // Present but blank is not supplied.
  assert.deepEqual(
    readinessFor({
      ACME_OAUTH_CLIENT_ID: "supplied",
      ACME_OAUTH_CLIENT_SECRET: "   ",
    }).deploymentReadiness.blockers.map((blocker) => blocker.key),
    ["ACME_OAUTH_CLIENT_SECRET"]
  );

  // Fully supplied: ready, with no allowlist entry anywhere for this key.
  const ready = readinessFor({ ACME_OAUTH_CLIENT_ID: "supplied", ACME_OAUTH_CLIENT_SECRET: "supplied" });
  assert.equal(ready.deploymentReadiness.state, "ready");
  assert.deepEqual(ready.deploymentReadiness.blockers, []);
});

test("a connector-key allowlist cannot declare readiness a deployment has not supplied", () => {
  // The inverse guard: naming a connector in the provider-auth allowlist must
  // NOT make it read ready while its declared settings are absent, or the
  // catalog would offer a source that cannot complete setup.
  const manifest: CatalogManifestLike = {
    capabilities: {
      auth: { deployment_config: ["ACME_OAUTH_CLIENT_ID"], kind: "oauth" },
      public_listing: { tier: "supported" },
    },
    connector_id: "acme-widgets",
    display_name: "Acme Widgets",
    runtime_requirements: { bindings: { network: { required: true } } },
    setup: { deployment_config: ["ACME_OAUTH_CLIENT_ID"], modality: "provider_authorization" },
  } as CatalogManifestLike;
  const entry = buildConnectorCatalog([manifest], ["acme-widgets"], {}).find(
    (candidate) => candidate.connectorKey === "acme-widgets"
  );
  assert.ok(entry);
  assert.equal(entry.deploymentReadiness.state, "needs_config", "an unsupplied setting must stay blocked");
  assert.deepEqual(
    entry.deploymentReadiness.blockers.map((blocker) => blocker.key),
    ["ACME_OAUTH_CLIENT_ID"]
  );
});

test("console catalog uses the manifest tier as its sole listing authority", () => {
  // Development-tier entries flow through as catalog rows -- the owner
  // running this instance must be able to see what is registered and tell
  // "unproven" apart from "unimplemented" (Development disclosure on
  // /sources/add). But the manifest tier remains the sole RUNNABLE-OFFER
  // authority: a development entry is never in the main list or the Preview
  // disclosure, and the obsolete UAT exposure fact cannot promote it there
  // either.
  const uatFalseTemplate = ownerTemplate({
    connectorKey: "test-unproven",
    tier: "development",
    uat_expose_unlisted_connectors: false,
  });
  let catalog = buildOwnerConnectorCatalog([], [uatFalseTemplate]);
  assert.equal(catalog.length, 1, "development must still be visible in the catalog for the Development disclosure");
  let entry = catalog[0];
  assert.ok(entry);
  assert.equal(isRunnableAddOffer(entry), false, "development is never a runnable add offer");
  // Real (non-scaffold), self-testable disposition: gets a self-test action
  // in the Development disclosure even though it is never a runnable offer.
  assert.equal(sourceSetupAction(entry) !== null, true, "a real development entry gets a self-test action");

  // The authenticated server can selectively expose one Development connector
  // without changing its lifecycle tier.
  const uatTrueTemplate = ownerTemplate({
    connectorKey: "test-unproven",
    tier: "development",
    uat_expose_unlisted_connectors: true,
  });
  catalog = buildOwnerConnectorCatalog([], [uatTrueTemplate]);
  entry = catalog[0];
  assert.ok(entry);
  assert.equal(isRunnableAddOffer(entry), false, "UAT exposure must not override development");

  // A KNOWN scaffold never gets a self-test action, regardless of UAT exposure.
  const scaffoldTemplate: OwnerConnectorTemplateLike = {
    ...ownerTemplate({ connectorKey: "test-scaffold", tier: "development" }),
    is_known_scaffold: true,
  };
  catalog = buildOwnerConnectorCatalog([], [scaffoldTemplate]);
  entry = catalog[0];
  assert.ok(entry);
  assert.equal(entry.isKnownScaffold, true);
  assert.equal(isRunnableAddOffer(entry), false, "a scaffold is never a runnable add offer");
  assert.equal(sourceSetupAction(entry), null, "a scaffold never gets a self-test action");
});
