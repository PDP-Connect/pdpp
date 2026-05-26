import {
  getRetainedSizeGlobal,
  listRetainedSizeStreams,
} from './retained-size-read-model.js';

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

export function classifyRecordVersionChurn({ currentRecordCount, recordHistoryCount }) {
  const current = Number(currentRecordCount || 0);
  const history = Number(recordHistoryCount || 0);
  const denominator = Math.max(1, current);
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
  getProjection = getRetainedSizeGlobal,
} = {}) {
  const effectiveLimit = clampRecordVersionStatsLimit(limit);
  const riskFilter = normalizeRecordVersionStatsRisk(risk);
  const streamRows = await listStreams({
    connectorInstanceId: connectorInstanceId || undefined,
    stream: stream || undefined,
  });
  const displayNames = await getDisplayNames(
    Array.from(new Set(streamRows.map((row) => row.connector_instance_id).filter(Boolean))),
    connectorInstanceStore,
  );

  const rows = streamRows
    .map((row) => {
      const currentRecordCount = Number(row.record_count || 0);
      const recordHistoryCount = Number(row.record_history_count || 0);
      const classification = classifyRecordVersionChurn({
        currentRecordCount,
        recordHistoryCount,
      });
      return {
        connector_id: row.connector_id || null,
        connector_instance_id: row.connector_instance_id,
        display_name: displayNames.get(row.connector_instance_id) || null,
        stream: row.stream,
        current_record_count: currentRecordCount,
        record_history_count: recordHistoryCount,
        versions_per_record: Number(classification.versionsPerRecord.toFixed(3)),
        // The retained-size projection tracks when aggregate facts were
        // computed, not separate current/history write timestamps.
        last_current_at: null,
        last_history_at: null,
        projection_dirty: Boolean(row.dirty),
        risk_level: classification.riskLevel,
        risk_reasons: classification.riskReasons,
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
      source: 'retained_size_projection',
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
