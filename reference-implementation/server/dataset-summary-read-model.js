import { getDb } from './db.js';

const GLOBAL_KEY = 'global';
const EMPTY_SUMMARY = Object.freeze({
  counts: { connector_count: 0, stream_count: 0, record_count: 0 },
  retained_bytes: {
    record_json_bytes: 0,
    record_changes_json_bytes: 0,
    blob_bytes: 0,
  },
  record_time_bounds: { earliest: null, latest: null },
  ingested_time_bounds: { earliest: null, latest: null },
  top_connector_candidates: [],
});

function nowIso() {
  return new Date().toISOString();
}

function sanitizeProjectionError(err) {
  const message = err instanceof Error ? err.message : String(err || 'unknown error');
  return message.replace(/[A-Za-z0-9+/=_-]{32,}/g, '[redacted]').slice(0, 240);
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

let projectionFaultHook = null;

export function __setDatasetSummaryProjectionFaultHookForTest(hook) {
  projectionFaultHook = typeof hook === 'function' ? hook : null;
}

export function getDatasetSummaryProjection() {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT summary_json, metadata_json, generation
         FROM dataset_summary_projection
        WHERE projection_key = ?`,
    )
    .get(GLOBAL_KEY);

  if (!row) {
    const at = nowIso();
    return {
      ...EMPTY_SUMMARY,
      metadata: {
        computed_at: null,
        state: 'rebuilding',
        stale_since: at,
        rebuild_status: 'running',
        last_error: null,
        source_high_watermark: null,
      },
      generation: 0,
    };
  }

  const summary = parseJson(row.summary_json, EMPTY_SUMMARY);
  const metadata = parseJson(row.metadata_json, null);
  const generation = Number(row.generation || 0);
  if (!metadata) {
    return {
      ...summary,
      metadata: {
        computed_at: null,
        state: 'failed',
        stale_since: nowIso(),
        rebuild_status: 'failed',
        last_error: 'dataset summary projection metadata is unreadable',
        source_high_watermark: null,
      },
      generation,
    };
  }

  return { ...summary, metadata, generation };
}

export function applyDatasetSummaryRecordDelta(delta) {
  try {
    maybeProjectionFault('before-record-delta', delta);
    const db = getDb();
    const current = getDatasetSummaryProjection();

    // Fence against an in-flight rebuild BEFORE the "has been rebuilt"
    // guard. During a first-ever rebuild, computed_at is still null and
    // rebuild_status is 'running'; the rebuild itself is what will
    // populate the projection. Treating a concurrent delta as a hard
    // "not rebuilt" failure in that window would mark the projection
    // failed instead of stale/deferred, even though the right outcome
    // is to leave the rebuild to win or detect the conflict via its
    // generation guard.
    if (current.metadata.rebuild_status === 'running') {
      markDatasetSummaryProjectionStale('record delta arrived during projection rebuild');
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
         computed_at = excluded.computed_at`,
    ).run(
      delta.connectorId,
      delta.stream,
      nextRecordCount,
      nextRecordJsonBytes,
      earliestIngestedAt,
      latestIngestedAt,
      consentTimeField,
      dirtyRecordTimeBounds,
      computedAt,
    );

    const summary = buildSummaryAfterDelta(current, {
      recordJsonBytesDelta: delta.recordJsonBytesDelta,
      recordChangesJsonBytesDelta: delta.recordChangesJsonBytesDelta,
      blobBytesDelta: 0,
      dirtyRecordTimeBounds,
    });
    writeDatasetSummaryProjection(summary, metadataAfterDelta(current, computedAt, dirtyRecordTimeBounds), computedAt);
  } catch (err) {
    markDatasetSummaryProjectionFailed(err);
  }
}

export function applyDatasetSummaryBlobDelta(delta) {
  try {
    maybeProjectionFault('before-blob-delta', delta);
    const current = getDatasetSummaryProjection();
    // Fence against an in-flight rebuild BEFORE the "has been rebuilt"
    // guard. Same reasoning as applyDatasetSummaryRecordDelta: during a
    // first-ever rebuild, computed_at is null and rebuild_status is
    // 'running', so the rebuild itself populates the projection. The
    // honest signal for a concurrent blob delta is stale/deferred, not
    // failed.
    if (current.metadata.rebuild_status === 'running') {
      markDatasetSummaryProjectionStale('blob delta arrived during projection rebuild');
      return;
    }
    if (!current.metadata.computed_at) {
      throw new Error('dataset summary projection has not been rebuilt');
    }
    const computedAt = nowIso();
    const summary = buildSummaryAfterDelta(current, {
      recordJsonBytesDelta: 0,
      recordChangesJsonBytesDelta: 0,
      blobBytesDelta: delta.blobBytesDelta,
      dirtyRecordTimeBounds: false,
    });
    writeDatasetSummaryProjection(summary, metadataAfterDelta(current, computedAt, false), computedAt);
  } catch (err) {
    markDatasetSummaryProjectionFailed(err);
  }
}

export function markDatasetSummaryProjectionStale(reason) {
  try {
    const current = getDatasetSummaryProjection();
    const staleAt = nowIso();
    writeDatasetSummaryProjection(
      {
        counts: current.counts,
        retained_bytes: current.retained_bytes,
        record_time_bounds: current.record_time_bounds,
        ingested_time_bounds: current.ingested_time_bounds,
        top_connector_candidates: current.top_connector_candidates,
      },
      {
        computed_at: current.metadata.computed_at,
        state: current.metadata.state === 'failed' ? 'failed' : 'stale',
        stale_since: current.metadata.stale_since || staleAt,
        rebuild_status: current.metadata.rebuild_status || 'idle',
        last_error: current.metadata.last_error || sanitizeProjectionError(reason || 'dataset summary projection is stale'),
        source_high_watermark: current.metadata.source_high_watermark || null,
      },
      staleAt,
    );
  } catch {
    // Projection maintenance is derived-state bookkeeping; a stale marker
    // failure must not retroactively make a canonical bulk delete fail.
  }
}

export async function rebuildDatasetSummaryProjection(dependencies) {
  const startedAt = nowIso();
  // Advance generation and stamp rebuild_status='running'. Capture the
  // post-advance generation so the final commit can detect a concurrent
  // delta or competing rebuild that bumped the counter further.
  const rebuildGeneration = markDatasetSummaryProjectionRebuilding(startedAt);

  try {
    const [counts, bytes, candidates] = await Promise.all([
      dependencies.getCounts(),
      dependencies.getRetainedBytes(),
      dependencies.listTopConnectorCandidates(),
    ]);
    const recordCount = Number(counts.record_count || 0);
    const [recordTimeBounds, ingestedTimeBounds] =
      recordCount > 0
        ? await Promise.all([
            dependencies.getRecordTimeBounds(),
            dependencies.getIngestedTimeBounds(),
          ])
        : [
            { earliest: null, latest: null },
            { earliest: null, latest: null },
          ];

    const computedAt = nowIso();
    const summary = {
      counts,
      retained_bytes: bytes,
      record_time_bounds: recordTimeBounds,
      ingested_time_bounds: ingestedTimeBounds,
      top_connector_candidates: candidates,
    };
    const metadata = {
      computed_at: computedAt,
      state: 'fresh',
      stale_since: null,
      rebuild_status: 'idle',
      last_error: null,
      source_high_watermark: `rebuilt:${computedAt}`,
    };
    const seeds = dependencies.listStreamProjectionSeeds
      ? await dependencies.listStreamProjectionSeeds()
      : [];
    const committed = writeDatasetSummaryProjectionWithStreamSeedsGuarded(
      summary,
      metadata,
      computedAt,
      seeds,
      rebuildGeneration,
    );
    if (!committed) {
      // A concurrent delta or competing rebuild advanced the generation
      // past rebuildGeneration. Honest behavior is to leave the projection
      // explicitly stale, not to claim freshness from values that no
      // longer match the live tables.
      const conflictAt = nowIso();
      const after = getDatasetSummaryProjection();
      writeDatasetSummaryProjection(
        {
          counts: after.counts,
          retained_bytes: after.retained_bytes,
          record_time_bounds: after.record_time_bounds,
          ingested_time_bounds: after.ingested_time_bounds,
          top_connector_candidates: after.top_connector_candidates,
        },
        {
          computed_at: after.metadata.computed_at,
          state: after.metadata.state === 'failed' ? 'failed' : 'stale',
          stale_since: after.metadata.stale_since || conflictAt,
          rebuild_status: 'idle',
          last_error:
            after.metadata.last_error ||
            'dataset summary projection rebuild superseded by concurrent delta',
          source_high_watermark: after.metadata.source_high_watermark || null,
        },
        conflictAt,
      );
      return getDatasetSummaryProjection();
    }
    return { ...summary, metadata };
  } catch (err) {
    const failedAt = nowIso();
    const current = getDatasetSummaryProjection();
    const metadata = {
      computed_at: current.metadata.computed_at,
      state: 'failed',
      stale_since: current.metadata.stale_since || startedAt,
      rebuild_status: 'failed',
      last_error: sanitizeProjectionError(err),
      source_high_watermark: current.metadata.source_high_watermark || null,
    };
    writeDatasetSummaryProjection(
      {
        counts: current.counts,
        retained_bytes: current.retained_bytes,
        record_time_bounds: current.record_time_bounds,
        ingested_time_bounds: current.ingested_time_bounds,
        top_connector_candidates: current.top_connector_candidates,
      },
      metadata,
      failedAt,
    );
    throw err;
  }
}

export async function reconcileDirtyDatasetSummaryRecordTimeBounds(dependencies) {
  // Capture each dirty row's current `computed_at` while reading the dirty
  // set. The transactional update below only clears the dirty flag and
  // writes new bounds for rows whose `computed_at` still matches — a
  // concurrent delta that touched the same row will have advanced
  // `computed_at` and re-set `dirty_record_time_bounds`; its work then
  // survives this reconcile pass for the next sweep.
  const dirtyRows = getDb()
    .prepare(
      `SELECT connector_id,
              stream,
              consent_time_field,
              computed_at
         FROM dataset_summary_stream_projection
        WHERE dirty_record_time_bounds <> 0
        ORDER BY connector_id ASC, stream ASC`,
    )
    .all();
  if (dirtyRows.length === 0) {
    return { reconciled: 0, deferred: 0 };
  }

  const computedAt = nowIso();
  let deferred = 0;
  const repairedRows = [];

  for (const row of dirtyRows) {
    if (!isSafeConsentTimeField(row.consent_time_field)) {
      deferred += 1;
      continue;
    }

    let bounds;
    try {
      bounds = await dependencies.getStreamRecordTimeBounds(
        row.connector_id,
        row.stream,
        row.consent_time_field,
      );
    } catch (err) {
      markDatasetSummaryProjectionFailed(err);
      throw err;
    }
    repairedRows.push({
      connector_id: row.connector_id,
      stream: row.stream,
      captured_computed_at: row.computed_at || null,
      earliest_record_time: bounds?.earliest || null,
      latest_record_time: bounds?.latest || null,
    });
  }

  let reconciled = 0;
  getDb().transaction(() => {
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
          )`,
    );
    for (const row of repairedRows) {
      const result = updateStream.run(
        row.earliest_record_time,
        row.latest_record_time,
        computedAt,
        row.connector_id,
        row.stream,
        row.captured_computed_at,
        row.captured_computed_at,
      );
      if (Number(result.changes || 0) > 0) {
        reconciled += 1;
      } else {
        // Row moved between the dirty scan and the transactional update —
        // either a concurrent delta touched it, or another reconcile pass
        // already cleared it. Either way, leaving the dirty bit alone is
        // safe; the next reconcile pass will pick it up if still needed.
        deferred += 1;
      }
    }

    const current = getDatasetSummaryProjection();
    const recordTimeBounds = getGlobalRecordTimeBoundsFromStreams();
    const stillDirty = hasDirtyRecordTimeBounds();
    const summary = {
      counts: current.counts,
      retained_bytes: current.retained_bytes,
      record_time_bounds: stillDirty ? current.record_time_bounds : recordTimeBounds,
      ingested_time_bounds: current.ingested_time_bounds,
      top_connector_candidates: current.top_connector_candidates,
    };
    const metadata = stillDirty
      ? {
          computed_at: computedAt,
          state: 'stale',
          stale_since: current.metadata.stale_since || computedAt,
          rebuild_status: current.metadata.rebuild_status === 'running' ? 'running' : 'idle',
          last_error: current.metadata.last_error || 'dirty record-time bounds could not be safely reconciled',
          source_high_watermark: `reconcile:${computedAt}`,
        }
      : {
          computed_at: computedAt,
          state: current.metadata.state === 'failed' ? 'failed' : 'fresh',
          stale_since: current.metadata.state === 'failed' ? current.metadata.stale_since : null,
          rebuild_status: current.metadata.state === 'failed' ? current.metadata.rebuild_status : 'idle',
          last_error: current.metadata.state === 'failed' ? current.metadata.last_error : null,
          source_high_watermark: `reconcile:${computedAt}`,
        };
    writeDatasetSummaryProjection(summary, metadata, computedAt);
  })();

  return { reconciled, deferred };
}

function maybeProjectionFault(point, ctx) {
  if (projectionFaultHook) projectionFaultHook(point, ctx);
}

function getStreamProjection(connectorId, stream) {
  return getDb()
    .prepare(
      `SELECT record_count,
              record_json_bytes,
              earliest_ingested_at,
              latest_ingested_at,
              consent_time_field,
              dirty_record_time_bounds
         FROM dataset_summary_stream_projection
        WHERE connector_id = ? AND stream = ?`,
    )
    .get(connectorId, stream);
}

function assertDeltaCanUseStreamProjection(current) {
  if (!current.metadata.computed_at) {
    throw new Error('dataset summary projection has not been rebuilt');
  }
  const streamProjectionCount = getDb()
    .prepare('SELECT COUNT(*) AS count FROM dataset_summary_stream_projection')
    .get()?.count || 0;
  if (Number(current.counts.record_count || 0) > 0 && Number(streamProjectionCount || 0) === 0) {
    throw new Error('dataset summary stream projection is missing for non-empty summary');
  }
}

function buildSummaryAfterDelta(current, delta) {
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
        ORDER BY record_count DESC, connector_id ASC`,
    )
    .all();
  const recordCount = streamRows.reduce((sum, row) => sum + Number(row.record_count || 0), 0);
  const streamCount = getDb()
    .prepare(
      `SELECT COUNT(*) AS stream_count
         FROM dataset_summary_stream_projection
        WHERE record_count > 0`,
    )
    .get()?.stream_count || 0;
  const earliestIngestedAt = minIsoFromRows(streamRows, 'earliest_ingested_at');
  const latestIngestedAt = maxIsoFromRows(streamRows, 'latest_ingested_at');
  const dirtyRecordTimeBounds = streamRows.some((row) => Number(row.dirty_record_time_bounds || 0) !== 0)
    || delta.dirtyRecordTimeBounds;

  return {
    counts: {
      connector_count: streamRows.length,
      stream_count: Number(streamCount || 0),
      record_count: recordCount,
    },
    retained_bytes: {
      record_json_bytes: Math.max(0, Number(current.retained_bytes.record_json_bytes || 0) + delta.recordJsonBytesDelta),
      record_changes_json_bytes: Math.max(0, Number(current.retained_bytes.record_changes_json_bytes || 0) + delta.recordChangesJsonBytesDelta),
      blob_bytes: Math.max(0, Number(current.retained_bytes.blob_bytes || 0) + delta.blobBytesDelta),
    },
    record_time_bounds: current.record_time_bounds,
    ingested_time_bounds: {
      earliest: earliestIngestedAt,
      latest: latestIngestedAt,
    },
    top_connector_candidates: streamRows.map((row) => ({
      connector_id: row.connector_id,
      record_count: Number(row.record_count || 0),
    })),
  };
}

function metadataAfterDelta(current, computedAt, dirtyRecordTimeBounds = false) {
  if (current.metadata.state === 'failed') {
    return {
      computed_at: current.metadata.computed_at,
      state: 'failed',
      stale_since: current.metadata.stale_since || computedAt,
      rebuild_status: current.metadata.rebuild_status || 'failed',
      last_error: current.metadata.last_error,
      source_high_watermark: current.metadata.source_high_watermark || null,
    };
  }
  if (current.metadata.state === 'stale' || dirtyRecordTimeBounds) {
    return {
      computed_at: computedAt,
      state: 'stale',
      stale_since: current.metadata.stale_since || computedAt,
      rebuild_status: current.metadata.rebuild_status === 'running' ? 'running' : 'idle',
      last_error: current.metadata.last_error,
      source_high_watermark: `delta:${computedAt}`,
    };
  }
  return {
    computed_at: computedAt,
    state: 'fresh',
    stale_since: null,
    rebuild_status: 'idle',
    last_error: null,
    source_high_watermark: `delta:${computedAt}`,
  };
}

function replaceStreamProjections(rows, computedAt, db = getDb()) {
  db.prepare('DELETE FROM dataset_summary_stream_projection').run();
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
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows || []) {
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
      computedAt,
    );
  }
}

function writeDatasetSummaryProjectionWithStreamSeedsGuarded(
  summary,
  metadata,
  updatedAt,
  streamRows,
  expectedGeneration,
) {
  let committed = false;
  getDb().transaction(() => {
    const row = getDb()
      .prepare(
        `SELECT generation FROM dataset_summary_projection WHERE projection_key = ?`,
      )
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

function markDatasetSummaryProjectionFailed(err) {
  const failedAt = nowIso();
  const current = getDatasetSummaryProjection();
  const metadata = {
    computed_at: current.metadata.computed_at,
    state: 'failed',
    stale_since: current.metadata.stale_since || failedAt,
    rebuild_status: 'failed',
    last_error: sanitizeProjectionError(err),
    source_high_watermark: current.metadata.source_high_watermark || null,
  };
  writeDatasetSummaryProjection(
    {
      counts: current.counts,
      retained_bytes: current.retained_bytes,
      record_time_bounds: current.record_time_bounds,
      ingested_time_bounds: current.ingested_time_bounds,
      top_connector_candidates: current.top_connector_candidates,
    },
    metadata,
    failedAt,
  );
}

function minIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a < b ? a : b;
}

function maxIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}

function minIsoFromRows(rows, field) {
  return rows.reduce((min, row) => minIso(min, row[field] || null), null);
}

function maxIsoFromRows(rows, field) {
  return rows.reduce((max, row) => maxIso(max, row[field] || null), null);
}

function getGlobalRecordTimeBoundsFromStreams() {
  const row = getDb()
    .prepare(
      `SELECT MIN(CASE WHEN record_count > 0 THEN earliest_record_time END) AS earliest,
              MAX(CASE WHEN record_count > 0 THEN latest_record_time END) AS latest
         FROM dataset_summary_stream_projection
        WHERE record_count > 0
          AND consent_time_field IS NOT NULL
          AND dirty_record_time_bounds = 0`,
    )
    .get();
  return {
    earliest: typeof row?.earliest === 'string' ? row.earliest : null,
    latest: typeof row?.latest === 'string' ? row.latest : null,
  };
}

function hasDirtyRecordTimeBounds() {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
         FROM dataset_summary_stream_projection
        WHERE dirty_record_time_bounds <> 0`,
    )
    .get();
  return Number(row?.count || 0) > 0;
}

function isSafeConsentTimeField(field) {
  return typeof field === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(field);
}

function markDatasetSummaryProjectionRebuilding(at) {
  const current = getDatasetSummaryProjection();
  return writeDatasetSummaryProjection(
    {
      counts: current.counts,
      retained_bytes: current.retained_bytes,
      record_time_bounds: current.record_time_bounds,
      ingested_time_bounds: current.ingested_time_bounds,
      top_connector_candidates: current.top_connector_candidates,
    },
    {
      computed_at: current.metadata.computed_at,
      state: current.metadata.computed_at ? 'refreshing' : 'rebuilding',
      stale_since: current.metadata.stale_since || at,
      rebuild_status: 'running',
      last_error: null,
      source_high_watermark: current.metadata.source_high_watermark || null,
    },
    at,
  );
}

function writeDatasetSummaryProjection(summary, metadata, updatedAt) {
  // Every projection write bumps the generation. Returns the post-write
  // generation so callers (notably rebuild) can capture an "expected
  // generation" they will later guard their final commit against.
  const row = getDb()
    .prepare(
      `SELECT generation FROM dataset_summary_projection WHERE projection_key = ?`,
    )
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
         generation = excluded.generation`,
    )
    .run(GLOBAL_KEY, JSON.stringify(summary), JSON.stringify(metadata), updatedAt, nextGeneration);
  return nextGeneration;
}
