// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Substrate implementations for the `rs.explore.timeline` operation.
 *
 * Wires `executeExploreTimeline` (operations/rs-explore-timeline) to the
 * configured storage backend (SQLite or Postgres), implementing the
 * `ExploreTimelineDependencies` contract.
 *
 * Two concrete implementations:
 *   - `sqliteExploreTimelineDeps` — uses `iterateDynamicSqlAcknowledged`
 *     over the SQLite `records` table.
 *   - `postgresExploreTimelineDeps` — uses `postgresQuery` over the PG
 *     `records` table.
 *
 * A factory `buildExploreTimelineDeps()` dispatches to the correct backend.
 *
 * Boundary rules:
 *   - This module speaks directly to storage; it MUST NOT import operations/
 *     modules or HTTP route modules. It is the "server" side of the
 *     operations dependency-injection seam.
 *   - SQL injected here uses ONLY parameterized placeholders for values.
 *     Column/table names come from the fixed schema.
 */

import { randomUUID } from "node:crypto";
import { execDynamicSqlAcknowledged, iterateDynamicSqlAcknowledged } from "../lib/db.ts";
import type {
  ExploreRecordBucketGranularity,
  ExploreRecordBucketQueryInput,
  ExploreRecordBucketSparseRow,
  ExploreRecordBucketsDependencies,
} from "../operations/rs-explore-record-buckets/index.ts";
import type {
  CountNewSinceSnapshotInput,
  ExploreTimelineDependencies,
  ExploreTimelinePartition,
  PartitionPageInput,
  PartitionPageResult,
  PartitionRow,
  UpcomingFetchInput,
  UpcomingFetchResult,
  UpcomingPartitionPosition,
} from "../operations/rs-explore-timeline/index.ts";
import { isPostgresStorageBackend, postgresQuery } from "./postgres-storage.js";

// Wall-clock helper. Isolated so the cursor TTL has a single time source.
function nowMs(): number {
  return Date.now();
}

// ---------------------------------------------------------------------------
// Server-side cursor store
// ---------------------------------------------------------------------------
//
// The Explore composite cursor blob is O(partition-count) and overflows proxy
// URL limits at scale (HTTP 431 — see
// docs/research/explore-cursor-431-diagnosis-2026-06-20.md). We persist the blob
// server-side keyed by a short opaque handle so only the handle travels in the
// URL. The blob is INERT data we already produced; storing it changes nothing
// about the merge/snapshot contract. Handles are single-snapshot-scoped and
// disposable: a stale/expired/unknown handle resolves to null and the operation
// returns a typed invalid_cursor 400, prompting a page reload.

const CURSOR_HANDLE_PREFIX = "ecr1_";
// Retain cursor blobs for a generous browsing session. A handle older than this
// is treated as expired; the owner simply reloads to anchor a fresh snapshot.
const CURSOR_TTL_SECONDS = 24 * 60 * 60;

function newCursorHandle(): string {
  // randomUUID is available in the reference runtime (used elsewhere for ids).
  return `${CURSOR_HANDLE_PREFIX}${randomUUID().replace(/-/g, "")}`;
}

function sqliteSaveCursorBlob(blob: string): string {
  execDynamicSqlAcknowledged(
    `CREATE TABLE IF NOT EXISTS explore_cursor_store (
       handle TEXT PRIMARY KEY,
       blob TEXT NOT NULL,
       created_at INTEGER NOT NULL
     )`
  );
  const handle = newCursorHandle();
  const now = Math.floor(nowMs() / 1000);
  execDynamicSqlAcknowledged("INSERT INTO explore_cursor_store (handle, blob, created_at) VALUES (?, ?, ?)", [
    handle,
    blob,
    now,
  ]);
  // Opportunistic prune of expired rows so the table stays small.
  execDynamicSqlAcknowledged("DELETE FROM explore_cursor_store WHERE created_at < ?", [now - CURSOR_TTL_SECONDS]);
  return handle;
}

function sqliteLoadCursorBlob(handle: string): string | null {
  const cutoff = Math.floor(nowMs() / 1000) - CURSOR_TTL_SECONDS;
  for (const row of iterateDynamicSqlAcknowledged<{ blob: string }>(
    "SELECT blob FROM explore_cursor_store WHERE handle = ? AND created_at >= ?",
    [handle, cutoff]
  )) {
    return row.blob;
  }
  return null;
}

let postgresCursorTableReady = false;

async function postgresEnsureCursorTable(): Promise<void> {
  if (postgresCursorTableReady) {
    return;
  }
  await postgresQuery(
    `CREATE TABLE IF NOT EXISTS explore_cursor_store (
       handle TEXT PRIMARY KEY,
       blob TEXT NOT NULL,
       created_at BIGINT NOT NULL
     )`,
    []
  );
  postgresCursorTableReady = true;
}

async function postgresSaveCursorBlob(blob: string): Promise<string> {
  await postgresEnsureCursorTable();
  const handle = newCursorHandle();
  const now = Math.floor(nowMs() / 1000);
  await postgresQuery("INSERT INTO explore_cursor_store (handle, blob, created_at) VALUES ($1, $2, $3)", [
    handle,
    blob,
    now,
  ]);
  await postgresQuery("DELETE FROM explore_cursor_store WHERE created_at < $1", [now - CURSOR_TTL_SECONDS]);
  return handle;
}

async function postgresLoadCursorBlob(handle: string): Promise<string | null> {
  await postgresEnsureCursorTable();
  const cutoff = Math.floor(nowMs() / 1000) - CURSOR_TTL_SECONDS;
  const result = await postgresQuery("SELECT blob FROM explore_cursor_store WHERE handle = $1 AND created_at >= $2", [
    handle,
    cutoff,
  ]);
  const row = result.rows[0] as { blob: string } | undefined;
  return row?.blob ?? null;
}

// ---------------------------------------------------------------------------
// SQLite substrate
// ---------------------------------------------------------------------------

/**
 * SQLite implementation. The `records` table has columns:
 *   id (INTEGER PRIMARY KEY AUTOINCREMENT = rowid alias), connector_id,
 *   connector_instance_id, stream, record_key, record_json, emitted_at, deleted
 *
 * We use `connector_instance_id` as the partition key so multiple accounts from
 * the same connector type stay distinct. We return BOTH `connector_instance_id`
 * (as `connectorId`) and `connector_id` (as `connectorType`) so the merge can
 * emit both identities on every record without a join.
 *
 * Snapshot stability: uses MAX(id) (the monotonic ingest sequence) as the snapshot
 * anchor, not MAX(emitted_at). This correctly excludes backfilled records that are
 * ingested after the snapshot but carry an older emitted_at.
 *
 * Keyset cursor: (semantic_time DESC, record_key DESC), where semantic_time is
 * COALESCE(NULLIF(semantic_time, ''), emitted_at) so un-backfilled rows fall
 * back to ingest time. ISO-8601 strings compare lexicographically =
 * chronologically for UTC timestamps. Membership stays on id <= snapshotSeq.
 *
 * Partition enumeration: NO LIMIT applied. Personal servers have at most thousands
 * of (connector_instance_id, stream) pairs; the DISTINCT scan over the indexed
 * columns is cheap. A cap would silently hide records in overflow partitions.
 */
interface ExploreTimelineScope {
  readonly connectionIds?: readonly string[];
  /** Connection ids to EXCLUDE (NOT IN), applied alongside the include scope. */
  readonly excludeConnectionIds?: readonly string[];
  /** Stream names to EXCLUDE (NOT IN), applied alongside the include scope. */
  readonly excludeStreams?: readonly string[];
  readonly streams?: readonly string[];
}

type ExploreTimelineScopeKey = keyof Pick<
  ExploreTimelineScope,
  "connectionIds" | "streams" | "excludeConnectionIds" | "excludeStreams"
>;

const SQLITE_SCOPE_RULES: readonly {
  readonly key: ExploreTimelineScopeKey;
  readonly clause: (placeholderList: string) => string;
}[] = [
  { key: "connectionIds", clause: (placeholders) => `connector_instance_id IN (${placeholders})` },
  { key: "streams", clause: (placeholders) => `stream IN (${placeholders})` },
  { key: "excludeConnectionIds", clause: (placeholders) => `connector_instance_id NOT IN (${placeholders})` },
  { key: "excludeStreams", clause: (placeholders) => `stream NOT IN (${placeholders})` },
];

const POSTGRES_SCOPE_RULES: readonly {
  readonly key: ExploreTimelineScopeKey;
  readonly clause: (parameterIndex: number) => string;
}[] = [
  { key: "connectionIds", clause: (index) => `connector_instance_id = ANY($${index}::text[])` },
  { key: "streams", clause: (index) => `stream = ANY($${index}::text[])` },
  { key: "excludeConnectionIds", clause: (index) => `connector_instance_id <> ALL($${index}::text[])` },
  { key: "excludeStreams", clause: (index) => `stream <> ALL($${index}::text[])` },
];

function appendSqliteScope(
  whereParts: string[],
  binds: (string | number)[],
  scope: ExploreTimelineScope | undefined
): void {
  for (const rule of SQLITE_SCOPE_RULES) {
    const values = scope?.[rule.key];
    if (!values || values.length === 0) {
      continue;
    }
    whereParts.push(rule.clause(values.map(() => "?").join(", ")));
    binds.push(...values);
  }
}

function appendPostgresScope(
  whereParts: string[],
  params: (string | number | readonly string[])[],
  scope: ExploreTimelineScope | undefined
): void {
  for (const rule of POSTGRES_SCOPE_RULES) {
    const values = scope?.[rule.key];
    if (!values || values.length === 0) {
      continue;
    }
    params.push(values);
    whereParts.push(rule.clause(params.length));
  }
}

function parseSqliteRecordJson(recordJson: string): unknown {
  try {
    return JSON.parse(recordJson);
  } catch {
    return null;
  }
}

function parsePostgresRecordJson(recordJson: unknown): unknown {
  if (recordJson !== null && typeof recordJson === "object") {
    return recordJson; // Postgres already parses JSONB
  }
  if (typeof recordJson !== "string") {
    return null;
  }
  return parseSqliteRecordJson(recordJson);
}

function sqliteListPartitions(scope?: ExploreTimelineScope): readonly ExploreTimelinePartition[] {
  // REVIEWED-DYNAMIC: SELECT DISTINCT query with no caller-controlled values.
  // No LIMIT: all partitions must be enumerable so every record is reachable.
  const whereParts = ["deleted = 0"];
  const binds: (string | number)[] = [];
  appendSqliteScope(whereParts, binds, scope);
  const sql = `
    SELECT DISTINCT connector_instance_id AS connectorId, connector_id AS connectorType, stream
    FROM records
    WHERE ${whereParts.join(" AND ")}
  `;
  const results: ExploreTimelinePartition[] = [];
  for (const row of iterateDynamicSqlAcknowledged<{ connectorId: string; connectorType: string; stream: string }>(
    sql,
    binds
  )) {
    results.push({ connectorId: row.connectorId, connectorType: row.connectorType, stream: row.stream });
  }
  return results;
}

function sqliteFetchSnapshotAnchor(): { snapshotSeq: number; snapshotAt: string } | null {
  // REVIEWED-DYNAMIC: aggregate query, no caller-controlled values.
  // MAX(id) gives the monotonic ingest sequence; MAX(emitted_at) gives the display timestamp.
  const sql = "SELECT MAX(id) AS maxSeq, MAX(emitted_at) AS maxAt FROM records WHERE deleted = 0";
  for (const row of iterateDynamicSqlAcknowledged<{ maxSeq: number | null; maxAt: string | null }>(sql)) {
    if (row.maxSeq === null || row.maxSeq === undefined) {
      return null;
    }
    return {
      snapshotSeq: row.maxSeq,
      snapshotAt: row.maxAt ?? "1970-01-01T00:00:00.000Z",
    };
  }
  return null;
}

type PartitionPageDirection = "asc" | "desc";

const PARTITION_PAGE_DIRECTION_SQL: Record<PartitionPageDirection, { readonly order: string; readonly seek: string }> =
  {
    asc: { order: "ASC", seek: ">" },
    desc: { order: "DESC", seek: "<" },
  };

function partitionPageDirection(input: PartitionPageInput): PartitionPageDirection {
  return input.direction === "asc" ? "asc" : "desc";
}

function partitionPageCursorValues(
  afterPosition: PartitionPageInput["afterPosition"]
): readonly [string, string, string] | null {
  if (afterPosition === null || afterPosition.lastSemanticTime === null || afterPosition.lastRecordKey === null) {
    return null;
  }
  return [afterPosition.lastSemanticTime, afterPosition.lastSemanticTime, afterPosition.lastRecordKey];
}

function appendSqlitePartitionPageNowCeiling(
  whereParts: string[],
  binds: (string | number)[],
  semanticExpression: string,
  nowCeiling: PartitionPageInput["nowCeiling"]
): void {
  if (typeof nowCeiling !== "string" || nowCeiling.length === 0) {
    return;
  }
  whereParts.push(`${semanticExpression} <= ?`);
  binds.push(nowCeiling);
}

function appendSqlitePartitionPageCursor(
  whereParts: string[],
  binds: (string | number)[],
  semanticExpression: string,
  direction: PartitionPageDirection,
  afterPosition: PartitionPageInput["afterPosition"]
): void {
  const cursorValues = partitionPageCursorValues(afterPosition);
  if (!cursorValues) {
    return;
  }
  const { seek } = PARTITION_PAGE_DIRECTION_SQL[direction];
  whereParts.push(`(${semanticExpression} ${seek} ? OR (${semanticExpression} = ? AND record_key ${seek} ?))`);
  binds.push(...cursorValues);
}

function sqlitePartitionPageQuery(input: PartitionPageInput): {
  readonly sql: string;
  readonly binds: (string | number)[];
} {
  const { connectorId, stream, snapshotSeq, limit } = input;
  const direction = partitionPageDirection(input);
  const directionSql = PARTITION_PAGE_DIRECTION_SQL[direction];
  const semanticExpression = "COALESCE(NULLIF(semantic_time, ''), emitted_at)";
  const whereParts: string[] = ["connector_instance_id = ?", "stream = ?", "deleted = 0", "id <= ?"];
  const binds: (string | number)[] = [connectorId, stream, snapshotSeq];
  appendSqlitePartitionPageNowCeiling(whereParts, binds, semanticExpression, input.nowCeiling);
  appendSqlitePartitionPageCursor(whereParts, binds, semanticExpression, direction, input.afterPosition);
  binds.push(limit + 1);
  return {
    binds,
    sql: `
      SELECT connector_instance_id AS connectorId, connector_id AS connectorType,
             stream, record_key AS recordKey,
             record_json AS recordJson, emitted_at AS emittedAt,
             ${semanticExpression} AS semanticTime
      FROM records
      WHERE ${whereParts.join(" AND ")}
      ORDER BY ${semanticExpression} ${directionSql.order}, record_key ${directionSql.order}
      LIMIT ?
    `,
  };
}

function sqliteFetchPartitionPage(input: PartitionPageInput): PartitionPageResult {
  // REVIEWED-DYNAMIC: keyset WHERE clause varies by cursor presence and
  // snapshot anchor; all values are bound as parameters.
  const { limit } = input;
  // Scan direction over semantic time. "desc" (default) = newest-first browse;
  // "asc" = the order=oldest re-page (earliest past record first). The keyset
  // seek predicate and the ORDER BY both flip with the direction; the nowCeiling
  // upper-bound clamp is kept either way, so "asc" walks the PAST partition from
  // its floor up to the ceiling and never surfaces the future partition.
  // The merged timeline ORDERS by SEMANTIC time (when the thing happened), not
  // ingest time. A row not yet backfilled has semantic_time '' -> COALESCE to
  // emitted_at, so ordering degrades gracefully to the prior behavior until the
  // semantic backfill runs. SNAPSHOT MEMBERSHIP stays on the monotonic ingest
  // sequence (id <= snapshotSeq) — ordering and membership are different keys.
  const { sql, binds } = sqlitePartitionPageQuery(input);

  const rawRows: Array<{
    connectorId: string;
    connectorType: string;
    stream: string;
    recordKey: string;
    recordJson: string;
    emittedAt: string;
    semanticTime: string;
  }> = [];
  for (const row of iterateDynamicSqlAcknowledged<{
    connectorId: string;
    connectorType: string;
    stream: string;
    recordKey: string;
    recordJson: string;
    emittedAt: string;
    semanticTime: string;
  }>(sql, binds)) {
    rawRows.push(row);
    if (rawRows.length >= limit + 1) {
      break;
    }
  }

  const hasMore = rawRows.length > limit;
  const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;

  const rows: PartitionRow[] = pageRows.map((r) => ({
    connectorId: r.connectorId,
    connectorType: r.connectorType,
    stream: r.stream,
    recordKey: r.recordKey,
    emittedAt: r.emittedAt,
    semanticTime: r.semanticTime,
    data: parseSqliteRecordJson(r.recordJson),
  }));

  return { rows, hasMore };
}

function sqliteCountNewSinceSnapshot(input: CountNewSinceSnapshotInput): number {
  // REVIEWED-DYNAMIC: aggregate query, value is parameterized.
  // Uses id > snapshotSeq (ingest sequence) not emitted_at, so backfilled records
  // with old emitted_at are correctly counted as "new since snapshot".
  const whereParts = ["deleted = 0", "id > ?"];
  const binds: (string | number)[] = [input.snapshotSeq];
  appendSqliteScope(whereParts, binds, input);
  const sql = `SELECT COUNT(*) AS cnt FROM records WHERE ${whereParts.join(" AND ")}`;
  for (const row of iterateDynamicSqlAcknowledged<{ cnt: number }>(sql, binds)) {
    return row.cnt ?? 0;
  }
  return 0;
}

// The separate FUTURE projection: records whose semantic time is strictly AFTER
// nowCeiling, FORWARD-chronological (soonest first), capped at `limit`, plus a TRUE
// COUNT of all such records. Snapshot-bound (id <= snapshotSeq). Probed PER-PARTITION
// (connector_instance_id + stream) so the partition-prefixed idx_records_semantic_time
// index serves it — a single GLOBAL `semantic_time > now` query Seq-Scans the table
// (cost ~472K on the live 2.8M corpus). Per-partition heads are merged soonest-first
// and capped; per-partition counts are summed. Surfaces future-dated rows (e.g. YNAB
// future budget months) in a dedicated "Upcoming" section instead of above today.
function sqliteFetchUpcoming(input: UpcomingFetchInput): UpcomingFetchResult {
  // REVIEWED-DYNAMIC: all caller values are parameterized binds.
  const semExpr = "COALESCE(NULLIF(semantic_time, ''), emitted_at)";
  const computeTotal = input.computeTotal !== false;
  const afterByKey = upcomingAfterPositionMap(input.afterPositions);
  let total = 0;
  // Per-partition tagged fetches: each fetched row remembers its partition index so
  // the merge can compute correct per-partition resume positions after the global cap.
  const tagged: TaggedUpcomingRow[] = [];
  // Whether THIS partition returned more than `limit` of its own rows (the +1
  // sentinel) — i.e. it has more even before the global cap is considered.
  const partitionOverflow: boolean[] = [];

  input.partitions.forEach((partition, partitionIndex) => {
    const after = afterByKey.get(upcomingPartitionKey(partition.connectorId, partition.stream)) ?? null;
    const fetched = sqliteFetchUpcomingPartition(input, semExpr, computeTotal, partition, partitionIndex, after);
    total += fetched.total;
    tagged.push(...fetched.tagged);
    partitionOverflow[partitionIndex] = fetched.overflow;
  });

  return finalizeUpcoming({
    input,
    tagged,
    partitionOverflow,
    total: computeTotal ? total : 0,
  });
}

/** A fetched upcoming row tagged with the partition index it came from. */
interface TaggedUpcomingRow {
  readonly partitionIndex: number;
  readonly row: PartitionRow;
}

interface SqliteUpcomingQuery {
  readonly binds: (string | number)[];
  readonly where: string;
}

interface UpcomingPartitionFetch {
  readonly overflow: boolean;
  readonly tagged: readonly TaggedUpcomingRow[];
  readonly total: number;
}

function sqliteUpcomingQuery(
  input: UpcomingFetchInput,
  semanticExpression: string,
  partition: ExploreTimelinePartition,
  after: UpcomingPartitionPosition | null
): SqliteUpcomingQuery {
  const binds: (string | number)[] = [partition.connectorId, partition.stream, input.snapshotSeq, input.nowCeiling];
  let where = `connector_instance_id = ? AND stream = ? AND deleted = 0 AND id <= ? AND ${semanticExpression} > ?`;
  if (after && after.lastSemanticTime !== null && after.lastRecordKey !== null) {
    where += ` AND (${semanticExpression} > ? OR (${semanticExpression} = ? AND record_key > ?))`;
    binds.push(after.lastSemanticTime, after.lastSemanticTime, after.lastRecordKey);
  }
  return { where, binds };
}

function sqliteCountUpcomingRows(query: SqliteUpcomingQuery): number {
  for (const row of iterateDynamicSqlAcknowledged<{ n: number }>(
    `SELECT COUNT(*) AS n FROM records WHERE ${query.where}`,
    query.binds
  )) {
    return Number(row.n) || 0;
  }
  return 0;
}

function sqliteFetchUpcomingTaggedRows(
  input: UpcomingFetchInput,
  semanticExpression: string,
  partitionIndex: number,
  query: SqliteUpcomingQuery
): { readonly tagged: readonly TaggedUpcomingRow[]; readonly overflow: boolean } {
  const sql = `
    SELECT connector_instance_id AS connectorId, connector_id AS connectorType,
           stream, record_key AS recordKey,
           record_json AS recordJson, emitted_at AS emittedAt,
           ${semanticExpression} AS semanticTime
    FROM records
    WHERE ${query.where}
    ORDER BY ${semanticExpression} ASC, record_key ASC
    LIMIT ?
  `;
  const tagged: TaggedUpcomingRow[] = [];
  for (const row of iterateDynamicSqlAcknowledged<{
    connectorId: string;
    connectorType: string;
    stream: string;
    recordKey: string;
    recordJson: string;
    emittedAt: string;
    semanticTime: string;
  }>(sql, [...query.binds, input.limit + 1])) {
    if (tagged.length >= input.limit) {
      return { tagged, overflow: true };
    }
    tagged.push({
      partitionIndex,
      row: {
        connectorId: row.connectorId,
        connectorType: row.connectorType,
        stream: row.stream,
        recordKey: row.recordKey,
        emittedAt: row.emittedAt,
        semanticTime: row.semanticTime,
        data: parseSqliteRecordJson(row.recordJson),
      },
    });
  }
  return { tagged, overflow: false };
}

function sqliteFetchUpcomingPartition(
  input: UpcomingFetchInput,
  semanticExpression: string,
  computeTotal: boolean,
  partition: ExploreTimelinePartition,
  partitionIndex: number,
  after: UpcomingPartitionPosition | null
): UpcomingPartitionFetch {
  const query = sqliteUpcomingQuery(input, semanticExpression, partition, after);
  const total = computeTotal ? sqliteCountUpcomingRows(query) : 0;
  const { tagged, overflow } = sqliteFetchUpcomingTaggedRows(input, semanticExpression, partitionIndex, query);
  return { total, tagged, overflow };
}

/** Stable key for matching afterPositions to partitions: connector_instance_id + stream. */
function upcomingPartitionKey(connectorInstanceId: string, stream: string): string {
  return `${connectorInstanceId} ${stream}`;
}

function upcomingAfterPositionMap(
  afterPositions: UpcomingFetchInput["afterPositions"]
): Map<string, UpcomingPartitionPosition> {
  const map = new Map<string, UpcomingPartitionPosition>();
  if (!afterPositions) {
    return map;
  }
  for (const pos of afterPositions) {
    map.set(upcomingPartitionKey(pos.connectorId, pos.stream), pos);
  }
  return map;
}

/**
 * Merge the per-partition tagged rows soonest-first, cap to `limit`, and compute
 * the correct per-partition resume positions for the next upcoming cursor.
 *
 * A partition has MORE after this page when EITHER (a) it overflowed its own
 * limit+1 fetch, OR (b) some of its fetched rows fell AFTER the global cap (were
 * not emitted into the page). The resume position for a partition is the last of
 * ITS rows that WAS emitted into the page; a partition that contributed nothing to
 * the page keeps its incoming position (carried unchanged) so the next page
 * re-probes it from where it left off.
 */
/** Explicit context for {@link nextUpcomingPositionForPartition}, formerly closure captures. */
interface NextUpcomingPositionLookups {
  readonly afterByKey: Map<string, UpcomingPartitionPosition>;
  readonly cutByPartition: ReadonlySet<number>;
  readonly lastEmittedByPartition: Map<number, PartitionRow>;
  readonly partitionOverflow: readonly boolean[];
}

function partitionHasMoreUpcomingRows(partitionIndex: number, lookups: NextUpcomingPositionLookups): boolean {
  return (lookups.partitionOverflow[partitionIndex] ?? false) || lookups.cutByPartition.has(partitionIndex);
}

/**
 * Per-partition cursor policy: whether this partition appears in the next-page
 * cursor and at WHICH resume position. Returns null when the partition is
 * exhausted (omitted from the next cursor). Otherwise returns its resume
 * position — either the last row of ITS that was emitted into this page, or,
 * if it contributed nothing but still has rows (all after the cut), its
 * incoming position carried unchanged so the next page re-probes from there.
 */
function nextUpcomingPositionForPartition(
  partition: ExploreTimelinePartition,
  partitionIndex: number,
  lookups: NextUpcomingPositionLookups
): UpcomingPartitionPosition | null {
  const lastEmitted = lookups.lastEmittedByPartition.get(partitionIndex);
  if (!partitionHasMoreUpcomingRows(partitionIndex, lookups)) {
    return null; // exhausted: omit from the next cursor
  }
  if (lastEmitted) {
    return {
      connectorId: lastEmitted.connectorId,
      connectorType: lastEmitted.connectorType,
      stream: lastEmitted.stream,
      lastSemanticTime: lastEmitted.semanticTime,
      lastRecordKey: lastEmitted.recordKey,
    };
  }
  // Contributed nothing to this page but still has rows (all after the cut):
  // carry its incoming position unchanged so the next page re-probes from there.
  const incoming = lookups.afterByKey.get(upcomingPartitionKey(partition.connectorId, partition.stream));
  return {
    connectorId: partition.connectorId,
    connectorType: partition.connectorType,
    stream: partition.stream,
    lastSemanticTime: incoming?.lastSemanticTime ?? null,
    lastRecordKey: incoming?.lastRecordKey ?? null,
  };
}

function finalizeUpcoming(args: {
  input: UpcomingFetchInput;
  tagged: TaggedUpcomingRow[];
  partitionOverflow: readonly boolean[];
  total: number;
}): UpcomingFetchResult {
  const { input, tagged, partitionOverflow, total } = args;
  const sorted = [...tagged].sort((a, b) => compareUpcomingAsc(a.row, b.row));
  const page = sorted.slice(0, input.limit);
  const overflowTail = sorted.slice(input.limit);

  const afterByKey = upcomingAfterPositionMap(input.afterPositions);
  // Last emitted row per partition index (its resume position).
  const lastEmittedByPartition = new Map<number, PartitionRow>();
  for (const t of page) {
    lastEmittedByPartition.set(t.partitionIndex, t.row);
  }
  // Partitions that had at least one row fall after the global cap.
  const cutByPartition = new Set<number>();
  for (const t of overflowTail) {
    cutByPartition.add(t.partitionIndex);
  }

  const lookups: NextUpcomingPositionLookups = {
    lastEmittedByPartition,
    partitionOverflow,
    cutByPartition,
    afterByKey,
  };
  const nextPositions: UpcomingPartitionPosition[] = [];
  input.partitions.forEach((partition, partitionIndex) => {
    const pos = nextUpcomingPositionForPartition(partition, partitionIndex, lookups);
    if (pos) {
      nextPositions.push(pos);
    }
  });

  return {
    rows: page.map((t) => t.row),
    total,
    hasMore: nextPositions.length > 0,
    nextPositions,
  };
}

/** Soonest-first comparator: (semanticTime ASC, recordKey ASC). */
function compareUpcomingAsc(a: PartitionRow, b: PartitionRow): number {
  const byTime = a.semanticTime.localeCompare(b.semanticTime);
  return byTime === 0 ? a.recordKey.localeCompare(b.recordKey) : byTime;
}

export function buildSqliteExploreTimelineDeps(): ExploreTimelineDependencies {
  return {
    listPartitions(scope) {
      return Promise.resolve(sqliteListPartitions(scope));
    },
    fetchSnapshotAnchor() {
      return Promise.resolve(sqliteFetchSnapshotAnchor());
    },
    fetchPartitionPage(input) {
      return Promise.resolve(sqliteFetchPartitionPage(input));
    },
    countNewSinceSnapshot(input) {
      return Promise.resolve(sqliteCountNewSinceSnapshot(input));
    },
    fetchUpcoming(input) {
      return Promise.resolve(sqliteFetchUpcoming(input));
    },
    saveCursorBlob(blob) {
      // Synchronous SQLite write wrapped to satisfy the Promise-typed dep.
      return Promise.resolve(sqliteSaveCursorBlob(blob));
    },
    loadCursorBlob(handle) {
      return Promise.resolve(sqliteLoadCursorBlob(handle));
    },
  };
}

// ---------------------------------------------------------------------------
// Postgres substrate
// ---------------------------------------------------------------------------

/**
 * Postgres implementation. The `records` table has columns:
 *   id BIGSERIAL PRIMARY KEY, connector_id, connector_instance_id, stream,
 *   record_key, record_json, emitted_at, deleted
 * (PG uses BOOLEAN not INTEGER for deleted.)
 *
 * Snapshot stability: uses MAX(id) (BIGSERIAL ingest sequence) as the snapshot
 * anchor, not MAX(emitted_at). Backfilled records with old emitted_at ingested
 * after the snapshot are excluded by id > snapshotSeq.
 *
 * Partition enumeration: NO LIMIT. All partitions must be enumerable.
 *
 * Keyset: (semantic_time DESC, record_key DESC), where semantic_time is
 * COALESCE(NULLIF(semantic_time, ''), emitted_at) so un-backfilled rows fall
 * back to ingest time. Same ISO-8601 ordering guarantee holds for text columns
 * in Postgres when values are properly formatted. Membership stays anchored on
 * the ingest sequence (id <= snapshotSeq).
 */
async function postgresListPartitions(scope?: ExploreTimelineScope): Promise<readonly ExploreTimelinePartition[]> {
  // No LIMIT: all (connector_instance_id, stream) pairs must be returned so
  // every record is reachable. The DISTINCT scan over the indexed columns is cheap.
  const whereParts = ["deleted = FALSE"];
  const params: (string | number | readonly string[])[] = [];
  appendPostgresScope(whereParts, params, scope);
  const result = await postgresQuery(
    `SELECT DISTINCT connector_instance_id AS "connectorId", connector_id AS "connectorType", stream
     FROM records
     WHERE ${whereParts.join(" AND ")}`,
    params
  );
  return result.rows.map((r: { connectorId: string; connectorType: string; stream: string }) => ({
    connectorId: r.connectorId,
    connectorType: r.connectorType,
    stream: r.stream,
  }));
}

async function postgresFetchSnapshotAnchor(): Promise<{ snapshotSeq: number; snapshotAt: string } | null> {
  // MAX(id) gives the monotonic ingest sequence for snapshot stability.
  // MAX(emitted_at) gives the display timestamp.
  const result = await postgresQuery(
    `SELECT MAX(id) AS "maxSeq", MAX(emitted_at) AS "maxAt" FROM records WHERE deleted = FALSE`,
    []
  );
  const [row] = result.rows;
  if (!row || row.maxSeq === null || row.maxSeq === undefined) {
    return null;
  }
  return {
    snapshotSeq: Number(row.maxSeq),
    snapshotAt: (row.maxAt as string | null | undefined) ?? "1970-01-01T00:00:00.000Z",
  };
}

function postgresPartitionPageNowCeilingClause(
  params: (string | number)[],
  semanticExpression: string,
  nowCeiling: PartitionPageInput["nowCeiling"]
): string {
  if (typeof nowCeiling !== "string" || nowCeiling.length === 0) {
    return "";
  }
  params.push(nowCeiling);
  return `AND ${semanticExpression} <= $${params.length}`;
}

function postgresPartitionPageCursorClause(
  params: (string | number)[],
  semanticExpression: string,
  direction: PartitionPageDirection,
  afterPosition: PartitionPageInput["afterPosition"]
): string {
  const cursorValues = partitionPageCursorValues(afterPosition);
  if (!cursorValues) {
    return "";
  }
  params.push(...cursorValues);
  const { seek } = PARTITION_PAGE_DIRECTION_SQL[direction];
  return `AND (${semanticExpression} ${seek} $${params.length - 2} OR (${semanticExpression} = $${params.length - 1} AND record_key ${seek} $${params.length}))`;
}

async function postgresFetchPartitionPage(input: PartitionPageInput): Promise<PartitionPageResult> {
  const { connectorId, stream, snapshotSeq, afterPosition, limit, nowCeiling } = input;
  // Scan direction over semantic time. "desc" (default) = newest-first; "asc" =
  // the order=oldest re-page. The keyset seek predicate and ORDER BY flip with
  // it; the nowCeiling clamp is kept either way (asc walks the PAST partition
  // floor→ceiling, never the future partition).
  const direction = partitionPageDirection(input);

  // The merged timeline ORDERS by SEMANTIC time (when the thing happened), not
  // ingest time. A row not yet backfilled has semantic_time '' -> COALESCE to
  // emitted_at, so ordering degrades gracefully to the prior behavior until the
  // semantic backfill runs. SNAPSHOT MEMBERSHIP stays on the monotonic ingest
  // sequence (id <= snapshotSeq) — ordering and membership are different keys.
  const semExpr = "COALESCE(NULLIF(semantic_time, ''), emitted_at)";

  // Snapshot stability via ingest sequence: id <= snapshotSeq excludes rows
  // ingested after the snapshot, including backfilled rows with old emitted_at.
  const params: (string | number)[] = [connectorId, stream, snapshotSeq];

  // Clamp the MAIN feed to <= now: future-dated records are surfaced separately
  // (fetchUpcoming) so they never dominate the newest-first feed above today.
  const nowClause = postgresPartitionPageNowCeilingClause(params, semExpr, nowCeiling);
  const cursorClause = postgresPartitionPageCursorClause(params, semExpr, direction, afterPosition);

  params.push(limit + 1);

  const orderDir = PARTITION_PAGE_DIRECTION_SQL[direction].order;
  const result = await postgresQuery(
    `SELECT connector_instance_id AS "connectorId", connector_id AS "connectorType",
            stream, record_key AS "recordKey", record_json AS "recordJson",
            emitted_at AS "emittedAt", ${semExpr} AS "semanticTime"
     FROM records
     WHERE connector_instance_id = $1
       AND stream = $2
       AND deleted = FALSE
       AND id <= $3
       ${nowClause}
       ${cursorClause}
     ORDER BY ${semExpr} ${orderDir}, record_key ${orderDir}
     LIMIT $${params.length}`,
    params
  );

  const rawRows = result.rows as Array<{
    connectorId: string;
    connectorType: string;
    stream: string;
    recordKey: string;
    recordJson: unknown;
    emittedAt: string;
    semanticTime: string;
  }>;
  const hasMore = rawRows.length > limit;
  const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;

  const rows: PartitionRow[] = pageRows.map((r) => ({
    connectorId: r.connectorId,
    connectorType: r.connectorType,
    stream: r.stream,
    recordKey: r.recordKey,
    emittedAt: r.emittedAt,
    semanticTime: r.semanticTime,
    data: parsePostgresRecordJson(r.recordJson),
  }));

  return { rows, hasMore };
}

async function postgresCountNewSinceSnapshot(input: CountNewSinceSnapshotInput): Promise<number> {
  // Uses id > snapshotSeq (ingest sequence) not emitted_at, so backfilled records
  // with old emitted_at are correctly counted as "new since snapshot".
  const whereParts = ["deleted = FALSE", "id > $1"];
  const params: (string | number | readonly string[])[] = [input.snapshotSeq];
  appendPostgresScope(whereParts, params, input);
  const result = await postgresQuery(
    `SELECT COUNT(*)::bigint AS cnt FROM records WHERE ${whereParts.join(" AND ")}`,
    params
  );
  return Number(result.rows[0]?.cnt ?? 0);
}

// The separate FUTURE projection (Postgres): records with semantic time > nowCeiling,
// soonest-first, capped, plus a TRUE COUNT. Snapshot-bound. Probed PER-PARTITION so
// the partition-prefixed idx_pg_records_semantic_time index serves it (a global query
// Seq-Scans, cost ~472K live). Per-partition heads merged soonest-first; counts summed.
async function postgresFetchUpcoming(input: UpcomingFetchInput): Promise<UpcomingFetchResult> {
  const semExpr = "COALESCE(NULLIF(semantic_time, ''), emitted_at)";
  const computeTotal = input.computeTotal !== false;
  const afterByKey = upcomingAfterPositionMap(input.afterPositions);
  let total = 0;
  const tagged: TaggedUpcomingRow[] = [];
  const partitionOverflow: boolean[] = [];

  for (const [partitionIndex, partition] of input.partitions.entries()) {
    const after = afterByKey.get(upcomingPartitionKey(partition.connectorId, partition.stream)) ?? null;
    const fetched = await postgresFetchUpcomingPartition(
      input,
      semExpr,
      computeTotal,
      partition,
      partitionIndex,
      after
    );
    total += fetched.total;
    tagged.push(...fetched.tagged);
    partitionOverflow[partitionIndex] = fetched.overflow;
  }

  return finalizeUpcoming({
    input,
    tagged,
    partitionOverflow,
    total: computeTotal ? total : 0,
  });
}

interface PostgresUpcomingQuery {
  readonly params: (string | number)[];
  readonly where: string;
}

function postgresUpcomingQuery(
  input: UpcomingFetchInput,
  semanticExpression: string,
  partition: ExploreTimelinePartition,
  after: UpcomingPartitionPosition | null
): PostgresUpcomingQuery {
  let where = `connector_instance_id = $1 AND stream = $2 AND deleted = FALSE AND id <= $3 AND ${semanticExpression} > $4`;
  const params: (string | number)[] = [partition.connectorId, partition.stream, input.snapshotSeq, input.nowCeiling];
  if (after && after.lastSemanticTime !== null && after.lastRecordKey !== null) {
    where += ` AND (${semanticExpression} > $5 OR (${semanticExpression} = $5 AND record_key > $6))`;
    params.push(after.lastSemanticTime, after.lastRecordKey);
  }
  return { where, params };
}

async function postgresCountUpcomingRows(query: PostgresUpcomingQuery): Promise<number> {
  const result = await postgresQuery(`SELECT COUNT(*)::bigint AS n FROM records WHERE ${query.where}`, query.params);
  return Number(result.rows[0]?.n ?? 0);
}

async function postgresFetchUpcomingTaggedRows(
  input: UpcomingFetchInput,
  semanticExpression: string,
  partitionIndex: number,
  query: PostgresUpcomingQuery
): Promise<{ readonly tagged: readonly TaggedUpcomingRow[]; readonly overflow: boolean }> {
  const limitPlaceholder = `$${query.params.length + 1}`;
  const result = await postgresQuery(
    `SELECT connector_instance_id AS "connectorId", connector_id AS "connectorType",
            stream, record_key AS "recordKey", record_json AS "recordJson",
            emitted_at AS "emittedAt", ${semanticExpression} AS "semanticTime"
     FROM records
     WHERE ${query.where}
     ORDER BY ${semanticExpression} ASC, record_key ASC
     LIMIT ${limitPlaceholder}`,
    [...query.params, input.limit + 1]
  );
  const tagged: TaggedUpcomingRow[] = [];
  for (const row of result.rows as Array<{
    connectorId: string;
    connectorType: string;
    stream: string;
    recordKey: string;
    recordJson: unknown;
    emittedAt: string;
    semanticTime: string;
  }>) {
    if (tagged.length >= input.limit) {
      return { tagged, overflow: true };
    }
    tagged.push({
      partitionIndex,
      row: {
        connectorId: row.connectorId,
        connectorType: row.connectorType,
        stream: row.stream,
        recordKey: row.recordKey,
        emittedAt: row.emittedAt,
        semanticTime: row.semanticTime,
        data: parsePostgresRecordJson(row.recordJson),
      },
    });
  }
  return { tagged, overflow: false };
}

async function postgresFetchUpcomingPartition(
  input: UpcomingFetchInput,
  semanticExpression: string,
  computeTotal: boolean,
  partition: ExploreTimelinePartition,
  partitionIndex: number,
  after: UpcomingPartitionPosition | null
): Promise<UpcomingPartitionFetch> {
  const query = postgresUpcomingQuery(input, semanticExpression, partition, after);
  const total = computeTotal ? await postgresCountUpcomingRows(query) : 0;
  const { tagged, overflow } = await postgresFetchUpcomingTaggedRows(input, semanticExpression, partitionIndex, query);
  return { total, tagged, overflow };
}

export function buildPostgresExploreTimelineDeps(): ExploreTimelineDependencies {
  return {
    listPartitions: postgresListPartitions,
    fetchSnapshotAnchor: postgresFetchSnapshotAnchor,
    fetchPartitionPage: postgresFetchPartitionPage,
    countNewSinceSnapshot: postgresCountNewSinceSnapshot,
    fetchUpcoming: postgresFetchUpcoming,
    saveCursorBlob: postgresSaveCursorBlob,
    loadCursorBlob: postgresLoadCursorBlob,
  };
}

// ---------------------------------------------------------------------------
// Explore bucket aggregate substrate
// ---------------------------------------------------------------------------

const EXPLORE_SEMANTIC_TIME_SQL = "COALESCE(NULLIF(semantic_time, ''), emitted_at)";

function parseBucketRow(row: {
  bucketStart: string | null;
  count: number | string | null;
  extentStart: string | null;
  extentEnd: string | null;
  extentCount: number | string | null;
  granularity: string;
}): ExploreRecordBucketSparseRow {
  return {
    bucketStart: row.bucketStart,
    count: Number(row.count ?? 0),
    extentStart: row.extentStart,
    extentEnd: row.extentEnd,
    extentCount: Number(row.extentCount ?? 0),
    granularity: row.granularity as ExploreRecordBucketGranularity,
  };
}

function sqliteBucketStartExpression(granularityExpr: string, semanticExpr: string): string {
  return `CASE ${granularityExpr}
    WHEN 'hour' THEN strftime('%Y-%m-%dT%H:00:00.000Z', ${semanticExpr})
    WHEN 'day' THEN strftime('%Y-%m-%dT00:00:00.000Z', ${semanticExpr})
    WHEN 'week' THEN strftime('%Y-%m-%dT00:00:00.000Z', date(${semanticExpr}, '-' || ((CAST(strftime('%w', ${semanticExpr}) AS INTEGER) + 6) % 7) || ' days'))
    WHEN 'month' THEN strftime('%Y-%m-01T00:00:00.000Z', ${semanticExpr})
    WHEN 'quarter' THEN printf('%04d-%02d-01T00:00:00.000Z',
      CAST(strftime('%Y', ${semanticExpr}) AS INTEGER),
      CAST(((CAST(strftime('%m', ${semanticExpr}) AS INTEGER) - 1) / 3) AS INTEGER) * 3 + 1
    )
    ELSE strftime('%Y-01-01T00:00:00.000Z', ${semanticExpr})
  END`;
}

function sqliteGranularityExpression(input: ExploreRecordBucketQueryInput): string {
  if (input.granularity !== "auto") {
    return `'${input.granularity}'`;
  }
  const monthSpan = `((CAST(strftime('%Y', extent_end) AS INTEGER) - CAST(strftime('%Y', extent_start) AS INTEGER)) * 12 + (CAST(strftime('%m', extent_end) AS INTEGER) - CAST(strftime('%m', extent_start) AS INTEGER)) + 1)`;
  return `CASE
    WHEN total = 0 THEN 'day'
    WHEN ((julianday(extent_end) - julianday(extent_start)) * 24) + 1 <= 60 THEN 'hour'
    WHEN (julianday(extent_end) - julianday(extent_start)) + 1 <= 60 THEN 'day'
    WHEN ((julianday(extent_end) - julianday(extent_start)) / 7) + 1 <= 60 THEN 'week'
    WHEN ${monthSpan} <= 60 THEN 'month'
    WHEN (${monthSpan} / 3) + 1 <= 60 THEN 'quarter'
    ELSE 'year'
  END`;
}

function sqliteFetchExploreBucketRows(input: ExploreRecordBucketQueryInput): readonly ExploreRecordBucketSparseRow[] {
  const semExpr = EXPLORE_SEMANTIC_TIME_SQL;
  const whereParts = ["deleted = 0", `${semExpr} IS NOT NULL`, `${semExpr} <= ?`];
  const binds: (string | number)[] = [input.until];
  if (input.since) {
    whereParts.push(`${semExpr} >= ?`);
    binds.push(input.since);
  }
  appendSqliteScope(whereParts, binds, input);

  const bucketExpr = sqliteBucketStartExpression("resolved.granularity", "scoped.semantic_time");
  const sql = `
    WITH scoped AS (
      SELECT ${semExpr} AS semantic_time
      FROM records
      WHERE ${whereParts.join(" AND ")}
    ),
    extent AS (
      SELECT MIN(semantic_time) AS extent_start, MAX(semantic_time) AS extent_end, COUNT(*) AS total
      FROM scoped
    ),
    resolved AS (
      SELECT extent_start, extent_end, total, ${sqliteGranularityExpression(input)} AS granularity
      FROM extent
    ),
    bucketed AS (
      SELECT ${bucketExpr} AS bucket_start, COUNT(*) AS count
      FROM scoped CROSS JOIN resolved
      GROUP BY bucket_start
    )
    SELECT
      bucketed.bucket_start AS bucketStart,
      COALESCE(bucketed.count, 0) AS count,
      resolved.extent_start AS extentStart,
      resolved.extent_end AS extentEnd,
      resolved.total AS extentCount,
      resolved.granularity AS granularity
    FROM resolved
    LEFT JOIN bucketed ON 1=1
    ORDER BY bucketed.bucket_start ASC
  `;

  // REVIEWED-DYNAMIC: fixed SQL fragments only; caller values are bound above.
  return Array.from(
    iterateDynamicSqlAcknowledged<{
      bucketStart: string | null;
      count: number | null;
      extentStart: string | null;
      extentEnd: string | null;
      extentCount: number | null;
      granularity: string;
    }>(sql, binds),
    parseBucketRow
  );
}

function postgresBucketStartExpression(granularityExpr: string, semanticExpr: string): string {
  return `CASE ${granularityExpr}
    WHEN 'hour' THEN date_trunc('hour', ${semanticExpr} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    WHEN 'day' THEN date_trunc('day', ${semanticExpr} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    WHEN 'week' THEN date_trunc('week', ${semanticExpr} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    WHEN 'month' THEN date_trunc('month', ${semanticExpr} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    WHEN 'quarter' THEN date_trunc('quarter', ${semanticExpr} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
    ELSE date_trunc('year', ${semanticExpr} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  END`;
}

function postgresGranularityExpression(
  input: ExploreRecordBucketQueryInput,
  params: (string | number | readonly string[])[]
): string {
  if (input.granularity !== "auto") {
    params.push(input.granularity);
    return `$${params.length}::text`;
  }
  const monthSpan = `((date_part('year', extent_end_ts) - date_part('year', extent_start_ts)) * 12 + (date_part('month', extent_end_ts) - date_part('month', extent_start_ts)) + 1)`;
  return `CASE
    WHEN total = 0 THEN 'day'
    WHEN (extract(epoch FROM (extent_end_ts - extent_start_ts)) / 3600) + 1 <= 60 THEN 'hour'
    WHEN (extract(epoch FROM (extent_end_ts - extent_start_ts)) / 86400) + 1 <= 60 THEN 'day'
    WHEN (extract(epoch FROM (extent_end_ts - extent_start_ts)) / 604800) + 1 <= 60 THEN 'week'
    WHEN ${monthSpan} <= 60 THEN 'month'
    WHEN (${monthSpan} / 3) + 1 <= 60 THEN 'quarter'
    ELSE 'year'
  END`;
}

async function postgresFetchExploreBucketRows(
  input: ExploreRecordBucketQueryInput
): Promise<readonly ExploreRecordBucketSparseRow[]> {
  const semText = EXPLORE_SEMANTIC_TIME_SQL;
  const semTs = `(${semText})::timestamptz`;
  const whereParts = ["deleted = FALSE", `${semText} IS NOT NULL`];
  const params: (string | number | readonly string[])[] = [];
  params.push(input.until);
  whereParts.push(`${semText} <= $${params.length}`);
  if (input.since) {
    params.push(input.since);
    whereParts.push(`${semText} >= $${params.length}`);
  }
  appendPostgresScope(whereParts, params, input);
  const granularityExpr = postgresGranularityExpression(input, params);
  const bucketExpr = postgresBucketStartExpression("resolved.granularity", "scoped.semantic_ts");
  const sql = `
    WITH scoped AS (
      SELECT ${semText} AS semantic_time, ${semTs} AS semantic_ts
      FROM records
      WHERE ${whereParts.join(" AND ")}
    ),
    extent AS (
      SELECT
        MIN(semantic_time) AS extent_start,
        MAX(semantic_time) AS extent_end,
        MIN(semantic_ts) AS extent_start_ts,
        MAX(semantic_ts) AS extent_end_ts,
        COUNT(*)::bigint AS total
      FROM scoped
    ),
    resolved AS (
      SELECT extent_start, extent_end, total, ${granularityExpr} AS granularity
      FROM extent
    ),
    bucketed AS (
      SELECT ${bucketExpr} AS bucket_start, COUNT(*)::bigint AS count
      FROM scoped CROSS JOIN resolved
      GROUP BY bucket_start
    )
    SELECT
      to_char(bucketed.bucket_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "bucketStart",
      COALESCE(bucketed.count, 0)::bigint AS "count",
      resolved.extent_start AS "extentStart",
      resolved.extent_end AS "extentEnd",
      resolved.total AS "extentCount",
      resolved.granularity AS "granularity"
    FROM resolved
    LEFT JOIN bucketed ON TRUE
    ORDER BY bucketed.bucket_start ASC
  `;
  const result = await postgresQuery(sql, params);
  return result.rows.map((row: unknown) =>
    parseBucketRow(
      row as {
        bucketStart: string | null;
        count: string | number | null;
        extentStart: string | null;
        extentEnd: string | null;
        extentCount: string | number | null;
        granularity: string;
      }
    )
  );
}

export function buildSqliteExploreRecordBucketsDeps(): ExploreRecordBucketsDependencies {
  return {
    fetchBucketRows: sqliteFetchExploreBucketRows,
  };
}

export function buildPostgresExploreRecordBucketsDeps(): ExploreRecordBucketsDependencies {
  return {
    fetchBucketRows: postgresFetchExploreBucketRows,
  };
}

export function buildExploreRecordBucketsDeps(): ExploreRecordBucketsDependencies {
  if (isPostgresStorageBackend()) {
    return buildPostgresExploreRecordBucketsDeps();
  }
  return buildSqliteExploreRecordBucketsDeps();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the explore timeline dependency implementation for the active
 * storage backend (Postgres or SQLite).
 */
export function buildExploreTimelineDeps(): ExploreTimelineDependencies {
  if (isPostgresStorageBackend()) {
    return buildPostgresExploreTimelineDeps();
  }
  return buildSqliteExploreTimelineDeps();
}
