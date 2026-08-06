// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure connector-catalog model for the console add-connection surface.
 *
 * The add-connection surface is a server component, so it can read every shipped
 * connector manifest cookie-side via `listConnectorManifests()` — each manifest
 * carries `runtime_requirements.bindings`, which is all the binding-derived
 * modality classifier needs. This module turns that manifest list into a catalog
 * the picker renders: every connector, grouped by modality, routed to the honest
 * next step the reference can complete today.
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
  enrollmentKeyForCanonicalKey,
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
      listed?: boolean | null;
      status?: string | null;
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

/** Binding-derived modality, matching the backend intent route's taxonomy. */
export type CatalogModality = ConnectorIntentModality;

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
 * - `static_secret_connect` — a network-class connector whose first connection
 *   is created via the owner-session static-secret draft path.
 *   A real owner connect route exists; the picker links to that owner-session
 *   capture form, not to local-device enrollment, and the connection stays
 *   hidden until first ingest accepts records.
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
  /** Binding-derived modality. */
  modality: CatalogModality;
  /** The next owner step selected by the shared planner. */
  nextStepKind: ConnectorSetupNextStepKind;
  /** Proof gate blocking support, if any. */
  proofGate: string | null;
  /** Existing capability rationale used for owner context where no setup copy exists. */
  refreshPolicyRationale: string | null;
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
 * Build the connector catalog from the shipped manifests. One entry per manifest
 * with a `connector_id`, sorted by display name so the picker is stable across
 * renders. Entries only carry an `enrollmentKey` for dispositions the console can
 * actually start, so a caller cannot accidentally deep-link a gated connector.
 */
export function buildConnectorCatalog(
  manifests: readonly CatalogManifestLike[],
  configuredProviderAuthConnectorKeys: readonly string[] = []
): ConnectorCatalogEntry[] {
  const entries: ConnectorCatalogEntry[] = [];
  for (const manifest of manifests) {
    if (!manifest.connector_id) {
      continue;
    }
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const plan = buildConnectionSetupPlan({ connectorKey, configuredProviderAuthConnectorKeys, manifest });
    const setupCopy = setupCopyFromManifest(manifest);
    const entry: ConnectorCatalogEntry = {
      acquisitionPaths: acquisitionPathsFromManifest(manifest),
      connectorKey,
      deploymentReadiness: plan.deploymentReadiness,
      displayName: displayNameFor(manifest, connectorKey),
      disposition: plan.catalogDisposition,
      externalDocs: externalDocsFromManifest(manifest),
      modality: plan.connectorModality,
      nextStepKind: plan.nextStepKind,
      proofGate: plan.proofGate,
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

/**
 * The owner picker only lists connectors whose manifest explicitly opts into
 * public listing. Registered-but-unlisted manifests remain available to the
 * backend registry and conformance tests without implying an owner setup path.
 */
export function ownerCatalogManifests(manifests: readonly CatalogManifestLike[]): CatalogManifestLike[] {
  return manifests.filter((manifest) => manifest.capabilities?.public_listing?.listed === true);
}

/** A ready provider-auth plan has the same action contract as the backend route. */
export function isReadyProviderAuthorizationEntry(entry: ConnectorCatalogEntry): boolean {
  return (
    entry.setupModality === "provider_authorization" &&
    entry.nextStepKind === "open_provider_auth" &&
    entry.supportState === "supported" &&
    entry.deploymentReadiness.state === "ready"
  );
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
  return catalog.filter(isReadyProviderAuthorizationEntry);
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
      (e.disposition === "provider_auth_proof_gated" && !isReadyProviderAuthorizationEntry(e)) ||
      e.disposition === "unknown_unsupported"
  );
}
