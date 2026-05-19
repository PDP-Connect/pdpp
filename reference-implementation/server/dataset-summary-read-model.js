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

export function getDatasetSummaryProjection() {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT summary_json, metadata_json
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
    };
  }

  const summary = parseJson(row.summary_json, EMPTY_SUMMARY);
  const metadata = parseJson(row.metadata_json, null);
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
    };
  }

  return { ...summary, metadata };
}

export async function rebuildDatasetSummaryProjection(dependencies) {
  const startedAt = nowIso();
  markDatasetSummaryProjectionRebuilding(startedAt);

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
    writeDatasetSummaryProjection(summary, metadata, computedAt);
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

function markDatasetSummaryProjectionRebuilding(at) {
  const current = getDatasetSummaryProjection();
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
  getDb()
    .prepare(
      `INSERT INTO dataset_summary_projection(
         projection_key,
         summary_json,
         metadata_json,
         updated_at
       )
       VALUES(?, ?, ?, ?)
       ON CONFLICT(projection_key) DO UPDATE SET
         summary_json = excluded.summary_json,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
    )
    .run(GLOBAL_KEY, JSON.stringify(summary), JSON.stringify(metadata), updatedAt);
}
