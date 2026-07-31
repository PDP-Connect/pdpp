// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Batched existing-sources lookup for Add Source and manual-upload discovery
 * (design doc add-source-perf-design-agy-0730.md; Fable ruling
 * terminal-read-architecture-fable-0730.md §2 R5, §3 G2/G4). Replaces the
 * prior 33-call catalog inventory (one `GET /_ref/connections?connector_id=`
 * per registered connector type) plus a per-live-connection scoped
 * full-summary N+1: both were bounded by catalog/connection cardinality but
 * still O(catalog) HTTP round trips for a question the batched
 * `retained_count_summary` profile answers with `ceil(R / 100)` calls, R
 * being the exact result count across the requested connector-type scope.
 *
 * Composition: one bounded repeated `connector_id` SET scope (design doc
 * "Minimal contract", 1..100 canonical distinct ids per request) against
 * `GET /_ref/connectors?profile=retained_count_summary`, traversed via
 * `next_cursor` to exhaustion — never a single unfollowed page called
 * "complete." A catalog larger than 100 connector types is partitioned into
 * disjoint 100-id scopes (design doc "Why this preserves completeness":
 * result sets are disjoint by canonical connector id, so partitioning never
 * double-counts or drops a connection). `total_records`/`total_records_state`/
 * `acquisition_coverage.latest_batch` — the exact fields this card
 * renders — come from the SAME batched page read, not a second per-connection
 * request.
 *
 * There is no `complete`/incompleteness signal on the result: exhausted
 * cursor traversal over an exact connector-id scope is complete by
 * construction, so there is nothing partial to disclose.
 */

import { mapWithConcurrency } from "../lib/concurrency.ts";
import {
  CONNECTOR_SUMMARY_CONNECTOR_ID_SET_MAX,
  listConnectorSummaries,
  type RefConnectorRetainedCountSummary,
} from "../lib/ref-client.ts";
import type { ExistingSourceSetupLink } from "./source-setup-catalog.tsx";

/**
 * Cross-partition concurrency bound for `fetchRetainedCountSummaries`.
 * Partitions are already bounded in SIZE (≤100 ids each,
 * `CONNECTOR_SUMMARY_CONNECTOR_ID_SET_MAX`); this bounds the number of
 * partitions traversed CONCURRENTLY, so a catalog large enough to need many
 * partitions (>800 distinct connector types) still issues at most this many
 * outbound reference-server requests at once, never one per partition.
 * Mirrors the reference server's own `LIST_CONNECTOR_SUMMARIES_CONCURRENCY`
 * precedent (ref-control.ts) — same small fixed bound, applied one layer
 * out (HTTP fan-out here, in-process projection there).
 */
const EXISTING_SOURCES_PARTITION_CONCURRENCY = 8;

function latestImportFacts(coverage: RefConnectorRetainedCountSummary["acquisition_coverage"]): {
  file: string | null;
  status: string | null;
} {
  const batch = coverage?.latest_batch ?? null;
  return {
    file: batch?.uploaded_file_name ?? null,
    status: batch?.status ?? null,
  };
}

function toExistingSourceSetupLink(row: RefConnectorRetainedCountSummary): ExistingSourceSetupLink {
  const importFacts = latestImportFacts(row.acquisition_coverage);
  return {
    connectionId: row.connector_instance_id,
    displayName: row.display_name,
    latestImportFile: importFacts.file,
    latestImportStatus: importFacts.status,
    status: row.status,
    totalRecords: row.total_records,
    totalRecordsState: row.total_records_state,
  };
}

function isLive(row: RefConnectorRetainedCountSummary): boolean {
  return row.status !== "revoked" && !row.revoked_at;
}

/**
 * Partition `connectorIds` into disjoint scopes of at most
 * {@link CONNECTOR_SUMMARY_CONNECTOR_ID_SET_MAX} ids each — the accepted
 * request-scope ceiling (design doc "Minimal contract"). Duplicate ids are
 * collapsed before partitioning: the reference rejects a duplicate-after-
 * canonicalization set as a typed invalid request.
 */
function partitionConnectorIds(connectorIds: readonly string[]): readonly string[][] {
  const distinct = [...new Set(connectorIds)];
  const partitions: string[][] = [];
  for (let offset = 0; offset < distinct.length; offset += CONNECTOR_SUMMARY_CONNECTOR_ID_SET_MAX) {
    partitions.push(distinct.slice(offset, offset + CONNECTOR_SUMMARY_CONNECTOR_ID_SET_MAX));
  }
  return partitions;
}

/**
 * Traverse one bounded connector-id scope (1..100 canonical distinct ids) to
 * exhaustion via `next_cursor`, following the `has_more` bit rather than
 * inferring completeness from any single page (design doc "Why this
 * preserves completeness").
 */
async function traverseConnectorIdScope(connectorIds: readonly string[]): Promise<RefConnectorRetainedCountSummary[]> {
  if (connectorIds.length === 0) {
    return [];
  }
  const rows: RefConnectorRetainedCountSummary[] = [];
  let cursor: string | undefined;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: each page's continuation cursor depends on the previous page's response.
    const page = await listConnectorSummaries({
      connectorId: connectorIds,
      cursor,
      limit: CONNECTOR_SUMMARY_CONNECTOR_ID_SET_MAX,
      profile: "retained_count_summary",
    });
    rows.push(...page.data);
    if (!(page.has_more && page.next_cursor)) {
      break;
    }
    cursor = page.next_cursor;
  }
  return rows;
}

/**
 * Fetch every owner-visible `retained_count_summary` row across
 * `connectorIds`, exhausted across as many partitioned 100-id scopes and
 * cursor pages as the result set requires. Partitions traverse independently
 * (disjoint result sets by canonical connector id), so partition order does
 * not matter and a single slow partition never blocks the others from
 * starting — but partition COUNT is unbounded (one per 100 catalog ids), so
 * traversal runs through `mapWithConcurrency` at
 * {@link EXISTING_SOURCES_PARTITION_CONCURRENCY} rather than `Promise.all`:
 * an arbitrarily large catalog must not fan out one concurrent HTTP request
 * per partition. A failed partition rejects the whole call (never silently
 * contributes zero rows and reports "complete" — completeness is never
 * fabricated on partial failure).
 */
async function fetchRetainedCountSummaries(
  connectorIds: readonly string[]
): Promise<readonly RefConnectorRetainedCountSummary[]> {
  const partitions = partitionConnectorIds(connectorIds);
  const results = await mapWithConcurrency(partitions, EXISTING_SOURCES_PARTITION_CONCURRENCY, (partition) =>
    traverseConnectorIdScope(partition)
  );
  return results.flat();
}

/**
 * Fetch the exact set of existing (non-revoked) sources for ONE connector.
 * Sorted by display name, matching the prior stopgap's presentation order.
 */
export async function existingSourcesForConnector(connectorId: string): Promise<ExistingSourceSetupLink[]> {
  const rows = await fetchRetainedCountSummaries([connectorId]);
  const links = rows.filter(isLive).map(toExistingSourceSetupLink);
  return links.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

/**
 * Fetch the exact existing-sources map for every connector in the catalog —
 * one exhausted batched traversal across the whole catalog id set (partitioned
 * into disjoint ≤100-id scopes), never one request per catalog entry. Used by
 * Add Source, which needs "does any connector already have a source" across
 * its whole catalog.
 */
export async function existingSourcesByConnectorCatalog(
  connectorIds: readonly string[]
): Promise<Record<string, readonly ExistingSourceSetupLink[]>> {
  const rows = await fetchRetainedCountSummaries(connectorIds);
  const byConnector: Record<string, ExistingSourceSetupLink[]> = {};
  for (const row of rows) {
    if (!isLive(row)) {
      continue;
    }
    const existing = byConnector[row.connector_id];
    if (existing) {
      existing.push(toExistingSourceSetupLink(row));
    } else {
      byConnector[row.connector_id] = [toExistingSourceSetupLink(row)];
    }
  }
  for (const connectorId of Object.keys(byConnector)) {
    byConnector[connectorId] = (byConnector[connectorId] as ExistingSourceSetupLink[]).sort((a, b) =>
      a.displayName.localeCompare(b.displayName)
    );
  }
  return byConnector;
}
