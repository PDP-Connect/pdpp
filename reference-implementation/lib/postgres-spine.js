/**
 * Postgres-backed disclosure spine primitives.
 *
 * Spec: openspec/changes/add-postgres-runtime-storage/
 */

import { randomUUID } from 'node:crypto';

import { postgresQuery } from '../server/postgres-storage.js';

const COLUMN_BY_KIND = {
  trace: 'trace_id',
  grant: 'grant_id',
  run: 'run_id',
};

function nowIso() {
  return new Date().toISOString();
}

function eventId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value ? value : null;
}

function isSourceKind(value) {
  return value === 'connector' || value === 'provider_native';
}

function normalizeSourceObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kind = isSourceKind(value.kind) ? value.kind : null;
  const id = nonEmptyString(value.id);
  if (kind && id) return { kind, id };

  const legacyKind = isSourceKind(value.binding_kind) ? value.binding_kind : null;
  if (legacyKind === 'connector') {
    const connectorId = nonEmptyString(value.connector_id);
    return connectorId ? { kind: 'connector', id: connectorId } : null;
  }
  if (legacyKind === 'provider_native') {
    const providerId = nonEmptyString(value.provider_id);
    return providerId ? { kind: 'provider_native', id: providerId } : null;
  }

  const connectorId = nonEmptyString(value.connector_id);
  const providerId = nonEmptyString(value.provider_id);
  if (connectorId && !providerId) return { kind: 'connector', id: connectorId };
  if (providerId && !connectorId) return { kind: 'provider_native', id: providerId };
  return null;
}

function deriveSource(input, actorType, actorId) {
  const explicitKind = isSourceKind(input.source_kind) ? input.source_kind : null;
  const explicitId = nonEmptyString(input.source_id);
  if (explicitKind && explicitId) return { kind: explicitKind, id: explicitId };

  const data = input.data && typeof input.data === 'object' && !Array.isArray(input.data) ? input.data : {};
  const source = normalizeSourceObject(data.source) || normalizeSourceObject(data.source_binding);
  if (source) return source;

  const connectorId = nonEmptyString(data.connector_id);
  const providerId = nonEmptyString(data.provider_id);
  if (connectorId && !providerId) return { kind: 'connector', id: connectorId };
  if (providerId && !connectorId) return { kind: 'provider_native', id: providerId };
  if (actorType === 'runtime' && actorId) return { kind: 'connector', id: actorId };
  return null;
}

function serializeData(inputData, source) {
  const data = inputData && typeof inputData === 'object' && !Array.isArray(inputData) ? { ...inputData } : {};
  if (source) data.source = source;
  return JSON.stringify(data);
}

function normalize(input = {}) {
  const at = input.occurred_at || nowIso();
  const actorType = input.actor_type || 'system';
  const actorId = input.actor_id || 'system';
  const source = deriveSource(input, actorType, actorId);
  return {
    event_id: input.event_id || eventId('evt'),
    event_type: input.event_type || 'event',
    occurred_at: at,
    recorded_at: nowIso(),
    scenario_id: input.scenario_id || 'default',
    trace_id: input.trace_id || eventId('trace'),
    actor_type: actorType,
    actor_id: actorId,
    subject_type: input.subject_type || null,
    subject_id: input.subject_id || null,
    object_type: input.object_type || 'object',
    object_id: input.object_id || eventId('obj'),
    status: input.status || 'ok',
    request_id: input.request_id || null,
    grant_id: input.grant_id || null,
    run_id: input.run_id || null,
    source_kind: source?.kind || null,
    source_id: source?.id || null,
    client_id: input.client_id || null,
    stream_id: input.stream_id || null,
    token_id: input.token_id || null,
    interaction_id: input.interaction_id || null,
    data_json: serializeData(input.data, source),
    version: input.version || '1',
  };
}

function hydrate(row) {
  if (!row) return null;
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    occurred_at: row.occurred_at,
    recorded_at: row.recorded_at,
    scenario_id: row.scenario_id,
    trace_id: row.trace_id,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    subject_type: row.subject_type,
    subject_id: row.subject_id,
    object_type: row.object_type,
    object_id: row.object_id,
    status: row.status,
    request_id: row.request_id,
    grant_id: row.grant_id,
    run_id: row.run_id,
    source_kind: row.source_kind,
    source_id: row.source_id,
    client_id: row.client_id,
    stream_id: row.stream_id,
    token_id: row.token_id,
    interaction_id: row.interaction_id,
    data: typeof row.data_json === 'string' ? JSON.parse(row.data_json) : row.data_json,
    version: row.version,
  };
}

function sourceFromEvent(event) {
  const sourceKind = isSourceKind(event.source_kind) ? event.source_kind : null;
  if (sourceKind && event.source_id) {
    return { kind: sourceKind, id: event.source_id };
  }

  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : {};
  const source = normalizeSourceObject(data.source) || normalizeSourceObject(data.source_binding);
  if (source) {
    return source;
  }

  const connectorId = nonEmptyString(data.connector_id);
  const providerId = nonEmptyString(data.provider_id);
  if (connectorId && !providerId) return { kind: 'connector', id: connectorId };
  if (providerId && !connectorId) return { kind: 'provider_native', id: providerId };
  if (event.actor_type === 'runtime' && event.actor_id) return { kind: 'connector', id: event.actor_id };
  return null;
}

function findLatestBrowserSurfaceProjection(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (!event?.event_type?.startsWith('run.browser_surface_')) {
      continue;
    }
    const projection = event.data?.browser_surface;
    if (projection && typeof projection === 'object' && !Array.isArray(projection)) {
      return projection;
    }
  }
  return null;
}

const BROWSER_SURFACE_PROJECTION_KEYS = [
  'browser_surface_status',
  'browser_surface_wait_reason',
  'browser_surface_lease_id',
  'browser_surface_profile_key',
];

function pickBrowserSurfaceFields(projection) {
  if (!projection) {
    return {};
  }
  const out = {};
  for (const key of BROWSER_SURFACE_PROJECTION_KEYS) {
    const value = projection[key];
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

function connectionIdFromBrowserSurfaceProfileKey(projection) {
  const profileKey = projection?.browser_surface_profile_key;
  if (typeof profileKey !== 'string' || profileKey.length === 0) {
    return null;
  }
  const suffix = profileKey.split(':').at(-1);
  return suffix?.startsWith('cin_') ? suffix : null;
}

function connectionIdFromEventData(event) {
  const data = event?.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data : null;
  if (!data) {
    return null;
  }
  if (typeof data.connection_id === 'string' && data.connection_id.length > 0) {
    return data.connection_id;
  }
  if (typeof data.connector_instance_id === 'string' && data.connector_instance_id.length > 0) {
    return data.connector_instance_id;
  }
  return null;
}

function findFirstConnectionId(events) {
  for (const event of events) {
    const connectionId = connectionIdFromEventData(event);
    if (connectionId) {
      return connectionId;
    }
  }
  return null;
}

function encodeEventCursor(eventSeq) {
  return eventSeq == null ? null : Buffer.from(JSON.stringify({ event_seq: Number(eventSeq) })).toString('base64url');
}

function decodeEventCursor(cursor) {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return Number(decoded.event_seq) || 0;
  } catch {
    return 0;
  }
}

function encodeSummaryCursor(summary) {
  return summary ? `${summary.last_at}::${summary.id}` : null;
}

// Run-terminal event types — kept aligned with lib/spine.ts
// RUN_TERMINAL_EVENT_TYPES. Reference: docs/run-reconciliation-design-brief.md §3.7.
const RUN_TERMINAL_EVENT_TYPES = new Set([
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.abandoned',
]);
const RUN_TERMINAL_EVENT_TYPE_LIST = [...RUN_TERMINAL_EVENT_TYPES];
const SUMMARY_EVENT_HEAD_LIMIT = 5000;
const SUMMARY_EVENT_TAIL_LIMIT = 200;
const RECENT_CORRELATION_SCAN_CHUNK = 1000;
const RECENT_CORRELATION_SCAN_FALLBACK_AFTER = 100000;

async function hasPostgresActiveRunLease(runId) {
  if (!runId) return false;
  const result = await postgresQuery('SELECT 1 AS active FROM controller_active_runs WHERE run_id = $1 LIMIT 1', [runId]);
  return result.rows.length > 0;
}

// Postgres mirror of `queries/spine/get-run-terminal-event.sql`: the run's
// most-recent terminal event (`ORDER BY event_seq DESC LIMIT 1`) over the
// terminal event types, or `null` when the run has no terminal event. The
// `LIMIT 1` keeps this independent of the run's event count — it never
// scans the full event list and never depends on a timeline page window.
export async function postgresGetRunTerminalEvent(runId) {
  if (!runId) return null;
  const result = await postgresQuery(
    `SELECT event_type, status, data_json::text AS data_json, occurred_at, trace_id, actor_id
     FROM spine_events
     WHERE run_id = $1 AND event_type = ANY($2::text[])
     ORDER BY event_seq DESC
     LIMIT 1`,
    [runId, RUN_TERMINAL_EVENT_TYPE_LIST],
  );
  return result.rows[0] ?? null;
}

// Postgres mirror of `queries/spine/get-run-started-event.sql`: the run's
// `run.started` event (`ORDER BY event_seq ASC LIMIT 1`), or `null` when
// the run never reached the runtime's start emit (e.g. a launch failure
// before spawn). Bounded by `LIMIT 1` like the terminal lookup above.
export async function postgresGetRunStartedEvent(runId) {
  if (!runId) return null;
  const result = await postgresQuery(
    `SELECT event_type, status, data_json::text AS data_json, occurred_at, trace_id, actor_id
     FROM spine_events
     WHERE run_id = $1 AND event_type = 'run.started'
     ORDER BY event_seq ASC
     LIMIT 1`,
    [runId],
  );
  return result.rows[0] ?? null;
}

function selectSummaryEventFields(events) {
  const first = events[0] || {};
  const last = events[events.length - 1] || first;
  const kinds = [...new Set(events.map((event) => event.event_type).filter(Boolean))];
  const failureEvent = events.find((event) => event.status === 'failed' || event.status === 'rejected');
  const hasRunStarted = events.some((event) => event.event_type === 'run.started');
  const needsInput = events.some((event) => event.status === 'needs_input');
  return { failureEvent, first, hasRunStarted, kinds, last, needsInput };
}

function selectSummarySourceProjection(events) {
  const sources = events.map(sourceFromEvent).filter(Boolean);
  const source = sources[0] || null;
  const connector = sources.find((candidate) => candidate.kind === 'connector') || null;
  return { connector, source };
}

function pickSummaryBrowserSurfaceProjection(events) {
  const browserSurface = findLatestBrowserSurfaceProjection(events);
  const connectionId = findFirstConnectionId(events) ?? connectionIdFromBrowserSurfaceProfileKey(browserSurface);
  return {
    connectionId,
    browserSurfaceFields: pickBrowserSurfaceFields(browserSurface),
  };
}

async function projectSummaryStatus(id, events) {
  // Status projection — mirror lib/spine.ts summarizeEvents logic.
  //
  // Run-correlation summaries must reflect the run's lifecycle status
  // (run.completed / run.failed / run.cancelled / run.abandoned), NOT
  // the status of incidental sub-resource events that happen to share
  // the run_id (e.g. run.batch_ingested, which carries status:'succeeded'
  // per batch — and would mislabel an in-flight run as succeeded if used
  // as the fallback). See docs/run-reconciliation-design-brief.md §3.7.
  let status = 'unknown';
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (!ev || !RUN_TERMINAL_EVENT_TYPES.has(ev.event_type)) continue;
    if (ev.status && ev.status !== 'unknown') {
      status = ev.status;
      break;
    }
  }
  if (status === 'unknown') {
    // Pass 2 (fallback): no run-terminal event yet. A started run is only
    // in progress while controller_active_runs still carries its lease;
    // otherwise it is an orphan and must not keep owner surfaces live.
    // Non-run correlations still use the most recent non-"unknown" status.
    const hasRunStarted = events.some((ev) => ev.event_type === 'run.started');
    if (hasRunStarted) {
      const runId = events.find((ev) => ev.run_id)?.run_id || id || null;
      status = await hasPostgresActiveRunLease(runId) ? 'in_progress' : 'failed';
    } else {
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const ev = events[i];
        if (ev && ev.status && ev.status !== 'unknown') {
          status = ev.status;
          break;
        }
      }
    }
  }
  return status;
}

function assembleSummaryObject(id, aggregate, events, eventFields, sourceProjection, browserSurfaceProjection, status) {
  const { failureEvent, first, hasRunStarted, kinds, last, needsInput } = eventFields;
  const { connector, source } = sourceProjection;
  const { connectionId, browserSurfaceFields } = browserSurfaceProjection;
  return {
    id,
    actor_id: last.actor_id || null,
    actor_type: last.actor_type || null,
    client_id: last.client_id || null,
    ...(connectionId
      ? { connection_id: connectionId, connector_instance_id: connectionId }
      : {}),
    connector_id: connector?.id || null,
    event_count: Number(aggregate.event_count) || events.length,
    failure: failureEvent
      ? {
          event_type: failureEvent.event_type,
          reason: typeof failureEvent.data?.reason === 'string' ? failureEvent.data.reason : null,
        }
      : status === 'failed' && hasRunStarted
        ? {
            event_type: 'run.started',
            reason: 'orphaned_started_run',
          }
      : null,
    first_at: aggregate.first_at || first.occurred_at || null,
    grant_id: last.grant_id || null,
    kinds,
    last_at: aggregate.last_at || last.occurred_at || null,
    needs_input: needsInput,
    request_id: last.request_id || null,
    run_id: last.run_id || null,
    source,
    source_id: source?.id || null,
    source_kind: source?.kind || null,
    status,
    trace_id: last.trace_id || null,
    ...browserSurfaceFields,
  };
}

async function summarizeRows(id, rows, aggregate = {}) {
  const events = rows.map(hydrate).filter(Boolean);
  const eventFields = selectSummaryEventFields(events);
  const sourceProjection = selectSummarySourceProjection(events);
  const browserSurfaceProjection = pickSummaryBrowserSurfaceProjection(events);
  const status = await projectSummaryStatus(id, events);
  return assembleSummaryObject(id, aggregate, events, eventFields, sourceProjection, browserSurfaceProjection, status);
}

function mergeEventRows(rows) {
  const bySeq = new Map();
  for (const row of rows) {
    if (!row) continue;
    const key = Number(row.event_seq);
    bySeq.set(Number.isFinite(key) ? key : row.event_id, row);
  }
  return [...bySeq.values()].sort((a, b) => Number(a.event_seq || 0) - Number(b.event_seq || 0));
}

async function fetchRowsForSummary(kind, column, id) {
  const head = await postgresQuery(
    `SELECT * FROM spine_events WHERE ${column} = $1 ORDER BY event_seq ASC LIMIT $2`,
    [id, SUMMARY_EVENT_HEAD_LIMIT],
  );
  if (kind !== 'run') {
    return head.rows;
  }

  const [tail, terminal] = await Promise.all([
    postgresQuery(
      `SELECT * FROM spine_events WHERE ${column} = $1 ORDER BY event_seq DESC LIMIT $2`,
      [id, SUMMARY_EVENT_TAIL_LIMIT],
    ),
    postgresQuery(
      `SELECT * FROM spine_events
       WHERE ${column} = $1 AND event_type = ANY($2::text[])
       ORDER BY event_seq DESC
       LIMIT 10`,
      [id, RUN_TERMINAL_EVENT_TYPE_LIST],
    ),
  ]);
  return mergeEventRows([...head.rows, ...tail.rows, ...terminal.rows]);
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.max(1, Math.min(limit, items.length)); i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

function hasOnlyFirstPageRecentFilters(filters) {
  return !(
    filters.cursor ||
    filters.since ||
    filters.until ||
    filters.status ||
    filters.clientId ||
    filters.sourceKind ||
    filters.sourceId ||
    filters.grantId ||
    filters.q
  );
}

function compareSummaryRows(a, b) {
  const lastAt = String(b.last_at || '').localeCompare(String(a.last_at || ''));
  if (lastAt !== 0) return lastAt;
  return String(a.id || '').localeCompare(String(b.id || ''));
}

async function listRecentCorrelationAggregates(column, limit) {
  const seen = new Map();
  let beforeAt = null;
  let beforeSeq = null;
  let scanned = 0;

  for (;;) {
    const params = [];
    let cursorSql = '';
    if (beforeAt !== null && beforeSeq !== null) {
      params.push(beforeAt, beforeSeq);
      cursorSql = `AND (occurred_at < $1 OR (occurred_at = $1 AND event_seq < $2))`;
    }
    params.push(Math.max(RECENT_CORRELATION_SCAN_CHUNK, limit * 20));
    const limitPlaceholder = `$${params.length}`;
    const result = await postgresQuery(
      `SELECT ${column} AS id, occurred_at, event_seq
       FROM spine_events
       WHERE ${column} IS NOT NULL
         ${cursorSql}
       ORDER BY occurred_at DESC, event_seq DESC
       LIMIT ${limitPlaceholder}`,
      params,
    );
    if (result.rows.length === 0) break;

    for (const row of result.rows) {
      if (row.id && !seen.has(row.id)) {
        seen.set(row.id, row.occurred_at);
      }
    }
    scanned += result.rows.length;

    const ordered = [...seen.entries()]
      .map(([id, last_at]) => ({ id, last_at }))
      .sort(compareSummaryRows);
    if (ordered.length >= limit + 1) {
      const boundary = ordered[Math.min(limit, ordered.length - 1)]?.last_at;
      const lastRow = result.rows[result.rows.length - 1];
      if (boundary && String(lastRow?.occurred_at || '') < String(boundary)) {
        break;
      }
    }
    if (scanned >= RECENT_CORRELATION_SCAN_FALLBACK_AFTER) {
      return null;
    }

    const last = result.rows[result.rows.length - 1];
    beforeAt = last.occurred_at;
    beforeSeq = Number(last.event_seq || 0);
  }

  const orderedIds = [...seen.entries()]
    .map(([id, last_at]) => ({ id, last_at }))
    .sort(compareSummaryRows)
    .slice(0, limit + 1)
    .map((row) => row.id);
  if (orderedIds.length === 0) {
    return [];
  }
  const placeholders = orderedIds.map((_, i) => `$${i + 1}`).join(', ');
  const aggregate = await postgresQuery(
    `SELECT ${column} AS id, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at, COUNT(*)::int AS event_count
     FROM spine_events
     WHERE ${column} IN (${placeholders})
     GROUP BY ${column}`,
    orderedIds,
  );
  const byId = new Map(aggregate.rows.map((row) => [row.id, row]));
  return orderedIds.map((id) => byId.get(id)).filter(Boolean).sort(compareSummaryRows);
}

export async function postgresEmitSpineEvent(input = {}) {
  const event = normalize(input);
  const result = await postgresQuery(
    `INSERT INTO spine_events (
       event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
       actor_type, actor_id, subject_type, subject_id, object_type, object_id,
       status, request_id, grant_id, run_id, source_kind, source_id, client_id, stream_id,
       token_id, interaction_id, data_json, version
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17, $18, $19, $20,
       $21, $22, $23::jsonb, $24
     )
     RETURNING *`,
    [
      event.event_id,
      event.event_type,
      event.occurred_at,
      event.recorded_at,
      event.scenario_id,
      event.trace_id,
      event.actor_type,
      event.actor_id,
      event.subject_type,
      event.subject_id,
      event.object_type,
      event.object_id,
      event.status,
      event.request_id,
      event.grant_id,
      event.run_id,
      event.source_kind,
      event.source_id,
      event.client_id,
      event.stream_id,
      event.token_id,
      event.interaction_id,
      event.data_json,
      event.version,
    ],
  );
  return hydrate(result.rows[0]);
}

export async function postgresListSpineEventsPage(kind, id, opts = {}) {
  const column = COLUMN_BY_KIND[kind];
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 500));
  if (!column) return { events: [], truncated: false, next_cursor: null, limit };
  const cursorSeq = decodeEventCursor(opts.cursor);
  const result = await postgresQuery(
    `SELECT * FROM spine_events
     WHERE ${column} = $1 AND event_seq > $2
     ORDER BY event_seq ASC
     LIMIT $3`,
    [id, cursorSeq, limit + 1],
  );
  const truncated = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const last = rows[rows.length - 1];
  return {
    events: rows.map(hydrate),
    truncated,
    next_cursor: truncated ? encodeEventCursor(last.event_seq) : null,
    limit,
  };
}

/**
 * Look up the parent grant-package id for each grant id. The binding
 * fact lives on `grant_package_members`; the package's MCP refresh
 * token carries `tokens.package_id` but has a NULL `grant_id`, so a
 * tokens-side lookup misses every child grant. Returns a `Map<grantId,
 * packageId>` containing only grants that are package-bound. Used by
 * `listSpineCorrelations` to decorate grant rows on the operator
 * surface; called once per page so the join cost stays bounded.
 */
export async function postgresGrantPackageIdsForGrants(grantIds) {
  if (!Array.isArray(grantIds) || grantIds.length === 0) return new Map();
  const placeholders = grantIds.map((_, i) => `$${i + 1}`).join(', ');
  const result = await postgresQuery(
    `SELECT grant_id, package_id
       FROM grant_package_members
       WHERE grant_id IN (${placeholders})`,
    grantIds,
  );
  const out = new Map();
  for (const row of result.rows) {
    if (row.grant_id && row.package_id && !out.has(row.grant_id)) {
      out.set(row.grant_id, row.package_id);
    }
  }
  return out;
}

function clientMetadataFromOAuthRow(row) {
  let metadata = {};
  try {
    metadata = typeof row.metadata_json === 'string' ? JSON.parse(row.metadata_json) : (row.metadata_json || {});
  } catch {
    metadata = {};
  }
  const clientName = typeof metadata.client_name === 'string' && metadata.client_name.trim()
    ? metadata.client_name.trim()
    : null;
  return {
    client_id: row.client_id,
    client_name: clientName,
    registration_mode: typeof row.registration_mode === 'string' && row.registration_mode ? row.registration_mode : null,
  };
}

/**
 * Look up registered OAuth client metadata for the current page of grant
 * summaries. This is reference-operator display metadata only; the verified
 * identity remains the grant summary's top-level `client_id`.
 */
export async function postgresClientMetadataForClients(clientIds) {
  if (!Array.isArray(clientIds) || clientIds.length === 0) return new Map();
  const placeholders = clientIds.map((_, i) => `$${i + 1}`).join(', ');
  const result = await postgresQuery(
    `SELECT client_id, registration_mode, metadata_json::text AS metadata_json
       FROM oauth_clients
       WHERE client_id IN (${placeholders})`,
    clientIds,
  );
  const out = new Map();
  for (const row of result.rows) {
    if (row.client_id && !out.has(row.client_id)) {
      out.set(row.client_id, clientMetadataFromOAuthRow(row));
    }
  }
  return out;
}

function annotateGrantPackageId(summary, packageByGrant) {
  if (!summary) return summary;
  const gid = summary.grant_id || summary.id;
  const packageId = gid ? packageByGrant.get(gid) : null;
  return packageId ? { ...summary, grant_package_id: packageId } : summary;
}

function annotateClientMetadata(summary, clientById) {
  if (!summary?.client_id) return summary;
  const client = clientById.get(summary.client_id);
  return client ? { ...summary, client } : summary;
}

export async function postgresListSpineCorrelations(kind, filters = {}) {
  const column = COLUMN_BY_KIND[kind];
  if (!column) return { summaries: [], hasMore: false, nextCursor: null };
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 500));

  let resultRows = null;
  if (hasOnlyFirstPageRecentFilters(filters)) {
    resultRows = await listRecentCorrelationAggregates(column, limit);
  }

  // Event-column equality filters. These tag every event in a correlation
  // with the same value (or null), so applying them in the WHERE clause is
  // safe — the GROUP BY rolls up matching events into per-correlation rows.
  //
  // Without these filters, per-connector queries (e.g.
  // getLatestRunSummary("connectors/amazon")) silently returned the
  // global-latest run, making every connector row on the dashboard show
  // identical "last success / event count / status" values. The SQLite
  // path in lib/spine.ts already had this; the Postgres implementation
  // was incomplete. See docs/run-reconciliation-design-brief.md for the
  // broader event-projection discipline.
  const whereParts = [`${column} IS NOT NULL`];
  const params = [];
  if (filters.clientId) {
    params.push(filters.clientId);
    whereParts.push(`client_id = $${params.length}`);
  }
  if (filters.sourceKind) {
    params.push(String(filters.sourceKind));
    whereParts.push(`source_kind = $${params.length}`);
  }
  if (filters.sourceId) {
    params.push(filters.sourceId);
    whereParts.push(`source_id = $${params.length}`);
  }
  if (filters.grantId && column !== 'grant_id') {
    params.push(filters.grantId);
    whereParts.push(`grant_id = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${String(filters.q)}%`);
    whereParts.push(`${column} LIKE $${params.length}`);
  }

  // HAVING for since/until (compares against the correlation's MAX/MIN
  // occurred_at, computed by the same GROUP BY).
  const havingParts = [];
  if (filters.since) {
    params.push(filters.since);
    havingParts.push(`MAX(occurred_at) >= $${params.length}`);
  }
  if (filters.until) {
    params.push(filters.until);
    havingParts.push(`MIN(occurred_at) <= $${params.length}`);
  }
  const havingSql = havingParts.length > 0 ? ` HAVING ${havingParts.join(' AND ')}` : '';

  params.push(limit + 1);
  const limitPlaceholder = `$${params.length}`;

  if (resultRows === null) {
    const result = await postgresQuery(
      `SELECT ${column} AS id, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at, COUNT(*)::int AS event_count
       FROM spine_events
       WHERE ${whereParts.join(' AND ')}
       GROUP BY ${column}${havingSql}
       ORDER BY last_at DESC, id ASC
       LIMIT ${limitPlaceholder}`,
      params,
    );
    resultRows = result.rows;
  }

  // Page-scope filters (applied after the aggregation): status filter is
  // applied against the summary's projected run-status, so it must run
  // after summarizeRows. The SQLite path does the same.
  const pageRows = resultRows.slice(0, limit);
  let summaries = await mapWithConcurrency(pageRows, 8, async (row) => {
    const events = await fetchRowsForSummary(kind, column, row.id);
    return summarizeRows(row.id, events, row);
  });

  if (filters.status) {
    const wanted = String(filters.status);
    summaries = summaries.filter((s) => s && s.status === wanted);
  }

  if (kind === 'grant' && summaries.length > 0) {
    const ids = summaries
      .map((s) => s?.grant_id || s?.id)
      .filter((v) => typeof v === 'string' && v.length > 0);
    const packageByGrant = await postgresGrantPackageIdsForGrants(ids);
    if (packageByGrant.size > 0) {
      summaries = summaries.map((s) => annotateGrantPackageId(s, packageByGrant));
    }
  }

  if ((kind === 'grant' || kind === 'trace') && summaries.length > 0) {
    const clientIds = [...new Set(summaries
      .map((s) => s?.client_id)
      .filter((v) => typeof v === 'string' && v.length > 0))];
    const clientById = await postgresClientMetadataForClients(clientIds);
    if (clientById.size > 0) {
      summaries = summaries.map((s) => annotateClientMetadata(s, clientById));
    }
  }

  const hasMore = resultRows.length > limit;
  return {
    summaries,
    hasMore,
    nextCursor: hasMore ? encodeSummaryCursor(summaries[summaries.length - 1]) : null,
  };
}

export async function postgresSearchSpine(query) {
  const q = String(query || '').trim();
  if (!q) return { exact: null, traces: [], grants: [], runs: [] };
  const exactResult = await postgresQuery(
    `SELECT trace_id, grant_id, run_id
     FROM spine_events
     WHERE trace_id = $1 OR grant_id = $1 OR run_id = $1
     LIMIT 1`,
    [q],
  );
  const exactRow = exactResult.rows[0];
  const exact = exactRow?.trace_id === q
    ? { kind: 'trace', id: q }
    : exactRow?.grant_id === q
      ? { kind: 'grant', id: q }
      : exactRow?.run_id === q
        ? { kind: 'run', id: q }
        : null;

  const like = `%${q}%`;
  async function summaries(kind) {
    const column = COLUMN_BY_KIND[kind];
    const correlations = await postgresQuery(
      `SELECT ${column} AS id, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at, COUNT(*)::int AS event_count
       FROM spine_events
       WHERE ${column} ILIKE $1
       GROUP BY ${column}
       ORDER BY id ASC
       LIMIT 25`,
      [like],
    );
    const out = [];
    for (const row of correlations.rows) {
      const events = await fetchRowsForSummary(kind, column, row.id);
      out.push(await summarizeRows(row.id, events, row));
    }
    return out;
  }

  return {
    exact,
    traces: await summaries('trace'),
    grants: await summaries('grant'),
    runs: await summaries('run'),
  };
}
