import {
  getRetainedSizeGlobal,
  listRetainedSizeStreams,
} from './retained-size-read-model.js';
import { getDb } from './db.js';
import {
  isPostgresStorageBackend,
  postgresQuery,
} from './postgres-storage.js';
import { classifyVersionDisposition, classifyVersionRemediation } from './version-disposition.js';
// COMPACTION_POLICIES is the single source of truth for the "registered
// compaction policy" signal — the same registry the maintenance tool resolves.
// `findPolicy` resolves the short, registry-URL, and local-device id forms.
import { findPolicy } from '../scripts/compact-record-history.mjs';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const VALID_RISKS = new Set(['normal', 'watch', 'high']);

export function clampRecordVersionStatsLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

export function normalizeRecordVersionStatsRisk(value) {
  if (value == null || value === '') return null;
  if (!VALID_RISKS.has(value)) {
    const err = new Error("risk must be one of: normal, watch, high");
    err.code = 'invalid_request';
    err.param = 'risk';
    throw err;
  }
  return value;
}

export function classifyRecordVersionChurn({ currentRecordCount, recordHistoryCount, recordKeyCount = null }) {
  const current = Number(currentRecordCount || 0);
  const history = Number(recordHistoryCount || 0);
  const keys = recordKeyCount == null ? null : Number(recordKeyCount || 0);
  const denominator = Math.max(1, keys == null ? current : keys);
  const versionsPerRecord = history / denominator;
  const riskReasons = [];

  if (current === 0 && history > 0) {
    riskReasons.push('history_without_current_records');
  }
  if (versionsPerRecord >= 50) {
    riskReasons.push('versions_per_record_ge_50');
  }
  if (history >= 10_000 && versionsPerRecord >= 10) {
    riskReasons.push('history_ge_10000_and_versions_per_record_ge_10');
  }
  if (riskReasons.some((reason) =>
    reason === 'history_without_current_records'
    || reason === 'versions_per_record_ge_50'
    || reason === 'history_ge_10000_and_versions_per_record_ge_10'
  )) {
    return { riskLevel: 'high', riskReasons, versionsPerRecord };
  }
  if (versionsPerRecord >= 5) {
    riskReasons.push('versions_per_record_ge_5');
    return { riskLevel: 'watch', riskReasons, versionsPerRecord };
  }
  return { riskLevel: 'normal', riskReasons, versionsPerRecord };
}

function buildGroundTruthWhere({ connectorInstanceId, stream } = {}, dialect = 'sqlite') {
  const clauses = [];
  const params = [];
  const placeholder = () => (dialect === 'postgres' ? `$${params.length + 1}` : '?');
  if (connectorInstanceId) {
    clauses.push(`connector_instance_id = ${placeholder()}`);
    params.push(connectorInstanceId);
  }
  if (stream) {
    clauses.push(`stream = ${placeholder()}`);
    params.push(stream);
  }
  return {
    params,
    where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
  };
}

function shapeGroundTruthRow(row) {
  return {
    connector_id: row.connector_id || null,
    connector_instance_id: row.connector_instance_id,
    stream: row.stream,
    current_record_count: Number(row.current_record_count || 0),
    record_history_count: Number(row.record_history_count || 0),
    record_key_count: Number(row.record_key_count || 0),
    last_current_at: row.last_current_at || null,
    last_history_at: row.last_history_at || null,
  };
}

// Domain-local store for the record-version ground-truth aggregates. Two
// adapters selected ONCE via isPostgresStorageBackend(), mirroring the
// VectorIndex / BlobStore precedent: each method returns RAW rows for the
// SAME history + current_records CTE, differing only by dialect (placeholder
// shape, deleted = FALSE vs 0, ::bigint casts, the PG VALUES-list join vs the
// SQLite temp-table join). Row-shaping (shapeGroundTruthRow) stays caller-side
// so the adapters remain thin and dialect-only.
function getRecordVersionStatsStore() {
  if (isPostgresStorageBackend()) {
    return {
      async listGroundTruthStreams({ connectorInstanceId, stream } = {}) {
        const historyFilter = buildGroundTruthWhere({ connectorInstanceId, stream }, 'postgres');
        const currentWhere = historyFilter.where
          ? `${historyFilter.where} AND deleted = FALSE`
          : 'WHERE deleted = FALSE';
        const result = await postgresQuery(
          `WITH history AS (
              SELECT connector_instance_id, connector_id, stream,
                     COUNT(*)::bigint AS record_history_count,
                     COUNT(DISTINCT record_key)::bigint AS record_key_count,
                     MAX(emitted_at) AS last_history_at
                FROM record_changes
                ${historyFilter.where}
               GROUP BY connector_instance_id, connector_id, stream
            ),
            current_records AS (
              SELECT connector_instance_id, stream,
                     COUNT(*)::bigint AS current_record_count,
                     MAX(emitted_at) AS last_current_at
                FROM records
                ${currentWhere}
               GROUP BY connector_instance_id, stream
            )
            SELECT history.connector_instance_id, history.connector_id, history.stream,
                   COALESCE(current_records.current_record_count, 0)::bigint AS current_record_count,
                   history.record_history_count,
                   history.record_key_count,
                   current_records.last_current_at,
                   history.last_history_at
              FROM history
              LEFT JOIN current_records
                ON current_records.connector_instance_id = history.connector_instance_id
               AND current_records.stream = history.stream`,
          historyFilter.params,
        );
        return result.rows;
      },
      async listGroundTruthForKeys(keyList) {
        // Build a VALUES list so a single bounded query covers every candidate key.
        const params = [];
        const tuples = keyList.map((k) => {
          params.push(k.connectorInstanceId, k.stream);
          return `($${params.length - 1}, $${params.length})`;
        });
        const valuesClause = tuples.join(', ');
        const result = await postgresQuery(
          `WITH wanted(connector_instance_id, stream) AS (
              VALUES ${valuesClause}
            ),
            history AS (
              SELECT rc.connector_instance_id, rc.connector_id, rc.stream,
                     COUNT(*)::bigint AS record_history_count,
                     COUNT(DISTINCT rc.record_key)::bigint AS record_key_count,
                     MAX(rc.emitted_at) AS last_history_at
                FROM record_changes rc
                JOIN wanted w
                  ON w.connector_instance_id = rc.connector_instance_id
                 AND w.stream = rc.stream
               GROUP BY rc.connector_instance_id, rc.connector_id, rc.stream
            ),
            current_records AS (
              SELECT r.connector_instance_id, r.stream,
                     COUNT(*)::bigint AS current_record_count,
                     MAX(r.emitted_at) AS last_current_at
                FROM records r
                JOIN wanted w
                  ON w.connector_instance_id = r.connector_instance_id
                 AND w.stream = r.stream
               WHERE r.deleted = FALSE
               GROUP BY r.connector_instance_id, r.stream
            )
            SELECT history.connector_instance_id, history.connector_id, history.stream,
                   COALESCE(current_records.current_record_count, 0)::bigint AS current_record_count,
                   history.record_history_count,
                   history.record_key_count,
                   current_records.last_current_at,
                   history.last_history_at
              FROM history
              LEFT JOIN current_records
                ON current_records.connector_instance_id = history.connector_instance_id
               AND current_records.stream = history.stream`,
          params,
        );
        return result.rows;
      },
    };
  }

  return {
    async listGroundTruthStreams({ connectorInstanceId, stream } = {}) {
      const historyFilter = buildGroundTruthWhere({ connectorInstanceId, stream }, 'sqlite');
      const currentFilter = buildGroundTruthWhere({ connectorInstanceId, stream }, 'sqlite');
      const currentWhere = currentFilter.where
        ? `${currentFilter.where} AND deleted = 0`
        : 'WHERE deleted = 0';
      return getDb()
        .prepare(
          `WITH history AS (
              SELECT connector_instance_id, connector_id, stream,
                     COUNT(*) AS record_history_count,
                     COUNT(DISTINCT record_key) AS record_key_count,
                     MAX(emitted_at) AS last_history_at
                FROM record_changes
                ${historyFilter.where}
               GROUP BY connector_instance_id, connector_id, stream
            ),
            current_records AS (
              SELECT connector_instance_id, stream,
                     COUNT(*) AS current_record_count,
                     MAX(emitted_at) AS last_current_at
                FROM records
                ${currentWhere}
               GROUP BY connector_instance_id, stream
            )
            SELECT history.connector_instance_id, history.connector_id, history.stream,
                   COALESCE(current_records.current_record_count, 0) AS current_record_count,
                   history.record_history_count,
                   history.record_key_count,
                   current_records.last_current_at,
                   history.last_history_at
              FROM history
              LEFT JOIN current_records
                ON current_records.connector_instance_id = history.connector_instance_id
               AND current_records.stream = history.stream`,
        )
        .all(...historyFilter.params, ...currentFilter.params);
    },
    listGroundTruthForKeys(keyList) {
      // SQLite has no row-VALUES join idiom as ergonomic as Postgres'; a temp
      // filter table keeps the query bounded and avoids an N-placeholder IN
      // list blowing the SQLite variable limit on large candidate sets.
      const db = getDb();
      return db.transaction(() => {
        db.prepare(
          `CREATE TEMP TABLE IF NOT EXISTS _vstats_wanted_keys(
             connector_instance_id TEXT NOT NULL,
             stream TEXT NOT NULL,
             PRIMARY KEY(connector_instance_id, stream)
           )`,
        ).run();
        db.prepare('DELETE FROM _vstats_wanted_keys').run();
        const insert = db.prepare(
          'INSERT OR IGNORE INTO _vstats_wanted_keys(connector_instance_id, stream) VALUES (?, ?)',
        );
        for (const k of keyList) insert.run(k.connectorInstanceId, k.stream);
        const rows = db
          .prepare(
            `WITH history AS (
                SELECT rc.connector_instance_id, rc.connector_id, rc.stream,
                       COUNT(*) AS record_history_count,
                       COUNT(DISTINCT rc.record_key) AS record_key_count,
                       MAX(rc.emitted_at) AS last_history_at
                  FROM record_changes rc
                  JOIN _vstats_wanted_keys w
                    ON w.connector_instance_id = rc.connector_instance_id
                   AND w.stream = rc.stream
                 GROUP BY rc.connector_instance_id, rc.connector_id, rc.stream
              ),
              current_records AS (
                SELECT r.connector_instance_id, r.stream,
                       COUNT(*) AS current_record_count,
                       MAX(r.emitted_at) AS last_current_at
                  FROM records r
                  JOIN _vstats_wanted_keys w
                    ON w.connector_instance_id = r.connector_instance_id
                   AND w.stream = r.stream
                 WHERE r.deleted = 0
                 GROUP BY r.connector_instance_id, r.stream
              )
              SELECT history.connector_instance_id, history.connector_id, history.stream,
                     COALESCE(current_records.current_record_count, 0) AS current_record_count,
                     history.record_history_count,
                     history.record_key_count,
                     current_records.last_current_at,
                     history.last_history_at
                FROM history
                LEFT JOIN current_records
                  ON current_records.connector_instance_id = history.connector_instance_id
                 AND current_records.stream = history.stream`,
          )
          .all();
        db.prepare('DELETE FROM _vstats_wanted_keys').run();
        return rows;
      })();
    },
  };
}

export async function listRecordVersionGroundTruthStreams({ connectorInstanceId, stream } = {}) {
  const rows = await getRecordVersionStatsStore().listGroundTruthStreams({ connectorInstanceId, stream });
  return rows.map(shapeGroundTruthRow);
}

/**
 * Bounded variant of `listRecordVersionGroundTruthStreams`: run the identical
 * history/current aggregate restricted to an explicit set of
 * `(connector_instance_id, stream)` keys. The diagnostic facts it returns for a
 * key are byte-identical to the full scan's facts for that key, but the work is
 * proportional to the candidate set, not the whole `record_changes` corpus. The
 * unfiltered hot path uses this for candidate + dirty streams only; the full
 * scan (`listRecordVersionGroundTruthStreams`) is reserved for explicit filters
 * and the dirty-global fallback.
 */
export async function listRecordVersionGroundTruthForKeys({ keys } = {}) {
  const keyList = Array.isArray(keys) ? keys.filter((k) => k && k.connectorInstanceId && k.stream) : [];
  if (keyList.length === 0) return [];

  const rows = await getRecordVersionStatsStore().listGroundTruthForKeys(keyList);
  return rows.map(shapeGroundTruthRow);
}

/**
 * Conservative candidate predicate for the unfiltered hot path. Returns true
 * when a stream COULD classify above `normal` and therefore needs the
 * ground-truth `record_key_count` / `last_history_at`. Inputs are the
 * projection's exact (`dirty = 0`) facts. Dirty rows are intentionally NOT
 * candidates on the unfiltered owner-dashboard path: they are surfaced as
 * honest projection-backed advisory rows with `projection_dirty: true`, while
 * exact verification remains available through scoped diagnostic requests. The
 * denominator uses `current` (not the unavailable distinct-key count), which is
 * an upper bound on versions-per-record — so the predicate never under-includes
 * a real non-normal stream among clean projection rows.
 *
 * Mirrors the thresholds in `classifyRecordVersionChurn`: current==0 with
 * history>0, or the watch lower bound (vpr >= 5). The high-history arm is
 * stricter than watch (`history >= 10_000 && vpr >= 10`), so the watch bound is
 * sufficient to avoid under-including it.
 */
export function isVersionChurnCandidate({ dirty, currentRecordCount, recordHistoryCount } = {}) {
  if (dirty) return false;
  const current = Number(currentRecordCount || 0);
  const history = Number(recordHistoryCount || 0);
  if (history <= 0) return false;
  if (current === 0) return true; // history_without_current_records
  // vpr upper bound (history / current) >= watch threshold.
  return history >= 5 * Math.max(1, current);
}

async function getDisplayNames(connectorInstanceIds, connectorInstanceStore) {
  if (!connectorInstanceStore || typeof connectorInstanceStore.get !== 'function') {
    return new Map();
  }
  const names = new Map();
  for (const id of connectorInstanceIds) {
    try {
      const instance = await connectorInstanceStore.get(id);
      if (instance?.displayName) names.set(id, instance.displayName);
    } catch {
      // Display names are advisory. Keep the diagnostic route available
      // even if a connection row disappeared or its store is unhealthy.
    }
  }
  return names;
}

function rowKey(row) {
  return `${row.connector_instance_id}\n${row.stream}`;
}

function riskSortValue(riskLevel) {
  if (riskLevel === 'high') return 0;
  if (riskLevel === 'watch') return 1;
  return 2;
}

export async function buildRecordVersionStatsEnvelope({
  connectorInstanceId = null,
  stream = null,
  risk = null,
  limit = DEFAULT_LIMIT,
} = {}, {
  connectorInstanceStore = null,
  listStreams = listRetainedSizeStreams,
  listGroundTruthStreams = listRecordVersionGroundTruthStreams,
  listGroundTruthForKeys = listRecordVersionGroundTruthForKeys,
  getProjection = getRetainedSizeGlobal,
} = {}) {
  const effectiveLimit = clampRecordVersionStatsLimit(limit);
  const riskFilter = normalizeRecordVersionStatsRisk(risk);
  const streamRows = await listStreams({
    connectorInstanceId: connectorInstanceId || undefined,
    stream: stream || undefined,
  });
  // Read projection freshness once so candidate selection and the envelope's
  // `projection` summary describe the same snapshot.
  const projection = await getProjection();

  // Hot-path optimization: an UNFILTERED request avoids the unbounded
  // `record_changes` scan, even while the projection is dirty/rebuilding. The
  // projection's exact (`dirty = 0`) record_history_count / record_count identify
  // the bounded candidate set that could classify watch/high; dirty rows stay
  // projection-backed and carry `projection_dirty` so the advisory is honest but
  // does not turn owner navigation into a whole-history aggregate. Exact
  // verification remains available through explicit connector_instance_id/stream
  // diagnostic filters.
  const isUnfiltered = !connectorInstanceId && !stream;
  const useCandidatePath = isUnfiltered
    && typeof listGroundTruthForKeys === 'function';

  let groundTruthRows;
  if (useCandidatePath) {
    const candidateKeys = streamRows
      .filter((row) => isVersionChurnCandidate({
        dirty: Boolean(row.dirty),
        currentRecordCount: row.record_count,
        recordHistoryCount: row.record_history_count,
      }))
      .map((row) => ({ connectorInstanceId: row.connector_instance_id, stream: row.stream }));
    groundTruthRows = candidateKeys.length
      ? await listGroundTruthForKeys({ keys: candidateKeys })
      : [];
  } else {
    groundTruthRows = listGroundTruthStreams
      ? await listGroundTruthStreams({
        connectorInstanceId: connectorInstanceId || undefined,
        stream: stream || undefined,
      })
      : [];
  }
  const groundTruthByKey = new Map(groundTruthRows.map((row) => [rowKey(row), row]));
  const projectionByKey = new Map(streamRows.map((row) => [rowKey(row), row]));
  const mergedRows = [
    ...streamRows,
    ...groundTruthRows.filter((row) => !projectionByKey.has(rowKey(row))).map((row) => ({
      connector_id: row.connector_id,
      connector_instance_id: row.connector_instance_id,
      stream: row.stream,
      record_count: row.current_record_count,
      record_history_count: row.record_history_count,
      dirty: false,
      computed_at: null,
      projection_missing: true,
    })),
  ];
  const displayNames = await getDisplayNames(
    Array.from(new Set(mergedRows.map((row) => row.connector_instance_id).filter(Boolean))),
    connectorInstanceStore,
  );

  const rows = mergedRows
    .map((row) => {
      const groundTruth = groundTruthByKey.get(rowKey(row));
      const projectionMissing = Boolean(row.projection_missing) || !projectionByKey.has(rowKey(row));
      const currentRecordCount = Number(groundTruth?.current_record_count ?? row.record_count ?? 0);
      const recordHistoryCount = Number(groundTruth?.record_history_count ?? row.record_history_count ?? 0);
      const recordKeyCount = groundTruth ? Number(groundTruth.record_key_count || 0) : null;
      const classification = classifyRecordVersionChurn({
        currentRecordCount,
        recordHistoryCount,
        recordKeyCount,
      });
      const riskReasons = [...classification.riskReasons];
      if (projectionMissing) {
        riskReasons.push('projection_missing');
      }
      if (Boolean(row.dirty)) {
        riskReasons.push('projection_dirty');
      }
      const lastHistoryAt = groundTruth?.last_history_at || null;
      // version_disposition is a derived label only — it never participates in
      // and never alters the numeric risk classification above. It is computed
      // from reference-controlled signals: the registered compaction-policy
      // presence (COMPACTION_POLICIES via findPolicy) plus the server-side
      // point-in-time / recurring-snapshot / reviewed-residue registries. No
      // connector-authored value feeds it.
      const versionDisposition = classifyVersionDisposition({
        connectorId: row.connector_id || null,
        stream: row.stream,
        lastHistoryAt,
        hasCompactionPolicy: findPolicy(row.connector_id || '', row.stream) != null,
      });
      // version_remediation is the orthogonal next-action axis, derived from the
      // disposition just computed plus reference-maintained stream lists. It is
      // a label only and never re-derives or contradicts the disposition. Like
      // disposition, NO connector-authored value feeds it.
      const versionRemediation = classifyVersionRemediation({
        connectorId: row.connector_id || null,
        stream: row.stream,
        versionDisposition,
      });
      return {
        connector_id: row.connector_id || null,
        connector_instance_id: row.connector_instance_id,
        display_name: displayNames.get(row.connector_instance_id) || null,
        stream: row.stream,
        current_record_count: currentRecordCount,
        record_history_count: recordHistoryCount,
        record_key_count: recordKeyCount,
        versions_per_record: Number(classification.versionsPerRecord.toFixed(3)),
        // The retained-size projection tracks when aggregate facts were
        // computed, not separate current/history write timestamps.
        last_current_at: groundTruth?.last_current_at || null,
        last_history_at: lastHistoryAt,
        projection_dirty: Boolean(row.dirty),
        projection_missing: projectionMissing,
        projection_authority: groundTruth ? 'record_changes_ground_truth' : 'retained_size_projection',
        risk_level: classification.riskLevel,
        risk_reasons: riskReasons,
        version_disposition: versionDisposition,
        version_remediation: versionRemediation,
      };
    })
    .filter((row) => (riskFilter ? row.risk_level === riskFilter : true))
    .sort((a, b) => {
      const byRisk = riskSortValue(a.risk_level) - riskSortValue(b.risk_level);
      if (byRisk !== 0) return byRisk;
      if (b.versions_per_record !== a.versions_per_record) {
        return b.versions_per_record - a.versions_per_record;
      }
      if (b.record_history_count !== a.record_history_count) {
        return b.record_history_count - a.record_history_count;
      }
      return `${a.connector_instance_id}:${a.stream}`.localeCompare(`${b.connector_instance_id}:${b.stream}`);
    });

  return {
    object: 'ref_record_version_stats',
    data: rows.slice(0, effectiveLimit),
    meta: {
      returned: Math.min(rows.length, effectiveLimit),
      total_matching: rows.length,
      has_more: rows.length > effectiveLimit,
      limit: effectiveLimit,
      filters: {
        connector_instance_id: connectorInstanceId || null,
        stream: stream || null,
        risk: riskFilter,
      },
      source: 'retained_size_projection_with_record_changes_ground_truth',
      risk_thresholds: {
        watch_versions_per_record: 5,
        high_versions_per_record: 50,
        high_history_count: 10_000,
        high_history_versions_per_record: 10,
      },
      // version_disposition is a label, never a threshold knob. The numeric
      // risk_thresholds above and each row's risk_level/risk_reasons are
      // computed independently of disposition. This assertion makes that
      // explicit so a reader cannot mistake disposition for a threshold
      // override.
      disposition_affects_thresholds: false,
      // version_remediation is likewise a label, never a threshold knob. It is
      // derived from the disposition + reference lists and never alters the
      // numeric risk path. This assertion mirrors the disposition one.
      remediation_affects_thresholds: false,
    },
    projection: {
      computed_at: projection.computed_at || null,
      dirty: Boolean(projection.dirty),
      metadata: projection.metadata || null,
    },
  };
}
