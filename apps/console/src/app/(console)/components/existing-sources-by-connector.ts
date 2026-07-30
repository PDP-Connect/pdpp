// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Exact, per-connector existing-sources lookup for Add Source and
 * manual-upload discovery — closes gate finding 1 (the rejected
 * one-arbitrary-fleet-page `complete`/`existingSourcesIncomplete` stopgap
 * this replaces entirely).
 *
 * Composition (not a single call, because the two available backend shapes
 * are complementary, not substitutable):
 *   1. `listConnectionsByConnector(connectorId)` — the reference's exact,
 *      connector_id-filtered, UNPAGINATED `GET /_ref/connections` seam
 *      (`ref-client.ts`). Returns every connection the owner has for that
 *      one connector, exactly — no fleet-page ambiguity, because the route
 *      is scoped by connector identity, not fleet position.
 *   2. For each connection id that route returns, a SCOPED
 *      `listConnectorSummaries({ connectionRouteId })` call (the same
 *      "0-or-1 list" mechanism Explore's `resolveExactSelectedSummaries`
 *      already uses) backfills the fields `/_ref/connections` does not
 *      carry: `total_records`/`total_records_state` (record counts) and
 *      `acquisition_coverage.latest_batch` (latest-import file/status) —
 *      both genuinely rendered in the existing-sources card, not decorative.
 *
 * Call volume is bounded by the connector's OWN connection count (typically
 * 1-3 for a real owner), never by fleet size — structurally the same shape
 * as the exact-selection fix already shipped for Explore, not a
 * reintroduction of any fleet-wide read.
 *
 * There is no `complete`/incompleteness signal on the result: a connector's
 * existing-sources list is exact by construction (bounded by that
 * connector's own connection count, not truncated by an arbitrary global
 * page boundary), so there is nothing partial to disclose.
 */

import { listConnectionsByConnector, listConnectorSummaries } from "../lib/ref-client.ts";
import type { ExistingSourceSetupLink } from "./source-setup-catalog.tsx";

function latestImportFacts(
  coverage: { latest_batch?: { status?: string | null; uploaded_file_name?: string | null } | null } | null | undefined
): { file: string | null; status: string | null } {
  const batch = coverage?.latest_batch ?? null;
  return {
    file: batch?.uploaded_file_name ?? null,
    status: batch?.status ?? null,
  };
}

/**
 * Fetch the exact set of existing (non-revoked) sources for ONE connector.
 * Sorted by display name, matching the prior stopgap's presentation order.
 */
export async function existingSourcesForConnector(connectorId: string): Promise<ExistingSourceSetupLink[]> {
  const connections = await listConnectionsByConnector(connectorId);
  const live = connections.filter((connection) => connection.status !== "revoked" && !connection.revoked_at);
  const summaries = await Promise.all(
    live.map((connection) => listConnectorSummaries({ connectionRouteId: connection.connector_instance_id }))
  );
  const links = live.map((connection, index): ExistingSourceSetupLink => {
    // A 0-or-1 list — the connection is authoritative for identity/status,
    // the scoped summary (when present) backfills the decorative fields.
    const summary = summaries[index]?.data[0];
    const importFacts = latestImportFacts(summary?.acquisition_coverage);
    return {
      connectionId: connection.connector_instance_id,
      displayName: connection.display_name,
      latestImportFile: importFacts.file,
      latestImportStatus: importFacts.status,
      status: connection.status,
      totalRecords: summary?.total_records ?? 0,
      totalRecordsState: summary?.total_records_state,
    };
  });
  return links.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Fetch the exact existing-sources map for every connector in the catalog —
 * one `listConnectionsByConnector` call per catalog entry (the set of
 * REGISTERED connector types, typically a few dozen — a fundamentally
 * different, small, bounded cardinality from the owner's fleet size, which
 * is what this whole migration exists to bound). Used by Add Source, which
 * needs "does any connector already have a source" across its whole catalog.
 */
export async function existingSourcesByConnectorCatalog(
  connectorIds: readonly string[]
): Promise<Record<string, readonly ExistingSourceSetupLink[]>> {
  const entries = await Promise.all(
    connectorIds.map(
      async (connectorId): Promise<readonly [string, ExistingSourceSetupLink[]]> => [
        connectorId,
        await existingSourcesForConnector(connectorId),
      ]
    )
  );
  const byConnector: Record<string, readonly ExistingSourceSetupLink[]> = {};
  for (const [connectorId, links] of entries) {
    if (links.length > 0) {
      byConnector[connectorId] = links;
    }
  }
  return byConnector;
}
