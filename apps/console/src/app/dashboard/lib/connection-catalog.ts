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
 * This module introduces NO new classification truth. It reuses the same
 * `filesystem > browser > network` binding precedence the backend owner-agent
 * intent route uses (`classifyConnectorIntentModality` in
 * `reference-implementation/server/routes/owner-connection-intent.ts`) and the
 * console-side supported-set predicates in `connection-modality.ts`. The
 * disposition is the join of those two: the modality says what class a connector
 * is; the supported-set predicates say whether the console has a committed
 * creation path for it today.
 */

import {
  canonicalConnectorKey,
  enrollmentKeyForCanonicalKey,
  isSupportedBrowserCollectorConnector,
  isSupportedLocalCollectorConnector,
} from "./connection-modality.ts";

/**
 * Minimal manifest shape the catalog reads. The real `ConnectorManifest`
 * (rs-client) carries far more; the catalog only needs identity, a display
 * label, and the runtime bindings that drive classification.
 */
export interface CatalogManifestLike {
  connector_id: string;
  display_name?: string | null;
  name?: string | null;
  runtime_requirements?: { bindings?: Record<string, unknown> | null } | null;
}

/** Binding-derived modality, matching the backend intent route's taxonomy. */
export type CatalogModality = "local_collector" | "browser_bound" | "api_network" | "unknown";

/**
 * What the console can honestly do with this connector today:
 *
 * - `local_collector_enroll` — a proven one-click enrollment deep-link.
 * - `local_collector_unproven` — a filesystem-class connector whose collector is
 *   not in the console's proven enrollment set yet; the local-collector path
 *   exists in principle but this connector has no committed console proof, so it
 *   is shown without a deep-link rather than mislabeled as an API source.
 * - `browser_collector_manual` — Amazon's committed manual browser-collector
 *   proof path (deep-links to mint a code; the owner finishes the run locally).
 * - `browser_bound_runbook` — a browser-bound connector with no generated console
 *   path yet; visible and pointed at the runbook, but NOT deep-linked.
 * - `api_network_unsupported` — no owner connect route; visible with its reason,
 *   not creatable here.
 * - `unknown_unsupported` — a manifest with no recognized binding; surfaced
 *   honestly rather than silently dropped.
 */
export type CatalogDisposition =
  | "local_collector_enroll"
  | "local_collector_unproven"
  | "browser_collector_manual"
  | "browser_bound_runbook"
  | "api_network_unsupported"
  | "unknown_unsupported";

export interface ConnectorCatalogEntry {
  /** Canonical bare connector key (registry-URL prefix stripped). */
  connectorKey: string;
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
  /** Binding-derived modality. */
  modality: CatalogModality;
}

/**
 * Classify a manifest's runtime bindings into a modality. Mirrors
 * `classifyConnectorIntentModality` exactly: `filesystem` wins over `browser`
 * wins over `network`; a missing/empty binding set is `unknown`.
 */
export function catalogModalityFromManifest(manifest: CatalogManifestLike): CatalogModality {
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

function dispositionFor(connectorKey: string, modality: CatalogModality): CatalogDisposition {
  if (modality === "local_collector") {
    // Only the proven local-collector set is one-click-creatable. A filesystem
    // connector outside that set is still local-collector class — its collector
    // path exists in principle — but has no committed console enrollment proof,
    // so it is surfaced as `local_collector_unproven` (named, no deep-link)
    // rather than a false deep-link OR a misleading "needs an API flow" label.
    return isSupportedLocalCollectorConnector(enrollmentKeyForCanonicalKey(connectorKey))
      ? "local_collector_enroll"
      : "local_collector_unproven";
  }
  if (modality === "browser_bound") {
    return isSupportedBrowserCollectorConnector(connectorKey) ? "browser_collector_manual" : "browser_bound_runbook";
  }
  if (modality === "api_network") {
    return "api_network_unsupported";
  }
  return "unknown_unsupported";
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

/**
 * Build the connector catalog from the shipped manifests. One entry per manifest
 * with a `connector_id`, sorted by display name so the picker is stable across
 * renders. Entries only carry an `enrollmentKey` for dispositions the console can
 * actually start, so a caller cannot accidentally deep-link a gated connector.
 */
export function buildConnectorCatalog(manifests: readonly CatalogManifestLike[]): ConnectorCatalogEntry[] {
  const entries: ConnectorCatalogEntry[] = [];
  for (const manifest of manifests) {
    if (!manifest.connector_id) {
      continue;
    }
    const connectorKey = canonicalConnectorKey(manifest.connector_id);
    const modality = catalogModalityFromManifest(manifest);
    const disposition = dispositionFor(connectorKey, modality);
    const entry: ConnectorCatalogEntry = {
      connectorKey,
      displayName: displayNameFor(manifest, connectorKey),
      modality,
      disposition,
    };
    if (disposition === "local_collector_enroll" || disposition === "browser_collector_manual") {
      entry.enrollmentKey = enrollmentKeyForCanonicalKey(connectorKey);
    }
    entries.push(entry);
  }
  entries.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return entries;
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

/** Catalog entries with the manual browser-collector proof path (Amazon today). */
export function browserCollectorEntries(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return catalog.filter((e) => e.disposition === "browser_collector_manual");
}

/** Browser-bound entries that have no generated console path yet (runbook only). */
export function browserBoundRunbookEntries(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return catalog.filter((e) => e.disposition === "browser_bound_runbook");
}

/** API/network entries with no owner connect route, plus any unknown-binding entries. */
export function unsupportedNetworkEntries(catalog: readonly ConnectorCatalogEntry[]): ConnectorCatalogEntry[] {
  return catalog.filter((e) => e.disposition === "api_network_unsupported" || e.disposition === "unknown_unsupported");
}
