import { randomBytes } from 'crypto';
import { getDb, sql } from '../server/db.js';

export const DEFAULT_SCENARIO_ID = 'scn_reference_default';
const SPINE_VERSION = 'reference.spine.v1';

export function generateSpineId(prefix) {
    return `${prefix}_${randomBytes(8).toString('hex')}`;
}

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(raw, fallback = null) {
  try {
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

export function createTraceContext({ scenarioId = DEFAULT_SCENARIO_ID } = {}) {
  return {
    scenario_id: scenarioId,
    trace_id: generateSpineId('trc'),
    request_id: generateSpineId('req'),
  };
}

function normalizeEvent(input = {}) {
  const occurredAt = input.occurred_at || nowIso();
  return {
    event_id: input.event_id || generateSpineId('evt'),
    event_type: input.event_type,
    occurred_at: occurredAt,
    recorded_at: nowIso(),
    scenario_id: input.scenario_id || DEFAULT_SCENARIO_ID,
    trace_id: input.trace_id || generateSpineId('trc'),
    actor_type: input.actor_type || 'system',
    actor_id: input.actor_id || 'pdpp_reference',
    subject_type: input.subject_type || null,
    subject_id: input.subject_id || null,
    object_type: input.object_type || 'event',
    object_id: input.object_id || generateSpineId('obj'),
    status: input.status || 'succeeded',
    request_id: input.request_id || null,
    grant_id: input.grant_id || null,
    run_id: input.run_id || null,
    provider_id: input.provider_id || null,
    client_id: input.client_id || null,
    stream_id: input.stream_id || null,
    token_id: input.token_id || null,
    interaction_id: input.interaction_id || null,
    data_json: JSON.stringify(input.data || {}),
    version: input.version || SPINE_VERSION,
  };
}

export async function emitSpineEvent(input = {}, dbHandle = null) {
  const db = dbHandle || getDb();
  if (!db) return null;
  const event = normalizeEvent(input);

  await db.query(sql`
    INSERT INTO spine_events(
      event_id,
      event_type,
      occurred_at,
      recorded_at,
      scenario_id,
      trace_id,
      actor_type,
      actor_id,
      subject_type,
      subject_id,
      object_type,
      object_id,
      status,
      request_id,
      grant_id,
      run_id,
      provider_id,
      client_id,
      stream_id,
      token_id,
      interaction_id,
      data_json,
      version
    )
    VALUES(
      ${event.event_id},
      ${event.event_type},
      ${event.occurred_at},
      ${event.recorded_at},
      ${event.scenario_id},
      ${event.trace_id},
      ${event.actor_type},
      ${event.actor_id},
      ${event.subject_type},
      ${event.subject_id},
      ${event.object_type},
      ${event.object_id},
      ${event.status},
      ${event.request_id},
      ${event.grant_id},
      ${event.run_id},
      ${event.provider_id},
      ${event.client_id},
      ${event.stream_id},
      ${event.token_id},
      ${event.interaction_id},
      ${event.data_json},
      ${event.version}
    )
  `);

  return {
    ...event,
    data: safeJsonParse(event.data_json, {}),
  };
}

function hydrateRows(rows) {
  return rows.map((row) => ({
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
    provider_id: row.provider_id,
    client_id: row.client_id,
    stream_id: row.stream_id,
    token_id: row.token_id,
    interaction_id: row.interaction_id,
    data: safeJsonParse(row.data_json, {}),
    version: row.version,
  }));
}

export async function listSpineEvents(filters = {}) {
  const db = getDb();
  if (!db) return [];

  let rows;
  if (filters.traceId) {
    rows = await db.query(sql`SELECT * FROM spine_events WHERE trace_id = ${filters.traceId} ORDER BY rowid`);
  } else if (filters.grantId) {
    rows = await db.query(sql`SELECT * FROM spine_events WHERE grant_id = ${filters.grantId} ORDER BY rowid`);
  } else if (filters.runId) {
    rows = await db.query(sql`SELECT * FROM spine_events WHERE run_id = ${filters.runId} ORDER BY rowid`);
  } else if (filters.eventType) {
    rows = await db.query(sql`SELECT * FROM spine_events WHERE event_type = ${filters.eventType} ORDER BY rowid`);
  } else {
    rows = await db.query(sql`SELECT * FROM spine_events ORDER BY rowid`);
  }

  return hydrateRows(rows);
}
