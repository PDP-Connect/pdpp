#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * device-source-instance-duplicate-binding-repair
 *
 * Owner/operator-only operational tool that finds and repairs EXISTING
 * `device_source_instances` duplicate-binding rows left over from before
 * the enrollment-lifecycle fix in `performFirstEnrollment`
 * (`consumeEnrollmentCodeAndSupersedePriorDevices`, see
 * `device-exporter-store.ts`). That fix supersedes a prior device going
 * forward, at enroll time; it does not retroactively touch rows created
 * before it shipped. This tool is the bounded, idempotent repair for those
 * pre-existing duplicates.
 *
 * The durable invariant this tool repairs:
 *
 *   For each `(owner_subject_id, connector_id, source_kind,
 *   local_binding_id)` identity key, at most ONE non-revoked
 *   `device_source_instances` row SHALL exist.
 *
 * The live incident that motivated this tool: pdpp.vivid.fish's
 * "vivid-fish Codex" connection (`connector_instance_id`
 * `cin_da9889ea09f0132af33c2f4e`) carried two non-revoked
 * `device_source_instances` rows bound to the same `local_binding_id`
 * ("vivid-fish") — one from a live, heartbeating device, and one dead
 * stub from an abandoned 2026-07-24 enrollment attempt that never
 * heartbeated. `connector-outbox-axis.ts`'s untrusted-gap safety guard
 * (deliberately conservative: ANY trusted-but-never-heartbeated row
 * poisons the whole aggregation, so a dead collector can never silently
 * read healthy) correctly refused to trust the connection while that
 * dead stub sat there — pinning the connection's outbox axis to
 * `unknown` and its freshness to a stale historical snapshot, even
 * while the live device heartbeated every ~15 minutes.
 *
 * LEGACY-NULL source_kind (live-shape correction): `device_source_instances
 * .source_kind` was added via `ALTER TABLE ... ADD COLUMN` with no backfill
 * (see migratePostgresSpineSourceColumns's sibling migration in
 * postgres-storage.ts), so rows written before that migration are
 * permanently NULL unless explicitly repaired. The dead stub in the live
 * incident above is EXACTLY this shape: `dexp_b07c56a6e71de9ae`'s row has
 * `source_kind IS NULL`, while the healthy row has `source_kind =
 * 'local_device'`. A first version of this tool filtered
 * `dsi.source_kind IS NOT NULL`, which silently excluded the NULL row from
 * ever being scanned — the exact live duplicate this tool exists to find
 * was invisible to it. The scan and revalidation queries below instead
 * resolve each row's EFFECTIVE source_kind by joining through
 * `connector_instances` (whose own `source_kind` column is `NOT NULL` and
 * constraint-checked to one of a fixed enum): `COALESCE(dsi.source_kind,
 * ci.source_kind)`. This is authoritative, not a guess — `connector_
 * instances.source_kind` is the ORIGINAL kind decision made once, at
 * enrollment, for the whole binding; every `device_source_instances` row
 * durably bound to that SAME `connector_instance_id` necessarily shares it
 * (a `device_source_instances` row is never re-pointed to a
 * connector_instance of a different kind — `deviceExporterSourceBinding
 * Identity` folds `sourceKind` into the very identity that selects/creates
 * the connector_instance in the first place). A row whose
 * `connector_instance_id` is itself NULL (an unfinished placeholder that
 * never reached `upsertSourceInstance`, per `resolveOrCreateEnrollmentDevice`
 * 's doc comment) has no connector_instance to resolve from and is excluded
 * from consideration entirely — never silently assigned a guessed kind.
 * `applyRepairPlanEntry` additionally normalizes: whenever a surviving OR
 * superseded row's raw `source_kind` is NULL, it backfills the column to
 * the resolved value in the SAME locked transaction, so a re-scan converges
 * on real (non-NULL) data — the terminal invariant — rather than needing
 * this resolution logic forever.
 *
 * Authoritative-row selection (per group):
 *   1. Prefer the row with the MOST RECENT `last_heartbeat_at` — real,
 *      current evidence of life beats everything else.
 *   2. If no row in the group has ever heartbeated, fall back to the
 *      most recently CREATED row — the newest enrollment attempt is the
 *      one most likely to still be in use.
 *   Every other row in the group is superseded (revoked) via the exact
 *   same cascade `revokeDevice`/`consumeEnrollmentCodeAndSupersedePriorDevices`
 *   use: device -> credentials -> source-instances -> connector_instance-
 *   if-now-orphaned. Nothing is deleted; every state transition is a
 *   status flip with a `revoked_at` stamp, so the repair is fully
 *   auditable and the connector_instance itself is untouched (the
 *   authoritative row's device still references it).
 *
 * Concurrency safety (transaction + lock + revalidation): `scanDuplicateBindings`
 * is a plain read used only to build a CANDIDATE plan — by the time
 * `applyRepairPlanEntry` runs, that plan may be stale (a concurrent
 * heartbeat, re-enrollment, or another repair run could have changed
 * which row is authoritative, or already revoked one of the candidates).
 * `applyRepairPlanEntry` therefore does NOT trust the candidate plan's
 * membership or authoritative pick for the actual writes. Per group, it:
 *   1. Opens ONE transaction.
 *   2. `SELECT ... FOR UPDATE` every currently non-revoked
 *      `device_source_instances` row for that EXACT identity key
 *      (owner, connector, source_kind, binding) — this both re-reads
 *      current truth and row-locks it against concurrent heartbeat,
 *      enrollment, or another repair's writes for the duration of the
 *      transaction.
 *   3. Re-derives the authoritative row from the FRESHLY LOCKED rows
 *      (never from the candidate plan) using the same pure selection
 *      logic.
 *   4. Revokes only the locked rows that are (a) not the freshly-derived
 *      authoritative row and (b) still non-revoked at lock time.
 *   5. Commits.
 * This makes a newly-authoritative device (e.g. one that heartbeated
 * between scan and apply) provably safe from revocation — its is-
 * authoritative status is decided under lock, immediately before the
 * write, not from a snapshot taken earlier. Applying the SAME group
 * twice (e.g. two concurrent repair runs) converges to the same
 * single-survivor state without double-revoking or racing: the second
 * run's lock acquisition waits for the first's transaction, then
 * re-reads a group that already has at most one non-revoked row and has
 * nothing left to revoke.
 *
 * This tool NEVER supersedes a genuinely distinct device: it only acts
 * within one (owner, connector, EFFECTIVE source_kind, local_binding_id)
 * group, which is the same identity key `resolveOrCreateEnrollmentDevice`
 * uses to decide whether two devices are "the same binding" — "effective"
 * meaning NULL raw values are resolved through `connector_instances`
 * first (see "LEGACY-NULL source_kind" above), never left as an
 * un-resolved NULL that could either wrongly exclude a real duplicate or
 * wrongly merge two rows that only coincidentally share a NULL. Two
 * devices under DIFFERENT binding names, or whose resolved kinds are
 * genuinely different, are never compared or touched.
 *
 * Authorization is by direct database access — possession of
 * `PDPP_DATABASE_URL` (the same credential that grants owner-level
 * access to the reference Postgres). There is no HTTP route. Postgres-
 * only, matching record-current-projection-repair.ts's convention.
 *
 * Output discipline: only aggregate counts, group identity keys, device
 * ids, and heartbeat timestamps are printed — no record payloads, no
 * credentials, no tokens.
 *
 * Usage:
 *   node reference-implementation/scripts/repair/device-source-instance-duplicate-binding-repair.ts \
 *     [--owner-subject-id=<id>] [--connector-id=<id>] [--apply]
 *
 * Env:
 *   PDPP_DATABASE_URL   required (postgres connection string).
 *                       PDPP_TEST_POSTGRES_URL is accepted as a fallback
 *                       so the same CLI can be exercised against a
 *                       throwaway test database.
 *
 * Default is dry-run (scan + report only). Use --apply to execute the
 * revoke cascade. Idempotent: re-running after --apply finds zero
 * duplicate groups (every group already has exactly one non-revoked row).
 */

import process from "node:process";
// biome-ignore lint/correctness/noUnresolvedImports: Biome cannot resolve this installed package export; Node and TypeScript resolve it.
import pg from "pg";

const { Pool } = pg;

export interface DuplicateBindingRow {
  readonly connectorId: string;
  /** The `device_source_instances.connector_instance_id` this row is bound
   *  to. Required (rows with a NULL connector_instance_id are excluded by
   *  `selectGroupRows` — see its doc comment) — the authoritative anchor
   *  `sourceKind` is resolved from. */
  readonly connectorInstanceId: string;
  readonly deviceId: string;
  readonly deviceStatus: string;
  readonly lastHeartbeatAt: string | null;
  readonly localBindingId: string;
  readonly ownerSubjectId: string;
  readonly sourceInstanceCreatedAt: string;
  readonly sourceInstanceId: string;
  /** The EFFECTIVE source_kind: `device_source_instances.source_kind` when
   *  non-NULL, otherwise resolved from the authoritative, NOT-NULL
   *  `connector_instances.source_kind` for this row's `connectorInstanceId`.
   *  Never the raw, possibly-NULL column directly — see the module doc
   *  comment's "LEGACY-NULL source_kind" section. */
  readonly sourceKind: string;
  /** True when the raw `device_source_instances.source_kind` column was
   *  NULL and `sourceKind` was resolved from `connector_instances.source_
   *  kind` instead. `applyRepairPlanEntry` backfills the column when this
   *  is true, in the same locked transaction as any revocation. */
  readonly sourceKindWasLegacyNull: boolean;
}

export interface DuplicateBindingGroup {
  readonly connectorId: string;
  /** The single connector_instance_id every row in this group is bound to
   *  — the revalidation anchor `applyRepairPlanEntry` re-reads by. */
  readonly connectorInstanceId: string;
  readonly localBindingId: string;
  readonly ownerSubjectId: string;
  readonly rows: readonly DuplicateBindingRow[];
  readonly sourceKind: string;
}

interface PgQueryResult<T> {
  readonly rows: T[];
}

interface PgClientLike {
  query: <T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => Promise<PgQueryResult<T>>;
}

interface PgPoolClientLike extends PgClientLike {
  release: () => void;
}

interface PgPoolLike {
  connect: () => Promise<PgPoolClientLike>;
  query: PgClientLike["query"];
}

/**
 * Scan for every (owner, connector, EFFECTIVE source_kind, binding)
 * identity group with more than one non-revoked device_source_instances
 * row. Read-only. Optional owner/connector filters narrow the scan (e.g.
 * for a targeted live-incident repair); omitted, it scans the entire
 * fleet. This is a CANDIDATE-plan read only — see the module doc comment
 * for why `applyRepairPlanEntry` never trusts it for the actual writes.
 */
export async function scanDuplicateBindings(
  client: PgClientLike,
  filters: { connectorId?: string | null; ownerSubjectId?: string | null } = {}
): Promise<DuplicateBindingGroup[]> {
  const rows = await selectGroupRows(client, {
    connectorId: filters.connectorId ?? null,
    connectorInstanceId: null,
    localBindingId: null,
    ownerSubjectId: filters.ownerSubjectId ?? null,
  });
  return groupDuplicateBindingRows(rows);
}

/**
 * Shared row-fetch + mapping used by both the fleet-wide scan and the
 * per-group revalidation inside a transaction. `forUpdate` row-locks the
 * result set (Postgres `SELECT ... FOR UPDATE`) so concurrent writers
 * (heartbeat, enrollment, another repair run) block until this
 * transaction commits or rolls back.
 *
 * Resolves each row's EFFECTIVE `source_kind` via a JOIN to
 * `connector_instances` (`COALESCE(dsi.source_kind, ci.source_kind)`) —
 * see the module doc comment's "LEGACY-NULL source_kind" section for why
 * this is authoritative rather than a guess. A row with a NULL
 * `connector_instance_id` has nothing to resolve from and is excluded
 * (`dsi.connector_instance_id IS NOT NULL`) — it is an unfinished
 * placeholder, not a completed binding this tool's invariant applies to.
 * Filtering by `connectorInstanceId` (rather than by kind) is what the
 * revalidation call site uses: re-reading by the EXACT connector_instance
 * a candidate group's rows were bound to is a stronger, simpler
 * revalidation anchor than re-matching a derived kind string.
 */
async function selectGroupRows(
  client: PgClientLike,
  filters: {
    connectorId: string | null;
    connectorInstanceId: string | null;
    localBindingId: string | null;
    ownerSubjectId: string | null;
  },
  forUpdate = false
): Promise<DuplicateBindingRow[]> {
  const result = await client.query<{
    connector_id: string;
    connector_instance_id: string;
    device_id: string;
    device_status: string;
    effective_source_kind: string;
    last_heartbeat_at: string | null;
    local_binding_id: string;
    owner_subject_id: string;
    raw_source_kind: string | null;
    source_instance_created_at: string;
    source_instance_id: string;
  }>(
    `SELECT
        de.owner_subject_id,
        dsi.connector_id,
        dsi.connector_instance_id,
        dsi.source_kind AS raw_source_kind,
        COALESCE(dsi.source_kind, ci.source_kind) AS effective_source_kind,
        dsi.local_binding_id,
        dsi.device_id,
        dsi.source_instance_id,
        dsi.last_heartbeat_at,
        dsi.created_at AS source_instance_created_at,
        de.status AS device_status
      FROM device_source_instances dsi
      JOIN device_exporters de ON de.device_id = dsi.device_id
      JOIN connector_instances ci ON ci.connector_instance_id = dsi.connector_instance_id
      WHERE dsi.status != 'revoked'
        AND de.status != 'revoked'
        AND dsi.connector_instance_id IS NOT NULL
        AND ($1::text IS NULL OR de.owner_subject_id = $1)
        AND ($2::text IS NULL OR dsi.connector_id = $2)
        AND ($3::text IS NULL OR dsi.local_binding_id = $3)
        AND ($4::text IS NULL OR dsi.connector_instance_id = $4)
      ORDER BY de.owner_subject_id, dsi.connector_id, dsi.connector_instance_id, dsi.created_at DESC${
        forUpdate ? "\n      FOR UPDATE OF dsi" : ""
      }`,
    [filters.ownerSubjectId, filters.connectorId, filters.localBindingId, filters.connectorInstanceId]
  );
  return result.rows.map((row) => ({
    connectorId: row.connector_id,
    connectorInstanceId: row.connector_instance_id,
    deviceId: row.device_id,
    deviceStatus: row.device_status,
    lastHeartbeatAt: row.last_heartbeat_at,
    localBindingId: row.local_binding_id,
    ownerSubjectId: row.owner_subject_id,
    sourceInstanceCreatedAt: row.source_instance_created_at,
    sourceInstanceId: row.source_instance_id,
    sourceKind: row.effective_source_kind,
    sourceKindWasLegacyNull: row.raw_source_kind === null,
  }));
}

/**
 * Pure grouping + duplicate-filter: groups rows by the exact identity key
 * `resolveOrCreateEnrollmentDevice` uses (owner, connector, EFFECTIVE
 * source_kind, binding — see `DuplicateBindingRow.sourceKind`'s doc
 * comment for what "effective" means), then, within each such bucket,
 * splits FURTHER by `connectorInstanceId` before accepting a group as a
 * genuine duplicate — this is the "never merge genuinely different
 * kinds/devices" guarantee applied literally: `connector_instances`'
 * `(owner_subject_id, connector_id, source_kind, source_binding_key)`
 * UNIQUE constraint means the 4-tuple key normally implies exactly one
 * connector_instance_id, but a legacy connector_instances row whose id
 * predates the deterministic-id formula (see D8 in mass-justifications.json)
 * can coincidentally share a 4-tuple with a different, newer
 * connector_instance_id. Two rows are only ever treated as the same
 * "duplicate" group when BOTH the 4-tuple AND connector_instance_id match
 * — proven equivalence, not an assumption. Finally keeps only groups with
 * more than one row. Exported and tested standalone so the "what counts as
 * a duplicate" decision is provable without a database. The key
 * (`duplicateBindingGroupKey`) is an injective `JSON.stringify` encoding —
 * never a plain delimiter join, which can collide across a field boundary
 * (see that function's doc comment), and never a raw control character
 * embedded in source, which risks silent binary corruption of the tracked
 * file.
 */
export function groupDuplicateBindingRows(rows: readonly DuplicateBindingRow[]): DuplicateBindingGroup[] {
  const groups = new Map<string, DuplicateBindingRow[]>();
  for (const row of rows) {
    // Splitting by connector_instance_id INSIDE the 4-tuple key (rather
    // than as a separate grouping pass) means two rows that share a
    // 4-tuple but differ in connector_instance_id land in different
    // buckets from the start — they are never transiently merged and then
    // split, so there is no window where a caller could observe them as
    // one group.
    const key = duplicateBindingGroupKey(row);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  const out: DuplicateBindingGroup[] = [];
  for (const rowsForKey of groups.values()) {
    if (rowsForKey.length <= 1) {
      continue;
    }
    const [first] = rowsForKey;
    if (!first) {
      continue;
    }
    out.push({
      connectorId: first.connectorId,
      connectorInstanceId: first.connectorInstanceId,
      localBindingId: first.localBindingId,
      ownerSubjectId: first.ownerSubjectId,
      rows: rowsForKey,
      sourceKind: first.sourceKind,
    });
  }
  return out;
}

/**
 * The identity key deciding "same binding" — encoded as `JSON.stringify` of
 * five fields (owner, connector, EFFECTIVE source_kind, binding,
 * connector_instance_id) in a fixed order. The first four are the exact
 * identity `resolveOrCreateEnrollmentDevice` uses; `connectorInstanceId` is
 * appended so two rows sharing that 4-tuple but bound to DIFFERENT
 * connector_instance_ids (the rare legacy-duplicate-connector-instance
 * shape — see `groupDuplicateBindingRows`'s doc comment) are never merged
 * into one group merely because their derived identity fields match.
 *
 * This is INJECTIVE (distinct 5-tuples always produce distinct strings):
 * JSON.stringify escapes every quote and backslash in each string field and
 * wraps each in its own `"..."`, so no field's content can ever bleed
 * across the fixed array-index boundaries into an adjacent field — unlike a
 * plain delimiter join (e.g. `.join(" ")`), where a field containing the
 * delimiter character can collide with a different tuple whose fields
 * split differently around the same delimiter (e.g. `ownerSubjectId="a b",
 * connectorId="c"` and `ownerSubjectId="a", connectorId="b c"` join to the
 * identical string `"a b c ..."`). A collision here would silently MERGE
 * two genuinely distinct identity keys into one grouped "duplicate",
 * producing a misleading repair plan — see the collision regression in the
 * test file for a concrete counterexample.
 *
 * This is a grouping-decision safeguard only: `applyRepairPlanEntry`'s
 * actual revalidation-under-lock query re-reads by the exact
 * `connectorInstanceId`, never this string key, so the write path was
 * never exposed to this collision class — only the candidate-plan
 * grouping was.
 */
function duplicateBindingGroupKey(
  row: Pick<
    DuplicateBindingRow,
    "connectorId" | "connectorInstanceId" | "localBindingId" | "ownerSubjectId" | "sourceKind"
  >
): string {
  return JSON.stringify([
    row.ownerSubjectId,
    row.connectorId,
    row.sourceKind,
    row.localBindingId,
    row.connectorInstanceId,
  ]);
}

/**
 * Pure authoritative-row selection for one duplicate group:
 *   1. The row with the most recent `lastHeartbeatAt` (real evidence of
 *      life), if any row in the group has ever heartbeated.
 *   2. Otherwise, the most recently created row (`sourceInstanceCreatedAt`
 *      DESC) — the newest enrollment attempt.
 * Ties are broken deterministically by `deviceId` (lexicographic) so
 * this function is a pure, reproducible decision — never a coin flip.
 * A single-row input trivially returns that row (used by the
 * revalidation path, where a concurrent write may have shrunk the group
 * to one live row by the time it is re-read under lock).
 */
export function selectAuthoritativeRow(rows: readonly DuplicateBindingRow[]): DuplicateBindingRow {
  const withHeartbeat = rows.filter((row) => row.lastHeartbeatAt !== null);
  const pool = withHeartbeat.length > 0 ? withHeartbeat : rows;
  const sortKey = withHeartbeat.length > 0 ? "lastHeartbeatAt" : "sourceInstanceCreatedAt";
  const sorted = [...pool].sort((a, b) => {
    const aTime = Date.parse(a[sortKey] ?? "");
    const bTime = Date.parse(b[sortKey] ?? "");
    if (aTime !== bTime) {
      return bTime - aTime;
    }
    if (a.deviceId === b.deviceId) {
      return 0;
    }
    return a.deviceId < b.deviceId ? -1 : 1;
  });
  const [winner] = sorted;
  if (!winner) {
    throw new Error("selectAuthoritativeRow: empty rows (unreachable — groups always have >= 1 row)");
  }
  return winner;
}

export interface RepairPlanEntry {
  readonly authoritative: DuplicateBindingRow;
  readonly group: DuplicateBindingGroup;
  readonly superseded: readonly DuplicateBindingRow[];
}

/** Pure: turn duplicate groups into a CANDIDATE repair plan (who stays,
 *  who goes) for reporting/dry-run purposes. `applyRepairPlanEntry` does
 *  NOT use this plan's membership for its writes — see its doc comment. */
export function buildRepairPlan(groups: readonly DuplicateBindingGroup[]): RepairPlanEntry[] {
  return groups.map((group) => {
    const authoritative = selectAuthoritativeRow(group.rows);
    const superseded = group.rows.filter((row) => row.deviceId !== authoritative.deviceId);
    return { authoritative, group, superseded };
  });
}

export interface AppliedRepairResult {
  readonly authoritativeDeviceId: string;
  readonly supersededDeviceIds: readonly string[];
}

/**
 * Apply one group's repair inside a single transaction with a lock and
 * full revalidation — never independent statements against a stale
 * candidate plan. See the module doc comment ("Concurrency safety") for
 * the full contract. `pool` must be a real connection pool (not a bare
 * query-only client) because this needs one held connection across
 * `BEGIN`/lock/writes/`COMMIT`.
 *
 * Revalidates by `connectorInstanceId` (not by the derived 4-tuple
 * `entry.group.sourceKind` etc.) — the single strongest, simplest anchor:
 * every row genuinely bound to the SAME connector_instance is, by
 * construction, the same binding (see the module doc comment's
 * "LEGACY-NULL source_kind" section), so re-reading by that one id is both
 * necessary and sufficient, and cannot itself suffer the legacy-duplicate-
 * connector-instance ambiguity `groupDuplicateBindingRows` guards against
 * at the CANDIDATE-plan stage (there is exactly one row set for one id).
 *
 * Also normalizes: any freshly-locked row (survivor or superseded) whose
 * raw `source_kind` is NULL is backfilled to the resolved effective kind
 * in this SAME transaction, so re-scanning after `--apply` sees real
 * (non-NULL) data — the terminal invariant this repair converges toward —
 * rather than needing the COALESCE resolution forever.
 *
 * Returns the freshly-derived authoritative device id and the device ids
 * actually revoked (a subset of, or none of, the candidate `entry`'s
 * `superseded` list — never a superset, and never including a row that
 * turns out to be authoritative or already revoked under lock).
 */
export async function applyRepairPlanEntry(
  pool: PgPoolLike,
  entry: RepairPlanEntry,
  revokedAt: string
): Promise<AppliedRepairResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Re-read AND row-lock current truth for this exact connector_instance
    // — never trust `entry`'s membership or authoritative pick, which were
    // read before this transaction and may be stale.
    const lockedRows = await selectGroupRows(
      client,
      {
        connectorId: entry.group.connectorId,
        connectorInstanceId: entry.group.connectorInstanceId,
        localBindingId: entry.group.localBindingId,
        ownerSubjectId: entry.group.ownerSubjectId,
      },
      true
    );
    if (lockedRows.length === 0) {
      // Every row in this group was already revoked by a concurrent
      // writer (heartbeat cannot revoke, but a concurrent repair run or
      // an owner-initiated revoke could) between scan and apply. Nothing
      // to do — idempotent no-op.
      await client.query("COMMIT");
      return { authoritativeDeviceId: entry.authoritative.deviceId, supersededDeviceIds: [] };
    }
    // Normalize legacy-NULL rows first, in this same transaction: any
    // locked row whose raw source_kind is NULL is backfilled to the
    // resolved effective kind. Runs before the revoke cascade below so
    // the normalization always lands even for a group that turns out to
    // need no revocation (e.g. a race already resolved it to one row).
    //
    // Keyed on `source_instance_id` (device_source_instances' actual
    // PRIMARY KEY), NEVER `device_id` alone: one device can legitimately
    // own multiple device_source_instances rows (different streams or
    // bindings), so a device_id-scoped UPDATE could reach past this
    // group and silently normalize an unrelated NULL-kind row that
    // happens to share the same device_id but belongs to a different
    // connector_instance entirely. `connector_instance_id` is retained
    // as a second, redundant predicate — defense in depth, since the
    // locked rows are already scoped to exactly one connector_instance_id
    // by `selectGroupRows`.
    const legacyNullRowIds = lockedRows.filter((row) => row.sourceKindWasLegacyNull).map((row) => row.sourceInstanceId);
    if (legacyNullRowIds.length > 0) {
      await client.query(
        `UPDATE device_source_instances
            SET source_kind = $1, updated_at = $2
          WHERE source_instance_id = ANY($3::text[])
            AND connector_instance_id = $4
            AND source_kind IS NULL`,
        [entry.group.sourceKind, revokedAt, legacyNullRowIds, entry.group.connectorInstanceId]
      );
    }
    // Re-derive authoritative from the FRESHLY LOCKED rows, not the stale
    // candidate plan — a device that heartbeated between scan and apply
    // (or a newer enrollment that superseded the old candidate already)
    // must be provably safe from revocation here.
    const authoritative = selectAuthoritativeRow(lockedRows);
    const toRevoke = lockedRows.filter((row) => row.deviceId !== authoritative.deviceId);
    for (const row of toRevoke) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential-per-device — the connector_instance revoke's NOT EXISTS guard must observe each prior row's device_source_instances revoke before the next row's.
      await client.query(
        `UPDATE device_exporters SET status = 'revoked', revoked_at = $1, updated_at = $1 WHERE device_id = $2`,
        [revokedAt, row.deviceId]
      );
      await client.query(
        `UPDATE device_ingest_credentials SET status = 'revoked', revoked_at = $1 WHERE device_id = $2 AND status <> 'revoked'`,
        [revokedAt, row.deviceId]
      );
      await client.query(
        `UPDATE device_source_instances
            SET status = 'revoked', revoked_at = $1, updated_at = $1
          WHERE device_id = $2 AND status <> 'revoked'`,
        [revokedAt, row.deviceId]
      );
      await client.query(
        `UPDATE connector_instances ci
            SET status = 'revoked', revoked_at = $1, updated_at = $1
          WHERE ci.status <> 'revoked'
            AND ci.connector_instance_id IN (
              SELECT connector_instance_id
              FROM device_source_instances
              WHERE device_id = $2
                AND connector_instance_id IS NOT NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM device_source_instances active
              WHERE active.connector_instance_id = ci.connector_instance_id
                AND active.status <> 'revoked'
            )`,
        [revokedAt, row.deviceId]
      );
    }
    await client.query("COMMIT");
    return { authoritativeDeviceId: authoritative.deviceId, supersededDeviceIds: toRevoke.map((row) => row.deviceId) };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Rollback failure must not hide the original error.
    }
    throw err;
  } finally {
    client.release();
  }
}

function printPlanSummary(plan: readonly RepairPlanEntry[]): void {
  if (plan.length === 0) {
    console.log("No duplicate-binding groups found.");
    return;
  }
  console.log(`Found ${plan.length} duplicate-binding group(s):`);
  for (const entry of plan) {
    console.log(
      `  ${entry.group.connectorId} / ${entry.group.sourceKind} / "${entry.group.localBindingId}" (owner ${entry.group.ownerSubjectId})`
    );
    console.log(
      `    candidate keep:      ${entry.authoritative.deviceId} (last_heartbeat_at=${entry.authoritative.lastHeartbeatAt ?? "never"})`
    );
    for (const row of entry.superseded) {
      console.log(`    candidate supersede: ${row.deviceId} (last_heartbeat_at=${row.lastHeartbeatAt ?? "never"})`);
    }
  }
  console.log(
    "(Actual --apply revalidates each group under a fresh lock; the final outcome may differ from this candidate list.)"
  );
}

// ─── Argv parsing (no deps) ─────────────────────────────────────────────

type ParsedArgValue = string | boolean;

function parseArgs(argv: string[]): Record<string, ParsedArgValue> {
  const out: Record<string, ParsedArgValue> = {};
  for (const arg of argv) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq > 0) {
        out[arg.slice(2, eq)] = arg.slice(eq + 1);
      } else {
        out[arg.slice(2)] = true;
      }
    }
  }
  return out;
}

// Only execute the CLI when invoked as a script. Importing this module
// (e.g. from tests) does not parse argv or open a Pool.
const invokedAsScript =
  import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1] || "");

if (invokedAsScript) {
  await runCli();
}

async function runCli(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apply = !!args.apply;
  const ownerSubjectIdArg = args["owner-subject-id"];
  const connectorIdArg = args["connector-id"];
  const ownerSubjectId = typeof ownerSubjectIdArg === "string" ? ownerSubjectIdArg : null;
  const connectorId = typeof connectorIdArg === "string" ? connectorIdArg : null;
  const databaseUrl = process.env.PDPP_DATABASE_URL || process.env.PDPP_TEST_POSTGRES_URL || null;

  if (!databaseUrl) {
    console.error("PDPP_DATABASE_URL is required");
    process.exit(2);
  }

  const pool = new Pool({ connectionString: databaseUrl });
  let exitCode = 0;
  try {
    const groups = await scanDuplicateBindings(pool, { connectorId, ownerSubjectId });
    const plan = buildRepairPlan(groups);
    printPlanSummary(plan);
    if (plan.length > 0 && apply) {
      const revokedAt = new Date().toISOString();
      let supersededCount = 0;
      for (const entry of plan) {
        // biome-ignore lint/performance/noAwaitInLoops: sequential across groups — each group's own transaction is independent, but running them one at a time keeps a mid-run failure's blast radius to a clean prefix of fully-committed groups plus one rolled-back group, never a partially-applied group.
        const result = await applyRepairPlanEntry(pool, entry, revokedAt);
        supersededCount += result.supersededDeviceIds.length;
      }
      console.log(
        `Applied: superseded ${supersededCount} device(s) (revalidated under lock; may differ from the candidate list above).`
      );
    } else if (plan.length > 0) {
      console.log("Dry run — pass --apply to execute.");
    }
  } catch (err) {
    console.error(err);
    exitCode = 1;
  } finally {
    await pool.end();
  }
  process.exit(exitCode);
}
