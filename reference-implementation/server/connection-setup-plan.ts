// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import {
  KNOWN_SCAFFOLD_CONNECTORS,
  PRODUCTION_READY_CONNECTORS,
} from "../../packages/polyfill-connectors/src/connector-conformance-roster.ts";
import {
  type CredentialValidationMode,
  credentialValidationMode,
} from "../../packages/polyfill-connectors/src/credential-probe.ts";
import {
  type NormalizedStaticSecretCredentialCapture,
  type NormalizedStaticSecretField,
  normalizeStaticSecretCredentialCapture,
  type StaticSecretCredentialCaptureFieldLike,
  type StaticSecretFieldType,
} from "../../packages/polyfill-connectors/src/static-secret-credential-capture.ts";
import { legacyLocalAliasMap } from "./connector-key.ts";
import {
  BROWSER_BOUND_KEYS,
  LEGACY_LOCAL_ALIASES,
  LOCAL_COLLECTOR_PROVEN_KEYS,
  PROVIDER_AUTH_LIFECYCLE_PROVEN_KEYS,
  STATIC_SECRET_LIVE_PROVEN_KEYS,
} from "./generated/connector-registry.generated.ts";

export type ConnectorIntentModality = "local_collector" | "browser_bound" | "api_network" | "unknown";

export type ConnectorSetupModality =
  | "local_collector"
  | "browser_bound"
  | "static_secret"
  | "provider_authorization"
  | "manual_or_upload"
  | "unsupported"
  | "unknown";

export type ConnectorSetupSupportState =
  | "supported"
  | "experimental"
  | "proof_gated"
  | "unsupported"
  | "needs_deployment_config";

export type ConnectorSetupNextStepKind =
  | "enroll_local_collector"
  | "enroll_browser_collector"
  | "capture_static_secret"
  | "open_provider_auth"
  | "needs_deployment_config"
  | "provide_import_file"
  | "manual_runbook"
  | "unsupported";

export type ConnectorCatalogDisposition =
  | "local_collector_enroll"
  | "local_collector_unproven"
  | "browser_collector_manual"
  | "browser_bound_runbook"
  | "static_secret_connect"
  | "static_secret_experimental"
  | "manual_upload_connect"
  | "manual_upload_pending"
  | "provider_auth_deployment_blocked"
  | "provider_auth_connect"
  | "provider_auth_proof_gated"
  | "api_network_unsupported"
  | "unknown_unsupported";

export interface DeploymentConfigKeyLike {
  readonly key: string;
  readonly label?: string | null;
  readonly secret?: boolean | null;
}

/**
 * The current, generic deployment-config entry shape: a manifest-declared
 * logical role name (`client_id`, `client_secret`, ...), never a
 * provider-specific literal. `env_alias` is optional and exists only so an
 * operator can satisfy this entry via an env var instead of the DB-backed
 * config store for infra-as-code deploys — it is resolved server-side only
 * and is never surfaced to the operator UI (which renders `label`).
 */
export interface DeploymentConfigLogicalKeyLike {
  readonly env_alias?: string | null;
  readonly label?: string | null;
  readonly logical_key: string;
  readonly secret?: boolean | null;
}

export type DeploymentConfigDeclarationLike = readonly (
  | string
  | DeploymentConfigKeyLike
  | DeploymentConfigLogicalKeyLike
)[];

/**
 * One `connection_config` entry: the per-connection runtime env var a
 * connector already reads, paired with the generic bundle field name that
 * supplies its value. `single_field` manifests (one refresh token) and
 * `multi_field` manifests (e.g. an access-type/resource-group bundle) both
 * express themselves the same way — the RI never special-cases either shape.
 */
export interface ConnectionConfigEntryLike {
  readonly bundle_field: string;
  readonly env_var: string;
  readonly required?: boolean | null;
}

/** Normalizes `connection_config` to the plain-object shape
 * `provider-auth-run-credentials.ts` consumes, accepting only the current
 * `{env_var,bundle_field,required?}` entry shape (no legacy bare-string form
 * exists for this field — it was added generic from the start). */
export function connectionConfigEntriesFromManifest(
  manifest: ConnectorManifestLike | null
): readonly { readonly envVar: string; readonly bundleField: string; readonly required?: boolean }[] {
  const declared = manifest?.capabilities?.auth?.connection_config;
  if (!Array.isArray(declared)) {
    return [];
  }
  const out: { envVar: string; bundleField: string; required?: boolean }[] = [];
  for (const entry of declared) {
    if (typeof entry === "string" || !entry) {
      continue;
    }
    const envVar = typeof entry.env_var === "string" ? entry.env_var.trim() : "";
    const bundleField = typeof entry.bundle_field === "string" ? entry.bundle_field.trim() : "";
    if (!(envVar && bundleField)) {
      continue;
    }
    out.push({
      bundleField,
      envVar,
      ...(typeof entry.required === "boolean" ? { required: entry.required } : {}),
    });
  }
  return out;
}

export interface ConnectorManifestLike {
  readonly capabilities?: {
    readonly auth?: {
      readonly kind?: string | null;
      readonly mode?: string | null;
      readonly type?: string | null;
      readonly required?: readonly string[] | null;
      readonly deployment_config?: DeploymentConfigDeclarationLike | null;
      readonly connection_config?: readonly (string | ConnectionConfigEntryLike)[] | null;
      readonly scopes?: readonly string[] | null;
      readonly exchanger_kind?: string | null;
      readonly authorization_url?: string | null;
      readonly token_url?: string | null;
      readonly userinfo_url?: string | null;
      /** Opaque grouping token — manifests sharing this value share one
       * deployment-config app registration and get scope-union at
       * authorization time. Never treated as a provider name by the RI, and
       * never rendered as display copy — the client-facing GET surface may
       * return it verbatim as a hidden addressing token (so the client can
       * make the matching POST call), but never as UI text; only
       * `provider_identity_label` is display-safe. */
      readonly provider_identity_group?: string | null;
      /** Human-readable copy for the identity group, e.g. "Shared Google
       * OAuth App". Opaque display text the RI passes through verbatim,
       * exactly like `deployment_config[].label` — never parsed or branched
       * on. This is the ONLY identity-group-related value ever rendered as
       * UI copy. */
      readonly provider_identity_label?: string | null;
      /** Static query params merged onto the authorization URL. The RI/its
       * adapters apply exactly what is declared here — no implicit defaults. */
      readonly authorization_params?: Readonly<Record<string, string>> | null;
      /** Closed enum of generic provider-token bundle shapes. */
      readonly env_bundle_kind?: "single_field" | "multi_field" | null;
      /** Connector-owned declarative migration metadata: generic bundle
       * field name -> legacy field name written by a since-retired exchanger.
       * The RI reads this mechanically; it never hardcodes a legacy name. */
      readonly legacy_bundle_field_aliases?: Readonly<Record<string, string>> | null;
    } | null;
  } | null;
  readonly connector_id?: string | null;
  readonly connector_key?: string | null;
  readonly display_name?: string | null;
  readonly name?: string | null;
  readonly runtime_requirements?: {
    readonly bindings?: Readonly<Record<string, unknown>> | null;
  } | null;
  readonly setup?: {
    readonly credential_capture?: {
      readonly description?: string | null;
      readonly fields?: readonly StaticSecretSetupFieldLike[] | null;
      readonly kind?: string | null;
      readonly credential_kind?: string | null;
      readonly label?: string | null;
      readonly required?: boolean | null;
      readonly submit_label?: string | null;
    } | null;
    readonly manual_or_upload?: {
      readonly accepted_file_extensions?: readonly string[] | null;
      readonly accepted_file_names?: readonly string[] | null;
      readonly acquisition_methods?: readonly ManualUploadAcquisitionMethodLike[] | null;
      readonly description?: string | null;
      readonly help_text?: string | null;
      readonly help_url?: string | null;
      readonly import_dir_env_var?: string | null;
      readonly label?: string | null;
      readonly large_file_fallback?: string | null;
      readonly validation?: ManualUploadValidationLike | null;
      readonly validation_expectations?: readonly string[] | null;
    } | null;
    readonly modality?: string | null;
    readonly deployment_config?: DeploymentConfigDeclarationLike | null;
  } | null;
  readonly version?: string | null;
}

// Re-exported (not re-declared) from the shared, provider-neutral normalizer
// so setup and runtime injection's generator describe one field contract,
// not two independently-maintained copies of the same shape.
export type StaticSecretSetupFieldType = StaticSecretFieldType;
export type StaticSecretSetupFieldLike = StaticSecretCredentialCaptureFieldLike;
export type StaticSecretSetupField = NormalizedStaticSecretField;
export type StaticSecretCredentialCaptureSetup = NormalizedStaticSecretCredentialCapture;

export interface ManualUploadSetup {
  readonly acceptedFileExtensions: readonly string[];
  readonly acceptedFileNames: readonly string[];
  readonly acquisitionMethods: readonly ManualUploadAcquisitionMethod[];
  readonly description: string | null;
  readonly helpText: string | null;
  readonly helpUrl: string | null;
  readonly importDirEnvVar: string | null;
  readonly label: string;
  readonly largeFileFallback: string | null;
  readonly validation: ManualUploadValidation | null;
  readonly validationExpectations: readonly string[];
}

export interface ManualUploadAcquisitionMethodLike {
  readonly detail?: string | null;
  readonly help_url?: string | null;
  readonly label?: string | null;
  readonly platform?: string | null;
  readonly posture?: string | null;
}

export interface ManualUploadAcquisitionMethod {
  readonly detail: string | null;
  readonly helpUrl: string | null;
  readonly label: string;
  readonly platform: string | null;
  readonly posture: string | null;
}

export interface ManualUploadValidationLike {
  /** Declares that this kind's validator accepts a caller-owned file
   *  descriptor (fd-backed, never buffers the whole artifact) rather than
   *  requiring the full artifact bytes in memory first. A generic RI-side
   *  capability flag, not a connector identity -- RI reads this boolean to
   *  decide WHICH shared dispatcher to call
   *  (validateManualUploadArtifactFromFileByKind vs.
   *  validateManualUploadArtifactByKind), never which connector it is. */
  readonly file_backed?: boolean | null;
  readonly kind?: string | null;
  readonly max_file_bytes?: number | null;
}

export interface ManualUploadValidation {
  readonly fileBacked: boolean;
  readonly kind: string;
  readonly maxFileBytes: number | null;
}

export interface ConnectorSetupDeploymentBlocker {
  readonly key: string;
  readonly label: string;
  readonly secret: boolean;
}

export interface ConnectorSetupDeploymentReadiness {
  readonly blockers: readonly ConnectorSetupDeploymentBlocker[];
  readonly guidance: string | null;
  readonly state: "not_applicable" | "ready" | "needs_config";
}

export interface ConnectionSetupPlan {
  readonly catalogDisposition: ConnectorCatalogDisposition;
  readonly connectorKey: string;
  readonly connectorModality: ConnectorIntentModality;
  readonly deploymentReadiness: ConnectorSetupDeploymentReadiness;
  readonly displayName: string;
  readonly enrollmentKey?: string;
  readonly nextStepKind: ConnectorSetupNextStepKind;
  readonly ownerAgentIntent: {
    readonly method: "POST" | null;
    readonly nextStepKind: ConnectorSetupNextStepKind;
    readonly reason: string;
    readonly status: ConnectorSetupSupportState;
  };
  readonly proofGate: string | null;
  readonly runbookPath: string | null;
  readonly setupModality: ConnectorSetupModality;
  readonly supportState: ConnectorSetupSupportState;
  // Whether the owner-facing setup validates the credential synchronously at
  // capture (a connector with a `probeCredential` hook echoes the account
  // identity in ≤10s) or only at `first_sync` (the connection activates when
  // the first ingest accepts records). Reference-only; projected from the probe
  // registry, never a Collection Profile message. Always `first_sync` for
  // modalities without a synchronous probe.
  readonly validationMode: CredentialValidationMode;
}

// The enrollment-key (bundle-directory-id) form of every manifest declaring
// capabilities.proven.local_collector === true. LEGACY_LOCAL_ALIASES is
// generated from LOCAL_COLLECTOR_DEFINITIONS (the connector package's own
// local-collector bundle registry) keyed by bundle id -> canonical manifest
// key; inverting it here (rather than re-deriving from canonical keys
// forward) means a local-collector connector whose bundle id already equals
// its canonical key still resolves correctly. See
// connector-registry.generated.ts.
const CANONICAL_TO_ENROLLMENT_KEY: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(LEGACY_LOCAL_ALIASES).map(([enrollmentKey, canonicalKey]) => [canonicalKey, enrollmentKey])
  )
);

export const SUPPORTED_LOCAL_COLLECTOR_CONNECTORS: readonly string[] = Object.freeze(
  LOCAL_COLLECTOR_PROVEN_KEYS.map((canonicalKey) => CANONICAL_TO_ENROLLMENT_KEY[canonicalKey] ?? canonicalKey)
);

export type SupportedLocalCollectorConnector = (typeof SUPPORTED_LOCAL_COLLECTOR_CONNECTORS)[number];

// Every manifest declaring a runtime_requirements.bindings.browser binding —
// see connector-registry.generated.ts. Equivalent to filtering the manifest
// set through classifyConnectorIntentModality === "browser_bound", expressed
// as generated data so this module (imported by apps/console; must stay
// node:fs-free) never hand-copies the connector-id list.
export const BROWSER_BOUND_CONNECTORS: readonly string[] = BROWSER_BOUND_KEYS;

export type BrowserBoundConnector = (typeof BROWSER_BOUND_CONNECTORS)[number];

/**
 * Browser enrollment is available when the shipped manifest/runtime pair is
 * both browser-bound and production-ready. The conformance roster is the
 * connector package's authority for the latter: it is checked against
 * an owner-visible lifecycle tier and each entry names a real collection
 * oracle. Deriving this intersection keeps a scaffold such as Anthropic out
 * without maintaining a second browser setup allowlist.
 */
export type SupportedBrowserCollectorConnector = Extract<
  BrowserBoundConnector,
  keyof typeof PRODUCTION_READY_CONNECTORS
>;

export const SUPPORTED_BROWSER_COLLECTOR_CONNECTORS: readonly SupportedBrowserCollectorConnector[] = Object.freeze(
  BROWSER_BOUND_CONNECTORS.filter((connector): connector is SupportedBrowserCollectorConnector =>
    Object.hasOwn(PRODUCTION_READY_CONNECTORS, connector)
  )
);

/**
 * Whether this connector key names a KNOWN scaffold: manifest ships,
 * registers, and validates, but its `collect()` is an unconditional
 * `SKIP_RESULT` placeholder with no real parsing/pagination/cursor logic.
 * `connector-conformance-roster.ts`'s `KNOWN_SCAFFOLD_CONNECTORS` is the
 * single hand-maintained list this reads (kept disjoint from
 * `PRODUCTION_READY_CONNECTORS` and `REAL_UNLISTED_CONNECTORS` by
 * `connector-conformance.test.ts`), so a Development-tier connector never
 * needs a second allowlist to tell "unproven but real" apart from
 * "unimplemented": a genuine stub must never render an add action, even
 * inside a Development disclosure, because clicking it can never collect
 * anything.
 */
export function isKnownScaffoldConnector(connectorKey: string | null | undefined): boolean {
  return (
    typeof connectorKey === "string" &&
    (KNOWN_SCAFFOLD_CONNECTORS as readonly string[]).includes(canonicalConnectorKey(connectorKey) ?? connectorKey)
  );
}

export const PROVIDER_AUTH_RUNBOOK_PATH = "docs/operator/add-connection.md";

// Connector keys for which the provider-authorization lifecycle (initiate +
// callback + token-exchange + inventory gate) is deterministically proven.
// Only connectors in this set may advertise `open_provider_auth` as a supported
// next step. Real production connectors must NOT be added here until their
// connector-specific inventory/test adapter is implemented and proven.
//
// "test_provider" is a synthetic connector constructed only by the
// deterministic test suite (test/provider-auth-lifecycle.test.ts fixtures);
// it has no manifest file, so it cannot be manifest-derived and stays a
// literal code-level addition alongside the generated,
// capabilities.proven.provider_auth_lifecycle-backed entries. See
// connector-registry.generated.ts.
export const PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS: readonly string[] = Object.freeze([
  "test_provider",
  ...PROVIDER_AUTH_LIFECYCLE_PROVEN_KEYS,
]);

export type ProviderAuthLifecycleProvenConnector = (typeof PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS)[number];

export function isProviderAuthLifecycleProven(connectorKey: string): boolean {
  return PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS.includes(canonicalConnectorKey(connectorKey));
}

// Connector keys for which the static-secret credential flow (draft → capture →
// first ingest) has been proven end-to-end via a live env-free container run.
// This is a proof gate, not a classification: it is generated from each
// manifest's capabilities.proven.static_secret_live.proven declaration (see
// connector-registry.generated.ts), which also carries the run_id/date/note
// evidence for each proof — this module only reads the boolean.
export const STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS: readonly string[] = STATIC_SECRET_LIVE_PROVEN_KEYS;

export type StaticSecretLiveProvenConnector = (typeof STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS)[number];

export function isStaticSecretLiveProven(connectorKey: string): boolean {
  return STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS.includes(canonicalConnectorKey(connectorKey));
}

/**
 * Whether a static-secret connector qualifies for owner opt-in UAT today.
 *
 * Capability-derived, not a hardcoded per-connector list: any connector whose
 * manifest declares a real `credential_capture` block (a secret field, a
 * label, a submit action — the same shape the live-proven connectors use)
 * reaches the exact same generic capture-form → draft-connection →
 * first-sync route already proven for gmail/github/slack/ynab. The only
 * thing distinguishing "experimental" from "supported" is that no owner has
 * completed a live run yet, which `STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS`
 * still tracks.
 *
 * This check does NOT consult `capabilities.public_listing`: lifecycle tier
 * controls offering, while this function answers whether the generic static-
 * secret path is technically available. The console combines both facts.
 */
export function isStaticSecretExperimentalEligible(manifest: ConnectorManifestLike | null): boolean {
  return staticSecretCredentialCaptureFromManifest(manifest) !== null;
}

const NOT_APPLICABLE_DEPLOYMENT_READINESS: ConnectorSetupDeploymentReadiness = Object.freeze({
  blockers: [],
  guidance: null,
  state: "not_applicable",
});

const READY_DEPLOYMENT_READINESS: ConnectorSetupDeploymentReadiness = Object.freeze({
  blockers: [],
  guidance: null,
  state: "ready",
});

const FIRST_PARTY_REGISTRY_PREFIX = "https://registry.pdpp.dev/connectors/";
const SECRET_DEPLOYMENT_KEY_RE = /SECRET|TOKEN|PASSWORD|KEY/i;
const TRAILING_SLASH_RE = /\/$/;

function stripRegistryPrefix(connectorId: string): string {
  if (connectorId.startsWith(FIRST_PARTY_REGISTRY_PREFIX)) {
    return connectorId.slice(FIRST_PARTY_REGISTRY_PREFIX.length).replace(TRAILING_SLASH_RE, "");
  }
  return connectorId;
}

export function canonicalConnectorKey(connectorId: string): string {
  return stripRegistryPrefix(connectorId.trim());
}

export function connectorKeyFromManifest(manifest: ConnectorManifestLike, fallback?: string | null): string | null {
  const raw =
    manifest.connector_key?.trim() || manifest.connector_id?.trim() || (typeof fallback === "string" ? fallback : "");
  return raw ? canonicalConnectorKey(raw) : null;
}

// Two canonical keys have a registry-URL slug that differs from the
// connector directory / bundled-registry id (LOCAL_COLLECTOR_DEFINITIONS is
// keyed by `connector_id`, which uses underscores for both): claude-code and
// google-takeout. Every other bundled connector's canonical key already
// equals its directory name.
//
// Derived from connector-key.ts's legacyLocalAliasMap() (legacy snake_case ->
// canonical hyphenated key) by inverting it, rather than hand-maintaining a
// second copy of the same mapping — that second copy had already diverged
// from a third one in auth.ts. See
// docs/inbox/report-connector-knowledge-clusters-bc.md. `codex` maps to
// itself in legacyLocalAliasMap() and is intentionally excluded here (no
// entry needed for an identity mapping).
const HYPHENATED_CANONICAL_KEY_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(legacyLocalAliasMap())
    .filter(([legacyKey, canonicalKey]) => legacyKey !== canonicalKey)
    .map(([legacyKey, canonicalKey]) => [canonicalKey, legacyKey])
);

export function enrollmentKeyForCanonicalKey(canonicalKey: string): string {
  const key = canonicalConnectorKey(canonicalKey);
  return HYPHENATED_CANONICAL_KEY_ALIASES[key] ?? key;
}

export function displayNameForConnector(connectorKey: string, manifest?: ConnectorManifestLike | null): string {
  return manifest?.display_name?.trim() || manifest?.name?.trim() || connectorKey;
}

function cleanString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Delegates to the shared, provider-neutral normalizer
 * (`packages/polyfill-connectors/src/static-secret-credential-capture.ts`) so
 * setup and runtime injection's generator derive a connector's static-secret
 * classification and field contract from ONE predicate. See that module's
 * doc for why this can throw `StaticSecretCredentialCaptureError` (a secret
 * field missing `label` or `env` is a manifest contract violation, not a
 * value to silently drop) and for the `type: "password"` implies-secret
 * rule.
 */
export function staticSecretCredentialCaptureFromManifest(
  manifest: ConnectorManifestLike | null | undefined
): StaticSecretCredentialCaptureSetup | null {
  const connectorKey = cleanString(manifest?.connector_key) ?? cleanString(manifest?.connector_id) ?? "unknown";
  return normalizeStaticSecretCredentialCapture(connectorKey, manifest?.setup?.credential_capture);
}

export function manualUploadSetupFromManifest(
  manifest: ConnectorManifestLike | null | undefined
): ManualUploadSetup | null {
  if (manifest?.setup?.modality !== "manual_or_upload") {
    return null;
  }
  const meta = manifest.setup.manual_or_upload;
  const acceptedFileNames = Array.isArray(meta?.accepted_file_names)
    ? meta.accepted_file_names.filter((value): value is string => cleanString(value) !== null)
    : [];
  const acceptedFileExtensions = Array.isArray(meta?.accepted_file_extensions)
    ? meta.accepted_file_extensions
        .map((value) => cleanString(value))
        .filter((value): value is string => value !== null)
        .map((value) => (value.startsWith(".") ? value.toLowerCase() : `.${value.toLowerCase()}`))
    : [];
  const acquisitionMethods = Array.isArray(meta?.acquisition_methods)
    ? meta.acquisition_methods
        .map((method): ManualUploadAcquisitionMethod | null => {
          const label = cleanString(method?.label);
          if (!label) {
            return null;
          }
          return {
            detail: cleanString(method?.detail),
            helpUrl: cleanString(method?.help_url),
            label,
            platform: cleanString(method?.platform),
            posture: cleanString(method?.posture),
          };
        })
        .filter((method): method is ManualUploadAcquisitionMethod => method !== null)
    : [];
  const validationKind = cleanString(meta?.validation?.kind);
  const maxFileBytes =
    typeof meta?.validation?.max_file_bytes === "number" && Number.isFinite(meta.validation.max_file_bytes)
      ? meta.validation.max_file_bytes
      : null;
  const fileBacked = meta?.validation?.file_backed === true;
  return {
    acceptedFileExtensions,
    acceptedFileNames,
    acquisitionMethods,
    description: cleanString(meta?.description),
    helpText: cleanString(meta?.help_text),
    helpUrl: cleanString(meta?.help_url),
    importDirEnvVar: cleanString(meta?.import_dir_env_var),
    label: cleanString(meta?.label) ?? "Import file",
    largeFileFallback: cleanString(meta?.large_file_fallback),
    validation: validationKind ? { fileBacked, kind: validationKind, maxFileBytes } : null,
    validationExpectations: Array.isArray(meta?.validation_expectations)
      ? meta.validation_expectations.filter((value): value is string => cleanString(value) !== null)
      : [],
  };
}

export function expectedStaticSecretCredentialKind(
  _connectorId: string,
  manifest?: ConnectorManifestLike | null
): string | null {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  return staticSecretCredentialCaptureFromManifest(manifest)?.kind ?? null;
}

export function isSupportedLocalCollectorConnector(
  connectorId: string | null | undefined
): connectorId is SupportedLocalCollectorConnector {
  return (
    typeof connectorId === "string" &&
    (SUPPORTED_LOCAL_COLLECTOR_CONNECTORS as readonly string[]).includes(enrollmentKeyForCanonicalKey(connectorId))
  );
}

export function isSupportedBrowserCollectorConnector(
  connectorId: string | null | undefined
): connectorId is SupportedBrowserCollectorConnector {
  return (
    typeof connectorId === "string" &&
    (SUPPORTED_BROWSER_COLLECTOR_CONNECTORS as readonly string[]).includes(canonicalConnectorKey(connectorId))
  );
}

export function isStaticSecretConnector(
  connectorId: string | null | undefined,
  manifest?: ConnectorManifestLike | null
): boolean {
  return typeof connectorId === "string" && expectedStaticSecretCredentialKind(connectorId, manifest) !== null;
}

export function isBrowserBoundConnector(connectorId: string | null | undefined): boolean {
  return (
    typeof connectorId === "string" &&
    (BROWSER_BOUND_CONNECTORS as readonly string[]).includes(canonicalConnectorKey(connectorId))
  );
}

export function classifyConnectorIntentModality(manifest: ConnectorManifestLike | null): ConnectorIntentModality {
  if (!manifest) {
    return "unknown";
  }
  const bindings = manifest.runtime_requirements?.bindings;
  if (!bindings || typeof bindings !== "object") {
    return "unknown";
  }
  if (Object.hasOwn(bindings, "filesystem")) {
    return "local_collector";
  }
  if (Object.hasOwn(bindings, "browser")) {
    return "browser_bound";
  }
  if (Object.hasOwn(bindings, "network")) {
    return "api_network";
  }
  return "unknown";
}

function authKindFromManifest(manifest: ConnectorManifestLike | null): string | null {
  const raw =
    manifest?.setup?.modality ??
    manifest?.capabilities?.auth?.kind ??
    manifest?.capabilities?.auth?.mode ??
    manifest?.capabilities?.auth?.type ??
    null;
  return typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : null;
}

export function classifyConnectorSetupModality(
  _connectorKey: string,
  manifest: ConnectorManifestLike | null
): ConnectorSetupModality {
  const authKind = authKindFromManifest(manifest);
  if (
    authKind === "manual_or_upload" ||
    authKind === "manual-upload" ||
    authKind === "manual_upload" ||
    authKind === "file_import" ||
    authKind === "upload"
  ) {
    return "manual_or_upload";
  }
  if (staticSecretCredentialCaptureFromManifest(manifest)) {
    return "static_secret";
  }
  const connectorModality = classifyConnectorIntentModality(manifest);
  if (connectorModality === "local_collector") {
    return "local_collector";
  }
  if (connectorModality === "browser_bound") {
    return "browser_bound";
  }
  if (connectorModality === "api_network") {
    if (
      authKind === "oauth" ||
      authKind === "oauth2" ||
      authKind === "provider_authorization" ||
      authKind === "provider-authorization"
    ) {
      return "provider_authorization";
    }
    return "unsupported";
  }
  return connectorModality;
}

/**
 * One normalized `deployment_config` entry. `logicalKey` is always the
 * operator-facing/blocker identity (never `envAlias`, never leaked to any
 * client-visible surface). `envAlias`, when the manifest declares one, is
 * the *only* env var name this module will ever read for that entry — a
 * legacy bare-string or `{key,label,secret}` entry has no separate alias, so
 * its own key string doubles as the env lookup name (preserves today's
 * behavior for any manifest not yet migrated to the logical-key shape).
 */
interface NormalizedDeploymentConfigEntry {
  readonly envAlias: string | null;
  readonly label: string | null;
  readonly logicalKey: string;
  readonly secret: boolean | null;
}

// Accepts the legacy bare-string-array shape, the {key,label,secret} object
// shape, and the current {logical_key,label,secret,env_alias} shape declared
// by DeploymentConfigDeclarationLike, normalizing all three to one record
// shape. The RI never re-derives label/secret by guessing at a legacy shape
// when the manifest already declares them.
function trimmedOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function trimmedOrEmpty(value: unknown): string {
  return trimmedOrNull(value) ?? "";
}

function secretFlagOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizedBareStringEntry(entry: string): NormalizedDeploymentConfigEntry | null {
  const logicalKey = entry.trim();
  return logicalKey ? { envAlias: null, label: null, logicalKey, secret: null } : null;
}

function normalizedLogicalKeyEntry(entry: DeploymentConfigLogicalKeyLike): NormalizedDeploymentConfigEntry | null {
  const logicalKey = trimmedOrEmpty(entry.logical_key);
  if (!logicalKey) {
    return null;
  }
  return {
    envAlias: trimmedOrNull(entry.env_alias),
    label: trimmedOrNull(entry.label),
    logicalKey,
    secret: secretFlagOrNull(entry.secret),
  };
}

function normalizedLegacyKeyEntry(entry: DeploymentConfigKeyLike): NormalizedDeploymentConfigEntry | null {
  const logicalKey = trimmedOrEmpty(entry.key);
  if (!logicalKey) {
    return null;
  }
  return { envAlias: null, label: trimmedOrNull(entry.label), logicalKey, secret: secretFlagOrNull(entry.secret) };
}

function normalizedDeploymentConfigEntry(
  entry: string | DeploymentConfigKeyLike | DeploymentConfigLogicalKeyLike | null
): NormalizedDeploymentConfigEntry | null {
  if (typeof entry === "string") {
    return normalizedBareStringEntry(entry);
  }
  if (!entry) {
    return null;
  }
  return "logical_key" in entry ? normalizedLogicalKeyEntry(entry) : normalizedLegacyKeyEntry(entry);
}

function normalizedDeploymentConfigEntries(
  declaration: DeploymentConfigDeclarationLike | null | undefined
): readonly NormalizedDeploymentConfigEntry[] {
  if (!Array.isArray(declaration)) {
    return [];
  }
  return declaration
    .map(normalizedDeploymentConfigEntry)
    .filter((entry): entry is NormalizedDeploymentConfigEntry => entry !== null);
}

function deploymentConfigEntriesFromManifest(
  manifest: ConnectorManifestLike | null
): readonly NormalizedDeploymentConfigEntry[] {
  const setupEntries = normalizedDeploymentConfigEntries(manifest?.setup?.deployment_config);
  if (setupEntries.length > 0) {
    return setupEntries;
  }
  const authEntries = normalizedDeploymentConfigEntries(manifest?.capabilities?.auth?.deployment_config);
  if (authEntries.length > 0) {
    return authEntries;
  }
  return (manifest?.capabilities?.auth?.required ?? [])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((key) => ({ envAlias: null, label: null, logicalKey: key, secret: null }));
}

/**
 * The observed deployment environment. Injected rather than read directly so
 * this module stays a pure function of its inputs and a test can describe a
 * deployment without mutating the process. Callers ahead of a
 * provider-auth-relevant response pre-resolve this by merging `process.env`
 * with a DB-backed provider-app-config lookup (env-first, then DB) for any
 * declared `env_alias` missing from the process environment — this module
 * itself never talks to that store, keeping it a pure sync function.
 */
export interface DeploymentEnvLike {
  readonly [key: string]: string | undefined;
}

function needsDeploymentConfig(
  missingEntries: readonly NormalizedDeploymentConfigEntry[]
): ConnectorSetupDeploymentReadiness {
  return {
    blockers: missingEntries.map((entry) => ({
      key: entry.logicalKey,
      label: entry.label ?? entry.logicalKey,
      secret: entry.secret ?? SECRET_DEPLOYMENT_KEY_RE.test(entry.logicalKey),
    })),
    guidance:
      "Configure the instance-level provider application first. After that, each owner authorizes their own account through an owner-mediated provider authorization step.",
    state: "needs_config",
  };
}

function buildDeploymentReadiness(args: {
  readonly connectorKey: string;
  readonly configuredProviderAuthConnectorKeys?: readonly string[];
  readonly deploymentEnv?: DeploymentEnvLike;
  readonly manifest: ConnectorManifestLike | null;
  readonly requiredKeys?: readonly string[];
  readonly setupModality: ConnectorSetupModality;
}): ConnectorSetupDeploymentReadiness {
  if (args.setupModality !== "provider_authorization") {
    return NOT_APPLICABLE_DEPLOYMENT_READINESS;
  }
  const requiredEntries = args.requiredKeys?.length
    ? args.requiredKeys.map((key) => ({ envAlias: null, label: null, logicalKey: key, secret: null }))
    : deploymentConfigEntriesFromManifest(args.manifest);
  // A manifest that declares its deployment prerequisites is answered from
  // those entries against the observed environment. Readiness is then a
  // property of the DEPLOYMENT, not of the connector's identity: any
  // connector whose declared settings are all present reads ready, and any
  // connector missing one reads needs_config with that exact setting named.
  // Only a manifest declaring NO entries falls back to the adapter allowlist
  // below, which is the one case where this module has nothing to measure.
  if (requiredEntries.length > 0) {
    const env = args.deploymentEnv ?? process.env;
    // A setting counts as supplied only when it holds a non-blank value,
    // read by its declared env_alias (or its own key, for legacy entries
    // with no separate alias) — never by logicalKey directly, since
    // logicalKey is an operator-facing role name, not an env var name.
    const missing = requiredEntries.filter(
      (entry) => (env[entry.envAlias ?? entry.logicalKey] ?? "").trim().length === 0
    );
    return missing.length === 0 ? READY_DEPLOYMENT_READINESS : needsDeploymentConfig(missing);
  }
  const configured = new Set((args.configuredProviderAuthConnectorKeys ?? []).map(canonicalConnectorKey));
  if (configured.has(args.connectorKey)) {
    return READY_DEPLOYMENT_READINESS;
  }
  return needsDeploymentConfig([
    { envAlias: null, label: null, logicalKey: `${args.connectorKey.toUpperCase()}_OAUTH_CLIENT`, secret: null },
  ]);
}

export function unsupportedReason(modality: ConnectorIntentModality | ConnectorSetupModality): string {
  if (modality === "browser_bound") {
    return "This connector is browser-bound. The browser-collector enrollment primitive (`browser_collector` source kind plus binding-aware enrollment) already ships, but end-to-end proof that a real owner-logged-in browser session ingests through that path is still gated. The setup plan stays proof-gated until that live proof lands.";
  }
  if (modality === "static_secret" || modality === "api_network") {
    return "This API/network connector authenticates with a static provider secret declared by its connector manifest; there is no OAuth authorization URL. Use the owner-session static-secret setup page to create a draft, capture the provider secret, and start first sync. The connection stays hidden until first ingest accepts records.";
  }
  if (modality === "provider_authorization") {
    return "This connector needs provider authorization. The reference distinguishes deployment-level provider app readiness from per-owner authorization, but this build does not yet ship the callback/token-exchange lifecycle that proves an active connection only after authorization and account inventory or a connection test succeeds.";
  }
  if (modality === "local_collector") {
    return "This filesystem-backed connector is not in the proven local-collector enrollment set yet. The reference can classify it as local-collector class, but it must not advertise setup until a connector-specific local collector path is proven.";
  }
  if (modality === "manual_or_upload") {
    return "This connector imports an owner-provided file or artifact declared by its connector manifest. The reference recognizes the setup class, but the generic owner upload/import capture flow is not packaged yet.";
  }
  return "Unknown connector: no manifest with runtime binding requirements is registered for this connector_id. Register the connector or check the connector_id.";
}

type ConnectionSetupPlanContext = Readonly<{
  connectorKey: string;
  connectorModality: ConnectorIntentModality;
  deploymentReadiness: ConnectorSetupDeploymentReadiness;
  displayName: string;
  enrollmentKey: string;
  manifest: ConnectorManifestLike | null;
  setupModality: ConnectorSetupModality;
  validationMode: CredentialValidationMode;
}>;

function buildManualUploadSetupPlan(ctx: ConnectionSetupPlanContext): ConnectionSetupPlan {
  const uploadSetup = manualUploadSetupFromManifest(ctx.manifest);
  if (uploadSetup?.importDirEnvVar) {
    return {
      catalogDisposition: "manual_upload_connect",
      connectorKey: ctx.connectorKey,
      connectorModality: ctx.connectorModality,
      deploymentReadiness: ctx.deploymentReadiness,
      displayName: ctx.displayName,
      nextStepKind: "provide_import_file",
      ownerAgentIntent: {
        method: "POST",
        nextStepKind: "provide_import_file",
        reason:
          "Upload the owner-provided import file from the owner session. The connection activates after the first accepted ingest.",
        status: "supported",
      },
      proofGate: null,
      runbookPath: null,
      setupModality: ctx.setupModality,
      supportState: "supported",
      validationMode: ctx.validationMode,
    };
  }
  return {
    catalogDisposition: "manual_upload_pending",
    connectorKey: ctx.connectorKey,
    connectorModality: ctx.connectorModality,
    deploymentReadiness: ctx.deploymentReadiness,
    displayName: ctx.displayName,
    nextStepKind: "provide_import_file",
    ownerAgentIntent: {
      method: null,
      nextStepKind: "provide_import_file",
      reason: unsupportedReason(ctx.setupModality),
      status: "proof_gated",
    },
    proofGate: "manual_upload_capture_missing",
    runbookPath: null,
    setupModality: ctx.setupModality,
    supportState: "proof_gated",
    validationMode: ctx.validationMode,
  };
}

function buildLocalCollectorSetupPlan(ctx: ConnectionSetupPlanContext): ConnectionSetupPlan {
  if (isSupportedLocalCollectorConnector(ctx.enrollmentKey)) {
    return {
      catalogDisposition: "local_collector_enroll",
      connectorKey: ctx.connectorKey,
      connectorModality: ctx.connectorModality,
      deploymentReadiness: ctx.deploymentReadiness,
      displayName: ctx.displayName,
      enrollmentKey: ctx.enrollmentKey,
      nextStepKind: "enroll_local_collector",
      ownerAgentIntent: {
        method: "POST",
        nextStepKind: "enroll_local_collector",
        reason:
          "Create an owner-mediated local-collector enrollment intent. The connection materializes only after the owner's local collector exchanges the enrollment code and ingests.",
        status: "supported",
      },
      proofGate: null,
      runbookPath: null,
      setupModality: ctx.setupModality,
      supportState: "supported",
      validationMode: ctx.validationMode,
    };
  }
  return {
    catalogDisposition: "local_collector_unproven",
    connectorKey: ctx.connectorKey,
    connectorModality: ctx.connectorModality,
    deploymentReadiness: ctx.deploymentReadiness,
    displayName: ctx.displayName,
    nextStepKind: "unsupported",
    ownerAgentIntent: {
      method: null,
      nextStepKind: "manual_runbook",
      reason: unsupportedReason(ctx.connectorModality),
      status: "proof_gated",
    },
    proofGate: "local_collector_connector_proof_missing",
    runbookPath: null,
    setupModality: ctx.setupModality,
    supportState: "proof_gated",
    validationMode: ctx.validationMode,
  };
}

function buildBrowserBoundSetupPlan(ctx: ConnectionSetupPlanContext): ConnectionSetupPlan {
  const hasManualBrowserPath = isSupportedBrowserCollectorConnector(ctx.connectorKey);
  return {
    catalogDisposition: hasManualBrowserPath ? "browser_collector_manual" : "browser_bound_runbook",
    connectorKey: ctx.connectorKey,
    connectorModality: ctx.connectorModality,
    deploymentReadiness: ctx.deploymentReadiness,
    displayName: ctx.displayName,
    ...(hasManualBrowserPath ? { enrollmentKey: ctx.enrollmentKey } : {}),
    nextStepKind: hasManualBrowserPath ? "enroll_browser_collector" : "manual_runbook",
    ownerAgentIntent: {
      method: null,
      nextStepKind: "manual_runbook",
      reason: unsupportedReason(ctx.connectorModality),
      status: "proof_gated",
    },
    proofGate: "browser_collector_live_proof_missing",
    runbookPath: null,
    setupModality: ctx.setupModality,
    supportState: "proof_gated",
    validationMode: ctx.validationMode,
  };
}

function buildStaticSecretSetupPlan(ctx: ConnectionSetupPlanContext): ConnectionSetupPlan {
  const liveProven = isStaticSecretLiveProven(ctx.connectorKey);
  if (liveProven) {
    return {
      catalogDisposition: "static_secret_connect",
      connectorKey: ctx.connectorKey,
      connectorModality: ctx.connectorModality,
      deploymentReadiness: ctx.deploymentReadiness,
      displayName: ctx.displayName,
      nextStepKind: "capture_static_secret",
      ownerAgentIntent: {
        method: "POST",
        nextStepKind: "capture_static_secret",
        reason:
          "Initiate static-secret credential capture from the owner session. The connection activates after the secret is validated and first ingest succeeds.",
        status: "supported",
      },
      proofGate: null,
      runbookPath: null,
      setupModality: ctx.setupModality,
      supportState: "supported",
      validationMode: ctx.validationMode,
    };
  }
  // Browser-bound connectors with stored-credential capture (e.g. amazon) keep
  // their existing static_secret_connect/browser-session presentation — that
  // path already has its own dedicated UI treatment
  // (`browserBoundWithStoredCredentials`) independent of live-proof status,
  // and promoting it to "experimental" here would just be new, unrequested
  // scope on a connector this task never asked to touch.
  const experimentalEligible =
    ctx.connectorModality !== "browser_bound" && isStaticSecretExperimentalEligible(ctx.manifest);
  if (experimentalEligible) {
    return {
      catalogDisposition: "static_secret_experimental",
      connectorKey: ctx.connectorKey,
      connectorModality: ctx.connectorModality,
      deploymentReadiness: ctx.deploymentReadiness,
      displayName: ctx.displayName,
      nextStepKind: "capture_static_secret",
      ownerAgentIntent: {
        method: "POST",
        nextStepKind: "capture_static_secret",
        reason:
          "Experimental. This setup path has not completed live validation. Continue to test it with your own data.",
        status: "experimental",
      },
      proofGate: "static_secret_live_proof_missing",
      runbookPath: null,
      setupModality: ctx.setupModality,
      supportState: "experimental",
      validationMode: ctx.validationMode,
    };
  }
  return {
    catalogDisposition: "static_secret_connect",
    connectorKey: ctx.connectorKey,
    connectorModality: ctx.connectorModality,
    deploymentReadiness: ctx.deploymentReadiness,
    displayName: ctx.displayName,
    nextStepKind: "capture_static_secret",
    ownerAgentIntent: {
      method: null,
      nextStepKind: "capture_static_secret",
      reason: unsupportedReason(ctx.setupModality),
      status: "proof_gated",
    },
    proofGate: "static_secret_live_proof_missing",
    runbookPath: null,
    setupModality: ctx.setupModality,
    supportState: "proof_gated",
    validationMode: ctx.validationMode,
  };
}

function buildProviderAuthorizationSetupPlan(ctx: ConnectionSetupPlanContext): ConnectionSetupPlan {
  const deploymentBlocked = ctx.deploymentReadiness.state === "needs_config";
  const lifecycleProven = !deploymentBlocked && isProviderAuthLifecycleProven(ctx.connectorKey);
  if (lifecycleProven) {
    return {
      catalogDisposition: "provider_auth_connect",
      connectorKey: ctx.connectorKey,
      connectorModality: ctx.connectorModality,
      deploymentReadiness: ctx.deploymentReadiness,
      displayName: ctx.displayName,
      nextStepKind: "open_provider_auth",
      ownerAgentIntent: {
        method: "POST",
        nextStepKind: "open_provider_auth",
        reason:
          "Initiate provider authorization from the owner session. The callback will activate the connection only after authorization and account inventory succeed.",
        status: "supported",
      },
      proofGate: null,
      runbookPath: null,
      setupModality: ctx.setupModality,
      supportState: "supported",
      validationMode: ctx.validationMode,
    };
  }
  return {
    catalogDisposition: deploymentBlocked ? "provider_auth_deployment_blocked" : "provider_auth_proof_gated",
    connectorKey: ctx.connectorKey,
    connectorModality: ctx.connectorModality,
    deploymentReadiness: ctx.deploymentReadiness,
    displayName: ctx.displayName,
    nextStepKind: deploymentBlocked ? "needs_deployment_config" : "manual_runbook",
    ownerAgentIntent: {
      method: null,
      nextStepKind: deploymentBlocked ? "needs_deployment_config" : "manual_runbook",
      reason: deploymentBlocked
        ? (ctx.deploymentReadiness.guidance ?? unsupportedReason(ctx.setupModality))
        : unsupportedReason(ctx.setupModality),
      status: deploymentBlocked ? "needs_deployment_config" : "proof_gated",
    },
    proofGate: deploymentBlocked
      ? "provider_app_deployment_config_missing"
      : "provider_authorization_lifecycle_missing",
    runbookPath: PROVIDER_AUTH_RUNBOOK_PATH,
    setupModality: ctx.setupModality,
    supportState: deploymentBlocked ? "needs_deployment_config" : "proof_gated",
    validationMode: ctx.validationMode,
  };
}

function buildApiNetworkSetupPlan(ctx: ConnectionSetupPlanContext): ConnectionSetupPlan {
  if (ctx.setupModality === "static_secret") {
    return buildStaticSecretSetupPlan(ctx);
  }
  if (ctx.setupModality === "provider_authorization") {
    return buildProviderAuthorizationSetupPlan(ctx);
  }
  return {
    catalogDisposition: "api_network_unsupported",
    connectorKey: ctx.connectorKey,
    connectorModality: ctx.connectorModality,
    deploymentReadiness: ctx.deploymentReadiness,
    displayName: ctx.displayName,
    nextStepKind: "unsupported",
    ownerAgentIntent: {
      method: null,
      nextStepKind: "unsupported",
      reason:
        "This API/network connector has no owner-mediated connection setup route in this reference build. A supported setup path must be added before it can be created from Console, owner-agent REST, CLI, or SDK helpers.",
      status: "unsupported",
    },
    proofGate: null,
    runbookPath: null,
    setupModality: ctx.setupModality,
    supportState: "unsupported",
    validationMode: ctx.validationMode,
  };
}

function buildUnsupportedSetupPlan(ctx: ConnectionSetupPlanContext): ConnectionSetupPlan {
  return {
    catalogDisposition: "unknown_unsupported",
    connectorKey: ctx.connectorKey,
    connectorModality: ctx.connectorModality,
    deploymentReadiness: ctx.deploymentReadiness,
    displayName: ctx.displayName,
    nextStepKind: "unsupported",
    ownerAgentIntent: {
      method: null,
      nextStepKind: "unsupported",
      reason: unsupportedReason(ctx.connectorModality),
      status: "unsupported",
    },
    proofGate: null,
    runbookPath: null,
    setupModality: ctx.setupModality,
    supportState: "unsupported",
    validationMode: ctx.validationMode,
  };
}

export function buildConnectionSetupPlan(args: {
  readonly connectorKey?: string | null;
  readonly configuredProviderAuthConnectorKeys?: readonly string[];
  readonly deploymentEnv?: DeploymentEnvLike;
  readonly manifest: ConnectorManifestLike | null;
}): ConnectionSetupPlan {
  const rawConnectorKey = typeof args.connectorKey === "string" ? args.connectorKey.trim() : "";
  const connectorKey =
    (rawConnectorKey ? canonicalConnectorKey(rawConnectorKey) : null) ??
    connectorKeyFromManifest(args.manifest ?? {}, args.connectorKey) ??
    "unknown";
  const displayName = displayNameForConnector(connectorKey, args.manifest);
  const connectorModality = classifyConnectorIntentModality(args.manifest);
  const setupModality = classifyConnectorSetupModality(connectorKey, args.manifest);
  const deploymentArgs: {
    connectorKey: string;
    configuredProviderAuthConnectorKeys?: readonly string[];
    deploymentEnv?: DeploymentEnvLike;
    manifest: ConnectorManifestLike | null;
    setupModality: ConnectorSetupModality;
  } = {
    connectorKey,
    manifest: args.manifest,
    setupModality,
  };
  if (args.configuredProviderAuthConnectorKeys) {
    deploymentArgs.configuredProviderAuthConnectorKeys = args.configuredProviderAuthConnectorKeys;
  }
  if (args.deploymentEnv) {
    deploymentArgs.deploymentEnv = args.deploymentEnv;
  }
  const deploymentReadiness = buildDeploymentReadiness(deploymentArgs);
  const enrollmentKey = enrollmentKeyForCanonicalKey(connectorKey);
  // Synchronous validation only applies to static-secret connectors with a
  // registered probe. Everything else activates at first sync.
  const validationMode: CredentialValidationMode =
    setupModality === "static_secret" ? credentialValidationMode(connectorKey) : "first_sync";
  const ctx: ConnectionSetupPlanContext = {
    connectorKey,
    connectorModality,
    deploymentReadiness,
    displayName,
    enrollmentKey,
    manifest: args.manifest,
    setupModality,
    validationMode,
  };

  if (setupModality === "manual_or_upload") {
    return buildManualUploadSetupPlan(ctx);
  }

  if (setupModality === "static_secret") {
    return buildStaticSecretSetupPlan(ctx);
  }

  if (setupModality === "provider_authorization") {
    return buildProviderAuthorizationSetupPlan(ctx);
  }

  if (connectorModality === "local_collector") {
    return buildLocalCollectorSetupPlan(ctx);
  }

  if (connectorModality === "browser_bound") {
    return buildBrowserBoundSetupPlan(ctx);
  }

  if (connectorModality === "api_network") {
    return buildApiNetworkSetupPlan(ctx);
  }

  return buildUnsupportedSetupPlan(ctx);
}
