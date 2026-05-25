/**
 * Pure attribution of a public `search_result` hit to a concrete
 * connection summary.
 *
 * The deployed RS does not return `connection_id` on `/v1/search*` hits
 * today; the public response schema is `additionalProperties: true` and a
 * future tranche (`expose-connection-identity-on-public-read`) makes the
 * field additive-optional. This helper is honest about that uncertainty:
 *
 *   1. If the hit carries a concrete `connection_id` (or its deprecated
 *      `connector_instance_id` alias), resolve to that summary.
 *   2. Otherwise, attribute to a summary ONLY when exactly one connection
 *      of the hit's `connector_id` is visible. With two or more matching
 *      connections we refuse to pick an arbitrary first match.
 *
 * No "first by connector_id" fallback. Two connections of the same
 * connector type that both match the visibility filter MUST yield
 * `connectionId: null` / `connectionDisplayName: null` so the UI can
 * label the row as connector-scoped.
 */
import type { RefConnectorSummary } from "../../lib/ref-client.ts";
import type { SearchResultHit } from "../../lib/rs-client.ts";

export interface AttributedSearchHit {
  connectionDisplayName: string | null;
  connectionId: string | null;
}

/**
 * Post-hoc filter applied to public `/v1/search*` hits in connection-aware
 * mode. The public contract does not yet accept `connection_id` as a
 * request parameter, so the dashboard narrows the response itself.
 *
 * Two layers:
 *   1. Connector-scope: drop hits whose `connector_id` is not represented
 *      in the visible (already filtered) summaries.
 *   2. Connection-scope (forward-compatible): when the owner has selected
 *      connection chips AND the hit carries concrete identity
 *      (`connection_id` or its deprecated `connector_instance_id` alias),
 *      drop the hit unless that identity is one of the selected visible
 *      connections. Hits without concrete identity fall through to (1).
 *
 * Stream-scope is enforced by the caller against the `stream` filter set.
 */
export function shouldIncludeSearchHit(
  hit: Pick<SearchResultHit, "connector_id" | "connection_id" | "connector_instance_id">,
  opts: {
    allowedConnectors: ReadonlySet<string>;
    allowedConnectionIds: ReadonlySet<string>;
    enforceConnectionFilter: boolean;
  }
): boolean {
  if (opts.allowedConnectors.size > 0 && !opts.allowedConnectors.has(hit.connector_id)) {
    return false;
  }
  if (opts.enforceConnectionFilter) {
    const hitConnectionId = pickHitConnectionId(hit);
    if (hitConnectionId && !opts.allowedConnectionIds.has(hitConnectionId)) {
      return false;
    }
  }
  return true;
}

function pickHitConnectionId(hit: Pick<SearchResultHit, "connection_id" | "connector_instance_id">): string | null {
  if (typeof hit.connection_id === "string" && hit.connection_id.length > 0) {
    return hit.connection_id;
  }
  if (typeof hit.connector_instance_id === "string" && hit.connector_instance_id.length > 0) {
    return hit.connector_instance_id;
  }
  return null;
}

export function attributeSearchHit(
  hit: Pick<SearchResultHit, "connector_id" | "connection_id" | "connector_instance_id" | "display_name">,
  visibleSummaries: readonly RefConnectorSummary[]
): AttributedSearchHit {
  const hitConnectionId = pickHitConnectionId(hit);

  let resolved: RefConnectorSummary | null = null;

  if (hitConnectionId) {
    resolved =
      visibleSummaries.find(
        (s) => s.connection_id === hitConnectionId || s.connector_instance_id === hitConnectionId
      ) ?? null;
  }

  if (!resolved) {
    const matches = visibleSummaries.filter((s) => s.connector_id === hit.connector_id);
    if (matches.length === 1) {
      resolved = matches[0] ?? null;
    }
  }

  const displayName =
    (typeof hit.display_name === "string" && hit.display_name.length > 0 ? hit.display_name : null) ||
    resolved?.display_name ||
    resolved?.connector_display_name ||
    null;

  return {
    connectionId: resolved?.connection_id ?? hitConnectionId ?? null,
    connectionDisplayName: displayName,
  };
}
