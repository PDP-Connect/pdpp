// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { getDb } from "./db.ts";
import { isPostgresStorageBackend } from "./postgres-storage.ts";

type ProjectionError = Error & { code?: string };
type IsoTimestamp = string;
type MaybePromise<T> = T | Promise<T>;

interface DatasetSummaryCounts {
  connector_count: number;
  record_count: number;
  stream_count: number;
}

interface RetainedBytes {
  blob_bytes: number;
  record_changes_json_bytes: number;
  record_json_bytes: number;
}

interface TimeBounds {
  earliest: IsoTimestamp | null;
  latest: IsoTimestamp | null;
}

interface TopConnectorCandidate {
  connector_id: string;
  record_count: number;
}

interface DatasetSummary {
  counts: DatasetSummaryCounts;
  ingested_time_bounds: TimeBounds;
  record_time_bounds: TimeBounds;
  retained_bytes: RetainedBytes;
  top_connector_candidates: TopConnectorCandidate[];
}

interface ProjectionMetadata {
  computed_at: IsoTimestamp | null;
  last_error: string | null;
  rebuild_status: string;
  source_high_watermark: string | null;
  stale_since: IsoTimestamp | null;
  state: string;
}

interface DatasetSummaryProjection extends DatasetSummary {
  generation: number;
  metadata: ProjectionMetadata;
}

interface DatasetSummaryStreamRow {
  computed_at: IsoTimestamp | null;
  connector_id: string;
  consent_time_field: string | null;
  dirty_record_time_bounds: number | boolean;
  earliest_ingested_at: IsoTimestamp | null;
  earliest_record_time: IsoTimestamp | null;
  latest_ingested_at: IsoTimestamp | null;
  latest_record_time: IsoTimestamp | null;
  record_count: number;
  record_json_bytes: number;
  stream: string;
}

interface DatasetSummaryStreamSeed {
  computed_at?: IsoTimestamp | null;
  connector_id: string;
  consent_time_field?: string | null;
  dirty_record_time_bounds?: number | boolean;
  earliest_ingested_at?: IsoTimestamp | null;
  earliest_record_time?: IsoTimestamp | null;
  latest_ingested_at?: IsoTimestamp | null;
  latest_record_time?: IsoTimestamp | null;
  record_count: number;
  record_json_bytes: number;
  stream: string;
}

interface DatasetSummaryRecordDelta {
  connectorId: string;
  consentTimeField: string | null;
  dirtyRecordTimeBounds: boolean;
  emittedAt: IsoTimestamp;
  recordChangesJsonBytesDelta: number;
  recordCountDelta: number;
  recordJsonBytesDelta: number;
  stream: string;
}

interface DatasetSummaryBlobDelta {
  blobBytesDelta: number;
}

interface RebuildDatasetSummaryDependencies {
  getCounts: () => MaybePromise<DatasetSummaryCounts>;
  getIngestedTimeBounds: () => MaybePromise<TimeBounds>;
  getRecordTimeBounds: () => MaybePromise<TimeBounds>;
  getRetainedBytes: () => MaybePromise<RetainedBytes>;
  listStreamProjectionSeeds?: () => MaybePromise<DatasetSummaryStreamSeed[]>;
  listTopConnectorCandidates: () => MaybePromise<TopConnectorCandidate[]>;
}

interface ReconcileDatasetSummaryDependencies {
  getStreamRecordTimeBounds: (
    connectorId: string,
    stream: string,
    consentTimeField: string,
    options: { signal?: AbortSignal | undefined }
  ) => MaybePromise<TimeBounds | null | undefined>;
}

interface RepairedStreamRow {
  captured_computed_at: IsoTimestamp | null;
  connector_id: string;
  earliest_record_time: IsoTimestamp | null;
  latest_record_time: IsoTimestamp | null;
  stream: string;
}

const GLOBAL_KEY = "global";
// Postgres mode owns dataset-summary truth via the retained-size
// projection (`getRetainedSizeDatasetSummaryProjection` in
// `server/index.js`). This module is the SQLite projection. Any caller
// that reaches it while `PDPP_STORAGE_BACKEND=postgres` is configured is
// either reading stale SQLite rows or silently dropping writes — both
// are the failure mode `complete-postgres-runtime-boundary` exists to
// prevent. Fail fast with a typed error rather than serve or swallow
// the wrong answer.
//
// Design note:
// design-notes/postgres-runtime-boundary-sqlite-classification-2026-05-28.md
function assertSqliteBackendForDatasetSummary(operation: string): void {
  if (isPostgresStorageBackend()) {
    const err: ProjectionError = new Error(
      `SQLite dataset-summary read model reached in Postgres mode (operation: ${operation}). ` +
        "In Postgres mode the dashboard summary reads from the retained-size projection " +
        "via getRetainedSizeDatasetSummaryProjection; this module must not be invoked."
    );
    err.code = "storage_backend_mismatch";
    throw err;
  }
}
// Cap the candidate list the projection persists. The operation only
// emits the top three; anything beyond a small multiple of that is just
// noise that bloats the projection JSON, the wire response, and the
// in-memory rebuild result. Keep enough headroom that future tweaks to
// the operation's TOP_CONNECTOR_LIMIT do not regress accuracy.
const MAX_PERSISTED_TOP_CONNECTOR_CANDIDATES = 32;
// Per-call ceiling on reconcile work. Reconcile is a derived-state
// maintenance pass; a single invocation must not block on tens of
// thousands of dirty rows. Anything beyond the ceiling stays dirty for
// the next pass and the projection metadata reports the deferral
// honestly.
const MAX_RECONCILE_BATCH = 256;
// A rebuild that stamps rebuild_status='running' and then never returns
// (process crash, OOM kill, hard restart) leaves that status persisted in
// the database with nothing left alive to ever resolve it -- there is no
// in-memory lock to lose on restart. Without an expiry, every delta on a
// continuously-collecting instance fences itself against that dead lease
// forever: markDatasetSummaryProjectionStale preserves rebuild_status
// as-is, so "running" survives indefinitely and rebuild_status never
// returns to idle/failed on its own. Treat a "running" stamp older than
// this timeout as an orphaned lease rather than a live rebuild.
const REBUILD_LEASE_TIMEOUT_MS = 5 * 60 * 1000;
const EMPTY_SUMMARY = Object.freeze({
  counts: { connector_count: 0, record_count: 0, stream_count: 0 },
  ingested_time_bounds: { earliest: null, latest: null },
  record_time_bounds: { earliest: null, latest: null },
  retained_bytes: {
    blob_bytes: 0,
    record_changes_json_bytes: 0,
    record_json_bytes: 0,
  },
  top_connector_candidates: [],
});

function nowIso(): IsoTimestamp {
  return new Date().toISOString();
}

// A "running" rebuild_status only fences deltas while its lease is
// plausibly live. `stale_since` is stamped once when the rebuild starts
// (markDatasetSummaryProjectionRebuilding) and carried through unchanged
// by every subsequent stale-mark, so its age is the lease's age. Past
// REBUILD_LEASE_TIMEOUT_MS, no real rebuild -- even one contending with
// heavy concurrent writes -- is plausibly still the same in-flight
// attempt; treat the lease as orphaned so deltas stop deferring to it.
function isRebuildLeaseActive(metadata: ProjectionMetadata, at: IsoTimestamp = nowIso()): boolean {
  if (metadata.rebuild_status !== "running") {
    return false;
  }
  if (!metadata.stale_since) {
    return true;
  }
  const leaseAgeMs = Date.parse(at) - Date.parse(metadata.stale_since);
  if (!Number.isFinite(leaseAgeMs)) {
    return true;
  }
  return leaseAgeMs < REBUILD_LEASE_TIMEOUT_MS;
}

// If `projection` carries an orphaned rebuild lease (rebuild_status
// 'running' past REBUILD_LEASE_TIMEOUT_MS with nothing left alive to
// finish it), record the honest outcome -- the rebuild died mid-flight,
// it did not succeed -- and return the projection that reflects that
// write. Callers can then treat rebuild_status as no-longer-running
// without special-casing the timeout logic themselves. When the lease is
// still active (or there is no lease), returns `projection` unchanged.
function reclaimExpiredRebuildLease(projection: DatasetSummaryProjection): DatasetSummaryProjection {
  if (projection.metadata.rebuild_status !== "running" || isRebuildLeaseActive(projection.metadata)) {
    return projection;
  }
  const reclaimedAt = nowIso();
  writeDatasetSummaryProjectionPreservingSummary(
    projection,
    {
      computed_at: projection.metadata.computed_at,
      last_error: "dataset summary projection rebuild lease expired without completing",
      rebuild_status: "failed",
      source_high_watermark: projection.metadata.source_high_watermark || null,
      stale_since: projection.metadata.stale_since || reclaimedAt,
      state: "failed",
    },
    reclaimedAt
  );
  return getDatasetSummaryProjection();
}

function runSequentially<T>(
  items: readonly T[],
  action: (item: T, index: number) => void | Promise<void>
): Promise<void> {
  return items.reduce((previous, item, index) => previous.then(() => action(item, index)), Promise.resolve());
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    const reason =
      signal.reason instanceof Error
        ? signal.reason
        : new Error(
            typeof signal.reason === "string" && signal.reason
              ? signal.reason
              : "dataset summary projection rebuild cancelled"
          );
    if (reason.name !== "AbortError") {
      reason.name = "AbortError";
    }
    throw reason;
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || (err as ProjectionError).code === "ABORT_ERR");
}

function boundedTopConnectorCandidates(candidates: readonly TopConnectorCandidate[]): TopConnectorCandidate[] {
  if (!Array.isArray(candidates)) {
    return [];
  }
  if (candidates.length <= MAX_PERSISTED_TOP_CONNECTOR_CANDIDATES) {
    return candidates;
  }
  // Defensive sort: the rebuild dependency already promises an order,
  // but trimming without re-sorting would silently drop the true top-N
  // if the adapter ever returns them in a different order.
  return [...candidates]
    .sort((a, b) => {
      const aCount = Number(a?.record_count || 0);
      const bCount = Number(b?.record_count || 0);
      if (bCount !== aCount) {
        return bCount - aCount;
      }
      return String(a?.connector_id || "").localeCompare(String(b?.connector_id || ""));
    })
    .slice(0, MAX_PERSISTED_TOP_CONNECTOR_CANDIDATES);
}

function sanitizeProjectionError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err || "unknown error");
  return message.replace(/[A-Za-z0-9+/=_-]{32,}/g, "[redacted]").slice(0, 240);
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

let projectionFaultHook: ((point: string, context: unknown) => void) | null = null;

export function __setDatasetSummaryProjectionFaultHookForTest(
  hook: ((point: string, context: unknown) => void) | null
): void {
  projectionFaultHook = typeof hook === "function" ? hook : null;
}

/**
 * Read the per-`(connector_id, stream)` rows that the dataset-summary
 * projection already maintains. This is a thin read over
 * `dataset_summary_stream_projection`; it does not scan canonical
 * `records`, `record_changes`, or `blobs`.
 *
 * The returned rows surface NULL and dirty time-bound values honestly so
 * downstream surfaces can distinguish "we don't know yet" from
 * "definitely zero". Specifically:
 *   - `earliest_record_time` / `latest_record_time` pass through as
 *     `null` when the projection has no value for them (no
 *     manifest-declared `consent_time_field`, or not yet reconciled).
 *   - `dirty_record_time_bounds` is coerced to a boolean — `true` means
 *     the projection believes the record-time bounds are no longer
 *     trustworthy and need reconciliation.
 *
 * When `connectorId` is supplied, the result is filtered to rows whose
 * `connector_id` equals that value. Otherwise every row is returned,
 * sorted by `connector_id` then `stream` for deterministic output.
 */
export function listStreamProjections({ connectorId }: { connectorId?: string } = {}): DatasetSummaryStreamRow[] {
  assertSqliteBackendForDatasetSummary("listStreamProjections");
  const db = getDb();
  const params: string[] = [];
  let where = "";
  if (typeof connectorId === "string" && connectorId.length > 0) {
    where = " WHERE connector_id = ?";
    params.push(connectorId);
  }
  const rows = db
    .prepare(
      `SELECT connector_id,
              stream,
              record_count,
              record_json_bytes,
              earliest_ingested_at,
              latest_ingested_at,
              earliest_record_time,
              latest_record_time,
              consent_time_field,
              dirty_record_time_bounds,
              computed_at
         FROM dataset_summary_stream_projection${where}
        ORDER BY connector_id ASC, stream ASC`
    )
    .all<DatasetSummaryStreamRow>(...params);
  return rows.map((row) => ({
    computed_at: row.computed_at || null,
    connector_id: row.connector_id,
    consent_time_field: row.consent_time_field || null,
    dirty_record_time_bounds: Number(row.dirty_record_time_bounds || 0) !== 0,
    earliest_ingested_at: row.earliest_ingested_at || null,
    earliest_record_time: row.earliest_record_time || null,
    latest_ingested_at: row.latest_ingested_at || null,
    latest_record_time: row.latest_record_time || null,
    record_count: Number(row.record_count || 0),
    record_json_bytes: Number(row.record_json_bytes || 0),
    stream: row.stream,
  }));
}

export function getDatasetSummaryProjection(): DatasetSummaryProjection {
  assertSqliteBackendForDatasetSummary("getDatasetSummaryProjection");
  const db = getDb();
  const row = db
    .prepare(
      `SELECT summary_json, metadata_json, generation
         FROM dataset_summary_projection
        WHERE projection_key = ?`
    )
    .get<DatasetSummaryProjectionRow>(GLOBAL_KEY);

  if (!row) {
    const at = nowIso();
    return {
      ...EMPTY_SUMMARY,
      generation: 0,
      metadata: {
        computed_at: null,
        last_error: null,
        rebuild_status: "running",
        source_high_watermark: null,
        stale_since: at,
        state: "rebuilding",
      },
    };
  }

  const summary = parseJson<DatasetSummary>(row.summary_json, EMPTY_SUMMARY);
  const metadata = parseJson<ProjectionMetadata | null>(row.metadata_json, null);
  const generation = Number(row.generation || 0);
  if (metadata === null) {
    return {
      ...summary,
      generation,
      metadata: {
        computed_at: null,
        last_error: "dataset summary projection metadata is unreadable",
        rebuild_status: "failed",
        source_high_watermark: null,
        stale_since: nowIso(),
        state: "failed",
      },
    };
  }

  return { ...summary, generation, metadata };
}

export function applyDatasetSummaryRecordDelta(delta: DatasetSummaryRecordDelta): void {
  assertSqliteBackendForDatasetSummary("applyDatasetSummaryRecordDelta");
  try {
    maybeProjectionFault("before-record-delta", delta);
    const db = getDb();
    const current = reclaimExpiredRebuildLease(getDatasetSummaryProjection());

    // Fence against an in-flight rebuild BEFORE the "has been rebuilt"
    // guard. During a first-ever rebuild, computed_at is still null and
    // rebuild_status is 'running'; the rebuild itself is what will
    // populate the projection. Treating a concurrent delta as a hard
    // "not rebuilt" failure in that window would mark the projection
    // failed instead of stale/deferred, even though the right outcome
    // is to leave the rebuild to win or detect the conflict via its
    // generation guard. A "running" status past its lease timeout has
    // already been reclaimed above and no longer reaches this branch.
    if (isRebuildLeaseActive(current.metadata)) {
      markDatasetSummaryProjectionStale("record delta arrived during projection rebuild");
      return;
    }
    assertDeltaCanUseStreamProjection(current);

    const existingStream = getStreamProjection(delta.connectorId, delta.stream);
    const previousRecordCount = existingStream?.record_count || 0;
    const nextRecordCount = Math.max(0, previousRecordCount + delta.recordCountDelta);
    const previousRecordJsonBytes = existingStream?.record_json_bytes || 0;
    const nextRecordJsonBytes = Math.max(0, previousRecordJsonBytes + delta.recordJsonBytesDelta);
    const earliestIngestedAt = minIso(existingStream?.earliest_ingested_at || null, delta.emittedAt);
    const latestIngestedAt = maxIso(existingStream?.latest_ingested_at || null, delta.emittedAt);
    const consentTimeField = existingStream?.consent_time_field || delta.consentTimeField || null;
    const dirtyRecordTimeBounds =
      Number(existingStream?.dirty_record_time_bounds || 0) || (consentTimeField && delta.dirtyRecordTimeBounds)
        ? 1
        : 0;
    const computedAt = nowIso();

    db.prepare(
      `INSERT INTO dataset_summary_stream_projection(
         connector_id,
         stream,
         record_count,
         record_json_bytes,
         earliest_ingested_at,
         latest_ingested_at,
         consent_time_field,
         dirty_record_time_bounds,
         computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(connector_id, stream) DO UPDATE SET
         record_count = excluded.record_count,
         record_json_bytes = excluded.record_json_bytes,
         earliest_ingested_at = excluded.earliest_ingested_at,
         latest_ingested_at = excluded.latest_ingested_at,
         consent_time_field = excluded.consent_time_field,
         dirty_record_time_bounds = excluded.dirty_record_time_bounds,
         computed_at = excluded.computed_at`
    ).run(
      delta.connectorId,
      delta.stream,
      nextRecordCount,
      nextRecordJsonBytes,
      earliestIngestedAt,
      latestIngestedAt,
      consentTimeField,
      dirtyRecordTimeBounds,
      computedAt
    );

    const summary = buildSummaryAfterDelta(current, {
      blobBytesDelta: 0,
      dirtyRecordTimeBounds,
      recordChangesJsonBytesDelta: delta.recordChangesJsonBytesDelta,
      recordJsonBytesDelta: delta.recordJsonBytesDelta,
    });
    writeDatasetSummaryProjection(
      summary,
      metadataAfterDelta(current, computedAt, dirtyRecordTimeBounds !== 0),
      computedAt
    );
  } catch (err) {
    markDatasetSummaryProjectionFailed(err);
  }
}

export function applyDatasetSummaryBlobDelta(delta: DatasetSummaryBlobDelta): void {
  assertSqliteBackendForDatasetSummary("applyDatasetSummaryBlobDelta");
  try {
    maybeProjectionFault("before-blob-delta", delta);
    const current = reclaimExpiredRebuildLease(getDatasetSummaryProjection());
    // Fence against an in-flight rebuild BEFORE the "has been rebuilt"
    // guard. Same reasoning as applyDatasetSummaryRecordDelta: during a
    // first-ever rebuild, computed_at is null and rebuild_status is
    // 'running', so the rebuild itself populates the projection. The
    // honest signal for a concurrent blob delta is stale/deferred, not
    // failed. A "running" status past its lease timeout has already been
    // reclaimed above and no longer reaches this branch.
    if (isRebuildLeaseActive(current.metadata)) {
      markDatasetSummaryProjectionStale("blob delta arrived during projection rebuild");
      return;
    }
    if (!current.metadata.computed_at) {
      throw new Error("dataset summary projection has not been rebuilt");
    }
    const computedAt = nowIso();
    const summary = buildSummaryAfterDelta(current, {
      blobBytesDelta: delta.blobBytesDelta,
      dirtyRecordTimeBounds: false,
      recordChangesJsonBytesDelta: 0,
      recordJsonBytesDelta: 0,
    });
    writeDatasetSummaryProjection(summary, metadataAfterDelta(current, computedAt, false), computedAt);
  } catch (err) {
    markDatasetSummaryProjectionFailed(err);
  }
}

export function markDatasetSummaryProjectionStale(reason: string): void {
  assertSqliteBackendForDatasetSummary("markDatasetSummaryProjectionStale");
  try {
    const current = getDatasetSummaryProjection();
    const staleAt = nowIso();
    writeDatasetSummaryProjection(
      {
        counts: current.counts,
        ingested_time_bounds: current.ingested_time_bounds,
        record_time_bounds: current.record_time_bounds,
        retained_bytes: current.retained_bytes,
        top_connector_candidates: current.top_connector_candidates,
      },
      {
        computed_at: current.metadata.computed_at,
        last_error:
          current.metadata.last_error || sanitizeProjectionError(reason || "dataset summary projection is stale"),
        rebuild_status: current.metadata.rebuild_status || "idle",
        source_high_watermark: current.metadata.source_high_watermark || null,
        stale_since: current.metadata.stale_since || staleAt,
        state: current.metadata.state === "failed" ? "failed" : "stale",
      },
      staleAt
    );
  } catch {
    // Projection maintenance is derived-state bookkeeping; a stale marker
    // failure must not retroactively make a canonical bulk delete fail.
  }
}

// A single rebuild pass reads dependencies (counts, bytes, candidates,
// stream seeds) and then commits under a generation guard. On a
// continuously-collecting instance, a delta can land in the gap between
// "read dependencies" and "commit" on every single attempt -- a rebuild
// that only tries once therefore never converges; that is the mechanism
// behind the owner's stuck projection (rebuild_status stuck at 'running',
// computed_at null, stream projection empty). Retrying re-reads fresh
// dependencies each time, so every attempt reflects real current state --
// this is not fabricating convergence, it is giving the rebuild enough
// attempts to catch a quiet moment the way any CAS-based writer must.
const MAX_REBUILD_ATTEMPTS = 8;

export async function rebuildDatasetSummaryProjection(
  dependencies: RebuildDatasetSummaryDependencies,
  { signal }: { signal?: AbortSignal } = {}
): Promise<DatasetSummaryProjection | (DatasetSummary & { metadata: ProjectionMetadata })> {
  assertSqliteBackendForDatasetSummary("rebuildDatasetSummaryProjection");
  const startedAt = nowIso();

  try {
    for (let attempt = 1; attempt <= MAX_REBUILD_ATTEMPTS; attempt += 1) {
      throwIfAborted(signal);
      // biome-ignore lint/performance/noAwaitInLoops: Work is intentionally sequential to preserve ordering and state transitions.
      const result = await attemptDatasetSummaryRebuild(dependencies, startedAt, signal);
      if (result.committed) {
        return result.value;
      }
      // A concurrent delta or competing rebuild advanced the generation
      // past this attempt's expected value. Loop back and try again with
      // freshly re-read dependencies rather than accepting the loss --
      // sustained writes must not be able to starve every attempt
      // indefinitely just by outrunning a single pass.
    }
    // Exhausted every attempt without a clean commit: honest behavior is
    // to leave the projection explicitly stale, not to claim freshness
    // from values that no longer match the live tables.
    const conflictAt = nowIso();
    const after = getDatasetSummaryProjection();
    writeDatasetSummaryProjectionPreservingSummary(after, supersededRebuildMetadata(after, conflictAt), conflictAt);
    return getDatasetSummaryProjection();
  } catch (err) {
    const endedAt = nowIso();
    const current = getDatasetSummaryProjection();
    writeDatasetSummaryProjectionPreservingSummary(current, rebuildFailureMetadata(current, err, startedAt), endedAt);
    throw err;
  }
}

async function attemptDatasetSummaryRebuild(
  dependencies: RebuildDatasetSummaryDependencies,
  startedAt: IsoTimestamp,
  signal: AbortSignal | undefined
): Promise<
  { committed: true; value: DatasetSummary & { metadata: ProjectionMetadata } } | { committed: false; value: null }
> {
  // Advance generation and stamp rebuild_status='running'. Capture the
  // post-advance generation so this attempt's commit can detect a
  // concurrent delta or competing rebuild that bumped the counter
  // further.
  const rebuildGeneration = markDatasetSummaryProjectionRebuilding(startedAt);

  throwIfAborted(signal);
  const [counts, bytes, candidates] = await Promise.all([
    dependencies.getCounts(),
    dependencies.getRetainedBytes(),
    dependencies.listTopConnectorCandidates(),
  ]);
  throwIfAborted(signal);
  const recordCount = Number(counts.record_count || 0);
  const [recordTimeBounds, ingestedTimeBounds] =
    recordCount > 0
      ? await Promise.all([dependencies.getRecordTimeBounds(), dependencies.getIngestedTimeBounds()])
      : [
          { earliest: null, latest: null },
          { earliest: null, latest: null },
        ];
  throwIfAborted(signal);

  const computedAt = nowIso();
  const summary = {
    counts,
    ingested_time_bounds: ingestedTimeBounds,
    record_time_bounds: recordTimeBounds,
    retained_bytes: bytes,
    top_connector_candidates: boundedTopConnectorCandidates(candidates),
  };
  const metadata = {
    computed_at: computedAt,
    last_error: null,
    rebuild_status: "idle",
    source_high_watermark: `rebuilt:${computedAt}`,
    stale_since: null,
    state: "fresh",
  };
  const seeds = dependencies.listStreamProjectionSeeds ? await dependencies.listStreamProjectionSeeds() : [];
  throwIfAborted(signal);
  const committed = writeDatasetSummaryProjectionWithStreamSeedsGuarded(
    summary,
    metadata,
    computedAt,
    seeds,
    rebuildGeneration
  );
  if (!committed) {
    return { committed: false, value: null };
  }
  return { committed: true, value: { ...summary, metadata } };
}

// Metadata for a rebuild whose guarded commit lost the generation race:
// keep the last-known freshness and record why the rebuild's fresh values
// were discarded.
function supersededRebuildMetadata(after: DatasetSummaryProjection, conflictAt: IsoTimestamp): ProjectionMetadata {
  return {
    computed_at: after.metadata.computed_at,
    last_error: after.metadata.last_error || "dataset summary projection rebuild superseded by concurrent delta",
    rebuild_status: "idle",
    source_high_watermark: after.metadata.source_high_watermark || null,
    stale_since: after.metadata.stale_since || conflictAt,
    state: after.metadata.state === "failed" ? "failed" : "stale",
  };
}

// Metadata for a rebuild that threw. Cancellation is non-destructive:
// canonical evidence is untouched and the last-known projection rows
// survive, so an abort keeps the prior freshness and marks the projection
// stale (not failed) while reporting honestly that the rebuild did not
// complete. Any other error is a genuine failure.
function rebuildFailureMetadata(
  current: DatasetSummaryProjection,
  err: unknown,
  startedAt: IsoTimestamp
): ProjectionMetadata {
  if (isAbortError(err)) {
    return {
      computed_at: current.metadata.computed_at,
      last_error:
        current.metadata.last_error ||
        sanitizeProjectionError(
          err instanceof Error ? err.message || "dataset summary projection rebuild cancelled" : err
        ),
      rebuild_status: "idle",
      source_high_watermark: current.metadata.source_high_watermark || null,
      stale_since: current.metadata.stale_since || startedAt,
      state: current.metadata.state === "failed" ? "failed" : "stale",
    };
  }
  return {
    computed_at: current.metadata.computed_at,
    last_error: sanitizeProjectionError(err),
    rebuild_status: "failed",
    source_high_watermark: current.metadata.source_high_watermark || null,
    stale_since: current.metadata.stale_since || startedAt,
    state: "failed",
  };
}

// Auto-heal throttling. Process-local, not persisted -- a restart resets
// both counters, which is the right default: a fresh process deserves a
// fresh attempt rather than inheriting a failure streak from a build that
// may no longer apply (new code, new data, or the underlying cause fixed
// out of band). This mirrors the existing retained-size auto-reconcile
// throttle in server/routes/ref-dataset.ts (same shape, applied to the
// SQLite dataset-summary rebuild instead of the Postgres reconcile).
//
// Two bounds, not one:
//   - A floor between attempts (cooldown) so a hot read path (every GET
//     /_ref/dataset/summary) cannot fire a 456k-record table scan on every
//     request while a rebuild is legitimately in flight or just failed.
//   - A cap on CONSECUTIVE failures so a rebuild that fails for a durable
//     reason (corrupt data, disk full, a bug) does not retry forever and
//     burn CPU on every read. Once the cap is hit, auto-heal stops trying
//     and the projection stays honestly "failed" until an owner acts
//     (manual rebuild via the console action clears the counter by
//     succeeding, or the process restarts).
const DATASET_SUMMARY_AUTO_HEAL_COOLDOWN_MS = 30_000;
const DATASET_SUMMARY_AUTO_HEAL_MAX_CONSECUTIVE_FAILURES = 5;

let datasetSummaryAutoHealRetryAfterMs = 0;
let datasetSummaryAutoHealConsecutiveFailures = 0;
let datasetSummaryAutoHealNow = () => Date.now();

export function __resetDatasetSummaryAutoHealThrottleForTest(): void {
  datasetSummaryAutoHealRetryAfterMs = 0;
  datasetSummaryAutoHealConsecutiveFailures = 0;
  datasetSummaryAutoHealNow = () => Date.now();
}

export function __setDatasetSummaryAutoHealNowForTest(now: () => number): void {
  datasetSummaryAutoHealNow = now;
}

function datasetSummaryAutoHealInCooldown(): boolean {
  return datasetSummaryAutoHealNow() < datasetSummaryAutoHealRetryAfterMs;
}

function datasetSummaryAutoHealExhausted(): boolean {
  return datasetSummaryAutoHealConsecutiveFailures >= DATASET_SUMMARY_AUTO_HEAL_MAX_CONSECUTIVE_FAILURES;
}

function noteDatasetSummaryAutoHealFailure(): void {
  datasetSummaryAutoHealConsecutiveFailures += 1;
  datasetSummaryAutoHealRetryAfterMs = datasetSummaryAutoHealNow() + DATASET_SUMMARY_AUTO_HEAL_COOLDOWN_MS;
}

function noteDatasetSummaryAutoHealSuccess(): void {
  datasetSummaryAutoHealConsecutiveFailures = 0;
  datasetSummaryAutoHealRetryAfterMs = 0;
}

// A projection needs auto-heal when it has never converged (`computed_at`
// null) or when a prior rebuild left it in the terminal `failed` state --
// both are the "honestly unknown, and nothing is going to fix that on its
// own" states the owner's stuck instance was in. `stale`/`refreshing` are
// NOT included: those already carry a last-known-good value and either a
// live rebuild lease (refreshing) or a delta-driven staleness that the
// normal delta/reconcile paths already keep moving -- forcing a full
// rebuild there would be exactly the "thrash" the task warns against.
function datasetSummaryProjectionNeedsHeal(projection: DatasetSummaryProjection): boolean {
  return projection.metadata.computed_at === null || projection.metadata.state === "failed";
}

/**
 * Read-path auto-heal: if the projection has never converged, or a prior
 * rebuild landed in the terminal `failed` state, kick off a rebuild using
 * the same bounded-retry `rebuildDatasetSummaryProjection` that already
 * tolerates concurrent deltas -- no second convergence mechanism.
 *
 * This is the fix for "why wouldn't the projection heal automatically":
 * `rebuildDatasetSummaryProjection` had exactly one caller, an
 * owner-authenticated HTTP route with no boot hook, scheduler, or UI
 * affordance. Hanging the trigger off the OWNER'S OWN READ of the summary
 * (`GET /_ref/dataset/summary`, already called every time the dashboard or
 * deployment page loads) means the projection heals the next time anyone
 * looks at it, without a general-purpose scheduler and without touching
 * the synchronous per-record ingest path (`applyDatasetSummaryRecordDelta`
 * is called from inside every record write in records.js; hanging an
 * async multi-second table scan off that path would block ingestion).
 *
 * Never fabricates convergence: on failure the prior (getDatasetSummaryProjection())
 * value is returned unchanged, `rebuildDatasetSummaryProjection`'s own
 * failure path already stamps `state: 'failed'` honestly, and this
 * function's cooldown/cap only decide WHEN to retry, never what to report.
 */
export async function ensureDatasetSummaryProjectionHealthy(
  dependencies: RebuildDatasetSummaryDependencies
): Promise<DatasetSummaryProjection> {
  assertSqliteBackendForDatasetSummary("ensureDatasetSummaryProjectionHealthy");
  const before = getDatasetSummaryProjection();
  if (!datasetSummaryProjectionNeedsHeal(before)) {
    return before;
  }
  // `before.generation === 0` means no projection row has EVER been
  // written (getDatasetSummaryProjection's `!row` branch) -- the exact
  // shape of a brand-new/never-rebuilt instance. That branch fabricates a
  // `rebuild_status: "running"` / `stale_since: now()` placeholder purely
  // so the summary envelope's shape stays honest ("something must still
  // compute this") -- it is not a real lease left by a concurrent rebuild,
  // since a real rebuild's first write (markDatasetSummaryProjectionRebuilding)
  // always creates the row and bumps generation to 1+. Treating that
  // placeholder as a live lease would permanently defer auto-heal on
  // exactly the case it exists to fix. Only a rebuild with a real
  // persisted row (generation > 0) can hold a live lease.
  if (before.generation > 0 && isRebuildLeaseActive(before.metadata)) {
    // A rebuild (this auto-heal or the owner's manual action) is already
    // in flight. Do not start a second one -- the generation guard inside
    // rebuildDatasetSummaryProjection would just make the loser retry for
    // nothing, and a 456k-record scan is real work worth not duplicating.
    return before;
  }
  if (datasetSummaryAutoHealInCooldown() || datasetSummaryAutoHealExhausted()) {
    return before;
  }
  try {
    const healed = await rebuildDatasetSummaryProjection(dependencies);
    noteDatasetSummaryAutoHealSuccess();
    return healed as DatasetSummaryProjection;
  } catch {
    // rebuildDatasetSummaryProjection already persisted the honest failed
    // metadata; this function only tracks whether to try again on the next
    // read.
    noteDatasetSummaryAutoHealFailure();
    return getDatasetSummaryProjection();
  }
}

export async function reconcileDirtyDatasetSummaryRecordTimeBounds(
  dependencies: ReconcileDatasetSummaryDependencies,
  { signal }: { signal?: AbortSignal } = {}
): Promise<{ reconciled: number; deferred: number; residual: number }> {
  assertSqliteBackendForDatasetSummary("reconcileDirtyDatasetSummaryRecordTimeBounds");
  // Capture each dirty row's current `computed_at` while reading the dirty
  // set. The transactional update below only clears the dirty flag and
  // writes new bounds for rows whose `computed_at` still matches — a
  // concurrent delta that touched the same row will have advanced
  // `computed_at` and re-set `dirty_record_time_bounds`; its work then
  // survives this reconcile pass for the next sweep.
  //
  // The scan is bounded with `LIMIT MAX_RECONCILE_BATCH + 1` so a single
  // pass cannot block on tens of thousands of dirty streams. If the dirty
  // backlog exceeds the batch, the extra row is dropped from the work
  // set, `residual` is reported, and the projection metadata stays stale
  // until the next pass.
  throwIfAborted(signal);
  const scanned = getDb()
    .prepare(
      `SELECT connector_id,
              stream,
              consent_time_field,
              computed_at
         FROM dataset_summary_stream_projection
        WHERE dirty_record_time_bounds <> 0
        ORDER BY connector_id ASC, stream ASC
        LIMIT ?`
    )
    .all(MAX_RECONCILE_BATCH + 1) as DatasetSummaryStreamRow[];
  const residual = scanned.length > MAX_RECONCILE_BATCH;
  const dirtyRows = residual ? scanned.slice(0, MAX_RECONCILE_BATCH) : scanned;
  if (dirtyRows.length === 0) {
    return { deferred: 0, reconciled: 0, residual: 0 };
  }

  const computedAt = nowIso();
  let deferred = 0;
  const repairedRows: RepairedStreamRow[] = [];

  await runSequentially(dirtyRows, async (row) => {
    throwIfAborted(signal);
    if (!hasDeclaredConsentTimeField(row.consent_time_field)) {
      deferred += 1;
      return;
    }

    let bounds: TimeBounds | null | undefined;
    try {
      bounds = await dependencies.getStreamRecordTimeBounds(row.connector_id, row.stream, row.consent_time_field, {
        signal,
      });
    } catch (err) {
      if (isAbortError(err)) {
        // Cancellation must not destabilize either canonical evidence
        // or the projection. Leave the dirty rows dirty for the next
        // pass and mark the projection stale (not failed) so the
        // operator surface keeps last-known values honestly.
        markDatasetSummaryProjectionStale(
          err instanceof Error
            ? err.message || "dataset summary projection reconcile cancelled"
            : "dataset summary projection reconcile cancelled"
        );
        throw err;
      }
      markDatasetSummaryProjectionFailed(err);
      throw err;
    }
    repairedRows.push({
      captured_computed_at: row.computed_at || null,
      connector_id: row.connector_id,
      earliest_record_time: bounds?.earliest || null,
      latest_record_time: bounds?.latest || null,
      stream: row.stream,
    });
  });

  const { deferred: finalDeferred, reconciled } = commitReconciledDatasetSummaryRows(
    repairedRows,
    computedAt,
    deferred
  );

  // `residual` is the contract for callers to schedule another pass.
  // When > 0 the projection's `stillDirty` branch above already keeps
  // metadata stale, so the report is consistent with what
  // `getDatasetSummaryProjection()` will say.
  return { deferred: finalDeferred, reconciled, residual: residual ? 1 : 0 };
}

function commitReconciledDatasetSummaryRows(
  repairedRows: readonly RepairedStreamRow[],
  computedAt: IsoTimestamp,
  deferred: number
): { deferred: number; reconciled: number } {
  let updated = { deferred: 0, reconciled: 0 };
  getDb().transaction(() => {
    updated = updateReconciledStreamRows(repairedRows, computedAt);

    const current = getDatasetSummaryProjection();
    const recordTimeBounds = getGlobalRecordTimeBoundsFromStreams();
    const stillDirty = hasDirtyRecordTimeBounds();
    const summary: DatasetSummary = {
      counts: current.counts,
      ingested_time_bounds: current.ingested_time_bounds,
      record_time_bounds: reconciledRecordTimeBounds(current, recordTimeBounds, stillDirty),
      retained_bytes: current.retained_bytes,
      top_connector_candidates: current.top_connector_candidates,
    };
    const metadata: ProjectionMetadata = stillDirty
      ? {
          computed_at: computedAt,
          last_error: current.metadata.last_error || "dirty record-time bounds could not be safely reconciled",
          rebuild_status: current.metadata.rebuild_status === "running" ? "running" : "idle",
          source_high_watermark: `reconcile:${computedAt}`,
          stale_since: current.metadata.stale_since || computedAt,
          state: "stale",
        }
      : {
          computed_at: computedAt,
          last_error: current.metadata.state === "failed" ? current.metadata.last_error : null,
          rebuild_status: current.metadata.state === "failed" ? current.metadata.rebuild_status : "idle",
          source_high_watermark: `reconcile:${computedAt}`,
          stale_since: current.metadata.state === "failed" ? current.metadata.stale_since : null,
          state: current.metadata.state === "failed" ? "failed" : "fresh",
        };
    writeDatasetSummaryProjection(summary, metadata, computedAt);
  })();
  return { deferred: deferred + updated.deferred, reconciled: updated.reconciled };
}

function updateReconciledStreamRows(
  repairedRows: readonly RepairedStreamRow[],
  computedAt: IsoTimestamp
): { deferred: number; reconciled: number } {
  const updateStream = getDb().prepare(
    `UPDATE dataset_summary_stream_projection
        SET earliest_record_time = ?,
            latest_record_time = ?,
            dirty_record_time_bounds = 0,
            computed_at = ?
      WHERE connector_id = ?
        AND stream = ?
        AND dirty_record_time_bounds <> 0
        AND (
          (? IS NULL AND computed_at IS NULL)
          OR computed_at = ?
        )`
  );
  let deferred = 0;
  let reconciled = 0;
  for (const row of repairedRows) {
    const result = updateStream.run(
      row.earliest_record_time,
      row.latest_record_time,
      computedAt,
      row.connector_id,
      row.stream,
      row.captured_computed_at,
      row.captured_computed_at
    );
    const committed = Number(result.changes || 0) > 0;
    reconciled += Number(committed);
    // A row moved between the dirty scan and the transactional update —
    // either a concurrent delta touched it, or another reconcile pass
    // already cleared it. Either way, leaving the dirty bit alone is
    // safe; the next reconcile pass will pick it up if still needed.
    deferred += Number(!committed);
  }
  return { deferred, reconciled };
}

function reconciledRecordTimeBounds(
  current: DatasetSummaryProjection,
  recordTimeBounds: TimeBounds,
  stillDirty: boolean
): TimeBounds {
  return stillDirty ? current.record_time_bounds : recordTimeBounds;
}

function maybeProjectionFault(point: string, ctx: unknown): void {
  if (projectionFaultHook) {
    projectionFaultHook(point, ctx);
  }
}

function getStreamProjection(connectorId: string, stream: string): DatasetSummaryStreamRow | undefined {
  return getDb()
    .prepare(
      `SELECT record_count,
              record_json_bytes,
              earliest_ingested_at,
              latest_ingested_at,
              consent_time_field,
              dirty_record_time_bounds
         FROM dataset_summary_stream_projection
        WHERE connector_id = ? AND stream = ?`
    )
    .get(connectorId, stream) as DatasetSummaryStreamRow | undefined;
}

function assertDeltaCanUseStreamProjection(current: DatasetSummaryProjection): void {
  if (!current.metadata.computed_at) {
    throw new Error("dataset summary projection has not been rebuilt");
  }
  const streamProjectionCount =
    getDb().prepare("SELECT COUNT(*) AS count FROM dataset_summary_stream_projection").get()?.count || 0;
  if (Number(current.counts.record_count || 0) > 0 && Number(streamProjectionCount || 0) === 0) {
    throw new Error("dataset summary stream projection is missing for non-empty summary");
  }
}

function buildSummaryAfterDelta(
  current: DatasetSummaryProjection,
  delta: Pick<DatasetSummaryRecordDelta, "recordJsonBytesDelta" | "recordChangesJsonBytesDelta"> &
    DatasetSummaryBlobDelta & { dirtyRecordTimeBounds: boolean | number }
): DatasetSummary {
  const streamRows = getDb()
    .prepare(
      `SELECT connector_id,
              SUM(record_count) AS record_count,
              MIN(CASE WHEN record_count > 0 THEN earliest_ingested_at END) AS earliest_ingested_at,
              MAX(CASE WHEN record_count > 0 THEN latest_ingested_at END) AS latest_ingested_at,
              MAX(dirty_record_time_bounds) AS dirty_record_time_bounds
         FROM dataset_summary_stream_projection
        WHERE record_count > 0
        GROUP BY connector_id
        ORDER BY record_count DESC, connector_id ASC`
    )
    .all<ConnectorDatasetSummaryRow>();
  const recordCount = streamRows.reduce((sum, row) => sum + Number(row.record_count || 0), 0);
  const streamCount =
    getDb()
      .prepare(
        `SELECT COUNT(*) AS stream_count
         FROM dataset_summary_stream_projection
        WHERE record_count > 0`
      )
      .get()?.stream_count || 0;
  const earliestIngestedAt = minIsoFromRows(streamRows, "earliest_ingested_at");
  const latestIngestedAt = maxIsoFromRows(streamRows, "latest_ingested_at");
  return {
    counts: {
      connector_count: streamRows.length,
      record_count: recordCount,
      stream_count: Number(streamCount || 0),
    },
    ingested_time_bounds: {
      earliest: earliestIngestedAt,
      latest: latestIngestedAt,
    },
    record_time_bounds: current.record_time_bounds,
    retained_bytes: {
      blob_bytes: Math.max(0, Number(current.retained_bytes.blob_bytes || 0) + delta.blobBytesDelta),
      record_changes_json_bytes: Math.max(
        0,
        Number(current.retained_bytes.record_changes_json_bytes || 0) + delta.recordChangesJsonBytesDelta
      ),
      record_json_bytes: Math.max(
        0,
        Number(current.retained_bytes.record_json_bytes || 0) + delta.recordJsonBytesDelta
      ),
    },
    top_connector_candidates: boundedTopConnectorCandidates(
      streamRows.map((row) => ({
        connector_id: row.connector_id,
        record_count: Number(row.record_count || 0),
      }))
    ),
  };
}

function metadataAfterDelta(
  current: DatasetSummaryProjection,
  computedAt: IsoTimestamp,
  dirtyRecordTimeBounds = false
): ProjectionMetadata {
  if (current.metadata.state === "failed") {
    return {
      computed_at: current.metadata.computed_at,
      last_error: current.metadata.last_error,
      rebuild_status: current.metadata.rebuild_status || "failed",
      source_high_watermark: current.metadata.source_high_watermark || null,
      stale_since: current.metadata.stale_since || computedAt,
      state: "failed",
    };
  }
  if (current.metadata.state === "stale" || dirtyRecordTimeBounds) {
    return {
      computed_at: computedAt,
      last_error: current.metadata.last_error,
      rebuild_status: current.metadata.rebuild_status === "running" ? "running" : "idle",
      source_high_watermark: `delta:${computedAt}`,
      stale_since: current.metadata.stale_since || computedAt,
      state: "stale",
    };
  }
  return {
    computed_at: computedAt,
    last_error: null,
    rebuild_status: "idle",
    source_high_watermark: `delta:${computedAt}`,
    stale_since: null,
    state: "fresh",
  };
}

function replaceStreamProjections(
  rows: readonly DatasetSummaryStreamSeed[],
  computedAt: IsoTimestamp,
  db = getDb()
): void {
  db.prepare("DELETE FROM dataset_summary_stream_projection").run();
  const insert = db.prepare(
    `INSERT INTO dataset_summary_stream_projection(
       connector_id,
       stream,
       record_count,
       record_json_bytes,
       earliest_ingested_at,
       latest_ingested_at,
       earliest_record_time,
       latest_record_time,
       consent_time_field,
       dirty_record_time_bounds,
       computed_at
     )
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of rows) {
    insert.run(
      row.connector_id,
      row.stream,
      Number(row.record_count || 0),
      Number(row.record_json_bytes || 0),
      row.earliest_ingested_at || null,
      row.latest_ingested_at || null,
      row.earliest_record_time || null,
      row.latest_record_time || null,
      row.consent_time_field || null,
      Number(row.dirty_record_time_bounds || 0),
      computedAt
    );
  }
}

function writeDatasetSummaryProjectionWithStreamSeedsGuarded(
  summary: DatasetSummary,
  metadata: ProjectionMetadata,
  updatedAt: IsoTimestamp,
  streamRows: readonly DatasetSummaryStreamSeed[],
  expectedGeneration: number
): boolean {
  let committed = false;
  getDb().transaction(() => {
    const row = getDb()
      .prepare("SELECT generation FROM dataset_summary_projection WHERE projection_key = ?")
      .get(GLOBAL_KEY);
    const currentGeneration = Number(row?.generation || 0);
    if (currentGeneration !== expectedGeneration) {
      return;
    }
    replaceStreamProjections(streamRows, updatedAt);
    writeDatasetSummaryProjection(summary, metadata, updatedAt);
    committed = true;
  })();
  return committed;
}

function markDatasetSummaryProjectionFailed(err: unknown): void {
  const failedAt = nowIso();
  const current = getDatasetSummaryProjection();
  const metadata = {
    computed_at: current.metadata.computed_at,
    last_error: sanitizeProjectionError(err),
    rebuild_status: "failed",
    source_high_watermark: current.metadata.source_high_watermark || null,
    stale_since: current.metadata.stale_since || failedAt,
    state: "failed",
  };
  writeDatasetSummaryProjection(
    {
      counts: current.counts,
      ingested_time_bounds: current.ingested_time_bounds,
      record_time_bounds: current.record_time_bounds,
      retained_bytes: current.retained_bytes,
      top_connector_candidates: current.top_connector_candidates,
    },
    metadata,
    failedAt
  );
}

function minIso(a: IsoTimestamp | null, b: IsoTimestamp | null): IsoTimestamp | null {
  if (!a) {
    return b || null;
  }
  if (!b) {
    return a;
  }
  return a < b ? a : b;
}

function maxIso(a: IsoTimestamp | null, b: IsoTimestamp | null): IsoTimestamp | null {
  if (!a) {
    return b || null;
  }
  if (!b) {
    return a;
  }
  return a > b ? a : b;
}

function minIsoFromRows(
  rows: readonly Pick<DatasetSummaryStreamRow, "earliest_ingested_at">[],
  field: "earliest_ingested_at"
): IsoTimestamp | null {
  return rows.reduce<IsoTimestamp | null>((min, row) => minIso(min, row[field] || null), null);
}

function maxIsoFromRows(
  rows: readonly Pick<DatasetSummaryStreamRow, "latest_ingested_at">[],
  field: "latest_ingested_at"
): IsoTimestamp | null {
  return rows.reduce<IsoTimestamp | null>((max, row) => maxIso(max, row[field] || null), null);
}

function getGlobalRecordTimeBoundsFromStreams() {
  const row = getDb()
    .prepare(
      `SELECT MIN(CASE WHEN record_count > 0 THEN earliest_record_time END) AS earliest,
              MAX(CASE WHEN record_count > 0 THEN latest_record_time END) AS latest
         FROM dataset_summary_stream_projection
        WHERE record_count > 0
          AND consent_time_field IS NOT NULL
          AND dirty_record_time_bounds = 0`
    )
    .get();
  return {
    earliest: typeof row?.earliest === "string" ? row.earliest : null,
    latest: typeof row?.latest === "string" ? row.latest : null,
  };
}

function hasDirtyRecordTimeBounds() {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
         FROM dataset_summary_stream_projection
        WHERE dirty_record_time_bounds <> 0`
    )
    .get();
  return Number(row?.count || 0) > 0;
}

function hasDeclaredConsentTimeField(field: unknown): field is string {
  return typeof field === "string" && field.length > 0;
}

function markDatasetSummaryProjectionRebuilding(at: IsoTimestamp): number {
  const current = getDatasetSummaryProjection();
  return writeDatasetSummaryProjection(
    {
      counts: current.counts,
      ingested_time_bounds: current.ingested_time_bounds,
      record_time_bounds: current.record_time_bounds,
      retained_bytes: current.retained_bytes,
      top_connector_candidates: current.top_connector_candidates,
    },
    {
      computed_at: current.metadata.computed_at,
      last_error: null,
      rebuild_status: "running",
      source_high_watermark: current.metadata.source_high_watermark || null,
      stale_since: current.metadata.stale_since || at,
      state: current.metadata.computed_at ? "refreshing" : "rebuilding",
    },
    at
  );
}

// Write new metadata while carrying the projection's last-known summary
// fields through unchanged. This is the "preserve the last-known summary,
// overwrite only the metadata" shape shared by the stale/superseded/failed
// paths, which must not resurrect stale computed values yet must keep the
// operator surface showing the prior freshness. `projection` is an
// already-read projection object (as returned by
// getDatasetSummaryProjection); only its summary fields are read here.
function writeDatasetSummaryProjectionPreservingSummary(
  projection: DatasetSummaryProjection,
  metadata: ProjectionMetadata,
  updatedAt: IsoTimestamp
): number {
  return writeDatasetSummaryProjection(
    {
      counts: projection.counts,
      ingested_time_bounds: projection.ingested_time_bounds,
      record_time_bounds: projection.record_time_bounds,
      retained_bytes: projection.retained_bytes,
      top_connector_candidates: projection.top_connector_candidates,
    },
    metadata,
    updatedAt
  );
}

function writeDatasetSummaryProjection(
  summary: DatasetSummary,
  metadata: ProjectionMetadata,
  updatedAt: IsoTimestamp
): number {
  // Every projection write bumps the generation. Returns the post-write
  // generation so callers (notably rebuild) can capture an "expected
  // generation" they will later guard their final commit against.
  const row = getDb()
    .prepare("SELECT generation FROM dataset_summary_projection WHERE projection_key = ?")
    .get(GLOBAL_KEY);
  const nextGeneration = Number(row?.generation || 0) + 1;
  getDb()
    .prepare(
      `INSERT INTO dataset_summary_projection(
         projection_key,
         summary_json,
         metadata_json,
         updated_at,
         generation
       )
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(projection_key) DO UPDATE SET
         summary_json = excluded.summary_json,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at,
         generation = excluded.generation`
    )
    .run(GLOBAL_KEY, JSON.stringify(summary), JSON.stringify(metadata), updatedAt, nextGeneration);
  return nextGeneration;
}

interface ConnectorDatasetSummaryRow {
  connector_id: string;
  dirty_record_time_bounds: number | boolean | null;
  earliest_ingested_at: IsoTimestamp | null;
  latest_ingested_at: IsoTimestamp | null;
  record_count: number | null;
}

interface DatasetSummaryProjectionRow {
  generation: number | null;
  metadata_json: string;
  summary_json: string;
}
