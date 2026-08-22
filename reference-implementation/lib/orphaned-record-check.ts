// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Boot-time record-attribution consistency check.
 *
 * Standing principle P1: no data known to the system may be invisible in the
 * UI. Every read surface the owner has — the Sources list, Explore's
 * connection facets, Add Source — enumerates connections from
 * `connector_instances` and then reads records scoped by
 * `connector_instance_id`. A live (`NOT deleted`) record whose
 * `connector_instance_id` has NO `connector_instances` row is therefore
 * unreachable from every one of those surfaces: nothing enumerates it, so
 * nothing can scope a record read to it. It is not deleted, not archived, and
 * not shown — it is silently stranded.
 *
 * This module does not repair that state; repair is a data decision the owner
 * must approve. It makes the state LOUD at boot, because the alternative the
 * owner rejected is silence: a restart that leaves the system inconsistent
 * while reporting nothing.
 *
 * Deliberately read-only. It runs `SELECT`s and returns a summary. It never
 * deletes, reassociates, or mutates a record — so it is safe to run on every
 * boot, before HTTP routes mount, on a database whose disposition has not yet
 * been decided.
 *
 * Note on `connector_summary_evidence` pruning: the evidence engine's
 * `pruneOrphanedEvidenceComplete` deletes the summary-evidence row for an
 * instance that no longer exists. That prune touches only
 * `connector_summary_evidence` — never `records` — so it cannot destroy the
 * owner's data. It does, however, remove the last *derived* trace of the
 * stranded instance, which is precisely why the underlying `records` rows
 * need this independent check rather than relying on evidence surviving.
 */

import { getDb } from "../server/db.ts";
import { isPostgresStorageBackend, postgresQuery } from "../server/postgres-storage.ts";

/** One stranded connector-instance id and how much live data it holds. */
export interface OrphanedRecordGroup {
  readonly connectorInstanceId: string;
  readonly liveRecords: number;
  readonly streams: number;
}

/** Outcome of the boot-time attribution check. */
export interface OrphanedRecordCheckResult {
  /**
   * The stranded groups, largest first, capped at {@link ORPHAN_REPORT_LIMIT}
   * so a pathological database cannot produce an unbounded boot log line.
   */
  readonly groups: readonly OrphanedRecordGroup[];
  /**
   * Distinct `connector_instance_id` values that have at least one live
   * record but no `connector_instances` row.
   */
  readonly orphanedInstanceCount: number;
  /** Total live (`NOT deleted`) records across those instances. */
  readonly orphanedRecordCount: number;
  /** True when `groups` was truncated by the cap. */
  readonly truncated: boolean;
}

/**
 * Cap on how many stranded groups are itemised. The aggregate counts above
 * are always exact and unaffected by this cap — only the itemised list is
 * bounded.
 */
export const ORPHAN_REPORT_LIMIT = 20;

// A live record's `connector_instance_id` with no matching row in
// `connector_instances`. `NOT deleted` is the same liveness predicate the
// owner-facing record reads use, so this counts exactly the rows a surface
// would have shown had the instance still existed. Grouped and ordered so the
// largest strand is reported first; the aggregate totals are computed
// separately from the full set, never from the capped page.
const ORPHAN_GROUPS_SQL_SQLITE = `
SELECT r.connector_instance_id AS connector_instance_id,
       COUNT(*) AS live_records,
       COUNT(DISTINCT r.stream) AS streams
FROM records r
LEFT JOIN connector_instances ci
  ON ci.connector_instance_id = r.connector_instance_id
WHERE r.deleted = 0
  AND ci.connector_instance_id IS NULL
GROUP BY r.connector_instance_id
ORDER BY live_records DESC, r.connector_instance_id ASC
LIMIT ?`;

const ORPHAN_GROUPS_SQL_POSTGRES = `
SELECT r.connector_instance_id AS connector_instance_id,
       COUNT(*) AS live_records,
       COUNT(DISTINCT r.stream) AS streams
FROM records r
LEFT JOIN connector_instances ci
  ON ci.connector_instance_id = r.connector_instance_id
WHERE NOT r.deleted
  AND ci.connector_instance_id IS NULL
GROUP BY r.connector_instance_id
ORDER BY live_records DESC, r.connector_instance_id ASC
LIMIT $1`;

const ORPHAN_TOTALS_SQL_SQLITE = `
SELECT COUNT(*) AS live_records,
       COUNT(DISTINCT r.connector_instance_id) AS instances
FROM records r
LEFT JOIN connector_instances ci
  ON ci.connector_instance_id = r.connector_instance_id
WHERE r.deleted = 0
  AND ci.connector_instance_id IS NULL`;

const ORPHAN_TOTALS_SQL_POSTGRES = `
SELECT COUNT(*) AS live_records,
       COUNT(DISTINCT r.connector_instance_id) AS instances
FROM records r
LEFT JOIN connector_instances ci
  ON ci.connector_instance_id = r.connector_instance_id
WHERE NOT r.deleted
  AND ci.connector_instance_id IS NULL`;

type CountValue = number | string | bigint;

interface GroupRow {
  connector_instance_id: string;
  live_records: CountValue;
  streams: CountValue;
  [column: string]: unknown;
}

interface TotalsRow {
  instances: CountValue;
  live_records: CountValue;
  [column: string]: unknown;
}

// Postgres returns COUNT(*) as bigint, which node-postgres surfaces as a
// string; SQLite returns a number. Normalise both rather than letting a
// string leak into arithmetic or a JSON log field.
function toCount(value: CountValue | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return typeof value === "number" ? value : Number(value);
}

/**
 * Find live records whose owning connection no longer exists.
 *
 * Read-only. Returns exact aggregate totals plus a bounded itemised list.
 */
export async function findOrphanedRecords(limit: number = ORPHAN_REPORT_LIMIT): Promise<OrphanedRecordCheckResult> {
  const groupRows: GroupRow[] = [];
  let totals: TotalsRow | undefined;

  if (isPostgresStorageBackend()) {
    const groups = await postgresQuery<GroupRow>(ORPHAN_GROUPS_SQL_POSTGRES, [limit]);
    groupRows.push(...groups.rows);
    const [totalsRow] = (await postgresQuery<TotalsRow>(ORPHAN_TOTALS_SQL_POSTGRES, [])).rows;
    totals = totalsRow;
  } else {
    const db = getDb();
    groupRows.push(...(db.prepare(ORPHAN_GROUPS_SQL_SQLITE).all(limit) as GroupRow[]));
    totals = db.prepare(ORPHAN_TOTALS_SQL_SQLITE).get() as TotalsRow | undefined;
  }

  const groups = groupRows.map((row) => ({
    connectorInstanceId: row.connector_instance_id,
    liveRecords: toCount(row.live_records),
    streams: toCount(row.streams),
  }));

  return {
    groups,
    orphanedInstanceCount: toCount(totals?.instances),
    orphanedRecordCount: toCount(totals?.live_records),
    truncated: groups.length >= limit && toCount(totals?.instances) > groups.length,
  };
}

/** Minimal logger shape this check needs — matches the server's pino logger. */
export interface OrphanCheckLogger {
  error: (obj: Record<string, unknown>, msg: string) => void;
  info: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Run the check and report it.
 *
 * Reported at `error` level, not `warn`: stranded records are a standing
 * violation of P1 that no automatic process will resolve, so this must not
 * sit in a severity band operators routinely filter out. A clean database
 * logs a single `info` line — the check is never silent about having run,
 * because "no output" is indistinguishable from "check did not execute".
 *
 * Never throws on finding orphans: this reports a pre-existing data
 * condition, and refusing to boot would take the owner's remaining
 * 5.4M visible records offline to protest 8,857 stranded ones. A failure of
 * the check ITSELF (a broken query, an unreachable database) does propagate,
 * because that is a real fault rather than a finding.
 */
export async function checkOrphanedRecordsAtBoot(logger: OrphanCheckLogger): Promise<OrphanedRecordCheckResult> {
  const result = await findOrphanedRecords();

  if (result.orphanedRecordCount === 0) {
    logger.info({ orphaned_records: 0 }, "record-attribution check: every live record has an owning connection");
    return result;
  }

  logger.error(
    {
      groups: result.groups.map((group) => ({
        connector_instance_id: group.connectorInstanceId,
        live_records: group.liveRecords,
        streams: group.streams,
      })),
      orphaned_instances: result.orphanedInstanceCount,
      orphaned_records: result.orphanedRecordCount,
      truncated: result.truncated,
    },
    "record-attribution check: live records reference a connection that no longer exists — this data is not visible on any owner surface"
  );

  return result;
}
