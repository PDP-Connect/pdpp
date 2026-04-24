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

const CORRELATION_COLUMN = {
  trace: 'trace_id',
  grant: 'grant_id',
  run: 'run_id',
};

/**
 * SQL-level aggregation of spine events into per-correlation summaries.
 *
 * Slice-3 replacement for the full-scan version that read every spine_event,
 * grouped in JS, sorted in JS, paged in JS. New shape:
 *
 *   1. SQL `GROUP BY <correlation_column>` with bounded aggregates and SQL
 *      LIMIT/ORDER BY. `since`/`until`/`status` (strict — i.e., existence of
 *      any matching event) push into the WHERE clause. `clientId`/`providerId`/
 *      `grantId` are event-column equality filters pushed into WHERE too.
 *   2. SQL `q` narrowing via LIKE on the indexed correlation columns.
 *      Secondary-field LIKE (request_id / client_id / provider_id) stays as a
 *      page-scope filter in JS to avoid a Cartesian product in the GROUP BY.
 *   3. Page-scope hydration: for the at-most-`limit` group ids, fetch their
 *      events via `listSpineEvents({[key]: id})` (already indexed) and run
 *      `summarizeEvents` / `deriveGrantLifecycleStatus` to produce the same
 *      response shape as before.
 *   4. Page-scope JS filters: `connectorId` (derived from event JSON) and
 *      the fuzzy `q` match on secondary fields.
 *
 * Backwards-compatible return shape: `{summaries, hasMore, nextCursor}`. The
 * cursor remains `"<last_at>::<id>"` encoded via `stableCursor`.
 */
export async function listSpineCorrelations(key, filters = {}) {
  const db = getDb();
  if (!db) return { summaries: [], hasMore: false, nextCursor: null };
  const column = CORRELATION_COLUMN[key];
  if (!column) return { summaries: [], hasMore: false, nextCursor: null };

  const limit = Math.max(1, Math.min(Number(filters.limit) || 50, 500));

  const whereParts = [`${column} IS NOT NULL`];
  const whereBinds = [];

  // since/until: test against MAX/MIN respectively, done as HAVING after GROUP BY.
  const havingParts = [];
  const havingBinds = [];
  if (filters.since) {
    havingParts.push('MAX(occurred_at) >= ?');
    havingBinds.push(filters.since);
  }
  if (filters.until) {
    havingParts.push('MIN(occurred_at) <= ?');
    havingBinds.push(filters.until);
  }

  // Event-column equality filters. Valid because these columns tag the event
  // and every event in a correlation carries the same value (or null) for them.
  if (filters.clientId) {
    whereParts.push('client_id = ?');
    whereBinds.push(filters.clientId);
  }
  if (filters.providerId) {
    whereParts.push('provider_id = ?');
    whereBinds.push(filters.providerId);
  }
  if (filters.grantId && column !== 'grant_id') {
    whereParts.push('grant_id = ?');
    whereBinds.push(filters.grantId);
  }

  // q narrowing on the indexed correlation column. Secondary-field LIKE stays
  // in the page-scope pass below.
  if (filters.q) {
    whereParts.push(`${column} LIKE ?`);
    whereBinds.push(`%${String(filters.q)}%`);
  }

  // Cursor seek: pages are ordered by (last_at DESC, id DESC) for stability.
  // The cursor encodes the last `(last_at, id)` of the previous page; we skip
  // to rows strictly after it in that order.
  const cursorValue = decodeCursor(filters.cursor);
  let cursorLastAt = null;
  let cursorId = null;
  if (cursorValue) {
    const sep = cursorValue.indexOf('::');
    if (sep > 0) {
      cursorLastAt = cursorValue.slice(0, sep);
      cursorId = cursorValue.slice(sep + 2);
    }
  }

  // Over-fetch by a generous multiplier so the page-scope JS filters (status,
  // connectorId, fuzzy q on secondary fields) have room to reject without
  // under-filling the response. Bounded and still cheap vs. reading every row.
  const sqlLimit = limit * 4;

  // For `grant` key, status comes from event-type lifecycle derivation and
  // cannot be filtered in SQL. For `trace` and `run`, status is "last event's
  // status" — also derived post-aggregate. Both are applied in the JS pass.
  if (cursorLastAt) {
    havingParts.push(`(MAX(occurred_at) < ? OR (MAX(occurred_at) = ? AND ${column} < ?))`);
    havingBinds.push(cursorLastAt, cursorLastAt, cursorId);
  }
  const havingSql = havingParts.length ? ` HAVING ${havingParts.join(' AND ')}` : '';

  const sql = `
    SELECT
      ${column} AS id,
      MIN(occurred_at) AS first_at,
      MAX(occurred_at) AS last_at,
      COUNT(*) AS event_count
    FROM spine_events
    WHERE ${whereParts.join(' AND ')}
    GROUP BY ${column}${havingSql}
    ORDER BY last_at DESC, id DESC
    LIMIT ?
  `;

  const aggRows = db.prepare(sql).all(...whereBinds, ...havingBinds, sqlLimit);

  const summaries = [];
  const listEventsByCorrelation = {
    trace_id: (id) => listSpineEventsSync(db, { traceId: id }),
    grant_id: (id) => listSpineEventsSync(db, { grantId: id }),
    run_id: (id) => listSpineEventsSync(db, { runId: id }),
  };

  for (const aggRow of aggRows) {
    const events = listEventsByCorrelation[column](aggRow.id);
    if (!events.length) continue;
    const s = summarizeEvents(events);
    if (!s) continue;
    s.id = aggRow.id;
    if (key === 'grant') s.status = deriveGrantLifecycleStatus(events);

    if (!applyFilters(s, filters)) continue;
    if (filters.connectorId && s.connector_id !== filters.connectorId) continue;
    if (filters.q) {
      const needle = String(filters.q).toLowerCase();
      const hay = `${aggRow.id} ${s.request_id || ''} ${s.grant_id || ''} ${s.run_id || ''} ${s.client_id || ''} ${s.provider_id || ''}`.toLowerCase();
      if (!hay.includes(needle)) continue;
    }

    summaries.push(s);
    if (summaries.length >= limit + 1) break;
  }

  const hasMore = summaries.length > limit;
  const page = summaries.slice(0, limit);
  const nextCursor = hasMore && page.length
    ? stableCursor(`${page[page.length - 1].last_at}::${page[page.length - 1].id}`)
    : null;
  return { summaries: page, hasMore, nextCursor };
}

/**
 * Synchronous internal helper — `listSpineEvents` wraps the same work in a
 * Promise for historical reasons, but the aggregation loop above needs the
 * rows in the same call frame to avoid an extra Promise allocation per group.
 */
function listSpineEventsSync(db, filters) {
  let rows;
  if (filters.traceId) {
    rows = db.prepare('SELECT * FROM spine_events WHERE trace_id = ? ORDER BY rowid').all(filters.traceId);
  } else if (filters.grantId) {
    rows = db.prepare('SELECT * FROM spine_events WHERE grant_id = ? ORDER BY rowid').all(filters.grantId);
  } else if (filters.runId) {
    rows = db.prepare('SELECT * FROM spine_events WHERE run_id = ? ORDER BY rowid').all(filters.runId);
  } else {
    rows = [];
  }
  return hydrateRows(rows);
}

/**
 * SQL-indexed search across spine_events. Exact match uses equality on the
 * indexed (trace_id, grant_id, run_id) columns and a fallback equality on
 * request_id. Fuzzy matches use LIKE on each indexed column; we fetch at
 * most `limit + 1` distinct ids per column and summarize them page-scope.
 *
 * Replaces the full-scan variant which read every spine_event row.
 */
export async function searchSpine(query) {
  const db = getDb();
  if (!db) return { exact: null, traces: [], grants: [], runs: [] };
  const q = String(query || '').trim();
  if (!q) return { exact: null, traces: [], grants: [], runs: [] };

  const exactMatch = (() => {
    // Indexed equality on the correlation columns — O(log N).
    for (const { column, kind } of [
      { column: 'trace_id', kind: 'trace' },
      { column: 'grant_id', kind: 'grant' },
      { column: 'run_id', kind: 'run' },
    ]) {
      const row = db.prepare(
        `SELECT 1 FROM spine_events WHERE ${column} = ? LIMIT 1`,
      ).get(q);
      if (row) return { kind, id: q };
    }
    // request_id is un-indexed but small-cardinality; the lookup is bounded by
    // the very rare case where request_id equals the query string.
    const fallback = db.prepare(
      'SELECT trace_id FROM spine_events WHERE request_id = ? AND trace_id IS NOT NULL LIMIT 1',
    ).get(q);
    if (fallback?.trace_id) return { kind: 'trace', id: fallback.trace_id };
    return null;
  })();

  const like = `%${q}%`;
  const summariesByKey = (column) => {
    // Find distinct ids where the correlation column LIKEs the needle. Bound
    // to 10 rows (same as the legacy behavior) — cheap on indexed TEXT columns.
    const idRows = db.prepare(
      `SELECT DISTINCT ${column} AS id, MAX(occurred_at) AS last_at
         FROM spine_events
        WHERE ${column} IS NOT NULL
          AND ${column} LIKE ?
        GROUP BY ${column}
        ORDER BY last_at DESC
        LIMIT 10`,
    ).all(like);

    const filterKey = column === 'trace_id' ? 'traceId' : column === 'grant_id' ? 'grantId' : 'runId';
    const out = [];
    for (const { id } of idRows) {
      const events = listSpineEventsSync(db, { [filterKey]: id });
      if (!events.length) continue;
      const s = summarizeEvents(events);
      if (!s) continue;
      s.id = id;
      if (column === 'grant_id') s.status = deriveGrantLifecycleStatus(events);
      out.push(s);
    }
    return out;
  };

  return {
    exact: exactMatch,
    traces: summariesByKey('trace_id'),
    grants: summariesByKey('grant_id'),
    runs: summariesByKey('run_id'),
  };
}
