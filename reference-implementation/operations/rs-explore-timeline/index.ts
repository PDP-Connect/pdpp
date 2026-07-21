// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Canonical `rs.explore.timeline` operation — Phase 3 merged cross-source timeline.
 *
 * Implements a k-WAY MERGE across all the owner's (connector_id, stream) partitions:
 *
 *   - One keyset cursor per partition, anchored at the first-page snapshot INGEST SEQUENCE.
 *   - Always emits the globally-newest next record across partitions.
 *   - Returns a page of merged records + ONE opaque `next_cursor`. Internally the
 *     cursor is a composite payload (base64url JSON encoding each partition's cursor
 *     position + the snapshot anchor sequence); it is conveyed to the client as a
 *     short server-side handle when a cursor store is wired (the payload is
 *     O(partition-count) and would overflow URL limits inline — see
 *     docs/research/explore-cursor-431-diagnosis-2026-06-20.md).
 *   - Paging the composite cursor forward yields strictly-older, non-duplicated records
 *     spanning all sources.
 *   - POINT-IN-TIME STABILITY: the composite cursor anchors to MAX(id) (the monotonic
 *     ingest sequence — BIGSERIAL in Postgres, AUTOINCREMENT rowid in SQLite) captured at
 *     first-page time. This correctly excludes backfilled records: a connector may ingest a
 *     record with an OLD emitted_at (below any seen timestamp) AFTER the snapshot was taken;
 *     anchoring on emitted_at would incorrectly include such rows on later pages. Anchoring
 *     on the ingest sequence excludes ALL rows ingested after the snapshot regardless of
 *     their authored timestamp. New records above the anchor are counted and surfaced as
 *     `new_since_snapshot` so the UI can show an "N new" pill.
 *   - NO PARTITION CAP: all (connector_instance_id, stream) pairs are enumerated — the
 *     DISTINCT scan over the indexed columns is cheap and personal servers have at most
 *     thousands of partitions. A silent cap that hides overflow partitions violates the
 *     contract ("every record reachable").
 *   - BOTH IDENTITIES RETURNED: each record carries `connector_id` (the connector TYPE,
 *     e.g. "amazon") and `connector_instance_id` (the specific connection instance,
 *     e.g. "cin_..."). The UI needs the type to label the connector and the instance to
 *     build per-connection peek reads.
 *
 * CONTRACT:
 *   - Merged feed returns a composite cursor (`next_cursor`).
 *   - Paging forward yields strictly non-increasing SEMANTIC time
 *     (COALESCE(NULLIF(semantic_time, ''), emitted_at)), no duplicates.
 *   - Records spanning multiple (connector_id, stream) partitions appear in one feed.
 *   - Inserting a new record after page 1 does NOT appear in already-returned pages
 *     (snapshot stability) but IS counted in `new_since_snapshot`.
 *   - Records from overflow partitions (beyond any former cap) ARE reachable.
 *
 * Boundary rules (mirrors `ref-records-timeline/index.ts`):
 *   - This module SHALL NOT import Fastify, Express, Next, SQLite, Postgres, a raw SQL
 *     handle, sandbox modules, `reference-implementation/server/*` route or auth modules,
 *     or `process` / `process.env`.
 *   - All substrate reads flow through the dependency contract.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single (connector_instance_id, stream) partition identity.
 *
 * Carries both the connector TYPE (`connectorType`, i.e. `connector_id` in the
 * records table) and the connection INSTANCE (`connectorId`, i.e.
 * `connector_instance_id` in the records table) so that the merge can emit both
 * fields on every record without a join.
 */
export interface ExploreTimelinePartition {
  /** The connection instance id (connector_instance_id in the records table). */
  readonly connectorId: string;
  /** The connector type id (connector_id in the records table, e.g. "amazon"). */
  readonly connectorType: string;
  readonly stream: string;
}

/**
 * A per-partition keyset cursor position. Encodes exactly where we are in
 * that partition's ordered scan: the SEMANTIC time of the last record returned
 * plus its `record_key` tiebreaker. The keyset key is semantic time (when the
 * thing happened) because the merged timeline ORDERS by semantic time, not by
 * ingest time — see CompositeCursorPayload version history (v3).
 *
 * `null` values mean "start from the beginning (or end) of the partition".
 */
export interface PartitionCursorPosition {
  readonly connectorId: string;
  readonly stream: string;
  /** Last `semantic_time` returned for this partition; null = not yet started. */
  readonly lastSemanticTime: string | null;
  /** Last `record_key` returned (tiebreaker); null = not yet started. */
  readonly lastRecordKey: string | null;
}

/**
 * The composite cursor blob. Encodes all partition positions + the snapshot
 * anchor so the next page can maintain point-in-time stability.
 *
 * `version` lets us reject stale cursors with an incompatible format.
 *
 * VERSION HISTORY:
 *   v1: snapshotAt was a MAX(emitted_at) string. Broken for backfills.
 *   v2: snapshotSeq is MAX(id) — the monotonic ingest sequence (BIGSERIAL/rowid).
 *       Correctly excludes backfilled records with old emitted_at ingested after
 *       the snapshot. snapshotAt is still included for display only (not used for
 *       membership filtering). Per-partition keyset key was `lastEmittedAt`.
 *   v3: the merged timeline now ORDERS by each record's SEMANTIC time (when the
 *       thing happened), not its ingest time. The per-partition keyset key is
 *       therefore `lastSemanticTime` (was `lastEmittedAt`); the keyset seek and
 *       the k-way merge compare semantic_time. The snapshot anchor (snapshotSeq /
 *       MEMBERSHIP) is UNCHANGED — ordering and membership are different keys. A
 *       v2 cursor's keyset key no longer matches the sort, so v2 cursors are
 *       rejected as invalid_cursor (the version check below) and stale tabs
 *       re-anchor a fresh snapshot rather than mis-seek.
 */
export interface CompositeCursorPayload {
  readonly version: 4;
  /**
   * The snapshot anchor: MAX(id) (ingest sequence — BIGSERIAL in Postgres,
   * AUTOINCREMENT rowid in SQLite) captured at first-page load time. Rows with
   * id > snapshotSeq were ingested after the snapshot and must not appear in
   * paginated results, regardless of their emitted_at.
   */
  readonly snapshotSeq: number;
  /**
   * ISO-8601 display timestamp corresponding to the snapshot (MAX(emitted_at) at
   * snapshot time). Exposed as `snapshot_at` in the response for display only;
   * NOT used as the membership filter (snapshotSeq gates membership).
   */
  readonly snapshotAt: string;
  /**
   * The PINNED past/future boundary: real wall-clock now (ISO-8601) captured at
   * first-page load. The MAIN feed includes only records with semantic time <=
   * this ceiling; future-dated records are surfaced separately (upcoming). Pinned
   * — not recomputed per page — so the past/future split is CONSISTENT across the
   * whole traversal: a record whose scheduled time arrives mid-paging does not
   * silently skip the keyset window (it stays classified by the first-page now
   * until reload). This is the documented opt-in snapshot pin for a time-boundaried
   * feed; see docs/research/explore-now-boundary-pinning-prior-art-2026-06-21.md.
   * (v4: added in this field; v3 cursors are rejected as invalid_cursor.)
   */
  readonly nowCeiling: string;
  /**
   * The PINNED scan direction for this traversal. "asc" = oldest-first
   * (`order=oldest`), "desc" = newest-first (default browse). Carried so every
   * page of an oldest-first walk keeps paging ascending (and the keyset seek
   * predicate stays correct). Direction is feed-defining, so a flip starts a
   * fresh cursor — it never changes mid-traversal. OPTIONAL for backward
   * compatibility: a cursor minted before this field decodes as "desc", so no
   * version bump is needed (the keyset key, snapshot, and ceiling are unchanged).
   */
  readonly direction?: "asc" | "desc";
  /**
   * Per-partition positions. Partitions that have been exhausted are omitted
   * (no point carrying them; they contribute nothing to future pages).
   */
  readonly partitions: readonly PartitionCursorPosition[];
}

/**
 * A single record in the merged timeline response.
 *
 * Carries BOTH identity fields:
 *   - `connector_id`: the connector TYPE (e.g. "amazon") — use to label the
 *     connector name and load manifest metadata.
 *   - `connector_instance_id`: the specific connection INSTANCE (e.g. "cin_...") —
 *     use to build per-connection peek/record-detail reads and connection URLs.
 *
 * Frontend note: never render raw `connector_instance_id` as a display name;
 * resolve the human label via `connector_id` against the connector registry.
 */
export interface ExploreTimelineRecord {
  readonly object: "timeline_record";
  /** Connector TYPE id (e.g. "amazon"). Use for display labels and manifest lookup. */
  readonly connector_id: string;
  /** Connection INSTANCE id (e.g. "cin_..."). Use for per-connection API reads. */
  readonly connector_instance_id: string;
  readonly stream: string;
  readonly record_key: string;
  readonly emitted_at: string;
  /**
   * The SEMANTIC time this record is ORDERED by — COALESCE(NULLIF(semantic_time,
   * ''), emitted_at). This is the authoritative display/sort key the server already
   * computed (the keyset cursor key). Clients should use it directly as the display
   * timestamp so display == sort BY CONSTRUCTION, instead of re-deriving it from
   * manifest metadata (which silently fell back to emitted_at when the per-connector
   * metadata lookup missed — see the canonical-connector-key fix). Always present.
   */
  readonly semantic_time: string;
  readonly data: unknown;
}

/**
 * Input for a per-partition keyset page fetch.
 */
export interface PartitionPageInput {
  readonly connectorId: string;
  readonly stream: string;
  /**
   * Ingest sequence bound (MAX(id) at snapshot time). Include only records
   * with id <= snapshotSeq (point-in-time stability via ingest sequence).
   * This correctly excludes backfilled rows whose emitted_at is old but whose
   * ingest id is newer than the snapshot.
   */
  readonly snapshotSeq: number;
  /** Fetch records strictly before this position (null = start from snapshot). */
  readonly afterPosition: PartitionCursorPosition | null;
  /** Maximum rows to fetch from this partition. */
  readonly limit: number;
  /**
   * Upper bound (inclusive) on the ordering timestamp COALESCE(semantic_time,
   * emitted_at). The MAIN timeline excludes future-dated records (semantic time
   * AFTER this ceiling) so scheduled/future rows (e.g. YNAB future budget months)
   * never dominate the newest-first feed above today's activity. Pinned to the
   * snapshot's wall clock so a record's past/future classification is stable across
   * pages. The future set is fetched separately (fetchUpcoming). Null = no ceiling
   * (legacy behavior, no future/past split).
   */
  readonly nowCeiling?: string | null;
  /**
   * Scan DIRECTION over the partition's semantic-time order. "desc" (default) =
   * newest-first (the standard browse feed); "asc" = oldest-first — the
   * `order=oldest` re-page that walks from the partition's EARLIEST record
   * forward. Both directions keep the `nowCeiling` upper-bound clamp, so "asc"
   * pages the PAST partition from the floor up to the ceiling and never surfaces
   * the future partition into the main feed. The keyset seek predicate flips with
   * the direction (`<` for desc, `>` for asc). Display key == cursor key ==
   * semantic_time in BOTH directions (display == sort by construction), so an
   * oldest-first page is monotone across page boundaries exactly like newest-first.
   */
  readonly direction?: "asc" | "desc";
}

/**
 * A single row returned by a partition fetch.
 */
export interface PartitionRow {
  /** Connection instance id (connector_instance_id in records table). */
  readonly connectorId: string;
  /** Connector type id (connector_id in records table). */
  readonly connectorType: string;
  readonly stream: string;
  readonly recordKey: string;
  /** Ingest time (when the runtime wrote the row). Surfaced on the response. */
  readonly emittedAt: string;
  /**
   * SEMANTIC time (when the thing happened): the substrate's
   * COALESCE(NULLIF(semantic_time, ''), emitted_at). This is the ORDER BY /
   * keyset key for the merged timeline. Never empty.
   */
  readonly semanticTime: string;
  readonly data: unknown;
}

/**
 * Result of a per-partition page fetch.
 */
export interface PartitionPageResult {
  readonly rows: readonly PartitionRow[];
  /** True if there are more rows in this partition after these rows. */
  readonly hasMore: boolean;
}

/**
 * Input for counting records ingested after the snapshot anchor.
 */
export interface CountNewSinceSnapshotInput {
  /** Ingest sequence anchor (MAX(id) at snapshot time). Count rows with id > snapshotSeq. */
  readonly snapshotSeq: number;
  /** Optional connection-instance scope for filtered owner timelines. */
  readonly connectionIds?: readonly string[];
  /** Optional stream-name scope for filtered owner timelines. */
  readonly streams?: readonly string[];
}

export interface ExploreTimelineInput {
  /** Page size. Defaults to 50 if omitted or invalid. */
  readonly limit?: number | null;
  /** Opaque composite cursor from a prior page. Null/omitted = first page. */
  readonly cursor?: string | null;
  /**
   * REWIND: when true AND `cursor` is set, re-fetch PAGE 1 pinned to the cursor's
   * ORIGINAL snapshot (`snapshotSeq`/`snapshotAt`), ignoring the cursor's partition
   * positions and re-enumerating all partitions from the start. Used by the console
   * accumulator to re-render page 1 against the SAME snapshot as later pages, so an
   * after-snapshot backfill can never displace an original page-1 row. The snapshot
   * is NOT re-captured (membership stays `id <= snapshotSeq`).
   */
  readonly rewindToFirstPage?: boolean | null;
  /** Optional connection-instance scope. Empty/omitted means every visible connection. */
  readonly connectionIds?: readonly string[] | null;
  /** Optional stream-name scope. Empty/omitted means every visible stream. */
  readonly streams?: readonly string[] | null;
  /**
   * Optional EXCLUDE scope — connection ids to omit ("is not" facet / `-con:`). Applied
   * at partition enumeration so excluded partitions never enter the feed, the Upcoming
   * projection, the counts, OR the cursor — counts stay EXACT (no client-side shrinking).
   * Empty/omitted = exclude nothing. Re-passed by the client on every page (like the
   * include scope; the cursor carries positions only for the surviving partitions).
   */
  readonly excludeConnectionIds?: readonly string[] | null;
  /** Optional EXCLUDE scope — stream names to omit ("is not" facet / `-stream:`). */
  readonly excludeStreams?: readonly string[] | null;
  /**
   * Page size for the page-1 UPCOMING (future) head, independent of the main feed
   * `limit`. The future set is BOUNDED (its count is exact because it is cheap to
   * count), so the head can be large — the owner sees the whole common-case set on
   * first expand instead of a 32-row slice needing repeated load-more. Defaults to
   * `limit` when omitted (legacy). Normalized to the same [MIN, MAX] bounds.
   */
  readonly upcomingLimit?: number | null;
  /**
   * Sort DIRECTION for the main feed over its semantic-time order. "desc"
   * (default) = newest-first browse; "asc" = the `order=oldest` re-page that
   * walks from the EARLIEST past record forward. This is the honest replacement
   * for the old client-side window reverse: "asc" is a real server keyset walk
   * that reaches the true earliest record and pages forward in time. Direction is
   * FEED-DEFINING (a fresh snapshot/cursor), and it is also carried inside the
   * composite cursor so every page of an oldest-first traversal keeps walking
   * ascending. The `nowCeiling` past/future clamp is preserved in both directions:
   * "asc" never leaks the future (Upcoming) partition into the main feed.
   * Omitted/invalid → "desc" (backward compatible: existing cursors have no
   * direction field and decode as "desc").
   */
  readonly direction?: "asc" | "desc" | null;
}

export interface ExploreTimelineOutput {
  readonly object: "list";
  readonly data: readonly ExploreTimelineRecord[];
  readonly has_more: boolean;
  /**
   * Opaque cursor for the next page. Null when exhausted. Clients MUST treat it
   * as opaque and pass it back verbatim. When a cursor store is wired this is a
   * short server-side handle (prefix `ecr1_`) backing the composite payload; when
   * no store is wired (e.g. unit tests) it is the raw base64url composite blob.
   */
  readonly next_cursor: string | null;
  /**
   * ISO-8601 timestamp at which this result set was anchored.
   * Records with `emitted_at` after this value are "new" and not included.
   */
  readonly snapshot_at: string;
  /**
   * Count of records ingested (across all partitions) after `snapshot_at`.
   * UI can show an "N new" pill and refresh on click.
   */
  readonly new_since_snapshot: number;
  /**
   * FUTURE-dated records (semantic time > the pinned past/future boundary),
   * FORWARD-chronological (soonest first), capped — for the separate "Upcoming"
   * section. Excluded from `data` (the main feed) so they never sit above today.
   * Empty when no future records or when the dep doesn't implement fetchUpcoming.
   */
  readonly upcoming: readonly ExploreTimelineRecord[];
  /**
   * TRUE server-side count of ALL future records (not just the `upcoming` head),
   * for the collapsed "N upcoming" pill. 0 when none.
   */
  readonly upcoming_total: number;
  /**
   * Opaque cursor for the NEXT page of Upcoming (future) records, independent of
   * `next_cursor` (which pages the main past feed). Null when the upcoming set is
   * fully returned by this page (or empty). Clients pass it back verbatim to walk
   * the future projection to exhaustion — the count==reachability fix for "188
   * upcoming but only 32 shown". Backed by an UpcomingCursorPayload.
   */
  readonly upcoming_next_cursor: string | null;
  /** True when more future records exist after `upcoming` (i.e. `upcoming_next_cursor` is set). */
  readonly upcoming_has_more: boolean;
}

export interface ExploreTimelineDependencies {
  /**
   * List ALL distinct (connector_instance_id, stream) partitions visible to the
   * owner, with no limit. Returns an empty array when no records exist yet.
   *
   * IMPORTANT: implementations MUST NOT apply any LIMIT / cap to this query.
   * A cap silently hides records in overflow partitions, violating the contract.
   */
  listPartitions(input?: {
    readonly connectionIds?: readonly string[];
    readonly streams?: readonly string[];
    /** Connection ids to EXCLUDE (NOT IN); applied alongside the include scope. */
    readonly excludeConnectionIds?: readonly string[];
    /** Stream names to EXCLUDE (NOT IN); applied alongside the include scope. */
    readonly excludeStreams?: readonly string[];
  }): Promise<readonly ExploreTimelinePartition[]>;

  /**
   * Fetch the current maximum ingest sequence (MAX(id)) across all records
   * visible to the owner, together with the corresponding MAX(emitted_at) for
   * display. Returns null for both if no records exist (empty corpus).
   */
  fetchSnapshotAnchor(): Promise<{ snapshotSeq: number; snapshotAt: string } | null>;

  /**
   * Fetch a bounded page of records from a single (connector_instance_id, stream)
   * partition, ordered by SEMANTIC time DESC — COALESCE(NULLIF(semantic_time,
   * ''), emitted_at) — (newest first), keyset-paginated by `afterPosition`
   * (which carries `lastSemanticTime`). Only include records with
   * `id <= snapshotSeq` (membership stays anchored on the ingest sequence).
   */
  fetchPartitionPage(input: PartitionPageInput): Promise<PartitionPageResult>;

  /**
   * Count records with `id > snapshotSeq` across all visible partitions.
   * Used for the "N new" pill. May return 0 if the feature is expensive and
   * the caller prefers a best-effort / deferred count.
   */
  countNewSinceSnapshot(input: CountNewSinceSnapshotInput): Promise<number>;

  /**
   * OPTIONAL server-side cursor store. When provided, the composite cursor blob
   * is persisted server-side and only a short opaque HANDLE travels in the URL —
   * `next_cursor` is the handle, not the blob. This keeps the URL O(1) regardless
   * of partition count (the blob is O(partitions) and overflows proxy URL limits
   * at scale — see docs/research/explore-cursor-431-diagnosis-2026-06-20.md).
   *
   * When ABSENT (e.g. unit tests with a fake deps object), the operation falls
   * back to emitting the raw base64url blob inline, preserving the prior contract.
   * `loadCursorBlob` returns null for an unknown/expired handle.
   */
  saveCursorBlob?(blob: string): Promise<string>;
  loadCursorBlob?(handle: string): Promise<string | null>;

  /**
   * OPTIONAL injectable clock for the PINNED past/future boundary (nowCeiling).
   * Production omits it (real wall clock); tests provide a fixed instant so the
   * past/future split is deterministic. Returns an ISO-8601 string.
   */
  now?(): string;

  /**
   * OPTIONAL: fetch the FUTURE-dated set — records whose semantic time is strictly
   * AFTER `nowCeiling` — for the separate "Upcoming" projection, plus a true
   * server-side total COUNT of all such records (the Relay `totalCount` pattern;
   * the set is bounded so the count is cheap). Records come back FORWARD-
   * chronological (soonest future first), capped at `limit`. Membership stays
   * `id <= snapshotSeq` (same snapshot as the main feed). When ABSENT, the
   * operation returns an empty upcoming set (legacy: no future/past split).
   */
  fetchUpcoming?(input: UpcomingFetchInput): Promise<UpcomingFetchResult>;
}

/** Input for the separate future/upcoming projection. */
export interface UpcomingFetchInput {
  /**
   * The SCOPED partition list (already enumerated by the operation). The upcoming
   * fetch probes each (connector_instance_id, stream) partition INDIVIDUALLY so the
   * partition-prefixed `idx_*_records_semantic_time` index serves it — a single
   * GLOBAL `semantic_time > now` query Seq-Scans the whole table (cost ~472K on the
   * live 2.8M corpus; the index is keyed by connector_instance_id, stream FIRST).
   * The per-partition heads are merged + counts summed.
   */
  readonly partitions: readonly ExploreTimelinePartition[];
  /** Snapshot membership bound (id <= snapshotSeq), same as the main feed. */
  readonly snapshotSeq: number;
  /** Pinned past/future boundary: include records with semantic time > this. */
  readonly nowCeiling: string;
  /** Max future rows to return (the merged soonest-first head). */
  readonly limit: number;
  /**
   * Per-partition ASC seek positions from a prior upcoming page (the upcoming
   * composite cursor). Null/omitted = first upcoming page (start each partition
   * from its earliest future row). When present, each partition fetches strictly
   * AFTER its own `(lastSemanticTime, lastRecordKey)` position. Partitions absent
   * from this list (but present in `partitions`) start from the beginning; a
   * partition present here with a position resumes after it.
   */
  readonly afterPositions?: readonly UpcomingPartitionPosition[] | null;
  /**
   * Whether the caller wants the TRUE total recomputed. The total is stable under
   * a pinned snapshot+nowCeiling, so it only needs computing on the FIRST upcoming
   * page; later pages pass `false` (or carry it in the cursor) to skip the
   * per-partition COUNT(*) work. Default true (first page).
   */
  readonly computeTotal?: boolean;
}

/** Result of the future/upcoming projection. */
export interface UpcomingFetchResult {
  /** Future rows, FORWARD-chronological (soonest first), capped at `limit`. */
  readonly rows: readonly PartitionRow[];
  /**
   * TRUE server-side count of ALL future records (not just the returned page).
   * Only meaningful when the input requested it (`computeTotal !== false`);
   * otherwise 0 and the caller carries the total from the first page.
   */
  readonly total: number;
  /**
   * True if at least one partition has more future rows after this page. Drives
   * `upcoming_has_more` and whether a next upcoming cursor is issued.
   */
  readonly hasMore: boolean;
  /**
   * The advanced per-partition positions AFTER this page — the last
   * `(semanticTime, recordKey)` emitted per partition that still has more, for the
   * next upcoming cursor. Exhausted partitions are omitted. Empty when nothing
   * paged (no future rows) — the caller then issues no next cursor.
   */
  readonly nextPositions: readonly UpcomingPartitionPosition[];
}

/**
 * Opaque cursor handles are short, URL-safe, and structurally distinguishable
 * from a raw base64url composite blob: a blob is valid base64url JSON that
 * starts with `eyJ` (`{"`); a handle is prefixed so the operation can tell them
 * apart and stay backward-compatible with any blob cursor still in flight.
 */
const CURSOR_HANDLE_PREFIX = "ecr1_";

function isCursorHandle(cursor: string): boolean {
  return cursor.startsWith(CURSOR_HANDLE_PREFIX);
}

// ---------------------------------------------------------------------------
// Cursor encoding / decoding
// ---------------------------------------------------------------------------

const CURSOR_VERSION = 4 as const;

export class InvalidCompositeCursorError extends Error {
  override readonly name = "InvalidCompositeCursorError";
}

export function encodeCompositeCursor(payload: CompositeCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCompositeCursor(cursor: string): CompositeCursorPayload {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new InvalidCompositeCursorError("Composite cursor is not base64url-encoded.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidCompositeCursorError("Composite cursor payload is not valid JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).version !== CURSOR_VERSION ||
    typeof (parsed as Record<string, unknown>).snapshotAt !== "string" ||
    typeof (parsed as Record<string, unknown>).snapshotSeq !== "number" ||
    typeof (parsed as Record<string, unknown>).nowCeiling !== "string" ||
    !Array.isArray((parsed as Record<string, unknown>).partitions)
  ) {
    throw new InvalidCompositeCursorError(
      "Composite cursor payload is missing required fields or has an incompatible version."
    );
  }
  const obj = parsed as Record<string, unknown>;
  const partitions = (obj.partitions as unknown[]).map((p, i) => {
    if (
      typeof p !== "object" ||
      p === null ||
      typeof (p as Record<string, unknown>).connectorId !== "string" ||
      typeof (p as Record<string, unknown>).stream !== "string"
    ) {
      throw new InvalidCompositeCursorError(`Composite cursor partition[${i}] has invalid shape.`);
    }
    const part = p as Record<string, unknown>;
    return {
      connectorId: part.connectorId as string,
      stream: part.stream as string,
      lastSemanticTime: typeof part.lastSemanticTime === "string" ? part.lastSemanticTime : null,
      lastRecordKey: typeof part.lastRecordKey === "string" ? part.lastRecordKey : null,
    };
  });
  // Direction is OPTIONAL: a cursor minted before the field decodes as "desc"
  // (the prior newest-first-only behavior), so no version bump is required.
  const direction = obj.direction === "asc" ? "asc" : "desc";
  return {
    version: CURSOR_VERSION,
    snapshotSeq: obj.snapshotSeq as number,
    snapshotAt: obj.snapshotAt as string,
    nowCeiling: obj.nowCeiling as string,
    direction,
    partitions,
  };
}

// ---------------------------------------------------------------------------
// Upcoming (future projection) composite cursor — ASC walk to exhaustion
// ---------------------------------------------------------------------------
//
// The Upcoming section paginates SEPARATELY from the main feed: same pinned
// snapshot (snapshotSeq) + pinned nowCeiling, but FORWARD-chronological (soonest
// future first). It carries PER-PARTITION positions, NOT a single global
// (semanticTime, recordKey) seek — `record_key` is unique only WITHIN a
// partition, so a flat global cursor would skip a same-(time,key) row living in a
// different partition. Mirrors the main composite cursor's structure (so the same
// reasoning and stability guarantees apply) with ASC ordering and reusing
// PartitionCursorPosition. version `1` is independent of the main CURSOR_VERSION.
export const UPCOMING_CURSOR_VERSION = 1 as const;

/**
 * A per-partition ASC position in the upcoming cursor. Unlike the main feed's
 * `PartitionCursorPosition`, this carries `connectorType` too, so the upcoming
 * cursor fully reconstructs each partition's identity (the future-page fetch runs
 * only over the partitions the cursor still carries — there is no separate
 * partition enumeration to resupply `connectorType`).
 */
export interface UpcomingPartitionPosition {
  /** connector_instance_id (the records-table partition key). */
  readonly connectorId: string;
  /** connector_id / connector TYPE (carried so the page can rebuild the partition). */
  readonly connectorType: string;
  readonly stream: string;
  /** Last `semantic_time` emitted for this partition; seek strictly after. */
  readonly lastSemanticTime: string | null;
  /** Last `record_key` emitted (tiebreaker); seek strictly after. */
  readonly lastRecordKey: string | null;
}

export interface UpcomingCursorPayload {
  readonly version: 1;
  /** Same ingest-sequence membership bound as the main feed (id <= snapshotSeq). */
  readonly snapshotSeq: number;
  /** Display-only snapshot timestamp (carried so a future page can echo it). */
  readonly snapshotAt: string;
  /** Same pinned past/future boundary as the main feed (include semantic time > this). */
  readonly nowCeiling: string;
  /**
   * Per-partition ASC positions. A partition is omitted once exhausted (it
   * contributes nothing to further pages). `lastSemanticTime`/`lastRecordKey` are
   * the last row emitted FOR THAT PARTITION; the next page seeks strictly after.
   */
  readonly partitions: readonly UpcomingPartitionPosition[];
}

export function encodeUpcomingCursor(payload: UpcomingCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeUpcomingCursor(cursor: string): UpcomingCursorPayload {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new InvalidCompositeCursorError("Upcoming cursor is not base64url-encoded.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InvalidCompositeCursorError("Upcoming cursor payload is not valid JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).version !== UPCOMING_CURSOR_VERSION ||
    typeof (parsed as Record<string, unknown>).snapshotAt !== "string" ||
    typeof (parsed as Record<string, unknown>).snapshotSeq !== "number" ||
    typeof (parsed as Record<string, unknown>).nowCeiling !== "string" ||
    !Array.isArray((parsed as Record<string, unknown>).partitions)
  ) {
    throw new InvalidCompositeCursorError(
      "Upcoming cursor payload is missing required fields or has an incompatible version."
    );
  }
  const obj = parsed as Record<string, unknown>;
  const partitions = (obj.partitions as unknown[]).map((p, i) => {
    if (
      typeof p !== "object" ||
      p === null ||
      typeof (p as Record<string, unknown>).connectorId !== "string" ||
      typeof (p as Record<string, unknown>).connectorType !== "string" ||
      typeof (p as Record<string, unknown>).stream !== "string"
    ) {
      throw new InvalidCompositeCursorError(`Upcoming cursor partition[${i}] has invalid shape.`);
    }
    const part = p as Record<string, unknown>;
    return {
      connectorId: part.connectorId as string,
      connectorType: part.connectorType as string,
      stream: part.stream as string,
      lastSemanticTime: typeof part.lastSemanticTime === "string" ? part.lastSemanticTime : null,
      lastRecordKey: typeof part.lastRecordKey === "string" ? part.lastRecordKey : null,
    };
  });
  return {
    version: UPCOMING_CURSOR_VERSION,
    snapshotSeq: obj.snapshotSeq as number,
    snapshotAt: obj.snapshotAt as string,
    nowCeiling: obj.nowCeiling as string,
    partitions,
  };
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 500;

function normalizeLimit(raw: number | null | undefined): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < MIN_LIMIT) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

function normalizeScope(raw: readonly string[] | null | undefined): readonly string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

// ---------------------------------------------------------------------------
// k-way merge algorithm
// ---------------------------------------------------------------------------

/**
 * A per-partition bucket in the k-way merge heap.
 */
interface PartitionBucket {
  readonly partition: ExploreTimelinePartition;
  cursorPosition: PartitionCursorPosition | null;
  /** Buffered rows not yet emitted, newest-first order. */
  buffer: PartitionRow[];
  /** Whether this partition has been fully drained. */
  exhausted: boolean;
}

/**
 * Compare two records' SEMANTIC time + record_keys for DESC ordering (newest
 * first). Returns negative if a > b (a is newer, should come first).
 *
 * The merge orders by semantic_time so the globally-newest head it picks matches
 * the per-partition substrate ORDER BY (semantic_time DESC, record_key DESC). The
 * keys MUST be the same or pages mis-order. The snapshot anchor (id) is a
 * different key and is NOT compared here — it gates MEMBERSHIP, not order.
 */
function compareRowsDesc(a: PartitionRow, b: PartitionRow): number {
  // ISO 8601 timestamps compare lexicographically = chronologically (for UTC).
  if (a.semanticTime > b.semanticTime) return -1;
  if (a.semanticTime < b.semanticTime) return 1;
  // Tiebreak by record_key descending for total stable order.
  if (a.recordKey > b.recordKey) return -1;
  if (a.recordKey < b.recordKey) return 1;
  return 0;
}

/**
 * Compare two records for ASC ordering (oldest first) — the `order=oldest`
 * re-page. Returns negative if a < b (a is older, should come first). Mirrors
 * the per-partition substrate ORDER BY (semantic_time ASC, record_key ASC) so
 * the globally-OLDEST head the merge picks matches the partition fetch order;
 * the keys MUST match or pages mis-order. Membership (id <= snapshotSeq) is a
 * different key and is not compared here — direction only changes ORDER.
 */
function compareRowsAsc(a: PartitionRow, b: PartitionRow): number {
  if (a.semanticTime < b.semanticTime) return -1;
  if (a.semanticTime > b.semanticTime) return 1;
  if (a.recordKey < b.recordKey) return -1;
  if (a.recordKey > b.recordKey) return 1;
  return 0;
}

/** The merge comparator for a scan direction (newest-first vs oldest-first). */
function compareRowsForDirection(direction: "asc" | "desc"): (a: PartitionRow, b: PartitionRow) => number {
  return direction === "asc" ? compareRowsAsc : compareRowsDesc;
}

/**
 * Refill a partition bucket from the dependency, advancing its cursor.
 * Fetches `fetchSize` rows and appends them to the bucket's buffer (newest first).
 */
/** Map a substrate PartitionRow to a public timeline_record. Shared by the main
 *  feed (k-way merge emit) and the separate upcoming projection. */
function partitionRowToRecord(row: PartitionRow): ExploreTimelineRecord {
  return {
    object: "timeline_record",
    connector_id: row.connectorType,
    connector_instance_id: row.connectorId,
    stream: row.stream,
    record_key: row.recordKey,
    emitted_at: row.emittedAt,
    semantic_time: row.semanticTime,
    data: row.data,
  };
}

async function refillBucket(
  bucket: PartitionBucket,
  snapshotSeq: number,
  fetchSize: number,
  deps: ExploreTimelineDependencies,
  nowCeiling: string | null,
  direction: "asc" | "desc"
): Promise<void> {
  if (bucket.exhausted) return;

  const result = await deps.fetchPartitionPage({
    connectorId: bucket.partition.connectorId,
    stream: bucket.partition.stream,
    snapshotSeq,
    afterPosition: bucket.cursorPosition,
    limit: fetchSize,
    nowCeiling,
    direction,
  });

  if (result.rows.length === 0) {
    bucket.exhausted = true;
    return;
  }

  // Rows come back in the requested direction (newest-first for "desc",
  // oldest-first for "asc") from the dependency.
  bucket.buffer.push(...result.rows);

  if (!result.hasMore) {
    bucket.exhausted = true;
  }
}

// ---------------------------------------------------------------------------
// Main operation
// ---------------------------------------------------------------------------

/**
 * Execute the k-way merge timeline operation.
 *
 * Algorithm:
 *   1. Decode or initialize composite cursor (establishes snapshot anchor).
 *   2. Initialize per-partition buckets from the composite cursor positions.
 *   3. Seed each bucket with an initial fetch.
 *   4. k-way merge: always pick the globally-newest head across all buckets.
 *      When a bucket is drained, refill it before declaring it exhausted.
 *   5. Emit `limit` records, build next composite cursor from final bucket positions.
 *   6. Count "new" records above the snapshot anchor.
 */
export async function executeExploreTimeline(
  input: ExploreTimelineInput,
  deps: ExploreTimelineDependencies
): Promise<ExploreTimelineOutput> {
  const limit = normalizeLimit(input.limit ?? null);
  // The page-1 upcoming head has its own (larger) limit so the bounded future set is
  // revealed on first expand; falls back to the feed limit when not supplied.
  const upcomingLimit = normalizeLimit(input.upcomingLimit ?? input.limit ?? null);
  const connectionIds = normalizeScope(input.connectionIds ?? null);
  const streams = normalizeScope(input.streams ?? null);
  // EXCLUDE scope ("is not" facet / `-con:`/`-stream:`): applied at partition
  // enumeration so excluded partitions are absent from the feed, Upcoming, counts,
  // and cursor — counts stay exact, never client-side shrunk.
  const excludeConnectionIds = normalizeScope(input.excludeConnectionIds ?? null);
  const excludeStreams = normalizeScope(input.excludeStreams ?? null);
  // Rewind only applies when a cursor is present (it pins page 1 to that cursor's
  // snapshot). With no cursor it is a no-op (first page already starts fresh).
  const rewindToFirstPage = Boolean(input.rewindToFirstPage) && Boolean(input.cursor);

  // ── Phase 1: Resolve or initialize the composite cursor ─────────────────

  let snapshotSeq: number;
  let snapshotAt: string;
  // The PINNED past/future boundary (real wall-clock now at first-page capture).
  // Restored verbatim from the cursor on resume so the past/future split is stable
  // across the whole traversal. See the CompositeCursorPayload.nowCeiling doc.
  let nowCeiling: string;
  // The PINNED scan direction for this traversal. On resume the cursor's
  // direction WINS (so an oldest-first walk keeps paging ascending); on a fresh
  // page the input picks it. Direction is feed-defining (a flip resets the
  // cursor upstream), so it never changes mid-traversal.
  let direction: "asc" | "desc";
  let initialPositions: Map<string, PartitionCursorPosition>;
  const requestedDirection: "asc" | "desc" = input.direction === "asc" ? "asc" : "desc";

  if (input.cursor) {
    // Resuming from a prior page. The URL carries either an opaque server-side
    // HANDLE (when a cursor store is wired) or — for backward compatibility with
    // any blob cursor still in flight — the raw base64url blob itself.
    let cursorBlob: string = input.cursor;
    if (isCursorHandle(input.cursor)) {
      const loaded = deps.loadCursorBlob ? await deps.loadCursorBlob(input.cursor) : null;
      if (loaded === null) {
        const typed = new Error(
          "Explore cursor has expired or is unknown. Reload the page to start a fresh view."
        ) as Error & { code: string };
        typed.code = "invalid_cursor";
        throw typed;
      }
      cursorBlob = loaded;
    }
    let decoded: CompositeCursorPayload;
    try {
      decoded = decodeCompositeCursor(cursorBlob);
    } catch (err) {
      if (err instanceof InvalidCompositeCursorError) {
        const typed = new Error(err.message) as Error & { code: string };
        typed.code = "invalid_cursor";
        throw typed;
      }
      throw err;
    }
    snapshotSeq = decoded.snapshotSeq;
    snapshotAt = decoded.snapshotAt;
    nowCeiling = decoded.nowCeiling;
    // The cursor's direction is authoritative on resume (a cursor without the
    // field decodes as "desc"). A flip is feed-defining and resets the cursor
    // upstream, so the input never disagrees with a live cursor's direction.
    direction = decoded.direction === "asc" ? "asc" : "desc";
    if (rewindToFirstPage) {
      // REWIND: keep the cursor's snapshot, but discard its partition positions and
      // re-enumerate from the start — re-rendering page 1 of the ORIGINAL snapshot.
      // New-since-snapshot partitions are harmless: their rows are all id > snapshotSeq
      // and excluded by the membership filter, so they contribute nothing.
      initialPositions = new Map();
    } else {
      initialPositions = new Map(decoded.partitions.map((p) => [`${p.connectorId}\0${p.stream}`, p]));
    }
  } else {
    // First page: capture the ingest-sequence snapshot anchor now.
    const anchor = await deps.fetchSnapshotAnchor();
    if (anchor === null) {
      // Empty corpus: use sentinel values that exclude nothing (seq 0 means no
      // rows exist; future rows will have id >= 1 so new_since_snapshot will
      // correctly count them if the corpus grows between pages).
      snapshotSeq = 0;
      snapshotAt = "1970-01-01T00:00:00.000Z";
    } else {
      snapshotSeq = anchor.snapshotSeq;
      snapshotAt = anchor.snapshotAt;
    }
    // PIN the past/future boundary at first-page capture. `deps.now` is injectable
    // for deterministic tests; production uses the real wall clock.
    nowCeiling = deps.now ? deps.now() : new Date().toISOString();
    // Fresh page: the request picks the direction (oldest-first re-page or the
    // default newest-first browse). It is then pinned into this page's cursor.
    direction = requestedDirection;
    initialPositions = new Map();
  }

  // ── Phase 2: Enumerate partitions + build buckets ───────────────────────

  const allPartitions = await deps.listPartitions({
    connectionIds,
    streams,
    excludeConnectionIds,
    excludeStreams,
  });

  // When resuming from a cursor, only consider partitions that had data at
  // snapshot time. New partitions that appeared after snapshot are excluded
  // from this page (they'll be included in a fresh first-page call after
  // the user clicks "N new").
  // On first page — and on a REWIND (which re-renders page 1 of the original
  // snapshot) — use all partitions; new-since-snapshot partitions contribute
  // nothing because their rows are all id > snapshotSeq.
  const activePartitions = input.cursor && !rewindToFirstPage
    ? allPartitions.filter((p) => {
        const key = `${p.connectorId}\0${p.stream}`;
        // Include partitions that were in the cursor (even if now exhausted
        // — we check exhaustion lazily). Partitions in the cursor with a
        // position are still live; partitions not in the cursor are new
        // since snapshot and excluded.
        return initialPositions.has(key);
      })
    : allPartitions;

  // Per-partition fetch size: pull enough to have good merge candidates.
  // Fetch limit+1 per partition so we can detect has_more.
  const fetchSize = Math.max(limit, 10);

  const buckets: PartitionBucket[] = activePartitions.map((partition) => {
    const key = `${partition.connectorId}\0${partition.stream}`;
    const priorPosition = initialPositions.get(key) ?? null;
    return {
      partition,
      cursorPosition: priorPosition,
      buffer: [],
      exhausted: false,
    };
  });

  // Seed all buckets with their first fetch in parallel. The MAIN feed is clamped
  // to <= nowCeiling (the PINNED past/future boundary captured at first-page and
  // carried in the cursor) so future-dated rows (e.g. YNAB future budget months)
  // never dominate the newest-first feed above today, and the split stays consistent
  // across every page. See CompositeCursorPayload.nowCeiling.
  await Promise.all(buckets.map((b) => refillBucket(b, snapshotSeq, fetchSize, deps, nowCeiling, direction)));

  // ── Phase 3: k-way merge ────────────────────────────────────────────────
  //
  // The comparator follows the scan direction: "desc" picks the globally-NEWEST
  // head (browse), "asc" picks the globally-OLDEST head (the order=oldest
  // re-page). It MUST match the per-partition substrate ORDER BY for the same
  // direction or pages mis-order.
  const compareRows = compareRowsForDirection(direction);

  const emitted: ExploreTimelineRecord[] = [];

  while (emitted.length < limit) {
    // Find the bucket whose head is first in the scan direction (newest for
    // "desc", oldest for "asc").
    let bestBucket: PartitionBucket | null = null;
    let bestRow: PartitionRow | null = null;

    for (const bucket of buckets) {
      // Refill if buffer is empty and not yet known to be exhausted.
      if (bucket.buffer.length === 0 && !bucket.exhausted) {
        // This is the sequential refill path: we exhaust the previous batch
        // before fetching the next one for this bucket.
        await refillBucket(bucket, snapshotSeq, fetchSize, deps, nowCeiling, direction);
      }
      if (bucket.buffer.length === 0) {
        // Truly exhausted.
        continue;
      }
      const head = bucket.buffer[0];
      if (head !== undefined && (bestRow === null || compareRows(head, bestRow) < 0)) {
        bestBucket = bucket;
        bestRow = head;
      }
    }

    if (bestBucket === null || bestRow === null) {
      // All partitions exhausted.
      break;
    }

    // Consume the best row.
    const bucket = bestBucket;
    bucket.buffer.shift();

    // Update this bucket's cursor position. The keyset key is the SEMANTIC time
    // (the merge/ORDER BY key), not the ingest time.
    bucket.cursorPosition = {
      connectorId: bestRow.connectorId,
      stream: bestRow.stream,
      lastSemanticTime: bestRow.semanticTime,
      lastRecordKey: bestRow.recordKey,
    };

    emitted.push(partitionRowToRecord(bestRow));
  }

  // ── Phase 4: Determine has_more + build composite cursor ────────────────

  // Check if any bucket still has rows (including after refill).
  let hasMore = false;
  for (const bucket of buckets) {
    if (bucket.buffer.length > 0) {
      hasMore = true;
      break;
    }
    if (!bucket.exhausted) {
      hasMore = true;
      break;
    }
  }

  let nextCursor: string | null = null;
  if (hasMore && emitted.length > 0) {
    // Build the next composite cursor from each live bucket's last-consumed position.
    // Omit a bucket only after `refillBucket` has exhausted a snapshotSeq-bounded
    // read. At that point the partition has returned every row visible in this
    // pinned snapshot, so there is no later reachable row for the cursor to preserve.
    const partitionPositions: PartitionCursorPosition[] = [];
    for (const bucket of buckets) {
      if (bucket.cursorPosition !== null) {
        // This bucket contributed at least one row to a prior page.
        if (!bucket.exhausted || bucket.buffer.length > 0) {
          // Still has rows left: include position so we continue from where we stopped.
          partitionPositions.push(bucket.cursorPosition);
        }
        // else: exhausted after contributing, no buffered rows left. This is
        // snapshot-safe to omit: `exhausted` means a snapshotSeq-bounded refill
        // returned no further rows for this partition.
      } else {
        // This bucket has not yet contributed any row to any page.
        if (bucket.buffer.length > 0 || !bucket.exhausted) {
          // Has buffered rows waiting to be emitted (or un-drained pages remaining):
          // carry it forward with a null position so the next page re-fetches from
          // the start of this partition (respecting snapshotSeq). The rows in the
          // buffer are still within the snapshot so they will be returned again.
          partitionPositions.push({
            connectorId: bucket.partition.connectorId,
            stream: bucket.partition.stream,
            lastSemanticTime: null,
            lastRecordKey: null,
          });
        }
        // else: no buffer and exhausted (empty partition in this snapshot) — omit.
      }
    }
    const blob = encodeCompositeCursor({
      version: CURSOR_VERSION,
      snapshotSeq,
      snapshotAt,
      nowCeiling,
      // Carry direction only for an oldest-first walk so the next page keeps
      // paging ascending; the default "desc" is omitted so existing newest-first
      // cursors stay byte-identical (backward compatible).
      ...(direction === "asc" ? { direction } : {}),
      partitions: partitionPositions,
    });
    // Persist the blob server-side and hand back a short opaque handle so the
    // URL stays O(1) regardless of partition count. Falls back to the inline
    // blob only when no store is wired (e.g. unit tests with a fake deps).
    nextCursor = deps.saveCursorBlob ? await deps.saveCursorBlob(blob) : blob;
  }

  // ── Phase 5: Count new records above the snapshot anchor ────────────────

  const newSinceSnapshot = await deps.countNewSinceSnapshot({ snapshotSeq, connectionIds, streams });

  // The separate FUTURE projection (Upcoming), probed PER-PARTITION (index-backed;
  // a global query Seq-Scans) over the same scoped partition list, snapshot-bound,
  // split at the SAME pinned nowCeiling. A true server-side count backs the collapsed
  // "N upcoming" pill, and a SEPARATE composite cursor paginates the future set to
  // exhaustion (count==reachability: the "188 upcoming" must all be reachable, not a
  // capped 32-row head). This is the FIRST upcoming page: no afterPositions, compute
  // the true total once (it is stable under the pinned snapshot+nowCeiling). Absent
  // dep → empty (legacy).
  const upcomingResult: UpcomingFetchResult = deps.fetchUpcoming
    ? await deps.fetchUpcoming({
        partitions: allPartitions,
        snapshotSeq,
        nowCeiling,
        limit: upcomingLimit,
        afterPositions: null,
        computeTotal: true,
      })
    : { rows: [], total: 0, hasMore: false, nextPositions: [] };

  const upcomingNextCursor = await buildUpcomingNextCursor(
    upcomingResult,
    { snapshotSeq, snapshotAt, nowCeiling },
    deps
  );

  return {
    object: "list",
    data: emitted,
    has_more: hasMore,
    next_cursor: nextCursor,
    snapshot_at: snapshotAt,
    new_since_snapshot: newSinceSnapshot,
    upcoming: upcomingResult.rows.map(partitionRowToRecord),
    upcoming_total: upcomingResult.total,
    upcoming_next_cursor: upcomingNextCursor,
    upcoming_has_more: upcomingNextCursor !== null,
  };
}

/**
 * Build the next upcoming cursor from a fetch result, or null when the future set
 * is exhausted by this page. A cursor is issued ONLY when the substrate reports
 * `hasMore` AND there are advanced positions to resume from — so an exhausted set
 * (or an empty one) yields null and the client stops paging.
 *
 * The encoded blob is O(live-future-partitions) and the client ACCUMULATES it into a
 * URL trail, so — exactly like the main feed's `next_cursor` — it MUST be persisted
 * server-side behind a short opaque handle (`ecr1_…`) when a cursor store is wired.
 * Returning the raw blob in the URL trail reintroduces the HTTP 431 class
 * (docs/research/explore-cursor-431-diagnosis-2026-06-20.md). When no store is wired
 * (unit tests), the raw base64url blob is returned (and accepted) for compatibility.
 */
async function buildUpcomingNextCursor(
  result: UpcomingFetchResult,
  anchor: { snapshotSeq: number; snapshotAt: string; nowCeiling: string },
  deps: ExploreTimelineDependencies
): Promise<string | null> {
  if (!result.hasMore || result.nextPositions.length === 0) {
    return null;
  }
  const blob = encodeUpcomingCursor({
    version: UPCOMING_CURSOR_VERSION,
    snapshotSeq: anchor.snapshotSeq,
    snapshotAt: anchor.snapshotAt,
    nowCeiling: anchor.nowCeiling,
    partitions: result.nextPositions,
  });
  return deps.saveCursorBlob ? await deps.saveCursorBlob(blob) : blob;
}

/**
 * Page subsequent UPCOMING (future) records, walking the future projection to
 * exhaustion. Independent of the main feed: decodes the upcoming composite cursor
 * (pinned snapshotSeq + nowCeiling + per-partition ASC positions), fetches the next
 * forward-chronological page, and returns only the upcoming fields. The total is
 * NOT recomputed (stable under the pinned snapshot+nowCeiling — the client carries
 * the first page's `upcoming_total`).
 *
 * The partition SET is taken from the cursor itself: only partitions that still had
 * more future rows are carried forward, so this query touches exactly the live
 * partitions. Scope (connection/stream filters) is therefore implicit in the cursor.
 */
export async function executeExploreUpcoming(
  input: { readonly upcomingCursor: string; readonly limit?: number | null },
  deps: ExploreTimelineDependencies
): Promise<{
  readonly object: "list";
  readonly upcoming: readonly ExploreTimelineRecord[];
  readonly upcoming_next_cursor: string | null;
  readonly upcoming_has_more: boolean;
  readonly snapshot_at: string;
}> {
  if (!deps.fetchUpcoming) {
    // Legacy dep without the future projection: nothing to page.
    return {
      object: "list",
      upcoming: [],
      upcoming_next_cursor: null,
      upcoming_has_more: false,
      snapshot_at: new Date(0).toISOString(),
    };
  }
  // Resolve the incoming cursor: a short opaque handle (`ecr1_…`) is loaded from the
  // server-side store; a raw base64url blob is accepted directly (in-flight URLs /
  // unit tests). An unknown/expired handle is a typed invalid_cursor (reload).
  let upcomingBlob: string = input.upcomingCursor;
  if (isCursorHandle(input.upcomingCursor)) {
    const loaded = deps.loadCursorBlob ? await deps.loadCursorBlob(input.upcomingCursor) : null;
    if (loaded === null) {
      const typed = new Error(
        "Upcoming cursor has expired or is unknown. Reload the page to start a fresh view."
      ) as Error & { code: string };
      typed.code = "invalid_cursor";
      throw typed;
    }
    upcomingBlob = loaded;
  }
  const cursor = decodeUpcomingCursor(upcomingBlob);
  const limit = normalizeLimit(input.limit);
  // Resume only the partitions the cursor still carries (the rest were exhausted on
  // an earlier page). Each partition seeks strictly after its own carried position.
  const partitions: readonly ExploreTimelinePartition[] = cursor.partitions.map((p) => ({
    connectorId: p.connectorId,
    connectorType: p.connectorType,
    stream: p.stream,
  }));
  const result = await deps.fetchUpcoming({
    partitions,
    snapshotSeq: cursor.snapshotSeq,
    nowCeiling: cursor.nowCeiling,
    limit,
    afterPositions: cursor.partitions,
    computeTotal: false,
  });
  const nextCursor = await buildUpcomingNextCursor(
    result,
    { snapshotSeq: cursor.snapshotSeq, snapshotAt: cursor.snapshotAt, nowCeiling: cursor.nowCeiling },
    deps
  );
  return {
    object: "list",
    upcoming: result.rows.map(partitionRowToRecord),
    upcoming_next_cursor: nextCursor,
    upcoming_has_more: nextCursor !== null,
    snapshot_at: cursor.snapshotAt,
  };
}
