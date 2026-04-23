import { randomBytes } from 'crypto';
import { getDb } from '../server/db.js';

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

const INSERT_SPINE_EVENT_SQL = `
  INSERT INTO spine_events(
    event_id, event_type, occurred_at, recorded_at, scenario_id, trace_id,
    actor_type, actor_id, subject_type, subject_id, object_type, object_id,
    status, request_id, grant_id, run_id, provider_id, client_id, stream_id,
    token_id, interaction_id, data_json, version
  ) VALUES (
    @event_id, @event_type, @occurred_at, @recorded_at, @scenario_id, @trace_id,
    @actor_type, @actor_id, @subject_type, @subject_id, @object_type, @object_id,
    @status, @request_id, @grant_id, @run_id, @provider_id, @client_id, @stream_id,
    @token_id, @interaction_id, @data_json, @version
  )
`;

/**
 * Emit a spine event synchronously. Declared `async` for backwards-compatible
 * return shape (callers already `await` it); internally the `better-sqlite3`
 * INSERT is synchronous, so the returned Promise resolves on the next tick
 * with no I/O wait. That means callers inside a `db.transaction(fn)` block
 * can either call this without `await` or use the synchronous insert path
 * directly — the DB write has already happened when the call returns.
 */
export async function emitSpineEvent(input = {}, dbHandle = null) {
  const db = dbHandle || getDb();
  if (!db) return null;
  const event = normalizeEvent(input);

  db.prepare(INSERT_SPINE_EVENT_SQL).run(event);

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
    rows = db.prepare('SELECT * FROM spine_events WHERE trace_id = ? ORDER BY rowid').all(filters.traceId);
  } else if (filters.grantId) {
    rows = db.prepare('SELECT * FROM spine_events WHERE grant_id = ? ORDER BY rowid').all(filters.grantId);
  } else if (filters.runId) {
    rows = db.prepare('SELECT * FROM spine_events WHERE run_id = ? ORDER BY rowid').all(filters.runId);
  } else if (filters.eventType) {
    rows = db.prepare('SELECT * FROM spine_events WHERE event_type = ? ORDER BY rowid').all(filters.eventType);
  } else {
    rows = db.prepare('SELECT * FROM spine_events ORDER BY rowid').all();
  }

  return hydrateRows(rows);
}

/**
 * Aggregate spine events into per-correlation summaries.
 *
 * Reference-only helper used by the `_ref` list surfaces. Reads all spine
 * events (bounded by the reference corpus size) and groups them by the
 * requested correlation key.
 */
function connectorIdFromEvent(ev) {
  if (ev.actor_type === 'runtime' && ev.actor_id) return ev.actor_id;
  const d = ev.data || {};
  if (d.connector_id) return d.connector_id;
  if (d.source_binding && d.source_binding.connector_id) return d.source_binding.connector_id;
  if (d.source && d.source.connector_id) return d.source.connector_id;
  return null;
}

function summarizeEvents(events) {
  if (!events.length) return null;
  const first = events[0];
  const last = events[events.length - 1];
  const kinds = Array.from(new Set(events.map((e) => e.event_type))).slice(0, 16);
  let status = 'unknown';
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const s = events[i].status;
    if (s && s !== 'unknown') { status = s; break; }
  }
  const terminalFailure = events.find(
    (e) => e.status === 'failed' || e.status === 'rejected',
  );
  let connector_id = null;
  for (const ev of events) {
    const c = connectorIdFromEvent(ev);
    if (c) { connector_id = c; break; }
  }
  return {
    first_at: first.occurred_at,
    last_at: last.occurred_at,
    event_count: events.length,
    status,
    kinds,
    request_id: events.find((e) => e.request_id)?.request_id || null,
    grant_id: events.find((e) => e.grant_id)?.grant_id || null,
    trace_id: events.find((e) => e.trace_id)?.trace_id || null,
    run_id: events.find((e) => e.run_id)?.run_id || null,
    client_id: events.find((e) => e.client_id)?.client_id || null,
    provider_id: events.find((e) => e.provider_id)?.provider_id || null,
    connector_id,
    actor_type: first.actor_type,
    actor_id: first.actor_id,
    failure: terminalFailure
      ? {
          event_type: terminalFailure.event_type,
          reason: terminalFailure.data?.reason || terminalFailure.data?.failure_reason || null,
        }
      : null,
  };
}

function stableCursor(lastKey) {
  return lastKey;
}

function decodeCursor(cursor) {
  return cursor || null;
}

function applyFilters(summary, filters) {
  if (filters.status && summary.status !== filters.status) return false;
  if (filters.since && summary.last_at < filters.since) return false;
  if (filters.until && summary.first_at > filters.until) return false;
  if (filters.clientId && summary.client_id !== filters.clientId) return false;
  if (filters.providerId && summary.provider_id !== filters.providerId) return false;
  if (filters.grantId && summary.grant_id !== filters.grantId) return false;
  return true;
}

function deriveGrantLifecycleStatus(events) {
  // Pick the most advanced terminal state across the grant’s event history.
  // Order of precedence (strongest wins): revoked > denied > failed/rejected > issued > pending.
  let status = 'pending';
  for (const ev of events) {
    const t = ev.event_type;
    if (!t) continue;
    if (t === 'grant.revoked' || ev.status === 'revoked') return 'revoked';
    if (t === 'grant.denied' || t === 'consent.denied') {
      if (status !== 'revoked') status = 'denied';
      continue;
    }
    if (t === 'grant.rejected' || t === 'request.rejected' || ev.status === 'rejected' || ev.status === 'failed') {
      if (status === 'pending' || status === 'issued') status = 'failed';
      continue;
    }
    if (t === 'grant.issued' || ev.status === 'issued') {
      if (status === 'pending') status = 'issued';
      continue;
    }
  }
  return status;
}

export async function listSpineCorrelations(key, filters = {}) {
  const db = getDb();
  if (!db) return { summaries: [], hasMore: false, nextCursor: null };
  const rows = db.prepare('SELECT * FROM spine_events ORDER BY rowid').all();
  const events = hydrateRows(rows);
  const column =
    key === 'trace'
      ? 'trace_id'
      : key === 'grant'
      ? 'grant_id'
      : key === 'run'
      ? 'run_id'
      : null;
  if (!column) return { summaries: [], hasMore: false, nextCursor: null };

  const groups = new Map();
  for (const ev of events) {
    const id = ev[column];
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(ev);
  }

  const summaries = [];
  for (const [id, grouped] of groups.entries()) {
    const s = summarizeEvents(grouped);
    if (!s) continue;
    s.id = id;
    if (key === 'grant') s.status = deriveGrantLifecycleStatus(grouped);
    if (!applyFilters(s, filters)) continue;
    if (filters.connectorId && s.connector_id !== filters.connectorId) continue;
    if (filters.q) {
      const needle = String(filters.q).toLowerCase();
      const hay = `${id} ${s.request_id || ''} ${s.grant_id || ''} ${s.run_id || ''} ${s.client_id || ''} ${s.provider_id || ''}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    summaries.push(s);
  }

  summaries.sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0));

  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 500));
  const cursorAt = decodeCursor(filters.cursor);
  const startIndex = cursorAt
    ? summaries.findIndex((s) => `${s.last_at}::${s.id}` === cursorAt) + 1
    : 0;
  const effectiveStart = startIndex < 0 ? 0 : startIndex;
  const page = summaries.slice(effectiveStart, effectiveStart + limit);
  const hasMore = effectiveStart + limit < summaries.length;
  const nextCursor = hasMore && page.length
    ? stableCursor(`${page[page.length - 1].last_at}::${page[page.length - 1].id}`)
    : null;
  return { summaries: page, hasMore, nextCursor };
}

export async function searchSpine(query) {
  const db = getDb();
  if (!db) return { exact: null, traces: [], grants: [], runs: [] };
  const q = String(query || '').trim();
  if (!q) return { exact: null, traces: [], grants: [], runs: [] };

  const rows = db.prepare('SELECT * FROM spine_events ORDER BY rowid').all();
  const events = hydrateRows(rows);

  const exactMatch = (() => {
    for (const ev of events) {
      if (ev.trace_id === q) return { kind: 'trace', id: q };
      if (ev.grant_id === q) return { kind: 'grant', id: q };
      if (ev.run_id === q) return { kind: 'run', id: q };
      if (ev.request_id === q) return ev.trace_id ? { kind: 'trace', id: ev.trace_id } : null;
    }
    return null;
  })();

  const summariesByKey = (column) => {
    const groups = new Map();
    for (const ev of events) {
      const id = ev[column];
      if (!id) continue;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id).push(ev);
    }
    const out = [];
    const needle = q.toLowerCase();
    for (const [id, grouped] of groups.entries()) {
      const s = summarizeEvents(grouped);
      if (!s) continue;
      s.id = id;
      if (column === 'grant_id') s.status = deriveGrantLifecycleStatus(grouped);
      const hay = `${id} ${s.request_id || ''} ${s.grant_id || ''} ${s.run_id || ''} ${s.client_id || ''} ${s.provider_id || ''}`.toLowerCase();
      if (!hay.includes(needle)) continue;
      out.push(s);
    }
    out.sort((a, b) => (a.last_at < b.last_at ? 1 : a.last_at > b.last_at ? -1 : 0));
    return out.slice(0, 10);
  };

  return {
    exact: exactMatch,
    traces: summariesByKey('trace_id'),
    grants: summariesByKey('grant_id'),
    runs: summariesByKey('run_id'),
  };
}
