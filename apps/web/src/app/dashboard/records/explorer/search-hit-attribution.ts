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

export function attributeSearchHit(
  hit: Pick<SearchResultHit, "connector_id" | "connection_id" | "connector_instance_id" | "display_name">,
  visibleSummaries: readonly RefConnectorSummary[]
): AttributedSearchHit {
  let hitConnectionId: string | null = null;
  if (typeof hit.connection_id === "string" && hit.connection_id.length > 0) {
    hitConnectionId = hit.connection_id;
  } else if (typeof hit.connector_instance_id === "string" && hit.connector_instance_id.length > 0) {
    hitConnectionId = hit.connector_instance_id;
  }

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
