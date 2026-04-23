import { getDb } from './db.js';
import {
  buildPendingConsentRequestUri,
  getConnectorManifest,
} from './auth.js';
import {
  chooseDisplayTimestamp,
  compareTimestampValues,
  pickSemanticTimestamp,
  timestampWithinWindow,
} from './ref-record-utils.js';
import { listSpineCorrelations } from '../lib/spine.js';

function parseManifest(raw, connectorId) {
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error(`Connector manifest for ${connectorId} is malformed or no longer valid`);
    err.code = 'connector_invalid';
    throw err;
  }
}

function buildFreshness(lastUpdated = null) {
  if (!lastUpdated) {
    return { status: 'unknown' };
  }
  return {
    status: 'unknown',
    captured_at: lastUpdated,
    last_attempted_at: lastUpdated,
  };
}

function toLastRun(summary) {
  if (!summary) return null;
  return {
    run_id: summary.id,
    status: summary.status,
    started_at: summary.first_at,
    finished_at: summary.status === 'pending' ? null : summary.last_at,
  };
}

async function getLatestRunSummary(connectorId) {
  const { summaries } = await listSpineCorrelations('run', {
    connectorId,
    limit: 1,
  });
  return toLastRun(summaries[0] || null);
}

async function getConnectorRecordProjection(connectorId) {
  const rows = getDb().prepare(`
    SELECT
      stream,
      COUNT(*) AS record_count,
      MAX(emitted_at) AS last_updated
    FROM records
    WHERE connector_id = ?
      AND deleted = 0
    GROUP BY stream
  `).all(connectorId);
  const byStream = new Map();
  let latest = null;
  for (const row of rows) {
    const recordCount = Number(row.record_count || 0);
    const lastUpdated = row.last_updated || null;
    byStream.set(row.stream, {
      record_count: recordCount,
      last_updated: lastUpdated,
      freshness: buildFreshness(lastUpdated),
    });
    if (lastUpdated && (!latest || lastUpdated > latest)) {
      latest = lastUpdated;
    }
  }
  return {
    byStream,
    freshness: buildFreshness(latest),
  };
}

function buildManifestExcerpt(manifest) {
  return {
    connector_id: manifest.connector_id,
    display_name: manifest.display_name || manifest.connector_id,
    version: manifest.version,
    protocol_version: manifest.protocol_version || null,
    profile_ids: Array.isArray(manifest.profiles)
      ? manifest.profiles.map((profile) => profile.id)
      : [],
  };
}

function buildStreamSummary(stream, live = null) {
  return {
    object: 'stream',
    name: stream.name,
    semantics: stream.semantics || null,
    record_count: live?.record_count || 0,
    last_updated: live?.last_updated || null,
    freshness: live?.freshness || { status: 'unknown' },
  };
}

function listRegisteredConnectorRows() {
  return getDb().prepare(`
    SELECT connector_id, manifest
    FROM connectors
    ORDER BY connector_id ASC
  `).all();
}

export async function listConnectorSummaries(controller) {
  const rows = listRegisteredConnectorRows();
  return Promise.all(rows.map(async (row) => {
    const manifest = parseManifest(row.manifest, row.connector_id);
    const live = await getConnectorRecordProjection(row.connector_id);
    const schedule = controller ? await controller.getSchedule(row.connector_id) : null;
    const lastRun = await getLatestRunSummary(row.connector_id);
    return {
      connector_id: row.connector_id,
      display_name: manifest.display_name || row.connector_id,
      manifest_version: manifest.version || null,
      streams: (manifest.streams || []).map((stream) => stream.name),
      freshness: live.freshness,
      schedule,
      last_run: lastRun,
    };
  }));
}

export async function getConnectorDetail(connectorId, controller) {
  const manifest = await getConnectorManifest(connectorId);
  if (!manifest) {
    const err = new Error(`Unknown connector: ${connectorId}`);
    err.code = 'not_found';
    throw err;
  }
  const live = await getConnectorRecordProjection(connectorId);
  const schedule = controller ? await controller.getSchedule(connectorId) : null;
  const lastRun = await getLatestRunSummary(connectorId);
  return {
    object: 'ref_connector_detail',
    connector_id: connectorId,
    display_name: manifest.display_name || connectorId,
    manifest_version: manifest.version || null,
    freshness: live.freshness,
    schedule,
    last_run: lastRun,
    recent_runs: lastRun ? [lastRun] : [],
    manifest_excerpt: buildManifestExcerpt(manifest),
    streams: (manifest.streams || []).map((stream) =>
      buildStreamSummary(stream, live.byStream.get(stream.name) || null)),
  };
}

function buildConsentApproval(row) {
  const request = parseManifest(row.params_json, `pending consent ${row.device_code}`);
  return {
    object: 'approval',
    approval_id: row.device_code,
    kind: 'consent',
    client_id: request.client?.client_id || null,
    request_uri: buildPendingConsentRequestUri(row.device_code),
    user_code: row.user_code,
    created_at: row.created_at,
    grant_preview: {
      connector_id: request.source_binding?.connector_id || request.storage_binding?.connector_id || null,
      provider_id: request.source_binding?.provider_id || null,
      access_mode: request.selection?.access_mode || null,
      purpose_code: request.selection?.purpose_code || null,
      purpose_description: request.selection?.purpose_description || null,
      streams: request.selection?.streams || [],
    },
  };
}

function buildOwnerDeviceApproval(row) {
  return {
    object: 'approval',
    approval_id: row.device_code,
    kind: 'owner_device',
    client_id: row.client_id,
    request_uri: null,
    user_code: row.user_code,
    created_at: row.created_at,
    grant_preview: null,
  };
}

export async function listPendingApprovals() {
  const db = getDb();
  const now = new Date().toISOString();
  const pendingConsents = db.prepare(`
    SELECT device_code, user_code, params_json, created_at
    FROM pending_consents
    WHERE status = 'pending'
      AND expires_at > ?
    ORDER BY created_at DESC
  `).all(now);
  const pendingDevices = db.prepare(`
    SELECT device_code, user_code, client_id, created_at
    FROM owner_device_auth
    WHERE status = 'pending'
      AND expires_at > ?
    ORDER BY created_at DESC
  `).all(now);
  const approvals = [
    ...pendingConsents.map(buildConsentApproval),
    ...pendingDevices.map(buildOwnerDeviceApproval),
  ];
  approvals.sort((left, right) => (left.created_at < right.created_at ? 1 : left.created_at > right.created_at ? -1 : 0));
  return approvals;
}

export async function listRecordsTimeline({
  connectorId = null,
  stream = null,
  since = null,
  until = null,
  limit = 50,
  order = 'desc',
  timestampMode = 'native',
} = {}) {
  // Build the WHERE clause dynamically. Values are always bound, never
  // interpolated; the only thing that varies is which clauses are present.
  const where = ['deleted = 0'];
  const binds = [];
  if (connectorId) {
    where.push('connector_id = ?');
    binds.push(connectorId);
  }
  if (stream) {
    where.push('stream = ?');
    binds.push(stream);
  }

  const rows = getDb().prepare(`
    SELECT connector_id, stream, record_key, record_json, emitted_at, version
    FROM records
    WHERE ${where.join(' AND ')}
  `).all(...binds);

  const manifestCache = new Map();
  const data = [];
  for (const row of rows) {
    if (!manifestCache.has(row.connector_id)) {
      manifestCache.set(row.connector_id, await getConnectorManifest(row.connector_id));
    }
    const manifest = manifestCache.get(row.connector_id);
    const manifestStream = manifest?.streams?.find((item) => item.name === row.stream) || null;
    const recordData = row.record_json ? JSON.parse(row.record_json) : null;
    const semanticTimestamp = pickSemanticTimestamp(manifestStream, recordData);
    const displayTimestamp = chooseDisplayTimestamp({
      semanticTimestamp,
      emittedAt: row.emitted_at,
      mode: timestampMode,
    });
    if (timestampMode === 'native') {
      const candidateTimestamp = semanticTimestamp?.value || row.emitted_at;
      if (!timestampWithinWindow(candidateTimestamp, since, until)) continue;
    } else if (!timestampWithinWindow(row.emitted_at, since, until)) {
      continue;
    }

    data.push({
      object: 'timeline_entry',
      connector_id: row.connector_id,
      stream: row.stream,
      id: row.record_key,
      emitted_at: row.emitted_at,
      version: row.version,
      data: recordData,
      semantic_timestamp: semanticTimestamp,
      display_timestamp: displayTimestamp,
    });
  }

  data.sort((left, right) => {
    const primary = compareTimestampValues(left.display_timestamp, right.display_timestamp);
    if (primary !== 0) {
      return order === 'asc' ? primary : -primary;
    }
    if (left.emitted_at !== right.emitted_at) {
      return order === 'asc'
        ? compareTimestampValues(left.emitted_at, right.emitted_at)
        : compareTimestampValues(right.emitted_at, left.emitted_at);
    }
    return order === 'asc'
      ? String(left.id).localeCompare(String(right.id))
      : String(right.id).localeCompare(String(left.id));
  });

  const bounded = data.slice(0, limit);
  return {
    object: 'list',
    data: bounded,
    meta: {
      bounded: true,
      ordering: `semantic_or_emitted ${order}`,
      limit,
      timestamp_mode: timestampMode,
      filters: {
        connector_id: connectorId,
        stream,
        since,
        until,
      },
    },
  };
}
