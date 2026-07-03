/**
 * Owner-meaningful consent-card connection labels.
 *
 * The public consent surface (`apps/site/src/components/pdpp/consent-card.tsx`)
 * renders `ConsentCardConnection.displayName` verbatim. Per
 *   openspec/changes/expose-connection-identity-on-public-read
 * the consent card SHALL NOT surface a storage placeholder (`legacy`,
 * `default_account`, `legacy (pre-header)`), a connector registry URL, a
 * `local-device:` binding, or the bare connector type as the primary
 * connection label. When the owner has not given a connection a meaningful
 * name, the card SHALL render an owner-meaningful default derived from the
 * connector type plus a stable disambiguator (e.g. `Gmail · account 2`).
 *
 * This module is the mapper that builds `ConsentCardConnection[]` props from
 * raw connection identity BEFORE render, so the card never has to know the
 * fallback rule. It is intentionally a pure, dependency-free module (no React,
 * no Next, no `process.env`) so it can be unit-tested by the reference test
 * suite, which executes `apps/site` TS directly
 * (`reference-implementation/test/consent-connection-label.test.js`).
 *
 * The placeholder-detection rule is the same one the operator console uses to
 * decide whether a connection still needs a label
 * (`apps/console/src/app/(console)/lib/connector-display.ts:isFallbackConnectionLabel`).
 * It is duplicated here rather than imported because the two apps are split
 * surfaces that do not share an internal package; the parity is asserted by
 * tests on both sides. If a shared `@pdpp/*` package later hosts this rule,
 * collapse both copies into it.
 */

const LOCAL_DEVICE_PREFIX = "local-device:";
const REGISTRY_CONNECTOR_HOST = "registry.pdpp.org";
const NON_ALPHANUMERIC = /[^a-z0-9]+/g;
const WORD_SEPARATORS = /[\s_-]+/;
const SPACE_OR_HYPHEN = /[\s-]+/g;

/** Raw connection identity as it arrives from the read contract / grant scope. */
export interface ConnectionIdentity {
  /** Canonical `connection_id`. Stable selector; never the rendered label. */
  connectionId: string;
  /** Owner-set label, if any. May be absent, blank, or a storage placeholder. */
  displayName?: string | null;
}

/** A consent-card connection row: stable id + an owner-meaningful label. */
export interface ConsentConnectionLabel {
  displayName: string;
  id: string;
}

function normalizeText(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Collapse to a comparison key so casing / separators do not hide a match. */
function fallbackLabelKey(value: string): string {
  return value.toLowerCase().replace(NON_ALPHANUMERIC, "");
}

function isLegacyConnectorLabel(value: string): boolean {
  const normalized = value.toLowerCase().replace(SPACE_OR_HYPHEN, "_");
  return (
    normalized === "legacy" ||
    normalized === "legacy_default" ||
    normalized === "default_account" ||
    normalized.startsWith("legacy_(pre_header)") ||
    normalized.startsWith("legacy_(pre-header)")
  );
}

function isRegistryOrDeviceUrl(value: string): boolean {
  if (value.startsWith(LOCAL_DEVICE_PREFIX)) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.hostname === REGISTRY_CONNECTOR_HOST;
  } catch {
    return false;
  }
}

/**
 * Human display form of a connector type key. `gmail` -> `Gmail`,
 * `claude_code` -> `Claude Code`. Already-spaced/cased names pass through with
 * each word capitalized. This is presentation only; the canonical connector
 * key is unchanged.
 */
export function formatConnectorName(connector: string): string {
  const raw = normalizeText(connector);
  if (!raw) {
    return "Connection";
  }
  return raw
    .split(WORD_SEPARATORS)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * True when `displayName` is NOT an owner-meaningful label for a connection of
 * the given connector type — i.e. it is absent, blank, a `legacy` /
 * `default_account` placeholder, a registry URL, a `local-device:` binding, or
 * merely the bare connector type name (which carries no per-connection
 * meaning). Callers use this to decide whether to render the owner's label or
 * mint a `<Connector> · account N` fallback.
 */
export function isPlaceholderConnectionLabel(connector: string, displayName: string | null | undefined): boolean {
  const stored = normalizeText(displayName);
  if (!stored) {
    return true;
  }
  if (isLegacyConnectorLabel(stored) || isRegistryOrDeviceUrl(stored)) {
    return true;
  }
  // A label identical to the connector type (any casing) is not per-connection
  // meaningful. Compare against both the raw key and its formatted name.
  const connectorKey = normalizeText(connector);
  const storedKey = fallbackLabelKey(stored);
  return (
    storedKey === fallbackLabelKey(connectorKey) || storedKey === fallbackLabelKey(formatConnectorName(connectorKey))
  );
}

/**
 * Derive the owner-meaningful label for a single connection.
 *
 * Owner-set names are preserved verbatim. When the owner has not renamed the
 * connection, returns `<Connector> · account N`, where N is the 1-based
 * `ordinal` of the connection within its connector group. The disambiguator is
 * suppressed for a lone connection (`<Connector>` alone reads better than
 * `<Connector> · account 1`), but a real owner label is always preserved as-is
 * even for a single connection.
 */
export function deriveConnectionDisplayName(args: {
  connector: string;
  displayName?: string | null | undefined;
  /** 1-based position within the connector group. */
  ordinal: number;
  /** Total connections in the same connector group. */
  groupSize: number;
}): string {
  const { connector, displayName, ordinal, groupSize } = args;
  if (!isPlaceholderConnectionLabel(connector, displayName)) {
    return normalizeText(displayName);
  }
  const connectorName = formatConnectorName(connector);
  if (groupSize <= 1) {
    return connectorName;
  }
  return `${connectorName} · account ${ordinal}`;
}

/**
 * Build the consent-card connection rows for one connector group, deriving an
 * owner-meaningful label for each connection BEFORE render. Input order is
 * preserved and defines the stable disambiguator ordinal, so labels stay
 * stable across renders as long as the caller passes connections in a stable
 * order (e.g. by `connection_id`).
 */
export function buildConsentCardConnections(
  connector: string,
  connections: ConnectionIdentity[]
): ConsentConnectionLabel[] {
  const groupSize = connections.length;
  return connections.map((connection, index) => ({
    id: connection.connectionId,
    displayName: deriveConnectionDisplayName({
      connector,
      displayName: connection.displayName,
      ordinal: index + 1,
      groupSize,
    }),
  }));
}
