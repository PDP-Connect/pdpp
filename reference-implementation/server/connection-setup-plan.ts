export type ConnectorIntentModality = "local_collector" | "browser_bound" | "api_network" | "unknown";

export type ConnectorSetupModality =
  | "local_collector"
  | "browser_bound"
  | "static_secret"
  | "provider_authorization"
  | "manual_or_upload"
  | "unsupported"
  | "unknown";

export type ConnectorSetupSupportState = "supported" | "proof_gated" | "unsupported" | "needs_deployment_config";

export type ConnectorSetupNextStepKind =
  | "enroll_local_collector"
  | "enroll_browser_collector"
  | "capture_static_secret"
  | "open_provider_auth"
  | "needs_deployment_config"
  | "manual_runbook"
  | "unsupported";

export type ConnectorCatalogDisposition =
  | "local_collector_enroll"
  | "local_collector_unproven"
  | "browser_collector_manual"
  | "browser_bound_runbook"
  | "static_secret_connect"
  | "provider_auth_deployment_blocked"
  | "provider_auth_proof_gated"
  | "api_network_unsupported"
  | "unknown_unsupported";

export interface ConnectorManifestLike {
  readonly connector_id?: string | null;
  readonly connector_key?: string | null;
  readonly display_name?: string | null;
  readonly name?: string | null;
  readonly capabilities?: {
    readonly auth?: {
      readonly kind?: string | null;
      readonly mode?: string | null;
      readonly type?: string | null;
      readonly required?: readonly string[] | null;
      readonly deployment_config?: readonly string[] | null;
    } | null;
  } | null;
  readonly runtime_requirements?: {
    readonly bindings?: Readonly<Record<string, unknown>> | null;
  } | null;
  readonly setup?: {
    readonly modality?: string | null;
    readonly deployment_config?: readonly string[] | null;
  } | null;
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
}

export const SUPPORTED_LOCAL_COLLECTOR_CONNECTORS = ["claude_code", "codex"] as const;

export type SupportedLocalCollectorConnector = (typeof SUPPORTED_LOCAL_COLLECTOR_CONNECTORS)[number];

export const SUPPORTED_BROWSER_COLLECTOR_CONNECTORS = ["amazon"] as const;

export type SupportedBrowserCollectorConnector = (typeof SUPPORTED_BROWSER_COLLECTOR_CONNECTORS)[number];

export const STATIC_SECRET_CREDENTIAL_KIND_BY_CONNECTOR: Readonly<Record<string, string>> = Object.freeze({
  gmail: "app_password",
  github: "personal_access_token",
});

export const STATIC_SECRET_CONNECTORS = Object.freeze(
  Object.keys(STATIC_SECRET_CREDENTIAL_KIND_BY_CONNECTOR)
) as readonly StaticSecretConnector[];

export type StaticSecretConnector = "gmail" | "github";

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

export const BROWSER_BOUND_RUNBOOK_PATH = "docs/operator/browser-collector-proof-runbook.md";
export const STATIC_SECRET_RUNBOOK_PATH = "docs/operator/static-secret-connection-runbook.md";
export const PROVIDER_AUTH_RUNBOOK_PATH = "docs/operator/add-connection.md";

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

export function enrollmentKeyForCanonicalKey(canonicalKey: string): string {
  const key = canonicalConnectorKey(canonicalKey);
  return key === "claude-code" ? "claude_code" : key;
}

export function displayNameForConnector(connectorKey: string, manifest?: ConnectorManifestLike | null): string {
  return manifest?.display_name?.trim() || manifest?.name?.trim() || connectorKey;
}

export function expectedStaticSecretCredentialKind(connectorId: string): string | null {
  return STATIC_SECRET_CREDENTIAL_KIND_BY_CONNECTOR[canonicalConnectorKey(connectorId)] ?? null;
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

export function isStaticSecretConnector(connectorId: string | null | undefined): connectorId is StaticSecretConnector {
  return (
    typeof connectorId === "string" &&
    Object.hasOwn(STATIC_SECRET_CREDENTIAL_KIND_BY_CONNECTOR, canonicalConnectorKey(connectorId))
  );
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
  connectorKey: string,
  manifest: ConnectorManifestLike | null
): ConnectorSetupModality {
  const connectorModality = classifyConnectorIntentModality(manifest);
  if (connectorModality === "local_collector") {
    return "local_collector";
  }
  if (connectorModality === "browser_bound") {
    return "browser_bound";
  }
  if (connectorModality === "api_network") {
    if (isStaticSecretConnector(connectorKey)) {
      return "static_secret";
    }
    const authKind = authKindFromManifest(manifest);
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

function deploymentConfigKeysFromManifest(manifest: ConnectorManifestLike | null): readonly string[] {
  const setupKeys = manifest?.setup?.deployment_config;
  if (Array.isArray(setupKeys) && setupKeys.length > 0) {
    return setupKeys.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  }
  const authKeys = manifest?.capabilities?.auth?.deployment_config ?? manifest?.capabilities?.auth?.required;
  if (Array.isArray(authKeys) && authKeys.length > 0) {
    return authKeys.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  }
  return [];
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
      secret: /SECRET|TOKEN|PASSWORD|KEY/i.test(key),
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
    return "This connector is browser-bound. The browser-collector enrollment primitive (`browser_collector` source kind plus binding-aware enrollment) already ships, but end-to-end proof that a real owner-logged-in browser session ingests through that path is still gated. Follow `docs/operator/browser-collector-proof-runbook.md`; the setup plan stays proof-gated until that live proof lands.";
  }
  if (modality === "static_secret" || modality === "api_network") {
    return "This API/network connector authenticates with a static provider secret the owner supplies locally (gmail uses a Google app password over IMAP; github uses a personal access token); there is no OAuth authorization URL. Use the owner-session static-secret setup page to create a draft, capture the provider secret, and start first sync. The connection stays hidden until first ingest accepts records.";
  }
  if (modality === "provider_authorization") {
    return "This connector needs provider authorization. The reference distinguishes deployment-level provider app readiness from per-owner authorization, but this build does not yet ship the callback/token-exchange lifecycle that proves an active connection only after authorization and account inventory or a connection test succeeds.";
  }
  if (modality === "local_collector") {
    return "This filesystem-backed connector is not in the proven local-collector enrollment set yet. The reference can classify it as local-collector class, but it must not advertise setup until a connector-specific local collector path is proven.";
  }
  return "Unknown connector: no manifest with runtime binding requirements is registered for this connector_id. Register the connector or check the connector_id.";
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

  if (connectorModality === "local_collector") {
    if (isSupportedLocalCollectorConnector(enrollmentKey)) {
      return {
        catalogDisposition: "local_collector_enroll",
        connectorKey,
        connectorModality,
        deploymentReadiness,
        displayName,
        enrollmentKey,
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
        setupModality,
        supportState: "supported",
      };
    }
    return {
      catalogDisposition: "local_collector_unproven",
      connectorKey,
      connectorModality,
      deploymentReadiness,
      displayName,
      nextStepKind: "unsupported",
      ownerAgentIntent: {
        method: null,
        nextStepKind: "manual_runbook",
        reason: unsupportedReason(connectorModality),
        status: "proof_gated",
      },
      proofGate: "local_collector_connector_proof_missing",
      runbookPath: null,
      setupModality,
      supportState: "proof_gated",
    };
  }

  if (connectorModality === "browser_bound") {
    const hasManualBrowserPath = isSupportedBrowserCollectorConnector(connectorKey);
    return {
      catalogDisposition: hasManualBrowserPath ? "browser_collector_manual" : "browser_bound_runbook",
      connectorKey,
      connectorModality,
      deploymentReadiness,
      displayName,
      ...(hasManualBrowserPath ? { enrollmentKey } : {}),
      nextStepKind: hasManualBrowserPath ? "enroll_browser_collector" : "manual_runbook",
      ownerAgentIntent: {
        method: null,
        nextStepKind: "manual_runbook",
        reason: unsupportedReason(connectorModality),
        status: "proof_gated",
      },
      proofGate: "browser_collector_live_proof_missing",
      runbookPath: BROWSER_BOUND_RUNBOOK_PATH,
      setupModality,
      supportState: "proof_gated",
    };
  }

  if (connectorModality === "api_network") {
    if (setupModality === "static_secret") {
      return {
        catalogDisposition: "static_secret_connect",
        connectorKey,
        connectorModality,
        deploymentReadiness,
        displayName,
        nextStepKind: "capture_static_secret",
        ownerAgentIntent: {
          method: null,
          nextStepKind: "capture_static_secret",
          reason: unsupportedReason(setupModality),
          status: "proof_gated",
        },
        proofGate: "static_secret_live_proof_missing",
        runbookPath: STATIC_SECRET_RUNBOOK_PATH,
        setupModality,
        supportState: "proof_gated",
      };
    }
    if (setupModality === "provider_authorization") {
      const deploymentBlocked = deploymentReadiness.state === "needs_config";
      return {
        catalogDisposition: deploymentBlocked ? "provider_auth_deployment_blocked" : "provider_auth_proof_gated",
        connectorKey,
        connectorModality,
        deploymentReadiness,
        displayName,
        nextStepKind: deploymentBlocked ? "needs_deployment_config" : "manual_runbook",
        ownerAgentIntent: {
          method: null,
          nextStepKind: deploymentBlocked ? "needs_deployment_config" : "manual_runbook",
          reason: deploymentBlocked
            ? deploymentReadiness.guidance ?? unsupportedReason(setupModality)
            : unsupportedReason(setupModality),
          status: deploymentBlocked ? "needs_deployment_config" : "proof_gated",
        },
        proofGate: deploymentBlocked ? "provider_app_deployment_config_missing" : "provider_authorization_lifecycle_missing",
        runbookPath: PROVIDER_AUTH_RUNBOOK_PATH,
        setupModality,
        supportState: deploymentBlocked ? "needs_deployment_config" : "proof_gated",
      };
    }
    return {
      catalogDisposition: "api_network_unsupported",
      connectorKey,
      connectorModality,
      deploymentReadiness,
      displayName,
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
      setupModality,
      supportState: "unsupported",
    };
  }

  return {
    catalogDisposition: "unknown_unsupported",
    connectorKey,
    connectorModality,
    deploymentReadiness,
    displayName,
    nextStepKind: "unsupported",
    ownerAgentIntent: {
      method: null,
      nextStepKind: "unsupported",
      reason: unsupportedReason(connectorModality),
      status: "unsupported",
    },
    proofGate: null,
    runbookPath: null,
    setupModality,
    supportState: "unsupported",
  };
}
