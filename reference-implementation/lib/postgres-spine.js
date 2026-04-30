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

function summarizeRows(id, rows) {
  const events = rows.map(hydrate).filter(Boolean);
  const first = events[0] || {};
  const last = events[events.length - 1] || first;
  const kinds = [...new Set(events.map((event) => event.event_type).filter(Boolean))];
  const failureEvent = events.find((event) => event.status === 'failed' || event.status === 'rejected');
  const source = events.find((event) => event.source_kind && event.source_id);
  const connector = events.find((event) => event.source_kind === 'connector' && event.source_id);
  return {
    id,
    actor_id: last.actor_id || null,
    actor_type: last.actor_type || null,
    client_id: last.client_id || null,
    connector_id: connector?.source_id || null,
    event_count: events.length,
    failure: failureEvent
      ? {
          event_type: failureEvent.event_type,
          reason: typeof failureEvent.data?.reason === 'string' ? failureEvent.data.reason : null,
        }
      : null,
    first_at: first.occurred_at || null,
    grant_id: last.grant_id || null,
    kinds,
    last_at: last.occurred_at || null,
    needs_input: events.some((event) => event.status === 'needs_input'),
    request_id: last.request_id || null,
    run_id: last.run_id || null,
    source: source ? { kind: source.source_kind, id: source.source_id } : null,
    source_id: source?.source_id || null,
    source_kind: source?.source_kind || null,
    status: last.status || 'unknown',
    trace_id: last.trace_id || null,
  };
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

export async function postgresListSpineCorrelations(kind, filters = {}) {
  const column = COLUMN_BY_KIND[kind];
  if (!column) return { summaries: [], hasMore: false, nextCursor: null };
  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 500));
  const result = await postgresQuery(
    `SELECT ${column} AS id, MIN(occurred_at) AS first_at, MAX(occurred_at) AS last_at, COUNT(*)::int AS event_count
     FROM spine_events
     WHERE ${column} IS NOT NULL
     GROUP BY ${column}
     ORDER BY last_at DESC, id ASC
     LIMIT $1`,
    [limit + 1],
  );
  const pageRows = result.rows.slice(0, limit);
  const summaries = [];
  for (const row of pageRows) {
    const events = await postgresQuery(
      `SELECT * FROM spine_events WHERE ${column} = $1 ORDER BY event_seq ASC LIMIT 5000`,
      [row.id],
    );
    summaries.push(summarizeRows(row.id, events.rows));
  }
  const hasMore = result.rows.length > limit;
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
    const ids = await postgresQuery(
      `SELECT DISTINCT ${column} AS id
       FROM spine_events
       WHERE ${column} ILIKE $1
       ORDER BY id ASC
       LIMIT 25`,
      [like],
    );
    const out = [];
    for (const row of ids.rows) {
      const events = await postgresQuery(
        `SELECT * FROM spine_events WHERE ${column} = $1 ORDER BY event_seq ASC LIMIT 5000`,
        [row.id],
      );
      out.push(summarizeRows(row.id, events.rows));
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
