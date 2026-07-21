/**
 * Per-source add-account support projection for the Sources / Connections page.
 *
 * The Sources page lists connections that already have data or are registered.
 * The owner's reported confusion was that the page conflated two facts: "this
 * source already works" and "I can add another account from this screen". A
 * browser-bound source can have years of data and still not support
 * self-service add-another-account today, while a static-secret source both has
 * data and can take a second account right now.
 *
 * This module keeps those facts distinct. It projects the shared reference setup
 * planner (`buildConnectorCatalog`, which is itself a projection of
 * `connection-setup-plan`) into a map keyed by canonical connector key, so the
 * Sources page can answer, per source it already shows: can the owner add
 * another account, and what is the one next action.
 *
 * Construction note: this is deliberately NOT the full Sources "Add source"
 * catalog. The Sources first screen imports this small per-source projection
 * instead, so existing-data monitoring and add-new-account support stay one
 * screen but two clearly separate facts.
 */

import { canonicalConnectorKey } from "pdpp-reference-implementation/connection-setup-plan";
import { buildConnectorCatalog, type CatalogManifestLike } from "./connection-catalog.ts";
import { type AddAccountSupport, addAccountSupport, sourceSetupAction } from "./source-setup-presentation.ts";

export interface SourceAddSupport {
  /**
   * The primary "add another account" action, or null when add-new is not
   * self-service yet. The href is the SAME setup route the first-account flow
   * uses; only the label is phrased for a source that already exists.
   */
  action: { href: string; label: string } | null;
  /** Canonical connector key this descriptor applies to. */
  connectorKey: string;
  /** Whether adding a new account is self-service today. */
  support: AddAccountSupport;
  /** One short owner-facing line describing the add-account support state. */
  supportLabel: string;
  /** Tailwind tone classes for the add-support chip. */
  supportTone: string;
}

const SUPPORT_LABELS: Record<AddAccountSupport, string> = {
  self_service: "Add another account",
  packaged_path_pending: "Add path not packaged",
  deployment_prerequisite: "Server setup required to add another account",
  not_self_service: "Add path not available here",
};

const SUPPORT_TONES: Record<AddAccountSupport, string> = {
  self_service: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700",
  packaged_path_pending: "border-amber-500/30 bg-amber-500/10 text-amber-700",
  deployment_prerequisite: "border-amber-500/30 bg-amber-500/10 text-amber-700",
  not_self_service: "border-border bg-muted/30 text-muted-foreground",
};

/**
 * The owner-facing "add another account" action for a source that already
 * exists. Reuses the shared first-account route so there is one setup path per
 * connector, then relabels for the add-another context. Returns null when
 * add-new is not self-service today.
 */
function addAnotherAccountAction(entry: ReturnType<typeof buildConnectorCatalog>[number]): {
  href: string;
  label: string;
} | null {
  if (addAccountSupport(entry) !== "self_service") {
    return null;
  }
  const setup = sourceSetupAction(entry);
  if (!setup) {
    return null;
  }
  return { href: setup.href, label: "Add another account" };
}

/**
 * Build a `connector_id` → add-account support map from the shipped manifests.
 * Keyed by canonical connector key so a connection's `connector_id` resolves
 * directly. Connectors with no manifest entry simply have no map entry, and the
 * Sources page falls back to showing no add-account affordance for them rather
 * than inventing one.
 */
export function buildSourceAddSupport(manifests: readonly CatalogManifestLike[]): Map<string, SourceAddSupport> {
  const catalog = buildConnectorCatalog(manifests);
  const map = new Map<string, SourceAddSupport>();
  for (const entry of catalog) {
    const support = addAccountSupport(entry);
    map.set(entry.connectorKey, {
      connectorKey: entry.connectorKey,
      support,
      action: addAnotherAccountAction(entry),
      supportLabel: SUPPORT_LABELS[support],
      supportTone: SUPPORT_TONES[support],
    });
  }
  return map;
}

/**
 * Look up add-account support for a connection's raw `connector_id`. Uses the
 * shared `canonicalConnectorKey` so the lookup matches exactly the key the map
 * was built from — no re-implementation that could silently drift.
 */
export function resolveSourceAddSupport(
  support: Map<string, SourceAddSupport>,
  connectorId: string
): SourceAddSupport | null {
  return support.get(canonicalConnectorKey(connectorId)) ?? null;
}
