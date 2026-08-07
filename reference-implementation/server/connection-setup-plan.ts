// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { PRODUCTION_READY_CONNECTORS } from "../../packages/polyfill-connectors/src/connector-conformance-roster.ts";
import {
  type CredentialValidationMode,
  credentialValidationMode,
} from "../../packages/polyfill-connectors/src/credential-probe.ts";
import { legacyLocalAliasMap } from "./connector-key.ts";

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

export type DeploymentConfigDeclarationLike = readonly (string | DeploymentConfigKeyLike)[];

export interface ConnectorManifestLike {
  readonly capabilities?: {
    readonly auth?: {
      readonly kind?: string | null;
      readonly mode?: string | null;
      readonly type?: string | null;
      readonly required?: readonly string[] | null;
      readonly deployment_config?: DeploymentConfigDeclarationLike | null;
      readonly connection_config?: readonly string[] | null;
      readonly scopes?: readonly string[] | null;
      readonly exchanger_kind?: string | null;
      readonly authorization_url?: string | null;
      readonly token_url?: string | null;
      readonly userinfo_url?: string | null;
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

export type StaticSecretSetupFieldType = "email" | "password" | "text";

export interface StaticSecretSetupFieldLike {
  readonly autocomplete?: string | null;
  readonly description?: string | null;
  readonly env?: readonly string[] | null;
  readonly help_text?: string | null;
  readonly help_url?: string | null;
  readonly identity?: boolean | null;
  readonly label?: string | null;
  readonly name?: string | null;
  readonly placeholder?: string | null;
  readonly required?: boolean | null;
  readonly secret?: boolean | null;
  readonly type?: string | null;
}

export interface StaticSecretSetupField {
  readonly autocomplete: string | null;
  readonly description: string | null;
  readonly env: readonly string[];
  readonly helpText: string | null;
  readonly helpUrl: string | null;
  readonly identity: boolean;
  readonly label: string;
  readonly name: string;
  readonly placeholder: string | null;
  readonly required: boolean;
  readonly secret: boolean;
  readonly type: StaticSecretSetupFieldType;
}

export interface StaticSecretCredentialCaptureSetup {
  readonly description: string | null;
  readonly fields: readonly StaticSecretSetupField[];
  readonly kind: string;
  readonly label: string;
  readonly submitLabel: string | null;
}

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
  readonly kind?: string | null;
  readonly max_file_bytes?: number | null;
}

export interface ManualUploadValidation {
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

export const SUPPORTED_LOCAL_COLLECTOR_CONNECTORS = [
  "claude_code",
  "codex",
  "google_takeout",
  "imessage",
  "apple_photos",
  "google_messages",
] as const;

export type SupportedLocalCollectorConnector = (typeof SUPPORTED_LOCAL_COLLECTOR_CONNECTORS)[number];

export const BROWSER_BOUND_CONNECTORS = [
  "amazon",
  "anthropic",
  "chase",
  "chatgpt",
  "doordash",
  "heb",
  "linkedin",
  "loom",
  "meta",
  "reddit",
  "shopify",
  "uber",
  "usaa",
  "wholefoods",
] as const;

export type BrowserBoundConnector = (typeof BROWSER_BOUND_CONNECTORS)[number];

/**
 * Browser enrollment is available when the shipped manifest/runtime pair is
 * both browser-bound and production-ready. The conformance roster is the
 * connector package's authority for the latter: it is checked against
 * `capabilities.public_listing.listed` and each entry names a real collection
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

export const PROVIDER_AUTH_RUNBOOK_PATH = "docs/operator/add-connection.md";

// Connector keys for which the provider-authorization lifecycle (initiate +
// callback + token-exchange + inventory gate) is deterministically proven.
// Only connectors in this set may advertise `open_provider_auth` as a supported
// next step. Real production connectors must NOT be added here until their
// connector-specific inventory/test adapter is implemented and proven.
//
// "test_provider" is a synthetic connector used by the deterministic test suite
// to exercise the full lifecycle without live provider credentials.
export const PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS = ["test_provider", "google-maps-data-portability"] as const;

export type ProviderAuthLifecycleProvenConnector = (typeof PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS)[number];

export function isProviderAuthLifecycleProven(connectorKey: string): boolean {
  return (PROVIDER_AUTH_LIFECYCLE_PROVEN_CONNECTOR_KEYS as readonly string[]).includes(
    canonicalConnectorKey(connectorKey)
  );
}

// Connector keys for which the static-secret credential flow (draft → capture →
// first ingest) has been proven end-to-end via a live env-free container run.
// Live proof recorded 2026-06-10T22:55Z (ri-owner-current-state.md window
// "STORE-ONLY CREDENTIAL POSTURE LIVE AND PROVEN"):
//   gmail  — run_1781131328336 completed/succeeded, env-free container
//   github — run_1781131195649 completed/succeeded, env-free container
//           + run_1781131489458 trigger_kind=scheduled unattended succeeded (4 records)
//   slack  — run_1781131204868 completed/succeeded, env-free container
//   ynab   — store path proven; captured credentials validated successfully
export const STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS = ["gmail", "github", "slack", "ynab"] as const;

export type StaticSecretLiveProvenConnector = (typeof STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS)[number];

export function isStaticSecretLiveProven(connectorKey: string): boolean {
  return (STATIC_SECRET_LIVE_PROVEN_CONNECTOR_KEYS as readonly string[]).includes(canonicalConnectorKey(connectorKey));
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
 * This check does NOT consult `capabilities.public_listing` — that flag is a
 * separate, console-side gate (see `buildOwnerConnectorCatalog` in
 * apps/console/.../connection-catalog.ts): normal ("supported") entries still
 * require `listed === true`, but an `experimental` support_state is admitted
 * into the console's Experimental section even when `listed === false` (e.g.
 * Steam ships `listed: false` today). The Experimental section is itself the
 * explicit opt-in; the listing flag is not a second gate on top of it.
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

const FIRST_PARTY_REGISTRY_PREFIX = "https://registry.pdpp.org/connectors/";
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

function normalizeStaticSecretFieldType(raw: StaticSecretSetupFieldLike): StaticSecretSetupFieldType {
  const rawType = cleanString(raw.type)?.toLowerCase();
  if (rawType === "email" || rawType === "password" || rawType === "text") {
    return rawType;
  }
  if (raw.secret === true) {
    return "password";
  }
  return "text";
}

function normalizeStaticSecretField(raw: StaticSecretSetupFieldLike): StaticSecretSetupField | null {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const name = cleanString(raw?.name);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const label = cleanString(raw?.label);
  if (!(name && label)) {
    return null;
  }
  const type = normalizeStaticSecretFieldType(raw);
  return {
    autocomplete: cleanString(raw.autocomplete),
    description: cleanString(raw.description),
    env: Array.isArray(raw.env) ? raw.env.filter((value): value is string => cleanString(value) !== null) : [],
    helpText: cleanString(raw.help_text),
    helpUrl: cleanString(raw.help_url),
    identity: raw.identity === true,
    label,
    name,
    placeholder: cleanString(raw.placeholder),
    required: raw.required !== false,
    secret: raw.secret === true || type === "password",
    type,
  };
}

export function staticSecretCredentialCaptureFromManifest(
  manifest: ConnectorManifestLike | null | undefined
): StaticSecretCredentialCaptureSetup | null {
  const capture = manifest?.setup?.credential_capture;
  if (!capture || typeof capture !== "object") {
    return null;
  }
  const kind = cleanString(capture.credential_kind) ?? cleanString(capture.kind);
  if (!kind) {
    return null;
  }
  const fields = Array.isArray(capture.fields)
    ? capture.fields
        .map((field) => normalizeStaticSecretField(field))
        .filter((field): field is StaticSecretSetupField => field !== null)
    : [];
  if (!fields.some((field) => field.secret)) {
    return null;
  }
  return {
    description: cleanString(capture.description),
    fields,
    kind,
    label: cleanString(capture.label) ?? kind,
    submitLabel: cleanString(capture.submit_label),
  };
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
    validation: validationKind ? { kind: validationKind, maxFileBytes } : null,
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

// Accepts both the legacy bare-string-array shape and the enriched
// {key,label,secret} object shape declared by DeploymentConfigDeclarationLike,
// normalizing either to a plain key-string array.
function deploymentConfigKeyStrings(declaration: DeploymentConfigDeclarationLike | null | undefined): readonly string[] {
  if (!Array.isArray(declaration)) {
    return [];
  }
  return declaration
    .map((entry) => (typeof entry === "string" ? entry : entry?.key))
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function deploymentConfigKeysFromManifest(manifest: ConnectorManifestLike | null): readonly string[] {
  const setupKeys = deploymentConfigKeyStrings(manifest?.setup?.deployment_config);
  if (setupKeys.length > 0) {
    return setupKeys;
  }
  const authDeploymentKeys = deploymentConfigKeyStrings(manifest?.capabilities?.auth?.deployment_config);
  if (authDeploymentKeys.length > 0) {
    return authDeploymentKeys;
  }
  return (manifest?.capabilities?.auth?.required ?? []).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0
  );
}

function buildDeploymentReadiness(args: {
  readonly connectorKey: string;
  readonly configuredProviderAuthConnectorKeys?: readonly string[];
  readonly manifest: ConnectorManifestLike | null;
  readonly requiredKeys?: readonly string[];
  readonly setupModality: ConnectorSetupModality;
}): ConnectorSetupDeploymentReadiness {
  if (args.setupModality !== "provider_authorization") {
    return NOT_APPLICABLE_DEPLOYMENT_READINESS;
  }
  const configured = new Set((args.configuredProviderAuthConnectorKeys ?? []).map(canonicalConnectorKey));
  if (configured.has(args.connectorKey)) {
    return READY_DEPLOYMENT_READINESS;
  }
  const requiredKeys = args.requiredKeys?.length ? args.requiredKeys : deploymentConfigKeysFromManifest(args.manifest);
  const blockers = (requiredKeys.length > 0 ? requiredKeys : [`${args.connectorKey.toUpperCase()}_OAUTH_CLIENT`]).map(
    (key) => ({
      key,
      label: key,
      secret: SECRET_DEPLOYMENT_KEY_RE.test(key),
    })
  );
  return {
    blockers,
    guidance:
      "Configure the instance-level provider application first. After that, each owner authorizes their own account through an owner-mediated provider authorization step.",
    state: "needs_config",
  };
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
