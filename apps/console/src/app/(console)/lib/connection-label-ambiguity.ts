// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * One rule for "this connection's label is genuinely needed".
 *
 * A connection that was never given an owner-meaningful name falls back to its
 * connector type ("Amazon" for the `amazon` connector). For the common case —
 * exactly one connection of that type — the type name is a perfectly clear,
 * unambiguous label and there is nothing to fix. Nagging "Label needed —
 * rename" on every never-renamed connection is noise that trains owners to
 * ignore the prompt.
 *
 * A rename only carries real information when the bare type name is
 * AMBIGUOUS: two or more connections of the same connector type both fall back
 * to it, so the owner cannot tell "Amazon" from "Amazon". That is exactly the
 * condition under which the records list already appends a `· connection N`
 * ordinal (see `labelConnections` in connector-row.tsx) and the grant-pin
 * select appends `· account N` (see grant-request-connection-pin.ts). This
 * module is the shared, pure source of truth for that ambiguity so the row's
 * "Label needed" hint, the ordinal subtitles, and any future surface all agree.
 *
 * Kept dependency-free (only the shared connector-display labeler) so it runs
 * directly under `node --test` without a Next/server harness.
 */

import { isFallbackConnectionLabel } from "@pdpp/operator-ui/lib/connector-display";
import type { ConnectorOverview } from "./rs-client.ts";

/** The stable per-row key the list uses for routing and React keys. */
function overviewRouteId(overview: ConnectorOverview): string {
  return overview.connectionId ?? overview.connectorInstanceId ?? overview.connector.connector_id;
}

/**
 * True when this connection has no owner-meaningful label — its stored
 * `display_name` degrades to the bare connector type, a registry URL, a
 * `local-device:` binding, or a `legacy` placeholder.
 */
export function hasFallbackLabel(overview: ConnectorOverview): boolean {
  return isFallbackConnectionLabel({
    connectorId: overview.connector.connector_id,
    displayName: overview.connector.display_name,
    name: overview.connector.name,
  });
}

/**
 * The set of route keys whose fallback label is AMBIGUOUS — i.e. the
 * connection has no owner-set name AND at least one sibling of the same
 * connector type is also unnamed, so the bare type name cannot tell them
 * apart. These — and only these — are the connections for which a rename
 * surfaces real information and the "Label needed — rename" hint is honest.
 *
 * Pure and order-independent: the membership of a key never depends on its
 * position in the list, only on how many siblings share its connector type
 * and fallback status.
 */
export function ambiguousFallbackLabelKeys(overviews: readonly ConnectorOverview[]): Set<string> {
  // Count unnamed (fallback-label) connections per connector type.
  const fallbackCountByType = new Map<string, number>();
  for (const overview of overviews) {
    if (!hasFallbackLabel(overview)) {
      continue;
    }
    const type = overview.connector.connector_id;
    fallbackCountByType.set(type, (fallbackCountByType.get(type) ?? 0) + 1);
  }

  const ambiguous = new Set<string>();
  for (const overview of overviews) {
    if (!hasFallbackLabel(overview)) {
      continue;
    }
    if ((fallbackCountByType.get(overview.connector.connector_id) ?? 0) >= 2) {
      ambiguous.add(overviewRouteId(overview));
    }
  }
  return ambiguous;
}

/**
 * Whether this connection's row should surface the "Label needed — rename"
 * hint, given the ambiguity set computed across all sibling connections.
 *
 * The row is "label needed" only when it both lacks an owner-meaningful name
 * AND is one of the ambiguous fallbacks. A single connection of a type keeps
 * its honest type name with no nag.
 */
export function isLabelNeeded(overview: ConnectorOverview, ambiguousKeys: ReadonlySet<string>): boolean {
  return ambiguousKeys.has(overviewRouteId(overview));
}
