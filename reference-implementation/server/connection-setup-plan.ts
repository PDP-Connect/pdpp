export type ConnectorIntentModality = "local_collector" | "browser_bound" | "api_network" | "unknown";

export type ConnectorSetupSupportState = "supported" | "proof_gated" | "unsupported" | "needs_deployment_config";

export type ConnectorSetupNextStepKind =
  | "enroll_local_collector"
  | "enroll_browser_collector"
  | "capture_static_secret"
  | "open_provider_auth"
  | "manual_runbook"
  | "unsupported";

export type ConnectorCatalogDisposition =
  | "local_collector_enroll"
  | "local_collector_unproven"
  | "browser_collector_manual"
  | "browser_bound_runbook"
  | "static_secret_connect"
  | "api_network_unsupported"
  | "unknown_unsupported";

export interface ConnectorManifestLike {
  readonly connector_id?: string | null;
  readonly connector_key?: string | null;
  readonly display_name?: string | null;
  readonly name?: string | null;
  readonly runtime_requirements?: {
    readonly bindings?: Readonly<Record<string, unknown>> | null;
  } | null;
}

export interface ConnectionSetupPlan {
  readonly catalogDisposition: ConnectorCatalogDisposition;
  readonly connectorKey: string;
  readonly connectorModality: ConnectorIntentModality;
  readonly displayName: string;
  readonly enrollmentKey?: string;
  readonly nextStepKind: ConnectorSetupNextStepKind;
  readonly ownerAgentIntent: {
    readonly method: "POST" | null;
    readonly nextStepKind: "enroll_local_collector" | "unsupported";
    readonly reason: string;
    readonly status: "supported" | "unsupported";
  };
  readonly proofGate: string | null;
  readonly runbookPath: string | null;
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

export function unsupportedReason(modality: ConnectorIntentModality): string {
  if (modality === "browser_bound") {
    return "This connector is browser-bound. The browser-collector enrollment primitive (`browser_collector` source kind plus binding-aware enrollment) already ships: the owner-authed enrollment-code route accepts this connector and enrolls a second account as a distinct `browser_collector` instance. What is not yet committed is end-to-end proof that a real owner-logged-in browser session ingests through that path, so this route stays `unsupported` and does not advertise a one-click next step. To add the connection today, follow the owner-run procedure in `docs/operator/browser-collector-proof-runbook.md` (mint an enrollment code for this connector, then run the monorepo local collector against your logged-in session). The one-click owner-agent next step lands together with the committed live proof.";
  }
  if (modality === "api_network") {
    return "This connector is API/network-only and authenticates with a static provider secret the owner supplies locally (gmail uses a Google app password over IMAP; github uses a personal access token) — there is no OAuth authorization URL to send the owner to. The reference now has the per-connection encrypted credential store, an owner-session credential capture route for existing connections, and connection-scoped subprocess injection for this credential model (add-static-secret-owner-connect-primitive), so a captured secret is sealed at rest, never agent-readable, and injected into exactly one connection run. What is still missing is the committed end-to-end proof — intent to owner capture to first ingest to an addressable connection_id, with two mailboxes proven as two connection_ids. Until that proof lands the route stays `unsupported` and does not advertise a one-click next step (`open_url` would apply only to a genuinely OAuth-backed connector, which none of the current ones are); an API connection still materializes only on first ingest, not from this intent. See openspec/changes/add-static-secret-owner-connect-primitive/design.md (Decision 6, proof-before-flip).";
  }
  if (modality === "local_collector") {
    return "This filesystem-backed connector is not in the proven local-collector enrollment set yet. The reference can classify it as local-collector class, but it must not advertise setup until a connector-specific local collector path is proven.";
  }
  return "Unknown connector: no manifest with runtime binding requirements is registered for this connector_id. Register the connector or check the connector_id.";
}

export function buildConnectionSetupPlan(args: {
  readonly connectorKey?: string | null;
  readonly manifest: ConnectorManifestLike | null;
}): ConnectionSetupPlan {
  const rawConnectorKey = typeof args.connectorKey === "string" ? args.connectorKey.trim() : "";
  const connectorKey =
    (rawConnectorKey ? canonicalConnectorKey(rawConnectorKey) : null) ??
    connectorKeyFromManifest(args.manifest ?? {}, args.connectorKey) ??
    "unknown";
  const displayName = displayNameForConnector(connectorKey, args.manifest);
  const connectorModality = classifyConnectorIntentModality(args.manifest);
  const enrollmentKey = enrollmentKeyForCanonicalKey(connectorKey);

  if (connectorModality === "local_collector") {
    if (isSupportedLocalCollectorConnector(enrollmentKey)) {
      return {
        catalogDisposition: "local_collector_enroll",
        connectorKey,
        connectorModality,
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
        supportState: "supported",
      };
    }
    return {
      catalogDisposition: "local_collector_unproven",
      connectorKey,
      connectorModality,
      displayName,
      nextStepKind: "unsupported",
      ownerAgentIntent: {
        method: null,
        nextStepKind: "unsupported",
        reason: unsupportedReason(connectorModality),
        status: "unsupported",
      },
      proofGate: "local_collector_connector_proof_missing",
      runbookPath: null,
      supportState: "proof_gated",
    };
  }

  if (connectorModality === "browser_bound") {
    const hasManualBrowserPath = isSupportedBrowserCollectorConnector(connectorKey);
    return {
      catalogDisposition: hasManualBrowserPath ? "browser_collector_manual" : "browser_bound_runbook",
      connectorKey,
      connectorModality,
      displayName,
      ...(hasManualBrowserPath ? { enrollmentKey } : {}),
      nextStepKind: hasManualBrowserPath ? "enroll_browser_collector" : "manual_runbook",
      ownerAgentIntent: {
        method: null,
        nextStepKind: "unsupported",
        reason: unsupportedReason(connectorModality),
        status: "unsupported",
      },
      proofGate: "browser_collector_live_proof_missing",
      runbookPath: BROWSER_BOUND_RUNBOOK_PATH,
      supportState: "proof_gated",
    };
  }

  if (connectorModality === "api_network") {
    if (isStaticSecretConnector(connectorKey)) {
      return {
        catalogDisposition: "static_secret_connect",
        connectorKey,
        connectorModality,
        displayName,
        nextStepKind: "manual_runbook",
        ownerAgentIntent: {
          method: null,
          nextStepKind: "unsupported",
          reason: unsupportedReason(connectorModality),
          status: "unsupported",
        },
        proofGate: "static_secret_live_proof_missing",
        runbookPath: STATIC_SECRET_RUNBOOK_PATH,
        supportState: "proof_gated",
      };
    }
    return {
      catalogDisposition: "api_network_unsupported",
      connectorKey,
      connectorModality,
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
      supportState: "unsupported",
    };
  }

  return {
    catalogDisposition: "unknown_unsupported",
    connectorKey,
    connectorModality,
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
    supportState: "unsupported",
  };
}
