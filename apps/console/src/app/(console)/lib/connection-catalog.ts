// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure connector-catalog model for the console add-connection surface.
 *
 * The live add-connection surface consumes the authenticated owner-template
 * projection. Local manifests are joined only for manifest-authored display,
 * help, acquisition, and documentation fields; they never supply capability,
 * listing, registration, proof, readiness, or action truth.
 *
 * This module introduces NO new classification truth. It projects the shared
 * reference setup planner (`pdpp-reference-implementation/connection-setup-plan`)
 * into the compact catalog shape this page renders.
 */

import {
  buildConnectionSetupPlan,
  type ConnectorCatalogDisposition,
  type ConnectorIntentModality,
  type ConnectorSetupDeploymentReadiness,
  type ConnectorSetupModality,
  type ConnectorSetupNextStepKind,
  type ConnectorSetupSupportState,
  canonicalConnectorKey,
  classifyConnectorIntentModality,
  connectorKeyFromManifest,
  enrollmentKeyForCanonicalKey,
  isKnownScaffoldConnector,
  manualUploadSetupFromManifest,
  type StaticSecretSetupFieldLike,
  staticSecretCredentialCaptureFromManifest,
} from "pdpp-reference-implementation/connection-setup-plan";

/**
 * Minimal manifest shape the catalog reads. The real `ConnectorManifest`
 * (rs-client) carries far more; the catalog only needs identity, a display
 * label, and the runtime bindings that drive classification.
 */
export interface CatalogManifestLike {
  capabilities?: {
    auth?: {
      deployment_config?: readonly string[] | null;
      kind?: string | null;
      mode?: string | null;
      required?: readonly string[] | null;
      type?: string | null;
    } | null;
    refresh_policy?: {
      rationale?: string | null;
    } | null;
    public_listing?: {
      /**
       * Owner-facing reason this connector is not offered as a runnable
       * "add now"/Preview card yet, when the manifest declares one. Written
       * for a development-tier connector, so it is the most honest,
       * connector-specific text available for the Development disclosure.
       */
      proof_gate?: string | null;
      /** Manifest-authored explanation for the current lifecycle tier. */
      rationale?: string | null;
      tier?: "supported" | "preview" | "development" | null;
    } | null;
  } | null;
  connector_id: string;
  connector_key?: string | null;
  display_name?: string | null;
  external_docs?: readonly { label?: string | null; url?: string | null }[] | null;
  name?: string | null;
  runtime_requirements?: { bindings?: Record<string, unknown> | null } | null;
  setup?: {
    credential_capture?: {
      credential_kind?: string | null;
      description?: string | null;
      fields?: readonly StaticSecretSetupFieldLike[] | null;
      kind?: string | null;
      label?: string | null;
      submit_label?: string | null;
    } | null;
    deployment_config?: readonly string[] | null;
    manual_or_upload?: {
      accepted_file_extensions?: readonly string[] | null;
      accepted_file_names?: readonly string[] | null;
      acquisition_methods?:
        | readonly {
            detail?: string | null;
            help_url?: string | null;
            label?: string | null;
            platform?: string | null;
            posture?: string | null;
          }[]
        | null;
      description?: string | null;
      help_text?: string | null;
      help_url?: string | null;
      import_dir_env_var?: string | null;
      label?: string | null;
    } | null;
    modality?: string | null;
  } | null;
}

/**
 * Server-owned capability projection returned by the owner-template route.
 * Local manifests are joined only for display/help/documentation fields; these
 * fields are the authority for registration, listing, setup capability, proof,
 * readiness, and owner-facing action. An owner-mediated browser action has no
 * owner-agent REST method or URL; `supported_actions` remains the authority
 * for that separate API capability.
 */
export interface OwnerConnectorTemplateLike {
  connector_key?: string | null;
  connector_modality?: string | null;
  display_name?: string | null;
  /** Optional manifest-declared brand glyph; absent renders the Monogram fallback (see ConnectorIcon). */
  icon?: {
    color?: string | null;
    kind?: string | null;
    svg?: string | null;
  } | null;
  /**
   * Server-owned fact, meaningful only for Development-tier entries: true when
   * the connector-conformance roster names this connector a KNOWN scaffold
   * (unconditional `SKIP_RESULT`, no real collection). A scaffold must never
   * render an add action, even inside a Development disclosure.
   */
  is_known_scaffold?: boolean | null;
  public_listing?: {
    /** Owner-facing reason this connector is not offered as a runnable card yet, when declared. */
    proof_gate?: string | null;
    /** Manifest-authored explanation for the current lifecycle tier. */
    rationale?: string | null;
    tier?: "supported" | "preview" | "development" | null;
  } | null;
  registration_status?: string | null;
  setup_plan?: {
    catalog_disposition?: string | null;
    deployment_readiness?: ConnectorSetupDeploymentReadiness | null;
    enrollment_key?: string | null;
    next_step_kind?: string | null;
    /** True when an owner-facing setup path exists, including owner-mediated browser setup. */
    owner_actionable?: boolean | null;
    proof_gate?: string | null;
    runbook_path?: string | null;
    setup_modality?: string | null;
    support_state?: string | null;
  } | null;
  supported_actions?:
    | readonly {
        family?: string | null;
        method?: string | null;
        status?: string | null;
        url?: string | null;
      }[]
    | null;
  uat_expose_unlisted_connectors?: boolean | null;
}

/** Binding-derived modality, matching the backend intent route's taxonomy. */
export type CatalogModality = ConnectorIntentModality;

export type PublicConnectorTier = "supported" | "preview" | "development";

/**
 * What the console can honestly do with this connector today:
 *
 * - `local_collector_enroll` — a proven one-click enrollment deep-link.
 * - `local_collector_unproven` — a filesystem-class connector whose collector is
 *   not in the console's proven enrollment set yet; the local-collector path
 *   exists in principle but this connector has no committed console proof, so it
 *   is shown without a deep-link rather than mislabeled as an API source.
 * - `browser_collector_manual` — a committed manual browser-collector proof
 *   path (deep-links to mint a code; the owner finishes the run locally).
 * - `browser_bound_runbook` — a browser-bound connector with no generated console
 *   path yet; visible and pointed at the runbook, but NOT deep-linked.
 * - `static_secret_connect` — a network-class connector whose manifest declares
 *   static-secret capture. The live owner catalog supplies the proof/action
 *   gate; a capture form alone never makes this disposition actionable.
 * - `static_secret_experimental` — same capture form as `static_secret_connect`,
 *   but no owner has completed a live proof run yet. Shown only behind an
 *   explicit "Experimental" opt-in, never mixed into the normal picker.
 * - `manual_upload_connect` — a manifest-declared file/import connector whose
 *   owner-session upload route is packaged; the picker links to the generic
 *   file-capture form and the connection stays hidden until first ingest
 *   accepts records.
 * - `manual_upload_pending` — a manifest-declared file/import connector. The
 *   connector owns the accepted artifact shape, but no generic capture env
 *   binding is declared yet.
 * - `api_network_unsupported` — no owner connect route; visible with its reason,
 *   not creatable here.
 * - `unknown_unsupported` — a manifest with no recognized binding; surfaced
 *   honestly rather than silently dropped.
 */
export type CatalogDisposition = ConnectorCatalogDisposition;

export interface ConnectorAcquisitionPath {
  detail: string | null;
  helpUrl: string | null;
  label: string;
  platform: string | null;
  posture: string;
}

export interface ConnectorExternalDoc {
  readonly label: string;
  readonly url: string;
}

export interface ConnectorCatalogEntry {
  /** Manifest-declared owner acquisition jobs, such as export/upload paths. */
  acquisitionPaths: readonly ConnectorAcquisitionPath[];
  /** Canonical bare connector key (registry-URL prefix stripped). */
  connectorKey: string;
  /** Non-secret deployment blockers, separated from per-connection owner action. */
  deploymentReadiness: ConnectorSetupDeploymentReadiness;
  /** Owner-meaningful display name from the manifest, falling back to the key. */
  displayName: string;
  /** What the console can honestly do with this connector today. */
  disposition: CatalogDisposition;
  /**
   * The `?connector=` value to deep-link into the enrollment form, present only
   * for dispositions the console can actually start (`local_collector_enroll`,
   * `browser_collector_manual`). Absent for gated dispositions so the picker
   * never renders an enrollment link the reference cannot complete.
   */
  enrollmentKey?: string;
  /** Manifest-authored external documentation links. */
  externalDocs: readonly ConnectorExternalDoc[];
  /** Optional manifest-declared brand glyph; absent renders the Monogram fallback (see ConnectorIcon). */
  icon?: OwnerConnectorTemplateLike["icon"];
  /**
   * Meaningful only for Development-tier entries: true when the connector is
   * a KNOWN scaffold (unconditional `SKIP_RESULT`, no real collection) rather
   * than real-but-unproven. Drives whether a Development disclosure card may
   * ever render an add action for this entry.
   */
  isKnownScaffold: boolean;
  /**
   * Manifest-authored explanation for the current lifecycle tier
   * (`public_listing.rationale` or `public_listing.proof_gate`, in that
   * order), when the manifest declares one. Most specific, most honest
   * per-connector text available for the Development disclosure; a
   * connector without one falls back to generic tier copy.
   */
  listingNote: string | null;
  /** Binding-derived modality. */
  modality: CatalogModality;
  /** The next owner step selected by the shared planner. */
  nextStepKind: ConnectorSetupNextStepKind;
  /** Server-authorized owner-facing setup action; live owner catalogs always set it. */
  ownerActionable?: boolean;
  /** Projected owner-agent method; null for owner-mediated browser setup. */
  ownerActionMethod?: string | null;
  /** Projected owner-agent URL; null for owner-mediated browser setup. */
  ownerActionUrl?: string | null;
  /** Proof gate blocking support, if any. */
  proofGate: string | null;
  /** Server-owned public-listing state. */
  publicTier: PublicConnectorTier;
  /** Existing capability rationale used for owner context where no setup copy exists. */
  refreshPolicyRationale: string | null;
  /** Server-owned registration state. */
  registrationStatus?: string | null;
  /** Optional runbook path surfaced in advanced/details copy. */
  runbookPath: string | null;
  /** Manifest-authored setup description, when the setup modality provides one. */
  setupDescription: string | null;
  /** Manifest-authored setup help text, when the setup modality provides one. */
  setupHelpText: string | null;
  /** The owner setup modality selected by the shared planner. */
  setupModality: ConnectorSetupModality;
  /** Support state selected by the shared planner. */
  supportState: ConnectorSetupSupportState;
}

/**
 * Classify a manifest's runtime bindings into a modality through the shared
 * setup planner classifier: `filesystem` wins over `browser` wins over
 * `network`; a missing/empty binding set is `unknown`.
 */
export function catalogModalityFromManifest(manifest: CatalogManifestLike): CatalogModality {
  return classifyConnectorIntentModality(manifest);
}

function displayNameFor(manifest: CatalogManifestLike, connectorKey: string): string {
  const display = manifest.display_name?.trim();
  if (display) {
    return display;
  }
  const name = manifest.name?.trim();
  if (name) {
    return name;
  }
  return connectorKey;
}

function cleanManifestText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function listingNoteFromPublicListing(
  listing: { proof_gate?: string | null; rationale?: string | null } | null | undefined
): string | null {
  return cleanManifestText(listing?.rationale) ?? cleanManifestText(listing?.proof_gate);
}

function setupCopyFromManifest(manifest: CatalogManifestLike): {
  description: string | null;
  helpText: string | null;
} {
  const uploadSetup = manualUploadSetupFromManifest(manifest);
  const credentialSetup = staticSecretCredentialCaptureFromManifest(manifest);
  return {
    description: uploadSetup?.description ?? credentialSetup?.description ?? null,
    helpText: uploadSetup?.helpText ?? null,
  };
}

function externalDocsFromManifest(manifest: CatalogManifestLike): ConnectorExternalDoc[] {
  if (!Array.isArray(manifest.external_docs)) {
    return [];
  }
  return manifest.external_docs.flatMap((doc) => {
    const label = cleanManifestText(doc?.label);
    const url = cleanManifestText(doc?.url);
    return label && url ? [{ label, url }] : [];
  });
}

function acquisitionPathsFromManifest(manifest: CatalogManifestLike): ConnectorAcquisitionPath[] {
  const uploadSetup = manualUploadSetupFromManifest(manifest);
  if (!uploadSetup) {
    return [];
  }
  return uploadSetup.acquisitionMethods.map((method) => ({
    detail: method.detail,
    helpUrl: method.helpUrl,
    label: method.label,
    platform: method.platform,
    posture: method.posture ?? "secondary",
  }));
}

/**
 * Build the pure manifest/planner projection used by tests and demo data. The
 * live Add Source page uses `buildOwnerConnectorCatalog` so local manifests
 * cannot supply registration, listing, proof, readiness, or action authority.
 */
export function buildConnectorCatalog(
  manifests: readonly CatalogManifestLike[],
  configuredProviderAuthConnectorKeys: readonly string[] = [],
  deploymentEnv?: Readonly<Record<string, string | undefined>>
): ConnectorCatalogEntry[] {
  const entries: ConnectorCatalogEntry[] = [];
  for (const manifest of manifests) {
    if (!manifest.connector_id) {
      continue;
    }
    // Prefer the manifest's own `connector_key` over a blind canonicalization
    // of `connector_id`'s registry-URL slug — they usually agree, but a
    // manifest is free to declare a `connector_key` the slug canonicalizer
    // wouldn't derive on its own. Falls back to canonicalConnectorKey
    // (connector_id) when connector_key is absent, the same precedence
    // buildConnectionSetupPlan itself uses internally.
    const connectorKey = connectorKeyFromManifest(manifest, manifest.connector_id) ?? "unknown";
    const plan = buildConnectionSetupPlan({
      connectorKey,
      configuredProviderAuthConnectorKeys,
      manifest,
      ...(deploymentEnv ? { deploymentEnv } : {}),
    });
    const setupCopy = setupCopyFromManifest(manifest);
    const entry: ConnectorCatalogEntry = {
      acquisitionPaths: acquisitionPathsFromManifest(manifest),
      connectorKey,
      deploymentReadiness: plan.deploymentReadiness,
      displayName: displayNameFor(manifest, connectorKey),
      disposition: plan.catalogDisposition,
      externalDocs: externalDocsFromManifest(manifest),
      isKnownScaffold: isKnownScaffoldConnector(connectorKey),
      listingNote: listingNoteFromPublicListing(manifest.capabilities?.public_listing),
      modality: plan.connectorModality,
      nextStepKind: plan.nextStepKind,
      proofGate: plan.proofGate,
      publicTier: manifest.capabilities?.public_listing?.tier ?? "development",
      refreshPolicyRationale: cleanManifestText(manifest.capabilities?.refresh_policy?.rationale),
      runbookPath: plan.runbookPath,
      setupDescription: setupCopy.description,
      setupHelpText: setupCopy.helpText,
      setupModality: plan.setupModality,
      supportState: plan.supportState,
    };
    if (plan.enrollmentKey) {
      entry.enrollmentKey = plan.enrollmentKey;
    } else if (entry.disposition === "local_collector_enroll" || entry.disposition === "browser_collector_manual") {
      entry.enrollmentKey = enrollmentKeyForCanonicalKey(connectorKey);
    }
    entries.push(entry);
  }
  entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return entries;
}

const CATALOG_INTENT_MODALITIES = new Set<ConnectorIntentModality>([
  "local_collector",
  "browser_bound",
  "api_network",
  "unknown",
]);
const CATALOG_MODALITIES = new Set<ConnectorSetupModality>([
  "local_collector",
  "browser_bound",
  "static_secret",
  "provider_authorization",
  "manual_or_upload",
  "unsupported",
  "unknown",
]);
const CATALOG_NEXT_STEPS = new Set<ConnectorSetupNextStepKind>([
  "enroll_local_collector",
  "enroll_browser_collector",
  "capture_static_secret",
  "open_provider_auth",
  "needs_deployment_config",
  "provide_import_file",
  "manual_runbook",
  "unsupported",
]);
const CATALOG_SUPPORT_STATES = new Set<ConnectorSetupSupportState>([
  "supported",
  "experimental",
  "proof_gated",
  "unsupported",
  "needs_deployment_config",
]);
const CATALOG_READINESS_STATES = new Set<ConnectorSetupDeploymentReadiness["state"]>([
  "not_applicable",
  "ready",
  "needs_config",
]);
const CATALOG_DISPOSITIONS = new Set<CatalogDisposition>([
  "local_collector_enroll",
  "local_collector_unproven",
  "browser_collector_manual",
  "browser_bound_runbook",
  "static_secret_connect",
  "static_secret_experimental",
  "manual_upload_connect",
  "manual_upload_pending",
  "provider_auth_deployment_blocked",
  "provider_auth_connect",
  "provider_auth_proof_gated",
  "api_network_unsupported",
  "unknown_unsupported",
]);

function isCatalogValue<T extends string>(values: ReadonlySet<T>, value: unknown): value is T {
  return typeof value === "string" && values.has(value as T);
}

function actionableOwnerActionFromTemplate(
  template: OwnerConnectorTemplateLike,
  entry: {
    connectorModality: ConnectorIntentModality;
    disposition: CatalogDisposition;
    enrollmentKey?: string;
    nextStepKind: ConnectorSetupNextStepKind;
    proofGate: string | null;
    setupModality: ConnectorSetupModality;
    supportState: ConnectorSetupSupportState;
  }
): { actionable: boolean; method: string | null; url: string | null } {
  const action = template.supported_actions?.find((candidate) => candidate.family === "initiate_connection");
  const method = typeof action?.method === "string" ? action.method : null;
  const url = typeof action?.url === "string" && action.url.trim() ? action.url : null;
  const listedOrExplicitlyExposed =
    template.public_listing?.tier !== "development" || template.uat_expose_unlisted_connectors === true;
  const authority =
    template.registration_status === "registered" &&
    listedOrExplicitlyExposed &&
    (template.setup_plan?.owner_actionable === true || template.uat_expose_unlisted_connectors === true) &&
    entry.nextStepKind === template.setup_plan?.next_step_kind;
  const ownerAgentActionable =
    authority &&
    entry.supportState === "supported" &&
    entry.proofGate === null &&
    action?.status === "supported" &&
    method !== null &&
    url !== null &&
    (entry.disposition !== "local_collector_enroll" || typeof entry.enrollmentKey === "string");
  const ownerSessionBrowserActionable =
    authority &&
    entry.connectorModality === "browser_bound" &&
    ((entry.disposition === "browser_collector_manual" &&
      entry.nextStepKind === "enroll_browser_collector" &&
      typeof entry.enrollmentKey === "string") ||
      (entry.disposition === "static_secret_connect" && entry.setupModality === "static_secret")) &&
    action?.status === "owner_mediated" &&
    method === null &&
    url === null;
  return { actionable: ownerAgentActionable || ownerSessionBrowserActionable, method, url };
}

/**
 * Build the live catalog from the authenticated server projection. A template
 * with missing authority fields is dropped rather than reconstructed from a
 * local manifest. Local data is a display/help/docs join only.
 */
export function buildOwnerConnectorCatalog(
  manifests: readonly CatalogManifestLike[],
  templates: readonly OwnerConnectorTemplateLike[]
): ConnectorCatalogEntry[] {
  const manifestsByKey = new Map<string, CatalogManifestLike>();
  for (const manifest of manifests) {
    if (manifest.connector_id) {
      manifestsByKey.set(canonicalConnectorKey(manifest.connector_id), manifest);
    }
  }

  const entries: ConnectorCatalogEntry[] = [];
  for (const template of templates) {
    const connectorKey = cleanManifestText(template.connector_key);
    const setupPlan = template.setup_plan;
    // Development-tier entries flow through as catalog entries so the owner
    // running this instance can see what exists and self-test it -- they are
    // never a runnable "add now" or Preview offer (see isRunnableAddOffer and
    // the Development disclosure in source-setup-catalog.tsx). The manifest
    // tier remains the sole listing-TIER authority; this only stops dropping
    // the row outright.
    //
    // This supersedes the narrower `uat_expose_unlisted_connectors` gate that
    // previously guarded this filter: that flag only revealed development rows
    // the server explicitly opted in, which still left the owner unable to see
    // the other development connectors on his own instance. The flag remains
    // authoritative for the owner-actionable/disposition decisions above; it is
    // only its use as a LISTING gate here that this replaces.
    if (!connectorKey || template.registration_status !== "registered") {
      continue;
    }
    const disposition = setupPlan?.catalog_disposition;
    const connectorModality = template.connector_modality;
    const setupModality = setupPlan?.setup_modality;
    const nextStepKind = setupPlan?.next_step_kind;
    const supportState = setupPlan?.support_state;
    const deploymentReadiness = setupPlan?.deployment_readiness;
    if (
      !(
        isCatalogValue(CATALOG_DISPOSITIONS, disposition) &&
        isCatalogValue(CATALOG_INTENT_MODALITIES, connectorModality) &&
        isCatalogValue(CATALOG_MODALITIES, setupModality) &&
        isCatalogValue(CATALOG_NEXT_STEPS, nextStepKind) &&
        isCatalogValue(CATALOG_SUPPORT_STATES, supportState) &&
        deploymentReadiness &&
        isCatalogValue(CATALOG_READINESS_STATES, deploymentReadiness.state)
      )
    ) {
      continue;
    }

    const localManifest = manifestsByKey.get(canonicalConnectorKey(connectorKey));
    const manifestForCopy = localManifest ?? { connector_id: connectorKey };
    const proofGate = typeof setupPlan.proof_gate === "string" ? setupPlan.proof_gate : null;
    const enrollmentKey = cleanManifestText(setupPlan.enrollment_key) ?? undefined;
    const capability = actionableOwnerActionFromTemplate(template, {
      connectorModality,
      disposition,
      enrollmentKey,
      nextStepKind,
      proofGate,
      setupModality,
      supportState,
    });
    const setupCopy = setupCopyFromManifest(manifestForCopy);
    const entry: ConnectorCatalogEntry = {
      acquisitionPaths: acquisitionPathsFromManifest(manifestForCopy),
      connectorKey: canonicalConnectorKey(connectorKey),
      deploymentReadiness,
      displayName: cleanManifestText(template.display_name) ?? displayNameFor(manifestForCopy, connectorKey),
      disposition,
      externalDocs: externalDocsFromManifest(manifestForCopy),
      icon: template.icon ?? null,
      isKnownScaffold:
        typeof template.is_known_scaffold === "boolean"
          ? template.is_known_scaffold
          : isKnownScaffoldConnector(connectorKey),
      listingNote: listingNoteFromPublicListing(template.public_listing),
      modality: connectorModality,
      nextStepKind,
      ownerActionable: capability.actionable,
      ownerActionMethod: capability.method,
      ownerActionUrl: capability.url,
      proofGate,
      publicTier: template.public_listing?.tier ?? "development",
      refreshPolicyRationale: cleanManifestText(localManifest?.capabilities?.refresh_policy?.rationale),
      registrationStatus: template.registration_status,
      runbookPath: cleanManifestText(setupPlan.runbook_path),
      setupDescription: setupCopy.description,
      setupHelpText: setupCopy.helpText,
      setupModality,
      supportState,
    };
    if (enrollmentKey) {
      entry.enrollmentKey = enrollmentKey;
    }
    entries.push(entry);
  }
  entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return entries;
}

/**
 * Check if this entry is owner-actionable.
 *
 * For live owner-catalog entries, ownerActionable is the authoritative field
 * computed once during buildOwnerConnectorCatalog. For demo/test entries from
 * buildConnectorCatalog, fall back to explicit rules since they carry no
 * owner-session authority.
 */
export function isOwnerActionableEntry(entry: ConnectorCatalogEntry): boolean {
  if (entry.ownerActionable !== undefined) {
    return entry.ownerActionable;
  }
  // `buildConnectorCatalog` remains a pure manifest/planner projection for
  // tests and demo data. Its static-secret and provider branches still fail
  // closed on the planner's proof fields; live pages must use the owner
  // projection above, which also supplies registration and listing authority.
  if (entry.setupModality === "static_secret" || entry.disposition === "provider_auth_connect") {
    return entry.supportState === "supported" && entry.proofGate === null;
  }
  return entry.supportState === "supported" || entry.disposition === "browser_collector_manual";
}

/**
 * Whether this entry is an experimental setup path: implemented and
 * reachable, but not yet proven against a live run. Kept as its own check
 * (never folded into `isOwnerActionableEntry`) so a normal picker never
 * treats an unproven path as equal-footing with a proven one; the console
 * must render experimental entries behind an explicit, separate opt-in.
 */
export function isExperimentalEntry(entry: ConnectorCatalogEntry): boolean {
  return entry.supportState === "experimental";
}

/** Catalog entries the console can start as a one-click local-collector enroll. */
export function localCollectorEntries(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return catalog.filter((e) => e.disposition === "local_collector_enroll");
}

/**
 * Filesystem-class entries whose collector is not in the console's proven
 * enrollment set yet — named and honest, no deep-link.
 */
export function localCollectorUnprovenEntries(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return catalog.filter((e) => e.disposition === "local_collector_unproven");
}

/** Catalog entries with a manual browser-collector proof path. */
export function browserCollectorEntries(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return catalog.filter((e) => e.disposition === "browser_collector_manual");
}

/** Browser-bound entries that have no generated console path yet (runbook only). */
export function browserBoundRunbookEntries(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return catalog.filter((e) => e.disposition === "browser_bound_runbook");
}

/**
 * Static-secret entries: a real owner-session draft-create path surfaced through
 * the owner-session static-secret form plus runbook/proof caveat. These carry no
 * `enrollmentKey` because they never deep-link into the local-device enrollment
 * form.
 */
export function staticSecretConnectEntries(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return catalog.filter((e) => e.disposition === "static_secret_connect");
}

/** Manual/file import entries with a packaged owner upload-and-run path. */
export function manualUploadConnectEntries(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return catalog.filter((e) => e.disposition === "manual_upload_connect");
}

/** Manual/file import entries awaiting a generic owner file-capture path. */
export function manualUploadPendingEntries(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return catalog.filter((e) => e.disposition === "manual_upload_pending");
}

/** Provider-auth entries whose shared plan authorizes an owner action now. */
export function providerAuthConnectEntries(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return catalog.filter((e) => e.disposition === "provider_auth_connect");
}

/** Provider-authorization entries blocked on instance-level deployment config. */
export function deploymentBlockedEntries(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return catalog.filter((e) => e.disposition === "provider_auth_deployment_blocked");
}

/** API/network entries with no owner connect route, plus any unknown-binding entries. */
export function unsupportedNetworkEntries(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return catalog.filter(
    (e) =>
      e.disposition === "api_network_unsupported" ||
      e.disposition === "provider_auth_proof_gated" ||
      e.disposition === "unknown_unsupported"
  );
}

/**
 * Entries with an implemented setup path that has not completed live
 * validation. Kept separate from every "available now" list so a normal
 * owner never mistakes an experimental path for a proven one.
 */
export function experimentalEntries(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return catalog.filter(isExperimentalEntry);
}
