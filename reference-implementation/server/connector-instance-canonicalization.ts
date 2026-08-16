// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Single choke point for connector-instance canonicalization.
 *
 * Production can accumulate multiple `connector_instances` rows for the SAME
 * real provider account -- most commonly recovered-history fragments
 * manufactured by a spine-event recovery pass, each with a synthetic
 * `source_binding_key` that never collides with a sibling fragment's key (see
 * the live-inventory audit this module was built from,
 * connector-instance-groups design note). Every fragment stays a fully
 * independent row: same records, schedules, and credentials columns as any
 * other connector instance. `connector_instance_groups` (server/db.ts /
 * postgres-storage.ts) is a pure alias/read-model table recording "fragment X
 * is the SAME logical account as canonical Y" -- it is the ONLY place that
 * fact is recorded, and this module is the ONLY place that fact is resolved
 * back out.
 *
 * What this module GUARANTEES:
 *   - `resolveCanonicalConnectorInstanceId` is a total function: every
 *     connector_instance_id maps to SOME canonical id (itself, if ungrouped).
 *   - A canonical id is never itself resolved further (no transitive chains
 *     -- grouping always targets a terminal canonical row; see
 *     `assertGroupingTargetIsNotAFragment` in the migration tool).
 *   - Grouping is data (rows in `connector_instance_groups`), never inferred
 *     at read time from heuristics (record overlap, provider ids, etc.) --
 *     this module does not compute overlap or identity proof; it only
 *     resolves an already-decided mapping.
 *
 * What this module explicitly does NOT do (bounded scope of this change):
 *   - It does NOT rewrite `lexical_search_index` / `semantic_search_blob` /
 *     `connector_summary_evidence` rows or their read queries. Those surfaces
 *     still attribute results to the RAW connector_instance_id today. Wiring
 *     them to call through this resolver is the documented next step (see
 *     the migration-tool report), not silently claimed as done here.
 *   - It does NOT decide identity (no record-overlap computation, no
 *     provider-id comparison). That evidence-gathering lives in the audit /
 *     migration-tool input, never in this module.
 *   - It does NOT touch credentials, schedules, or connector_state. A grouped
 *     fragment keeps whatever it already had (in every proven live case:
 *     nothing -- paused, uncredentialed) and the migration tool refuses to
 *     group a fragment that itself carries live credentials or an active
 *     schedule onto a DIFFERENT canonical id, to avoid orphaning live sync
 *     state (see `assertFragmentHasNoLiveSyncState`).
 */

import { getMany } from "../lib/db.ts";
import { postgresQuery } from "./postgres-storage.ts";
import { referenceQueries } from "./queries/index.ts";

export interface ConnectorInstanceGroupRow {
  readonly canonicalConnectorInstanceId: string;
  readonly connectorInstanceId: string;
  readonly evidence: unknown;
  readonly groupedAt: string;
  readonly groupedBy: string;
  readonly ownerSubjectId: string;
  readonly reason: string;
}

interface RawGroupRow extends Record<string, unknown> {
  canonical_connector_instance_id: string;
  connector_instance_id: string;
  evidence: string;
  grouped_at: string;
  grouped_by: string;
  owner_subject_id: string;
  reason: string;
}

function mapGroupRow(row: RawGroupRow): ConnectorInstanceGroupRow {
  return {
    canonicalConnectorInstanceId: row.canonical_connector_instance_id,
    connectorInstanceId: row.connector_instance_id,
    evidence: typeof row.evidence === "string" ? JSON.parse(row.evidence) : row.evidence,
    groupedAt: row.grouped_at,
    groupedBy: row.grouped_by,
    ownerSubjectId: row.owner_subject_id,
    reason: row.reason,
  };
}

// Owners are expected to have a small number of grouped fragments (single or
// low double digits) relative to their total connector-instance inventory --
// consistent with every proven live case (Amazon: 12 fragments under one
// owner). This is a preload cap, not a claim about total connector instances.
const MAX_GROUPS_PER_OWNER = 500;

/**
 * SQLite: full grouping map for one owner, keyed by fragment id. Intended to
 * be preloaded ONCE per request/page (not per-row) and passed into
 * `resolveCanonicalConnectorInstanceId` -- callers must not issue a DB round
 * trip per row being resolved.
 */
export function loadOwnerConnectorInstanceGroupsSqlite(ownerSubjectId: string): Map<string, ConnectorInstanceGroupRow> {
  const { rows } = getMany<RawGroupRow>(referenceQueries.connectorInstanceGroupsListByOwner, [ownerSubjectId], {
    limit: MAX_GROUPS_PER_OWNER,
  });
  return new Map(rows.map((row) => [row.connector_instance_id, mapGroupRow(row)]));
}

/** Postgres mirror of `loadOwnerConnectorInstanceGroupsSqlite`. */
export async function loadOwnerConnectorInstanceGroupsPostgres(
  ownerSubjectId: string
): Promise<Map<string, ConnectorInstanceGroupRow>> {
  const result = await postgresQuery<RawGroupRow>(
    `SELECT connector_instance_id, canonical_connector_instance_id, owner_subject_id, reason, evidence, grouped_by, grouped_at
     FROM connector_instance_groups
     WHERE owner_subject_id = $1
     ORDER BY connector_instance_id ASC
     LIMIT $2`,
    [ownerSubjectId, MAX_GROUPS_PER_OWNER]
  );
  return new Map(result.rows.map((row) => [row.connector_instance_id, mapGroupRow(row)]));
}

/**
 * Resolve `connectorInstanceId` to its canonical id using an already-loaded
 * group map (see `loadOwnerConnectorInstanceGroups{Sqlite,Postgres}`).
 * Identity function when ungrouped -- every connector_instance_id maps to
 * SOME canonical id. Never recurses: `connector_instance_groups` targets are
 * asserted (by the migration tool) to never themselves be a fragment, so one
 * lookup is always sufficient.
 */
export function resolveCanonicalConnectorInstanceId(
  connectorInstanceId: string,
  groups: ReadonlyMap<string, ConnectorInstanceGroupRow>
): string {
  return groups.get(connectorInstanceId)?.canonicalConnectorInstanceId ?? connectorInstanceId;
}

/**
 * True when `connectorInstanceId` is a grouped fragment (i.e. some OTHER row
 * is its canonical identity) -- the predicate a read surface uses to exclude
 * a fragment from a "one row per logical account" list, mirroring
 * `isOwnerVisibleConnectorInstance`'s shape for the historical-archive
 * pure-fragment exclusion.
 */
export function isCanonicalizedFragment(
  connectorInstanceId: string,
  groups: ReadonlyMap<string, ConnectorInstanceGroupRow>
): boolean {
  return groups.has(connectorInstanceId);
}
