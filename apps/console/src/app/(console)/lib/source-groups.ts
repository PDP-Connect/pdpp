// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Group existing connections by source (connector type) for the Sources page.
 *
 * The Sources page lists one row per connection, which is correct for
 * monitoring but does not answer the owner's source-level question: "for a
 * source I already have, can I add another account, and is anything wrong with
 * what I have?" This helper rolls the flat connection list up to one entry per
 * connector type, carrying the counts and attention flags the Sources summary
 * needs — without touching the per-connection list, its sort, or its health
 * projection.
 *
 * Pure and JSX-free so the grouping is unit-testable. It introduces no new
 * health classification: it reads the same `connectionHealth.state` the rows
 * already render and only aggregates it per source.
 */

import { formatConnectorNameForDisplay } from "@pdpp/operator-ui/lib/connector-display";
import { isRevokedConnection } from "./records-list-classification.ts";
import type { ConnectorOverview } from "./rs-client.ts";

export interface SourceGroup {
  /** A connection route id to deep-link to for repair when attention is needed. */
  attentionRouteId: string | null;
  /** How many connections of this source the owner currently has. */
  connectionCount: number;
  /** Canonical connector id shared by every connection in this group. */
  connectorId: string;
  /** Owner-facing source/type display name (e.g. "Gmail"). */
  displayName: string;
  /** Connections of this source with a needs_attention or blocked health state. */
  needsAttentionCount: number;
  /** Connections of this source whose future collection is stopped by owner revoke. */
  revokedCount: number;
  /** Connections of this source with at least one durable record. */
  withDataCount: number;
}

const ATTENTION_STATES = new Set(["needs_attention", "blocked"]);

function routeId(overview: ConnectorOverview): string {
  return overview.connectionId ?? overview.connectorInstanceId ?? overview.connector.connector_id;
}

function needsAttention(overview: ConnectorOverview): boolean {
  const state = overview.connectionHealth?.state;
  return Boolean(state && ATTENTION_STATES.has(state));
}

/** Seed a fresh group from the first connection seen for a connector type. */
function seedGroup(overview: ConnectorOverview): SourceGroup {
  const attention = needsAttention(overview);
  return {
    attentionRouteId: attention ? routeId(overview) : null,
    connectionCount: 1,
    connectorId: overview.connector.connector_id,
    displayName: formatConnectorNameForDisplay({
      connectorId: overview.connector.connector_id,
      displayName: overview.connectorDisplayName,
      name: overview.connector.name,
    }),
    needsAttentionCount: attention ? 1 : 0,
    revokedCount: isRevokedConnection(overview) ? 1 : 0,
    withDataCount: overview.totalRecords > 0 ? 1 : 0,
  };
}

/** Fold one more connection of an already-seen connector type into its group. */
function foldGroup(group: SourceGroup, overview: ConnectorOverview): void {
  const attention = needsAttention(overview);
  group.connectionCount += 1;
  group.needsAttentionCount += attention ? 1 : 0;
  group.revokedCount += isRevokedConnection(overview) ? 1 : 0;
  group.withDataCount += overview.totalRecords > 0 ? 1 : 0;
  if (attention && !group.attentionRouteId) {
    group.attentionRouteId = routeId(overview);
  }
}

/** Attention-needed sources first, then alphabetical by display name. */
function compareGroups(a: SourceGroup, b: SourceGroup): number {
  const attentionRank = (b.needsAttentionCount > 0 ? 1 : 0) - (a.needsAttentionCount > 0 ? 1 : 0);
  return attentionRank === 0 ? a.displayName.localeCompare(b.displayName) : attentionRank;
}

/**
 * Build one source group per connector type present in `overviews`. Groups are
 * returned sorted with attention-needed sources first, then by display name, so
 * the Sources summary leads with what the owner must act on — the same urgency
 * intent the per-connection sort uses, applied at the source level.
 */
export function groupSourcesByConnector(overviews: readonly ConnectorOverview[]): SourceGroup[] {
  const byConnector = new Map<string, SourceGroup>();
  for (const overview of overviews) {
    const existing = byConnector.get(overview.connector.connector_id);
    if (existing) {
      foldGroup(existing, overview);
    } else {
      byConnector.set(overview.connector.connector_id, seedGroup(overview));
    }
  }
  return [...byConnector.values()].sort(compareGroups);
}
