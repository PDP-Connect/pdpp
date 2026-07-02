const LOCAL_DEVICE_PREFIX = "local-device:";
const REGISTRY_CONNECTOR_HOST = "registry.pdpp.org";
const REGISTRY_CONNECTOR_PATH_PREFIX = "/connectors/";

const CONNECTOR_KEY_ALIASES = new Map<string, string>([
  ["amazon", "Amazon"],
  ["chatgpt", "ChatGPT"],
  ["claude_code", "claude-code"],
  ["claude-code", "claude-code"],
  ["gmail", "Gmail"],
  ["google-maps", "Google Maps"],
  ["google_maps", "Google Maps"],
  ["google-maps-data-portability", "Google Maps (Data Portability)"],
  ["google_maps_data_portability", "Google Maps (Data Portability)"],
]);

export interface ConnectorDisplayInput {
  connectorId?: string | null;
  displayName?: string | null;
  name?: string | null;
}

export interface SourceDisplayInput {
  connection_id?: string | null;
  connector_id?: string | null;
  id?: string | null;
  kind?: string | null;
}

export function formatConnectorKeyForDisplay(connectorId: string | null | undefined): string {
  const raw = normalizeText(connectorId);
  if (!raw) {
    return "unknown connector";
  }

  if (raw.startsWith(LOCAL_DEVICE_PREFIX)) {
    const inner = raw.slice(LOCAL_DEVICE_PREFIX.length).split(":").find(Boolean);
    return formatConnectorKeyForDisplay(inner ?? raw.slice(LOCAL_DEVICE_PREFIX.length));
  }

  if (isLegacyConnectorLabel(raw)) {
    return "default connection";
  }

  const alias = CONNECTOR_KEY_ALIASES.get(raw) ?? CONNECTOR_KEY_ALIASES.get(raw.toLowerCase());
  if (alias) {
    return alias;
  }

  const fromUrl = connectorKeyFromUrl(raw);
  if (fromUrl) {
    return fromUrl;
  }

  return raw;
}

export function formatConnectorNameForDisplay(input: ConnectorDisplayInput): string {
  const display = displayNameCandidate(input.displayName);
  if (display) {
    return display;
  }
  const name = displayNameCandidate(input.name);
  if (name) {
    return name;
  }
  return formatConnectorKeyForDisplay(input.connectorId);
}

/**
 * True when a connection has no owner-meaningful `display_name` — i.e. the
 * stored label degrades to the bare connector type, a registry URL, a
 * `local-device:` binding, or a `legacy` placeholder. Callers use this to
 * surface a "label needed" affordance and to decide whether a rename input
 * should pre-fill (owner-set) or start blank (fallback).
 *
 * `displayName` is the stored `connector.display_name`; `connectorId` is the
 * connector type. When `displayNameCandidate(displayName)` returns null the
 * label is a fallback. A stored label that merely equals the connector type
 * name (e.g. "Gmail" for the `gmail` connector) is also a fallback, because
 * it carries no per-connection meaning.
 */
export function isFallbackConnectionLabel(input: ConnectorDisplayInput): boolean {
  const stored = displayNameCandidate(input.displayName);
  if (!stored) {
    return true;
  }
  const normalizedStored = fallbackLabelKey(stored);
  const connectorCandidates = [
    formatConnectorKeyForDisplay(input.connectorId),
    displayNameCandidate(input.name),
    normalizeText(input.connectorId),
  ].filter((value): value is string => Boolean(value));
  return connectorCandidates.some((candidate) => fallbackLabelKey(candidate) === normalizedStored);
}

export function formatSourceForDisplay(source: SourceDisplayInput | null | undefined): string {
  if (!source) {
    return "source -";
  }
  const kind = normalizeText(source.kind) || "connector";
  const rawId = normalizeText(source.id) || normalizeText(source.connector_id);
  if (kind === "connector") {
    return formatConnectorKeyForDisplay(rawId);
  }
  const id = formatIdentityForDisplay(rawId);
  return `${kind}:${id}`;
}

export function formatSourceWithConnectionForDisplay(source: SourceDisplayInput | null | undefined): string {
  const label = formatSourceForDisplay(source);
  const connectionId = normalizeText(source?.connection_id);
  return connectionId ? `${label} (connection ${connectionId})` : label;
}

function displayNameCandidate(value: string | null | undefined): string | null {
  const raw = normalizeText(value);
  if (!raw || isLegacyConnectorLabel(raw) || raw.startsWith(LOCAL_DEVICE_PREFIX) || connectorKeyFromUrl(raw)) {
    return null;
  }
  return CONNECTOR_KEY_ALIASES.get(raw) ?? CONNECTOR_KEY_ALIASES.get(raw.toLowerCase()) ?? raw;
}

function formatIdentityForDisplay(value: string | null | undefined): string {
  const raw = normalizeText(value);
  if (!raw) {
    return "-";
  }
  const fromUrl = identityFromUrl(raw);
  return fromUrl ?? raw;
}

function connectorKeyFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const pathPart = url.pathname.split("/").filter(Boolean).at(-1);
  if (url.hostname === REGISTRY_CONNECTOR_HOST && url.pathname.startsWith(REGISTRY_CONNECTOR_PATH_PREFIX)) {
    return decodePathPart(pathPart) ?? "unknown connector";
  }
  return decodePathPart(pathPart) ?? url.hostname;
}

function identityFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return decodePathPart(url.pathname.split("/").filter(Boolean).at(-1)) ?? url.hostname;
  } catch {
    return null;
  }
}

function isLegacyConnectorLabel(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[\s-]+/g, "_");
  return normalized === "legacy" || normalized === "legacy_default";
}

function normalizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function fallbackLabelKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function decodePathPart(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
