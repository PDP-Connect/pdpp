import {
  getRetainedSizeGlobal,
  listRetainedSizeStreams,
} from './retained-size-read-model.js';
import { getDb } from './db.js';
import {
  isPostgresStorageBackend,
  postgresQuery,
} from './postgres-storage.js';

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

export async function listRecordVersionGroundTruthStreams({ connectorInstanceId, stream } = {}) {
  if (isPostgresStorageBackend()) {
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
    return result.rows.map(shapeGroundTruthRow);
  }

  const historyFilter = buildGroundTruthWhere({ connectorInstanceId, stream }, 'sqlite');
  const currentFilter = buildGroundTruthWhere({ connectorInstanceId, stream }, 'sqlite');
  const currentWhere = currentFilter.where
    ? `${currentFilter.where} AND deleted = 0`
    : 'WHERE deleted = 0';
  const rows = getDb()
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
  return rows.map(shapeGroundTruthRow);
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
  getProjection = getRetainedSizeGlobal,
} = {}) {
  const effectiveLimit = clampRecordVersionStatsLimit(limit);
  const riskFilter = normalizeRecordVersionStatsRisk(risk);
  const streamRows = await listStreams({
    connectorInstanceId: connectorInstanceId || undefined,
    stream: stream || undefined,
  });
  const groundTruthRows = listGroundTruthStreams
    ? await listGroundTruthStreams({
      connectorInstanceId: connectorInstanceId || undefined,
      stream: stream || undefined,
    })
    : [];
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
        last_history_at: groundTruth?.last_history_at || null,
        projection_dirty: Boolean(row.dirty),
        projection_missing: projectionMissing,
        projection_authority: groundTruth ? 'record_changes_ground_truth' : 'retained_size_projection',
        risk_level: classification.riskLevel,
        risk_reasons: riskReasons,
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

  const projection = await getProjection();
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
    },
    projection: {
      computed_at: projection.computed_at || null,
      dirty: Boolean(projection.dirty),
      metadata: projection.metadata || null,
    },
  };
}
