/**
 * Retained-size read model — reference-only, owner-facing.
 *
 * Backs the bounded `_ref` retained-size reads at global, connection, and
 * stream grain. The active storage backend (SQLite default, Postgres when
 * PDPP_STORAGE_BACKEND=postgres) owns the projection rows, so a Postgres
 * deployment never serves stale SQLite projection rows as live truth.
 *
 * Spec: openspec/changes/add-retained-size-read-model/
 */

import { getDb } from './db.js';
import {
  isPostgresStorageBackend,
  postgresQuery,
  withPostgresTransaction,
} from './postgres-storage.js';

const GLOBAL_KEY = 'global';
// Bound the top-N response. Bigger limits invite cardinality blow-ups and
// turn an owner introspection read into a corpus scan. 25 covers the
// useful "what's eating my dataset" question without becoming a query
// builder.
const MAX_TOP_LIMIT = 25;
const DEFAULT_TOP_LIMIT = 10;
const VALID_TOP_SCOPES = new Set(['connection', 'stream', 'record', 'blob']);
const VALID_TOP_MEASURES = new Set([
  'total_retained_bytes',
  'current_record_json_bytes',
  'record_history_json_bytes',
  'blob_bytes',
  'record_count',
  'record_history_count',
  'blob_count',
]);

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

function emptyMeasures() {
  return {
    current_record_json_bytes: 0,
    record_history_json_bytes: 0,
    blob_bytes: 0,
    record_count: 0,
    record_history_count: 0,
    blob_count: 0,
  };
}

function totalBytesFromMeasures(m) {
  return Number(m.current_record_json_bytes || 0)
    + Number(m.record_history_json_bytes || 0)
    + Number(m.blob_bytes || 0);
}

function defaultMetadata(at) {
  return {
    state: 'rebuilding',
    stale_since: at,
    rebuild_status: 'idle',
    last_error: null,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getRetainedSizeGlobal() {
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT current_record_json_bytes, record_history_json_bytes, blob_bytes,
              record_count, record_history_count, blob_count,
              dirty, computed_at, metadata_json
         FROM retained_size_global
        WHERE projection_key = $1`,
      [GLOBAL_KEY],
    );
    return shapeGlobalRow(result.rows[0]);
  }
  const row = getDb()
    .prepare(
      `SELECT current_record_json_bytes, record_history_json_bytes, blob_bytes,
              record_count, record_history_count, blob_count,
              dirty, computed_at, metadata_json
         FROM retained_size_global
        WHERE projection_key = ?`,
    )
    .get(GLOBAL_KEY);
  return shapeGlobalRow(row);
}

function shapeGlobalRow(row) {
  if (!row) {
    const at = nowIso();
    const measures = emptyMeasures();
    return {
      grain: 'global',
      ...measures,
      total_retained_bytes: 0,
      dirty: true,
      computed_at: null,
      metadata: { ...defaultMetadata(at), computed_at: null },
    };
  }
  const measures = {
    current_record_json_bytes: Number(row.current_record_json_bytes || 0),
    record_history_json_bytes: Number(row.record_history_json_bytes || 0),
    blob_bytes: Number(row.blob_bytes || 0),
    record_count: Number(row.record_count || 0),
    record_history_count: Number(row.record_history_count || 0),
    blob_count: Number(row.blob_count || 0),
  };
  const metadata = parseMetadata(row.metadata_json) || defaultMetadata(row.computed_at || nowIso());
  return {
    grain: 'global',
    ...measures,
    total_retained_bytes: totalBytesFromMeasures(measures),
    dirty: Number(row.dirty || 0) !== 0,
    computed_at: row.computed_at || null,
    metadata: { ...metadata, computed_at: row.computed_at || metadata.computed_at || null },
  };
}

function parseMetadata(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  return parseJson(String(value), null);
}

export async function listRetainedSizeConnections({ connectorInstanceId } = {}) {
  if (isPostgresStorageBackend()) {
    const params = [];
    let where = '';
    if (connectorInstanceId) {
      params.push(connectorInstanceId);
      where = `WHERE connector_instance_id = $${params.length}`;
    }
    const result = await postgresQuery(
      `SELECT connector_instance_id, connector_id,
              current_record_json_bytes, record_history_json_bytes, blob_bytes,
              record_count, record_history_count, blob_count,
              dirty, computed_at
         FROM retained_size_connection
         ${where}
         ORDER BY connector_instance_id ASC`,
      params,
    );
    return result.rows.map(shapeConnectionRow);
  }
  const db = getDb();
  const rows = connectorInstanceId
    ? db
      .prepare(
        `SELECT connector_instance_id, connector_id,
                current_record_json_bytes, record_history_json_bytes, blob_bytes,
                record_count, record_history_count, blob_count,
                dirty, computed_at
           FROM retained_size_connection
          WHERE connector_instance_id = ?
          ORDER BY connector_instance_id ASC`,
      )
      .all(connectorInstanceId)
    : db
      .prepare(
        `SELECT connector_instance_id, connector_id,
                current_record_json_bytes, record_history_json_bytes, blob_bytes,
                record_count, record_history_count, blob_count,
                dirty, computed_at
           FROM retained_size_connection
          ORDER BY connector_instance_id ASC`,
      )
      .all();
  return rows.map(shapeConnectionRow);
}

function shapeConnectionRow(row) {
  const measures = {
    current_record_json_bytes: Number(row.current_record_json_bytes || 0),
    record_history_json_bytes: Number(row.record_history_json_bytes || 0),
    blob_bytes: Number(row.blob_bytes || 0),
    record_count: Number(row.record_count || 0),
    record_history_count: Number(row.record_history_count || 0),
    blob_count: Number(row.blob_count || 0),
  };
  return {
    grain: 'connection',
    connector_instance_id: row.connector_instance_id,
    connector_id: row.connector_id,
    ...measures,
    total_retained_bytes: totalBytesFromMeasures(measures),
    dirty: Number(row.dirty || 0) !== 0,
    computed_at: row.computed_at || null,
  };
}

export async function listRetainedSizeStreams({ connectorInstanceId, stream } = {}) {
  if (isPostgresStorageBackend()) {
    const params = [];
    const clauses = [];
    if (connectorInstanceId) {
      params.push(connectorInstanceId);
      clauses.push(`connector_instance_id = $${params.length}`);
    }
    if (stream) {
      params.push(stream);
      clauses.push(`stream = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await postgresQuery(
      `SELECT connector_instance_id, connector_id, stream,
              current_record_json_bytes, record_history_json_bytes, blob_bytes,
              record_count, record_history_count, blob_count,
              dirty, computed_at
         FROM retained_size_stream
         ${where}
         ORDER BY connector_instance_id ASC, stream ASC`,
      params,
    );
    return result.rows.map(shapeStreamRow);
  }
  const db = getDb();
  let sql = `SELECT connector_instance_id, connector_id, stream,
                    current_record_json_bytes, record_history_json_bytes, blob_bytes,
                    record_count, record_history_count, blob_count,
                    dirty, computed_at
             FROM retained_size_stream`;
  const where = [];
  const params = [];
  if (connectorInstanceId) {
    where.push('connector_instance_id = ?');
    params.push(connectorInstanceId);
  }
  if (stream) {
    where.push('stream = ?');
    params.push(stream);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY connector_instance_id ASC, stream ASC';
  const rows = db.prepare(sql).all(...params);
  return rows.map(shapeStreamRow);
}

export async function listRetainedSizeRecordFamilies({
  connectorInstanceId,
  stream,
  recordFamily,
} = {}) {
  if (isPostgresStorageBackend()) {
    const params = [];
    const clauses = [];
    if (connectorInstanceId) {
      params.push(connectorInstanceId);
      clauses.push(`connector_instance_id = $${params.length}`);
    }
    if (stream) {
      params.push(stream);
      clauses.push(`stream = $${params.length}`);
    }
    if (recordFamily) {
      params.push(recordFamily);
      clauses.push(`record_family = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const result = await postgresQuery(
      `SELECT connector_instance_id, connector_id, stream, record_family,
              current_record_json_bytes, record_history_json_bytes, blob_bytes,
              record_count, record_history_count, blob_count,
              dirty, computed_at
         FROM retained_size_record_family
         ${where}
         ORDER BY connector_instance_id ASC, stream ASC, record_family ASC`,
      params,
    );
    return result.rows.map(shapeRecordFamilyRow);
  }
  const db = getDb();
  let sql = `SELECT connector_instance_id, connector_id, stream, record_family,
                    current_record_json_bytes, record_history_json_bytes, blob_bytes,
                    record_count, record_history_count, blob_count,
                    dirty, computed_at
               FROM retained_size_record_family`;
  const where = [];
  const params = [];
  if (connectorInstanceId) {
    where.push('connector_instance_id = ?');
    params.push(connectorInstanceId);
  }
  if (stream) {
    where.push('stream = ?');
    params.push(stream);
  }
  if (recordFamily) {
    where.push('record_family = ?');
    params.push(recordFamily);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY connector_instance_id ASC, stream ASC, record_family ASC';
  const rows = db.prepare(sql).all(...params);
  return rows.map(shapeRecordFamilyRow);
}

function shapeStreamRow(row) {
  const measures = {
    current_record_json_bytes: Number(row.current_record_json_bytes || 0),
    record_history_json_bytes: Number(row.record_history_json_bytes || 0),
    blob_bytes: Number(row.blob_bytes || 0),
    record_count: Number(row.record_count || 0),
    record_history_count: Number(row.record_history_count || 0),
    blob_count: Number(row.blob_count || 0),
  };
  return {
    grain: 'stream',
    connector_instance_id: row.connector_instance_id,
    connector_id: row.connector_id,
    stream: row.stream,
    ...measures,
    total_retained_bytes: totalBytesFromMeasures(measures),
    dirty: Number(row.dirty || 0) !== 0,
    computed_at: row.computed_at || null,
  };
}

function shapeRecordFamilyRow(row) {
  const stream = shapeStreamRow(row);
  return {
    ...stream,
    grain: 'record_family',
    record_family: row.record_family,
  };
}

export function clampTopLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TOP_LIMIT;
  return Math.min(MAX_TOP_LIMIT, Math.max(1, Math.floor(parsed)));
}

export function isValidTopScope(value) {
  return VALID_TOP_SCOPES.has(value);
}

export function isValidTopMeasure(value) {
  return VALID_TOP_MEASURES.has(value);
}

export async function listRetainedSizeTop({ scope, measure, limit } = {}) {
  if (!isValidTopScope(scope)) {
    const err = new Error(`unsupported retained-size top-N scope '${scope}'`);
    err.code = 'invalid_request';
    throw err;
  }
  if (!isValidTopMeasure(measure)) {
    const err = new Error(`unsupported retained-size top-N measure '${measure}'`);
    err.code = 'invalid_request';
    throw err;
  }
  const effectiveLimit = clampTopLimit(limit);

  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT scope, measure, rank, grain_key,
              connector_instance_id, connector_id, stream, record_key, blob_id,
              current_record_json_bytes, record_history_json_bytes, blob_bytes,
              total_retained_bytes, record_count, record_history_count, blob_count,
              dirty, computed_at, metadata_json
         FROM retained_size_top_rows
        WHERE scope = $1 AND measure = $2
        ORDER BY rank ASC
        LIMIT $3`,
      [scope, measure, effectiveLimit],
    );
    return result.rows.map(shapeTopRow);
  }
  const rows = getDb()
    .prepare(
      `SELECT scope, measure, rank, grain_key,
              connector_instance_id, connector_id, stream, record_key, blob_id,
              current_record_json_bytes, record_history_json_bytes, blob_bytes,
              total_retained_bytes, record_count, record_history_count, blob_count,
              dirty, computed_at, metadata_json
         FROM retained_size_top_rows
        WHERE scope = ? AND measure = ?
        ORDER BY rank ASC
        LIMIT ?`,
    )
    .all(scope, measure, effectiveLimit);
  return rows.map(shapeTopRow);
}

function shapeTopRow(row) {
  const measures = {
    current_record_json_bytes: Number(row.current_record_json_bytes || 0),
    record_history_json_bytes: Number(row.record_history_json_bytes || 0),
    blob_bytes: Number(row.blob_bytes || 0),
    record_count: Number(row.record_count || 0),
    record_history_count: Number(row.record_history_count || 0),
    blob_count: Number(row.blob_count || 0),
  };
  return {
    grain: row.scope,
    scope: row.scope,
    measure: row.measure,
    rank: Number(row.rank || 0),
    grain_key: row.grain_key,
    connector_instance_id: row.connector_instance_id || null,
    connector_id: row.connector_id || null,
    stream: row.stream || null,
    record_key: row.record_key || null,
    blob_id: row.blob_id || null,
    ...measures,
    total_retained_bytes: Number(row.total_retained_bytes || totalBytesFromMeasures(measures)),
    dirty: Number(row.dirty || 0) !== 0,
    computed_at: row.computed_at || null,
    metadata: parseMetadata(row.metadata_json) || null,
  };
}

// ---------------------------------------------------------------------------
// Incremental maintenance
// ---------------------------------------------------------------------------

/**
 * Apply a record-write delta. Called from the durable record ingest path
 * AFTER the canonical row is committed. Failures must NOT propagate back —
 * they mark the projection dirty so a subsequent rebuild/reconcile pass
 * repairs it. Same contract as applyDatasetSummaryRecordDelta.
 */
export async function applyRetainedSizeRecordDelta(delta) {
  try {
    if (isPostgresStorageBackend()) {
      await applyRecordDeltaPostgres(delta);
      return;
    }
    applyRecordDeltaSqlite(delta);
  } catch (err) {
    await markRetainedSizeDirty(`retained-size record delta failed: ${sanitizeProjectionError(err)}`);
  }
}

/**
 * Apply a blob-write delta. Counts and bytes are attributed to the
 * (connector_instance_id, connector_id, stream) grain captured at blob
 * insert/binding time. Same dirty-on-failure contract as record deltas.
 */
export async function applyRetainedSizeBlobDelta(delta) {
  try {
    if (isPostgresStorageBackend()) {
      await applyBlobDeltaPostgres(delta);
      return;
    }
    applyBlobDeltaSqlite(delta);
  } catch (err) {
    await markRetainedSizeDirty(`retained-size blob delta failed: ${sanitizeProjectionError(err)}`);
  }
}

function applyRecordDeltaSqlite(delta) {
  const db = getDb();
  const computedAt = nowIso();
  db.transaction(() => {
    upsertStreamRowSqlite(delta, computedAt);
    upsertConnectionRowSqlite(delta, computedAt);
    applyGlobalDeltaSqlite(delta, computedAt);
    markTopRowsDirtySqlite(db, 'record delta changed retained-size ordering', computedAt);
  })();
}

async function applyRecordDeltaPostgres(delta) {
  const computedAt = nowIso();
  await withPostgresTransaction(async (client) => {
    await upsertStreamRowPostgres(client, delta, computedAt);
    await upsertConnectionRowPostgres(client, delta, computedAt);
    await applyGlobalDeltaPostgres(client, delta, computedAt);
    await markTopRowsDirtyPostgres(client, 'record delta changed retained-size ordering', computedAt);
  });
}

function applyBlobDeltaSqlite(delta) {
  const db = getDb();
  const computedAt = nowIso();
  db.transaction(() => {
    upsertStreamRowSqlite(delta, computedAt);
    upsertConnectionRowSqlite(delta, computedAt);
    applyGlobalDeltaSqlite(delta, computedAt);
    markTopRowsDirtySqlite(db, 'blob delta changed retained-size ordering', computedAt);
  })();
}

async function applyBlobDeltaPostgres(delta) {
  const computedAt = nowIso();
  await withPostgresTransaction(async (client) => {
    await upsertStreamRowPostgres(client, delta, computedAt);
    await upsertConnectionRowPostgres(client, delta, computedAt);
    await applyGlobalDeltaPostgres(client, delta, computedAt);
    await markTopRowsDirtyPostgres(client, 'blob delta changed retained-size ordering', computedAt);
  });
}

function normalizedDelta(delta) {
  return {
    connector_instance_id: delta.connectorInstanceId || null,
    connector_id: delta.connectorId || null,
    stream: delta.stream || null,
    current_record_json_bytes_delta: Number(delta.currentRecordJsonBytesDelta || 0),
    record_history_json_bytes_delta: Number(delta.recordHistoryJsonBytesDelta || 0),
    blob_bytes_delta: Number(delta.blobBytesDelta || 0),
    record_count_delta: Number(delta.recordCountDelta || 0),
    record_history_count_delta: Number(delta.recordHistoryCountDelta || 0),
    blob_count_delta: Number(delta.blobCountDelta || 0),
  };
}

function upsertStreamRowSqlite(rawDelta, computedAt) {
  const delta = normalizedDelta(rawDelta);
  if (!delta.connector_instance_id || !delta.connector_id || !delta.stream) {
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO retained_size_stream(
         connector_instance_id, connector_id, stream,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(connector_instance_id, stream) DO UPDATE SET
         current_record_json_bytes = MAX(0, current_record_json_bytes + ?),
         record_history_json_bytes = MAX(0, record_history_json_bytes + ?),
         blob_bytes = MAX(0, blob_bytes + ?),
         record_count = MAX(0, record_count + ?),
         record_history_count = MAX(0, record_history_count + ?),
         blob_count = MAX(0, blob_count + ?),
         computed_at = ?`,
    )
    .run(
      delta.connector_instance_id,
      delta.connector_id,
      delta.stream,
      Math.max(0, delta.current_record_json_bytes_delta),
      Math.max(0, delta.record_history_json_bytes_delta),
      Math.max(0, delta.blob_bytes_delta),
      Math.max(0, delta.record_count_delta),
      Math.max(0, delta.record_history_count_delta),
      Math.max(0, delta.blob_count_delta),
      computedAt,
      delta.current_record_json_bytes_delta,
      delta.record_history_json_bytes_delta,
      delta.blob_bytes_delta,
      delta.record_count_delta,
      delta.record_history_count_delta,
      delta.blob_count_delta,
      computedAt,
    );
}

async function upsertStreamRowPostgres(client, rawDelta, computedAt) {
  const delta = normalizedDelta(rawDelta);
  if (!delta.connector_instance_id || !delta.connector_id || !delta.stream) {
    return;
  }
  await client.query(
    `INSERT INTO retained_size_stream(
       connector_instance_id, connector_id, stream,
       current_record_json_bytes, record_history_json_bytes, blob_bytes,
       record_count, record_history_count, blob_count,
       dirty, computed_at
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10)
     ON CONFLICT (connector_instance_id, stream) DO UPDATE SET
       current_record_json_bytes = GREATEST(0, retained_size_stream.current_record_json_bytes + $11),
       record_history_json_bytes = GREATEST(0, retained_size_stream.record_history_json_bytes + $12),
       blob_bytes = GREATEST(0, retained_size_stream.blob_bytes + $13),
       record_count = GREATEST(0, retained_size_stream.record_count + $14),
       record_history_count = GREATEST(0, retained_size_stream.record_history_count + $15),
       blob_count = GREATEST(0, retained_size_stream.blob_count + $16),
       computed_at = EXCLUDED.computed_at`,
    [
      delta.connector_instance_id,
      delta.connector_id,
      delta.stream,
      Math.max(0, delta.current_record_json_bytes_delta),
      Math.max(0, delta.record_history_json_bytes_delta),
      Math.max(0, delta.blob_bytes_delta),
      Math.max(0, delta.record_count_delta),
      Math.max(0, delta.record_history_count_delta),
      Math.max(0, delta.blob_count_delta),
      computedAt,
      delta.current_record_json_bytes_delta,
      delta.record_history_json_bytes_delta,
      delta.blob_bytes_delta,
      delta.record_count_delta,
      delta.record_history_count_delta,
      delta.blob_count_delta,
    ],
  );
}

function upsertConnectionRowSqlite(rawDelta, computedAt) {
  const delta = normalizedDelta(rawDelta);
  if (!delta.connector_instance_id || !delta.connector_id) return;
  getDb()
    .prepare(
      `INSERT INTO retained_size_connection(
         connector_instance_id, connector_id,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(connector_instance_id) DO UPDATE SET
         current_record_json_bytes = MAX(0, current_record_json_bytes + ?),
         record_history_json_bytes = MAX(0, record_history_json_bytes + ?),
         blob_bytes = MAX(0, blob_bytes + ?),
         record_count = MAX(0, record_count + ?),
         record_history_count = MAX(0, record_history_count + ?),
         blob_count = MAX(0, blob_count + ?),
         computed_at = ?`,
    )
    .run(
      delta.connector_instance_id,
      delta.connector_id,
      Math.max(0, delta.current_record_json_bytes_delta),
      Math.max(0, delta.record_history_json_bytes_delta),
      Math.max(0, delta.blob_bytes_delta),
      Math.max(0, delta.record_count_delta),
      Math.max(0, delta.record_history_count_delta),
      Math.max(0, delta.blob_count_delta),
      computedAt,
      delta.current_record_json_bytes_delta,
      delta.record_history_json_bytes_delta,
      delta.blob_bytes_delta,
      delta.record_count_delta,
      delta.record_history_count_delta,
      delta.blob_count_delta,
      computedAt,
    );
}

async function upsertConnectionRowPostgres(client, rawDelta, computedAt) {
  const delta = normalizedDelta(rawDelta);
  if (!delta.connector_instance_id || !delta.connector_id) return;
  await client.query(
    `INSERT INTO retained_size_connection(
       connector_instance_id, connector_id,
       current_record_json_bytes, record_history_json_bytes, blob_bytes,
       record_count, record_history_count, blob_count,
       dirty, computed_at
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)
     ON CONFLICT (connector_instance_id) DO UPDATE SET
       current_record_json_bytes = GREATEST(0, retained_size_connection.current_record_json_bytes + $10),
       record_history_json_bytes = GREATEST(0, retained_size_connection.record_history_json_bytes + $11),
       blob_bytes = GREATEST(0, retained_size_connection.blob_bytes + $12),
       record_count = GREATEST(0, retained_size_connection.record_count + $13),
       record_history_count = GREATEST(0, retained_size_connection.record_history_count + $14),
       blob_count = GREATEST(0, retained_size_connection.blob_count + $15),
       computed_at = $9`,
    [
      delta.connector_instance_id,
      delta.connector_id,
      Math.max(0, delta.current_record_json_bytes_delta),
      Math.max(0, delta.record_history_json_bytes_delta),
      Math.max(0, delta.blob_bytes_delta),
      Math.max(0, delta.record_count_delta),
      Math.max(0, delta.record_history_count_delta),
      Math.max(0, delta.blob_count_delta),
      computedAt,
      delta.current_record_json_bytes_delta,
      delta.record_history_json_bytes_delta,
      delta.blob_bytes_delta,
      delta.record_count_delta,
      delta.record_history_count_delta,
      delta.blob_count_delta,
    ],
  );
}

function applyGlobalDeltaSqlite(rawDelta, computedAt) {
  const delta = normalizedDelta(rawDelta);
  getDb()
    .prepare(
      `INSERT INTO retained_size_global(
         projection_key,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at, metadata_json
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(projection_key) DO UPDATE SET
         current_record_json_bytes = MAX(0, current_record_json_bytes + ?),
         record_history_json_bytes = MAX(0, record_history_json_bytes + ?),
         blob_bytes = MAX(0, blob_bytes + ?),
         record_count = MAX(0, record_count + ?),
         record_history_count = MAX(0, record_history_count + ?),
         blob_count = MAX(0, blob_count + ?),
         computed_at = ?`,
    )
    .run(
      GLOBAL_KEY,
      Math.max(0, delta.current_record_json_bytes_delta),
      Math.max(0, delta.record_history_json_bytes_delta),
      Math.max(0, delta.blob_bytes_delta),
      Math.max(0, delta.record_count_delta),
      Math.max(0, delta.record_history_count_delta),
      Math.max(0, delta.blob_count_delta),
      computedAt,
      JSON.stringify({
        state: 'fresh',
        stale_since: null,
        rebuild_status: 'idle',
        last_error: null,
      }),
      delta.current_record_json_bytes_delta,
      delta.record_history_json_bytes_delta,
      delta.blob_bytes_delta,
      delta.record_count_delta,
      delta.record_history_count_delta,
      delta.blob_count_delta,
      computedAt,
    );
}

async function applyGlobalDeltaPostgres(client, rawDelta, computedAt) {
  const delta = normalizedDelta(rawDelta);
  await client.query(
    `INSERT INTO retained_size_global(
       projection_key,
       current_record_json_bytes, record_history_json_bytes, blob_bytes,
       record_count, record_history_count, blob_count,
       dirty, computed_at, metadata_json
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, 0, $8, $9::jsonb)
     ON CONFLICT (projection_key) DO UPDATE SET
       current_record_json_bytes = GREATEST(0, retained_size_global.current_record_json_bytes + $10),
       record_history_json_bytes = GREATEST(0, retained_size_global.record_history_json_bytes + $11),
       blob_bytes = GREATEST(0, retained_size_global.blob_bytes + $12),
       record_count = GREATEST(0, retained_size_global.record_count + $13),
       record_history_count = GREATEST(0, retained_size_global.record_history_count + $14),
       blob_count = GREATEST(0, retained_size_global.blob_count + $15),
       computed_at = $8`,
    [
      GLOBAL_KEY,
      Math.max(0, delta.current_record_json_bytes_delta),
      Math.max(0, delta.record_history_json_bytes_delta),
      Math.max(0, delta.blob_bytes_delta),
      Math.max(0, delta.record_count_delta),
      Math.max(0, delta.record_history_count_delta),
      Math.max(0, delta.blob_count_delta),
      computedAt,
      JSON.stringify({
        state: 'fresh',
        stale_since: null,
        rebuild_status: 'idle',
        last_error: null,
      }),
      delta.current_record_json_bytes_delta,
      delta.record_history_json_bytes_delta,
      delta.blob_bytes_delta,
      delta.record_count_delta,
      delta.record_history_count_delta,
      delta.blob_count_delta,
    ],
  );
}

function staleTopMetadata(reason, at) {
  return JSON.stringify({
    state: 'stale',
    stale_since: at,
    rebuild_status: 'idle',
    last_error: sanitizeProjectionError(reason || 'retained-size top-N rows are stale'),
    computed_at: at,
  });
}

function markTopRowsDirtySqlite(db, reason, at = nowIso()) {
  db.prepare(
    `UPDATE retained_size_top_rows
        SET dirty = 1,
            metadata_json = ?
      WHERE dirty = 0`,
  ).run(staleTopMetadata(reason, at));
}

async function markTopRowsDirtyPostgres(client, reason, at = nowIso()) {
  await client.query(
    `UPDATE retained_size_top_rows
        SET dirty = 1,
            metadata_json = $1::jsonb
      WHERE dirty = 0`,
    [staleTopMetadata(reason, at)],
  );
}

// ---------------------------------------------------------------------------
// Dirty markers
// ---------------------------------------------------------------------------

export async function markRetainedSizeDirty(reason) {
  const at = nowIso();
  const sanitized = sanitizeProjectionError(reason || 'retained-size projection is stale');
  if (isPostgresStorageBackend()) {
    try {
      await postgresQuery(
        `INSERT INTO retained_size_global(
           projection_key, dirty, computed_at, metadata_json
         )
         VALUES($1, 1, $2, $3::jsonb)
         ON CONFLICT (projection_key) DO UPDATE SET
           dirty = 1,
           computed_at = COALESCE(retained_size_global.computed_at, $2),
           metadata_json = $3::jsonb`,
        [
          GLOBAL_KEY,
          at,
          JSON.stringify({
            state: 'stale',
            stale_since: at,
            rebuild_status: 'idle',
            last_error: sanitized,
          }),
        ],
      );
    } catch {
      // Dirty marker failure is non-fatal — canonical evidence is untouched.
    }
    return;
  }
  try {
    getDb()
      .prepare(
        `INSERT INTO retained_size_global(
           projection_key, dirty, computed_at, metadata_json
         )
         VALUES(?, 1, ?, ?)
         ON CONFLICT(projection_key) DO UPDATE SET
           dirty = 1,
           computed_at = COALESCE(computed_at, ?),
           metadata_json = ?`,
      )
      .run(
        GLOBAL_KEY,
        at,
        JSON.stringify({
          state: 'stale',
          stale_since: at,
          rebuild_status: 'idle',
          last_error: sanitized,
        }),
        at,
        JSON.stringify({
          state: 'stale',
          stale_since: at,
          rebuild_status: 'idle',
          last_error: sanitized,
        }),
      );
  } catch {
    // Dirty marker failure is non-fatal.
  }
}

export async function markRetainedSizeStreamDirty({ connectorInstanceId, stream }) {
  if (!connectorInstanceId || !stream) {
    await markRetainedSizeDirty(`bulk write on (${connectorInstanceId}, ${stream})`);
    return;
  }
  try {
    if (isPostgresStorageBackend()) {
      await postgresQuery(
        `UPDATE retained_size_stream SET dirty = 1 WHERE connector_instance_id = $1 AND stream = $2`,
        [connectorInstanceId, stream],
      );
      await postgresQuery(
        `UPDATE retained_size_connection SET dirty = 1 WHERE connector_instance_id = $1`,
        [connectorInstanceId],
      );
    } else {
      getDb()
        .prepare(`UPDATE retained_size_stream SET dirty = 1 WHERE connector_instance_id = ? AND stream = ?`)
        .run(connectorInstanceId, stream);
      getDb()
        .prepare(`UPDATE retained_size_connection SET dirty = 1 WHERE connector_instance_id = ?`)
        .run(connectorInstanceId);
    }
  } catch {
    // Best-effort marker; rebuild will repair.
  }
  await markRetainedSizeDirty(`bulk write on (${connectorInstanceId}, ${stream})`);
}

export async function markRetainedSizeConnectionDirty({ connectorInstanceId }) {
  if (!connectorInstanceId) {
    await markRetainedSizeDirty('bulk write on unknown connection');
    return;
  }
  try {
    if (isPostgresStorageBackend()) {
      await postgresQuery(
        `UPDATE retained_size_stream SET dirty = 1 WHERE connector_instance_id = $1`,
        [connectorInstanceId],
      );
      await postgresQuery(
        `UPDATE retained_size_connection SET dirty = 1 WHERE connector_instance_id = $1`,
        [connectorInstanceId],
      );
    } else {
      getDb()
        .prepare(`UPDATE retained_size_stream SET dirty = 1 WHERE connector_instance_id = ?`)
        .run(connectorInstanceId);
      getDb()
        .prepare(`UPDATE retained_size_connection SET dirty = 1 WHERE connector_instance_id = ?`)
        .run(connectorInstanceId);
    }
  } catch {
    // Best-effort.
  }
  await markRetainedSizeDirty(`bulk write on connection ${connectorInstanceId}`);
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

/**
 * Rebuild every retained-size row from the active backend's canonical
 * records/record_changes/blobs tables. The rebuild does NOT rerun
 * connectors or read credentials — it derives bytes/counts from already
 * durable state. On completion, all rows are marked dirty=0 and the
 * global metadata flips to 'fresh'.
 */
export async function rebuildRetainedSize() {
  const startedAt = nowIso();
  await markRetainedSizeRebuilding(startedAt);
  try {
    if (isPostgresStorageBackend()) {
      await rebuildPostgres();
    } else {
      rebuildSqlite();
    }
    const completedAt = nowIso();
    await markRetainedSizeFresh(completedAt);
    return await getRetainedSizeGlobal();
  } catch (err) {
    await markRetainedSizeFailed(err);
    throw err;
  }
}

function rebuildSqlite() {
  const db = getDb();
  const computedAt = nowIso();
  db.transaction(() => {
    db.prepare('DELETE FROM retained_size_stream').run();
    db.prepare('DELETE FROM retained_size_connection').run();
    db.prepare('DELETE FROM retained_size_record_family').run();

    const streamAgg = db
      .prepare(
        `SELECT connector_instance_id, connector_id, stream,
                COUNT(*)              AS record_count,
                COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS current_record_json_bytes
           FROM records
          WHERE deleted = 0
          GROUP BY connector_instance_id, connector_id, stream`,
      )
      .all();
    const changesAgg = db
      .prepare(
        `SELECT connector_instance_id, connector_id, stream,
                COUNT(*) AS record_history_count,
                COALESCE(SUM(LENGTH(CAST(COALESCE(record_json, '') AS BLOB))), 0) AS record_history_json_bytes
           FROM record_changes
          GROUP BY connector_instance_id, connector_id, stream`,
      )
      .all();
    const blobsAgg = db
      .prepare(
        `SELECT blob_bindings.connector_instance_id AS connector_instance_id,
                blob_bindings.connector_id AS connector_id,
                blob_bindings.stream AS stream,
                COUNT(*) AS blob_count,
                COALESCE(SUM(blobs.size_bytes), 0) AS blob_bytes
           FROM blob_bindings
           JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
          GROUP BY blob_bindings.connector_instance_id, blob_bindings.connector_id, blob_bindings.stream`,
      )
      .all();

    const merged = mergeAggregateRows(streamAgg, changesAgg, blobsAgg);

    const insertStream = db.prepare(
      `INSERT INTO retained_size_stream(
         connector_instance_id, connector_id, stream,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    for (const row of merged.streams) {
      insertStream.run(
        row.connector_instance_id,
        row.connector_id,
        row.stream,
        row.current_record_json_bytes,
        row.record_history_json_bytes,
        row.blob_bytes,
        row.record_count,
        row.record_history_count,
        row.blob_count,
        computedAt,
      );
    }

    const insertConnection = db.prepare(
      `INSERT INTO retained_size_connection(
         connector_instance_id, connector_id,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    for (const row of merged.connections) {
      insertConnection.run(
        row.connector_instance_id,
        row.connector_id,
        row.current_record_json_bytes,
        row.record_history_json_bytes,
        row.blob_bytes,
        row.record_count,
        row.record_history_count,
        row.blob_count,
        computedAt,
      );
    }

    refreshRetainedSizeTopRowsSqlite(db, computedAt);

    const globalRow = merged.global;
    db.prepare(
      `INSERT INTO retained_size_global(
         projection_key,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at, metadata_json
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(projection_key) DO UPDATE SET
         current_record_json_bytes = excluded.current_record_json_bytes,
         record_history_json_bytes = excluded.record_history_json_bytes,
         blob_bytes = excluded.blob_bytes,
         record_count = excluded.record_count,
         record_history_count = excluded.record_history_count,
         blob_count = excluded.blob_count,
         dirty = 0,
         computed_at = excluded.computed_at,
         metadata_json = excluded.metadata_json`,
    ).run(
      GLOBAL_KEY,
      globalRow.current_record_json_bytes,
      globalRow.record_history_json_bytes,
      globalRow.blob_bytes,
      globalRow.record_count,
      globalRow.record_history_count,
      globalRow.blob_count,
      computedAt,
      JSON.stringify({
        state: 'fresh',
        stale_since: null,
        rebuild_status: 'idle',
        last_error: null,
      }),
    );
  })();
}

async function rebuildPostgres() {
  await withPostgresTransaction(async (client) => {
    const computedAt = nowIso();
    await client.query('DELETE FROM retained_size_stream');
    await client.query('DELETE FROM retained_size_connection');
    await client.query('DELETE FROM retained_size_record_family');

    const streamAgg = await client.query(
      `SELECT connector_instance_id, connector_id, stream,
              COUNT(*)::bigint AS record_count,
              COALESCE(SUM(octet_length(record_json::text)), 0)::bigint AS current_record_json_bytes
         FROM records
        WHERE deleted = FALSE
        GROUP BY connector_instance_id, connector_id, stream`,
    );
    const changesAgg = await client.query(
      `SELECT connector_instance_id, connector_id, stream,
              COUNT(*)::bigint AS record_history_count,
              COALESCE(SUM(octet_length(COALESCE(record_json::text, ''))), 0)::bigint AS record_history_json_bytes
         FROM record_changes
        GROUP BY connector_instance_id, connector_id, stream`,
    );
    const blobsAgg = await client.query(
      `SELECT blob_bindings.connector_instance_id AS connector_instance_id,
              blob_bindings.connector_id AS connector_id,
              blob_bindings.stream AS stream,
              COUNT(*)::bigint AS blob_count,
              COALESCE(SUM(blobs.size_bytes), 0)::bigint AS blob_bytes
         FROM blob_bindings
         JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
        GROUP BY blob_bindings.connector_instance_id, blob_bindings.connector_id, blob_bindings.stream`,
    );
    const merged = mergeAggregateRows(streamAgg.rows, changesAgg.rows, blobsAgg.rows);

    for (const row of merged.streams) {
      await client.query(
        `INSERT INTO retained_size_stream(
           connector_instance_id, connector_id, stream,
           current_record_json_bytes, record_history_json_bytes, blob_bytes,
           record_count, record_history_count, blob_count,
           dirty, computed_at
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10)`,
        [
          row.connector_instance_id,
          row.connector_id,
          row.stream,
          row.current_record_json_bytes,
          row.record_history_json_bytes,
          row.blob_bytes,
          row.record_count,
          row.record_history_count,
          row.blob_count,
          computedAt,
        ],
      );
    }

    for (const row of merged.connections) {
      await client.query(
        `INSERT INTO retained_size_connection(
           connector_instance_id, connector_id,
           current_record_json_bytes, record_history_json_bytes, blob_bytes,
           record_count, record_history_count, blob_count,
           dirty, computed_at
         )
         VALUES($1, $2, $3, $4, $5, $6, $7, $8, 0, $9)`,
        [
          row.connector_instance_id,
          row.connector_id,
          row.current_record_json_bytes,
          row.record_history_json_bytes,
          row.blob_bytes,
          row.record_count,
          row.record_history_count,
          row.blob_count,
          computedAt,
        ],
      );
    }

    const g = merged.global;
    await refreshRetainedSizeTopRowsPostgres(client, computedAt);
    await client.query(
      `INSERT INTO retained_size_global(
         projection_key,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at, metadata_json
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, 0, $8, $9::jsonb)
       ON CONFLICT (projection_key) DO UPDATE SET
         current_record_json_bytes = EXCLUDED.current_record_json_bytes,
         record_history_json_bytes = EXCLUDED.record_history_json_bytes,
         blob_bytes = EXCLUDED.blob_bytes,
         record_count = EXCLUDED.record_count,
         record_history_count = EXCLUDED.record_history_count,
         blob_count = EXCLUDED.blob_count,
         dirty = 0,
         computed_at = EXCLUDED.computed_at,
         metadata_json = EXCLUDED.metadata_json`,
      [
        GLOBAL_KEY,
        g.current_record_json_bytes,
        g.record_history_json_bytes,
        g.blob_bytes,
        g.record_count,
        g.record_history_count,
        g.blob_count,
        computedAt,
        JSON.stringify({
          state: 'fresh',
          stale_since: null,
          rebuild_status: 'idle',
          last_error: null,
        }),
      ],
    );
  });
}

function mergeAggregateRows(streamAgg, changesAgg, blobsAgg) {
  const streamKey = (row) => `${row.connector_instance_id}\u0000${row.connector_id}\u0000${row.stream}`;
  const map = new Map();
  const ensure = (row) => {
    const key = streamKey(row);
    let entry = map.get(key);
    if (!entry) {
      entry = {
        connector_instance_id: row.connector_instance_id,
        connector_id: row.connector_id,
        stream: row.stream,
        current_record_json_bytes: 0,
        record_history_json_bytes: 0,
        blob_bytes: 0,
        record_count: 0,
        record_history_count: 0,
        blob_count: 0,
      };
      map.set(key, entry);
    }
    return entry;
  };
  for (const row of streamAgg) {
    const entry = ensure(row);
    entry.current_record_json_bytes = Number(row.current_record_json_bytes || 0);
    entry.record_count = Number(row.record_count || 0);
  }
  for (const row of changesAgg) {
    const entry = ensure(row);
    entry.record_history_json_bytes = Number(row.record_history_json_bytes || 0);
    entry.record_history_count = Number(row.record_history_count || 0);
  }
  for (const row of blobsAgg) {
    const entry = ensure(row);
    entry.blob_bytes = Number(row.blob_bytes || 0);
    entry.blob_count = Number(row.blob_count || 0);
  }
  const streams = [...map.values()];
  const connections = new Map();
  const global = {
    current_record_json_bytes: 0,
    record_history_json_bytes: 0,
    blob_bytes: 0,
    record_count: 0,
    record_history_count: 0,
    blob_count: 0,
  };
  for (const row of streams) {
    const key = row.connector_instance_id;
    let conn = connections.get(key);
    if (!conn) {
      conn = {
        connector_instance_id: row.connector_instance_id,
        connector_id: row.connector_id,
        current_record_json_bytes: 0,
        record_history_json_bytes: 0,
        blob_bytes: 0,
        record_count: 0,
        record_history_count: 0,
        blob_count: 0,
      };
      connections.set(key, conn);
    }
    conn.current_record_json_bytes += row.current_record_json_bytes;
    conn.record_history_json_bytes += row.record_history_json_bytes;
    conn.blob_bytes += row.blob_bytes;
    conn.record_count += row.record_count;
    conn.record_history_count += row.record_history_count;
    conn.blob_count += row.blob_count;
    global.current_record_json_bytes += row.current_record_json_bytes;
    global.record_history_json_bytes += row.record_history_json_bytes;
    global.blob_bytes += row.blob_bytes;
    global.record_count += row.record_count;
    global.record_history_count += row.record_history_count;
    global.blob_count += row.blob_count;
  }
  return { streams, connections: [...connections.values()], global };
}

function freshTopMetadata(computedAt) {
  return JSON.stringify({
    state: 'fresh',
    stale_since: null,
    rebuild_status: 'idle',
    last_error: null,
    computed_at: computedAt,
  });
}

function insertTopRowsSqlite(db, scope, measure, rows, computedAt) {
  const metadata = freshTopMetadata(computedAt);
  const insert = db.prepare(
    `INSERT INTO retained_size_top_rows(
       scope, measure, rank, grain_key,
       connector_instance_id, connector_id, stream, record_key, blob_id,
       current_record_json_bytes, record_history_json_bytes, blob_bytes,
       total_retained_bytes, record_count, record_history_count, blob_count,
       dirty, computed_at, metadata_json
     )
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  );
  rows.forEach((row, index) => {
    const measures = {
      current_record_json_bytes: Number(row.current_record_json_bytes || 0),
      record_history_json_bytes: Number(row.record_history_json_bytes || 0),
      blob_bytes: Number(row.blob_bytes || 0),
      record_count: Number(row.record_count || 0),
      record_history_count: Number(row.record_history_count || 0),
      blob_count: Number(row.blob_count || 0),
    };
    insert.run(
      scope,
      measure,
      index + 1,
      row.grain_key,
      row.connector_instance_id || null,
      row.connector_id || null,
      row.stream || null,
      row.record_key || null,
      row.blob_id || null,
      measures.current_record_json_bytes,
      measures.record_history_json_bytes,
      measures.blob_bytes,
      Number(row.total_retained_bytes || totalBytesFromMeasures(measures)),
      measures.record_count,
      measures.record_history_count,
      measures.blob_count,
      computedAt,
      metadata,
    );
  });
}

function refreshRetainedSizeTopRowsSqlite(db, computedAt) {
  db.prepare('DELETE FROM retained_size_top_rows').run();
  const baseColumns = `
    current_record_json_bytes,
    record_history_json_bytes,
    blob_bytes,
    current_record_json_bytes + record_history_json_bytes + blob_bytes AS total_retained_bytes,
    record_count,
    record_history_count,
    blob_count
  `;
  const topMeasures = [...VALID_TOP_MEASURES];
  for (const measure of topMeasures) {
    const orderExpr = measure === 'total_retained_bytes'
      ? 'current_record_json_bytes + record_history_json_bytes + blob_bytes'
      : measure;
    insertTopRowsSqlite(
      db,
      'connection',
      measure,
      db.prepare(
        `SELECT connector_instance_id AS grain_key,
                connector_instance_id,
                connector_id,
                ${baseColumns}
           FROM retained_size_connection
          ORDER BY ${orderExpr} DESC, connector_instance_id ASC
          LIMIT ?`,
      ).all(MAX_TOP_LIMIT),
      computedAt,
    );
    insertTopRowsSqlite(
      db,
      'stream',
      measure,
      db.prepare(
        `SELECT connector_instance_id || char(10) || stream AS grain_key,
                connector_instance_id,
                connector_id,
                stream,
                ${baseColumns}
           FROM retained_size_stream
          ORDER BY ${orderExpr} DESC, connector_instance_id ASC, stream ASC
          LIMIT ?`,
      ).all(MAX_TOP_LIMIT),
      computedAt,
    );
  }

  insertTopRowsSqlite(
    db,
    'record',
    'current_record_json_bytes',
    db.prepare(
      `SELECT connector_instance_id || char(10) || stream || char(10) || record_key AS grain_key,
              connector_instance_id,
              connector_id,
              stream,
              record_key,
              LENGTH(CAST(record_json AS BLOB)) AS current_record_json_bytes,
              LENGTH(CAST(record_json AS BLOB)) AS total_retained_bytes,
              1 AS record_count
         FROM records
        WHERE deleted = 0
        ORDER BY current_record_json_bytes DESC, connector_instance_id ASC, stream ASC, record_key ASC
        LIMIT ?`,
    ).all(MAX_TOP_LIMIT),
    computedAt,
  );
  insertTopRowsSqlite(
    db,
    'record',
    'record_history_json_bytes',
    db.prepare(
      `SELECT connector_instance_id || char(10) || stream || char(10) || record_key AS grain_key,
              connector_instance_id,
              connector_id,
              stream,
              record_key,
              COALESCE(SUM(LENGTH(CAST(COALESCE(record_json, '') AS BLOB))), 0) AS record_history_json_bytes,
              COALESCE(SUM(LENGTH(CAST(COALESCE(record_json, '') AS BLOB))), 0) AS total_retained_bytes,
              COUNT(*) AS record_history_count
         FROM record_changes
        GROUP BY connector_instance_id, connector_id, stream, record_key
        ORDER BY record_history_json_bytes DESC, connector_instance_id ASC, stream ASC, record_key ASC
        LIMIT ?`,
    ).all(MAX_TOP_LIMIT),
    computedAt,
  );
  insertTopRowsSqlite(
    db,
    'record',
    'total_retained_bytes',
    db.prepare(
      `WITH keys AS (
         SELECT connector_instance_id, connector_id, stream, record_key
           FROM records
          WHERE deleted = 0
         UNION
         SELECT connector_instance_id, connector_id, stream, record_key
           FROM record_changes
         UNION
         SELECT connector_instance_id, connector_id, stream, record_key
           FROM blob_bindings
       ),
       current_records AS (
         SELECT connector_instance_id, stream, record_key,
                COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS current_record_json_bytes,
                COUNT(*) AS record_count
           FROM records
          WHERE deleted = 0
          GROUP BY connector_instance_id, stream, record_key
       ),
       history_records AS (
         SELECT connector_instance_id, stream, record_key,
                COALESCE(SUM(LENGTH(CAST(COALESCE(record_json, '') AS BLOB))), 0) AS record_history_json_bytes,
                COUNT(*) AS record_history_count
           FROM record_changes
          GROUP BY connector_instance_id, stream, record_key
       ),
       record_blobs AS (
         SELECT blob_bindings.connector_instance_id AS connector_instance_id,
                blob_bindings.stream AS stream,
                blob_bindings.record_key AS record_key,
                COALESCE(SUM(blobs.size_bytes), 0) AS blob_bytes,
                COUNT(*) AS blob_count
           FROM blob_bindings
           JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
          GROUP BY blob_bindings.connector_instance_id, blob_bindings.stream, blob_bindings.record_key
       )
       SELECT keys.connector_instance_id || char(10) || keys.stream || char(10) || keys.record_key AS grain_key,
              keys.connector_instance_id,
              keys.connector_id,
              keys.stream,
              keys.record_key,
              COALESCE(current_records.current_record_json_bytes, 0) AS current_record_json_bytes,
              COALESCE(history_records.record_history_json_bytes, 0) AS record_history_json_bytes,
              COALESCE(record_blobs.blob_bytes, 0) AS blob_bytes,
              COALESCE(current_records.current_record_json_bytes, 0)
                + COALESCE(history_records.record_history_json_bytes, 0)
                + COALESCE(record_blobs.blob_bytes, 0) AS total_retained_bytes,
              COALESCE(current_records.record_count, 0) AS record_count,
              COALESCE(history_records.record_history_count, 0) AS record_history_count,
              COALESCE(record_blobs.blob_count, 0) AS blob_count
         FROM keys
         LEFT JOIN current_records
           ON current_records.connector_instance_id = keys.connector_instance_id
          AND current_records.stream = keys.stream
          AND current_records.record_key = keys.record_key
         LEFT JOIN history_records
           ON history_records.connector_instance_id = keys.connector_instance_id
          AND history_records.stream = keys.stream
          AND history_records.record_key = keys.record_key
         LEFT JOIN record_blobs
           ON record_blobs.connector_instance_id = keys.connector_instance_id
          AND record_blobs.stream = keys.stream
          AND record_blobs.record_key = keys.record_key
        ORDER BY total_retained_bytes DESC, keys.connector_instance_id ASC, keys.stream ASC, keys.record_key ASC
        LIMIT ?`,
    ).all(MAX_TOP_LIMIT),
    computedAt,
  );
  insertTopRowsSqlite(
    db,
    'blob',
    'blob_bytes',
    db.prepare(
      `SELECT blob_bindings.connector_instance_id || char(10) || blob_bindings.stream || char(10) || blob_bindings.record_key || char(10) || blob_bindings.blob_id AS grain_key,
              blob_bindings.connector_instance_id AS connector_instance_id,
              blob_bindings.connector_id AS connector_id,
              blob_bindings.stream AS stream,
              blob_bindings.record_key AS record_key,
              blob_bindings.blob_id AS blob_id,
              blobs.size_bytes AS blob_bytes,
              blobs.size_bytes AS total_retained_bytes,
              1 AS blob_count
         FROM blob_bindings
         JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
        ORDER BY blobs.size_bytes DESC, blob_bindings.connector_instance_id ASC, blob_bindings.stream ASC, blob_bindings.record_key ASC, blob_bindings.blob_id ASC
        LIMIT ?`,
    ).all(MAX_TOP_LIMIT),
    computedAt,
  );
  insertTopRowsSqlite(
    db,
    'blob',
    'total_retained_bytes',
    db.prepare(
      `SELECT blob_bindings.connector_instance_id || char(10) || blob_bindings.stream || char(10) || blob_bindings.record_key || char(10) || blob_bindings.blob_id AS grain_key,
              blob_bindings.connector_instance_id AS connector_instance_id,
              blob_bindings.connector_id AS connector_id,
              blob_bindings.stream AS stream,
              blob_bindings.record_key AS record_key,
              blob_bindings.blob_id AS blob_id,
              blobs.size_bytes AS blob_bytes,
              blobs.size_bytes AS total_retained_bytes,
              1 AS blob_count
         FROM blob_bindings
         JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
        ORDER BY blobs.size_bytes DESC, blob_bindings.connector_instance_id ASC, blob_bindings.stream ASC, blob_bindings.record_key ASC, blob_bindings.blob_id ASC
        LIMIT ?`,
    ).all(MAX_TOP_LIMIT),
    computedAt,
  );
}

async function insertTopRowsPostgres(client, scope, measure, rows, computedAt) {
  const metadata = freshTopMetadata(computedAt);
  let rank = 1;
  for (const row of rows) {
    const measures = {
      current_record_json_bytes: Number(row.current_record_json_bytes || 0),
      record_history_json_bytes: Number(row.record_history_json_bytes || 0),
      blob_bytes: Number(row.blob_bytes || 0),
      record_count: Number(row.record_count || 0),
      record_history_count: Number(row.record_history_count || 0),
      blob_count: Number(row.blob_count || 0),
    };
    await client.query(
      `INSERT INTO retained_size_top_rows(
         scope, measure, rank, grain_key,
         connector_instance_id, connector_id, stream, record_key, blob_id,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         total_retained_bytes, record_count, record_history_count, blob_count,
         dirty, computed_at, metadata_json
       )
       VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9,
              $10, $11, $12, $13, $14, $15, $16, 0, $17, $18::jsonb)`,
      [
        scope,
        measure,
        rank++,
        row.grain_key,
        row.connector_instance_id || null,
        row.connector_id || null,
        row.stream || null,
        row.record_key || null,
        row.blob_id || null,
        measures.current_record_json_bytes,
        measures.record_history_json_bytes,
        measures.blob_bytes,
        Number(row.total_retained_bytes || totalBytesFromMeasures(measures)),
        measures.record_count,
        measures.record_history_count,
        measures.blob_count,
        computedAt,
        metadata,
      ],
    );
  }
}

async function refreshRetainedSizeTopRowsPostgres(client, computedAt) {
  await client.query('DELETE FROM retained_size_top_rows');
  const topMeasures = [...VALID_TOP_MEASURES];
  for (const measure of topMeasures) {
    const orderExpr = measure === 'total_retained_bytes'
      ? 'current_record_json_bytes + record_history_json_bytes + blob_bytes'
      : measure;
    const connectionRows = await client.query(
      `SELECT connector_instance_id AS grain_key,
              connector_instance_id,
              connector_id,
              current_record_json_bytes,
              record_history_json_bytes,
              blob_bytes,
              current_record_json_bytes + record_history_json_bytes + blob_bytes AS total_retained_bytes,
              record_count,
              record_history_count,
              blob_count
         FROM retained_size_connection
        ORDER BY ${orderExpr} DESC, connector_instance_id ASC
        LIMIT $1`,
      [MAX_TOP_LIMIT],
    );
    await insertTopRowsPostgres(client, 'connection', measure, connectionRows.rows, computedAt);
    const streamRows = await client.query(
      `SELECT connector_instance_id || chr(10) || stream AS grain_key,
              connector_instance_id,
              connector_id,
              stream,
              current_record_json_bytes,
              record_history_json_bytes,
              blob_bytes,
              current_record_json_bytes + record_history_json_bytes + blob_bytes AS total_retained_bytes,
              record_count,
              record_history_count,
              blob_count
         FROM retained_size_stream
        ORDER BY ${orderExpr} DESC, connector_instance_id ASC, stream ASC
        LIMIT $1`,
      [MAX_TOP_LIMIT],
    );
    await insertTopRowsPostgres(client, 'stream', measure, streamRows.rows, computedAt);
  }

  const recordCurrentRows = await client.query(
    `SELECT connector_instance_id || chr(10) || stream || chr(10) || record_key AS grain_key,
            connector_instance_id,
            connector_id,
            stream,
            record_key,
            octet_length(record_json::text) AS current_record_json_bytes,
            octet_length(record_json::text) AS total_retained_bytes,
            1 AS record_count
       FROM records
      WHERE deleted = FALSE
      ORDER BY current_record_json_bytes DESC, connector_instance_id ASC, stream ASC, record_key ASC
      LIMIT $1`,
    [MAX_TOP_LIMIT],
  );
  await insertTopRowsPostgres(client, 'record', 'current_record_json_bytes', recordCurrentRows.rows, computedAt);
  const recordHistoryRows = await client.query(
    `SELECT connector_instance_id || chr(10) || stream || chr(10) || record_key AS grain_key,
            connector_instance_id,
            connector_id,
            stream,
            record_key,
            COALESCE(SUM(octet_length(COALESCE(record_json::text, ''))), 0)::bigint AS record_history_json_bytes,
            COALESCE(SUM(octet_length(COALESCE(record_json::text, ''))), 0)::bigint AS total_retained_bytes,
            COUNT(*)::bigint AS record_history_count
       FROM record_changes
      GROUP BY connector_instance_id, connector_id, stream, record_key
      ORDER BY record_history_json_bytes DESC, connector_instance_id ASC, stream ASC, record_key ASC
      LIMIT $1`,
    [MAX_TOP_LIMIT],
  );
  await insertTopRowsPostgres(client, 'record', 'record_history_json_bytes', recordHistoryRows.rows, computedAt);

  const recordTotalRows = await client.query(
    `WITH keys AS (
       SELECT connector_instance_id, connector_id, stream, record_key
         FROM records
        WHERE deleted = FALSE
       UNION
       SELECT connector_instance_id, connector_id, stream, record_key
         FROM record_changes
       UNION
       SELECT connector_instance_id, connector_id, stream, record_key
         FROM blob_bindings
     ),
     current_records AS (
       SELECT connector_instance_id, stream, record_key,
              COALESCE(SUM(octet_length(record_json::text)), 0)::bigint AS current_record_json_bytes,
              COUNT(*)::bigint AS record_count
         FROM records
        WHERE deleted = FALSE
        GROUP BY connector_instance_id, stream, record_key
     ),
     history_records AS (
       SELECT connector_instance_id, stream, record_key,
              COALESCE(SUM(octet_length(COALESCE(record_json::text, ''))), 0)::bigint AS record_history_json_bytes,
              COUNT(*)::bigint AS record_history_count
         FROM record_changes
        GROUP BY connector_instance_id, stream, record_key
     ),
     record_blobs AS (
       SELECT blob_bindings.connector_instance_id AS connector_instance_id,
              blob_bindings.stream AS stream,
              blob_bindings.record_key AS record_key,
              COALESCE(SUM(blobs.size_bytes), 0)::bigint AS blob_bytes,
              COUNT(*)::bigint AS blob_count
         FROM blob_bindings
         JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
        GROUP BY blob_bindings.connector_instance_id, blob_bindings.stream, blob_bindings.record_key
     )
     SELECT keys.connector_instance_id || chr(10) || keys.stream || chr(10) || keys.record_key AS grain_key,
            keys.connector_instance_id,
            keys.connector_id,
            keys.stream,
            keys.record_key,
            COALESCE(current_records.current_record_json_bytes, 0)::bigint AS current_record_json_bytes,
            COALESCE(history_records.record_history_json_bytes, 0)::bigint AS record_history_json_bytes,
            COALESCE(record_blobs.blob_bytes, 0)::bigint AS blob_bytes,
            (COALESCE(current_records.current_record_json_bytes, 0)
              + COALESCE(history_records.record_history_json_bytes, 0)
              + COALESCE(record_blobs.blob_bytes, 0))::bigint AS total_retained_bytes,
            COALESCE(current_records.record_count, 0)::bigint AS record_count,
            COALESCE(history_records.record_history_count, 0)::bigint AS record_history_count,
            COALESCE(record_blobs.blob_count, 0)::bigint AS blob_count
       FROM keys
       LEFT JOIN current_records
         ON current_records.connector_instance_id = keys.connector_instance_id
        AND current_records.stream = keys.stream
        AND current_records.record_key = keys.record_key
       LEFT JOIN history_records
         ON history_records.connector_instance_id = keys.connector_instance_id
        AND history_records.stream = keys.stream
        AND history_records.record_key = keys.record_key
       LEFT JOIN record_blobs
         ON record_blobs.connector_instance_id = keys.connector_instance_id
        AND record_blobs.stream = keys.stream
        AND record_blobs.record_key = keys.record_key
      ORDER BY total_retained_bytes DESC, keys.connector_instance_id ASC, keys.stream ASC, keys.record_key ASC
      LIMIT $1`,
    [MAX_TOP_LIMIT],
  );
  await insertTopRowsPostgres(client, 'record', 'total_retained_bytes', recordTotalRows.rows, computedAt);

  const blobRows = await client.query(
    `SELECT blob_bindings.connector_instance_id || chr(10) || blob_bindings.stream || chr(10) || blob_bindings.record_key || chr(10) || blob_bindings.blob_id AS grain_key,
            blob_bindings.connector_instance_id AS connector_instance_id,
            blob_bindings.connector_id AS connector_id,
            blob_bindings.stream AS stream,
            blob_bindings.record_key AS record_key,
            blob_bindings.blob_id AS blob_id,
            blobs.size_bytes AS blob_bytes,
            blobs.size_bytes AS total_retained_bytes,
            1 AS blob_count
       FROM blob_bindings
       JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
      ORDER BY blobs.size_bytes DESC, blob_bindings.connector_instance_id ASC, blob_bindings.stream ASC, blob_bindings.record_key ASC, blob_bindings.blob_id ASC
      LIMIT $1`,
    [MAX_TOP_LIMIT],
  );
  await insertTopRowsPostgres(client, 'blob', 'blob_bytes', blobRows.rows, computedAt);
  await insertTopRowsPostgres(client, 'blob', 'total_retained_bytes', blobRows.rows, computedAt);
}

// ---------------------------------------------------------------------------
// Reconcile (light pass over dirty rows)
// ---------------------------------------------------------------------------

/**
 * Reconcile dirty connection and stream rows by recomputing those rows
 * from canonical state. Reconcile is bounded to "dirty rows only" so it
 * stays cheap relative to a full rebuild. If no rows are dirty, this is
 * a no-op.
 */
export async function reconcileDirtyRetainedSize() {
  if (isPostgresStorageBackend()) {
    return reconcileDirtyPostgres();
  }
  return reconcileDirtySqlite();
}

function reconcileDirtySqlite() {
  const db = getDb();
  const dirtyStreams = db
    .prepare(
      `SELECT connector_instance_id, connector_id, stream
         FROM retained_size_stream
        WHERE dirty <> 0`,
    )
    .all();
  const reconciled = { streams: 0, connections: 0 };
  for (const row of dirtyStreams) {
    const recompute = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM records WHERE connector_instance_id = ? AND stream = ? AND deleted = 0) AS record_count,
           (SELECT COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) FROM records WHERE connector_instance_id = ? AND stream = ? AND deleted = 0) AS current_record_json_bytes,
           (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = ? AND stream = ?) AS record_history_count,
           (SELECT COALESCE(SUM(LENGTH(CAST(COALESCE(record_json, '') AS BLOB))), 0) FROM record_changes WHERE connector_instance_id = ? AND stream = ?) AS record_history_json_bytes,
           (SELECT COUNT(*) FROM blob_bindings WHERE connector_instance_id = ? AND stream = ?) AS blob_count,
           (SELECT COALESCE(SUM(blobs.size_bytes), 0)
              FROM blob_bindings JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
             WHERE blob_bindings.connector_instance_id = ? AND blob_bindings.stream = ?) AS blob_bytes`,
      )
      .get(
        row.connector_instance_id, row.stream,
        row.connector_instance_id, row.stream,
        row.connector_instance_id, row.stream,
        row.connector_instance_id, row.stream,
        row.connector_instance_id, row.stream,
        row.connector_instance_id, row.stream,
      );
    db.prepare(
      `UPDATE retained_size_stream SET
         current_record_json_bytes = ?,
         record_history_json_bytes = ?,
         blob_bytes = ?,
         record_count = ?,
         record_history_count = ?,
         blob_count = ?,
         dirty = 0,
         computed_at = ?
       WHERE connector_instance_id = ? AND stream = ?`,
    ).run(
      Number(recompute.current_record_json_bytes || 0),
      Number(recompute.record_history_json_bytes || 0),
      Number(recompute.blob_bytes || 0),
      Number(recompute.record_count || 0),
      Number(recompute.record_history_count || 0),
      Number(recompute.blob_count || 0),
      nowIso(),
      row.connector_instance_id,
      row.stream,
    );
    reconciled.streams += 1;
  }

  const dirtyConnections = db
    .prepare(
      `SELECT connector_instance_id
         FROM retained_size_connection
        WHERE dirty <> 0`,
    )
    .all();
  for (const row of dirtyConnections) {
    const sums = db
      .prepare(
        `SELECT
           COALESCE(SUM(current_record_json_bytes), 0) AS current_record_json_bytes,
           COALESCE(SUM(record_history_json_bytes), 0) AS record_history_json_bytes,
           COALESCE(SUM(blob_bytes), 0) AS blob_bytes,
           COALESCE(SUM(record_count), 0) AS record_count,
           COALESCE(SUM(record_history_count), 0) AS record_history_count,
           COALESCE(SUM(blob_count), 0) AS blob_count
         FROM retained_size_stream
        WHERE connector_instance_id = ?`,
      )
      .get(row.connector_instance_id);
    db.prepare(
      `UPDATE retained_size_connection SET
         current_record_json_bytes = ?,
         record_history_json_bytes = ?,
         blob_bytes = ?,
         record_count = ?,
         record_history_count = ?,
         blob_count = ?,
         dirty = 0,
         computed_at = ?
       WHERE connector_instance_id = ?`,
    ).run(
      Number(sums.current_record_json_bytes || 0),
      Number(sums.record_history_json_bytes || 0),
      Number(sums.blob_bytes || 0),
      Number(sums.record_count || 0),
      Number(sums.record_history_count || 0),
      Number(sums.blob_count || 0),
      nowIso(),
      row.connector_instance_id,
    );
    reconciled.connections += 1;
  }

  recomputeGlobalFromConnectionsSqlite();
  refreshRetainedSizeTopRowsSqlite(db, nowIso());
  return reconciled;
}

function recomputeGlobalFromConnectionsSqlite() {
  const sums = getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(current_record_json_bytes), 0) AS current_record_json_bytes,
         COALESCE(SUM(record_history_json_bytes), 0) AS record_history_json_bytes,
         COALESCE(SUM(blob_bytes), 0) AS blob_bytes,
         COALESCE(SUM(record_count), 0) AS record_count,
         COALESCE(SUM(record_history_count), 0) AS record_history_count,
         COALESCE(SUM(blob_count), 0) AS blob_count,
         MAX(dirty) AS dirty
       FROM retained_size_connection`,
    )
    .get();
  const stillDirty = Number(sums.dirty || 0) !== 0;
  const at = nowIso();
  getDb()
    .prepare(
      `INSERT INTO retained_size_global(
         projection_key,
         current_record_json_bytes, record_history_json_bytes, blob_bytes,
         record_count, record_history_count, blob_count,
         dirty, computed_at, metadata_json
       )
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(projection_key) DO UPDATE SET
         current_record_json_bytes = excluded.current_record_json_bytes,
         record_history_json_bytes = excluded.record_history_json_bytes,
         blob_bytes = excluded.blob_bytes,
         record_count = excluded.record_count,
         record_history_count = excluded.record_history_count,
         blob_count = excluded.blob_count,
         dirty = excluded.dirty,
         computed_at = excluded.computed_at,
         metadata_json = excluded.metadata_json`,
    )
    .run(
      GLOBAL_KEY,
      Number(sums.current_record_json_bytes || 0),
      Number(sums.record_history_json_bytes || 0),
      Number(sums.blob_bytes || 0),
      Number(sums.record_count || 0),
      Number(sums.record_history_count || 0),
      Number(sums.blob_count || 0),
      stillDirty ? 1 : 0,
      at,
      JSON.stringify({
        state: stillDirty ? 'stale' : 'fresh',
        stale_since: stillDirty ? at : null,
        rebuild_status: 'idle',
        last_error: stillDirty ? 'connection rows remain dirty after reconcile' : null,
      }),
    );
}

async function reconcileDirtyPostgres() {
  const reconciled = { streams: 0, connections: 0 };
  const dirtyStreams = await postgresQuery(
    `SELECT connector_instance_id, connector_id, stream
       FROM retained_size_stream
      WHERE dirty <> 0`,
  );
  for (const row of dirtyStreams.rows) {
    const recompute = await postgresQuery(
      `SELECT
         (SELECT COUNT(*) FROM records WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE)::bigint AS record_count,
         (SELECT COALESCE(SUM(octet_length(record_json::text)), 0) FROM records WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE)::bigint AS current_record_json_bytes,
         (SELECT COUNT(*) FROM record_changes WHERE connector_instance_id = $1 AND stream = $2)::bigint AS record_history_count,
         (SELECT COALESCE(SUM(octet_length(COALESCE(record_json::text, ''))), 0) FROM record_changes WHERE connector_instance_id = $1 AND stream = $2)::bigint AS record_history_json_bytes,
         (SELECT COUNT(*) FROM blob_bindings WHERE connector_instance_id = $1 AND stream = $2)::bigint AS blob_count,
         (SELECT COALESCE(SUM(blobs.size_bytes), 0)
            FROM blob_bindings JOIN blobs ON blobs.blob_id = blob_bindings.blob_id
           WHERE blob_bindings.connector_instance_id = $1 AND blob_bindings.stream = $2)::bigint AS blob_bytes`,
      [row.connector_instance_id, row.stream],
    );
    const r = recompute.rows[0] || {};
    await postgresQuery(
      `UPDATE retained_size_stream SET
         current_record_json_bytes = $1,
         record_history_json_bytes = $2,
         blob_bytes = $3,
         record_count = $4,
         record_history_count = $5,
         blob_count = $6,
         dirty = 0,
         computed_at = $7
       WHERE connector_instance_id = $8 AND stream = $9`,
      [
        Number(r.current_record_json_bytes || 0),
        Number(r.record_history_json_bytes || 0),
        Number(r.blob_bytes || 0),
        Number(r.record_count || 0),
        Number(r.record_history_count || 0),
        Number(r.blob_count || 0),
        nowIso(),
        row.connector_instance_id,
        row.stream,
      ],
    );
    reconciled.streams += 1;
  }
  const dirtyConnections = await postgresQuery(
    `SELECT connector_instance_id
       FROM retained_size_connection
      WHERE dirty <> 0`,
  );
  for (const row of dirtyConnections.rows) {
    const sums = await postgresQuery(
      `SELECT
         COALESCE(SUM(current_record_json_bytes), 0)::bigint AS current_record_json_bytes,
         COALESCE(SUM(record_history_json_bytes), 0)::bigint AS record_history_json_bytes,
         COALESCE(SUM(blob_bytes), 0)::bigint AS blob_bytes,
         COALESCE(SUM(record_count), 0)::bigint AS record_count,
         COALESCE(SUM(record_history_count), 0)::bigint AS record_history_count,
         COALESCE(SUM(blob_count), 0)::bigint AS blob_count
       FROM retained_size_stream
      WHERE connector_instance_id = $1`,
      [row.connector_instance_id],
    );
    const s = sums.rows[0] || {};
    await postgresQuery(
      `UPDATE retained_size_connection SET
         current_record_json_bytes = $1,
         record_history_json_bytes = $2,
         blob_bytes = $3,
         record_count = $4,
         record_history_count = $5,
         blob_count = $6,
         dirty = 0,
         computed_at = $7
       WHERE connector_instance_id = $8`,
      [
        Number(s.current_record_json_bytes || 0),
        Number(s.record_history_json_bytes || 0),
        Number(s.blob_bytes || 0),
        Number(s.record_count || 0),
        Number(s.record_history_count || 0),
        Number(s.blob_count || 0),
        nowIso(),
        row.connector_instance_id,
      ],
    );
    reconciled.connections += 1;
  }
  await recomputeGlobalFromConnectionsPostgres();
  await withPostgresTransaction(async (client) => {
    await refreshRetainedSizeTopRowsPostgres(client, nowIso());
  });
  return reconciled;
}

async function recomputeGlobalFromConnectionsPostgres() {
  const sums = await postgresQuery(
    `SELECT
       COALESCE(SUM(current_record_json_bytes), 0)::bigint AS current_record_json_bytes,
       COALESCE(SUM(record_history_json_bytes), 0)::bigint AS record_history_json_bytes,
       COALESCE(SUM(blob_bytes), 0)::bigint AS blob_bytes,
       COALESCE(SUM(record_count), 0)::bigint AS record_count,
       COALESCE(SUM(record_history_count), 0)::bigint AS record_history_count,
       COALESCE(SUM(blob_count), 0)::bigint AS blob_count,
       COALESCE(MAX(dirty), 0)::int AS dirty
     FROM retained_size_connection`,
  );
  const s = sums.rows[0] || {};
  const stillDirty = Number(s.dirty || 0) !== 0;
  const at = nowIso();
  await postgresQuery(
    `INSERT INTO retained_size_global(
       projection_key,
       current_record_json_bytes, record_history_json_bytes, blob_bytes,
       record_count, record_history_count, blob_count,
       dirty, computed_at, metadata_json
     )
     VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     ON CONFLICT (projection_key) DO UPDATE SET
       current_record_json_bytes = EXCLUDED.current_record_json_bytes,
       record_history_json_bytes = EXCLUDED.record_history_json_bytes,
       blob_bytes = EXCLUDED.blob_bytes,
       record_count = EXCLUDED.record_count,
       record_history_count = EXCLUDED.record_history_count,
       blob_count = EXCLUDED.blob_count,
       dirty = EXCLUDED.dirty,
       computed_at = EXCLUDED.computed_at,
       metadata_json = EXCLUDED.metadata_json`,
    [
      GLOBAL_KEY,
      Number(s.current_record_json_bytes || 0),
      Number(s.record_history_json_bytes || 0),
      Number(s.blob_bytes || 0),
      Number(s.record_count || 0),
      Number(s.record_history_count || 0),
      Number(s.blob_count || 0),
      stillDirty ? 1 : 0,
      at,
      JSON.stringify({
        state: stillDirty ? 'stale' : 'fresh',
        stale_since: stillDirty ? at : null,
        rebuild_status: 'idle',
        last_error: stillDirty ? 'connection rows remain dirty after reconcile' : null,
      }),
    ],
  );
}

// ---------------------------------------------------------------------------
// Metadata transitions used by rebuild
// ---------------------------------------------------------------------------

async function markRetainedSizeRebuilding(at) {
  const metadata = {
    state: 'rebuilding',
    stale_since: at,
    rebuild_status: 'running',
    last_error: null,
  };
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `INSERT INTO retained_size_global(projection_key, dirty, computed_at, metadata_json)
       VALUES($1, 1, $2, $3::jsonb)
       ON CONFLICT (projection_key) DO UPDATE SET
         metadata_json = $3::jsonb`,
      [GLOBAL_KEY, at, JSON.stringify(metadata)],
    );
    return;
  }
  getDb()
    .prepare(
      `INSERT INTO retained_size_global(projection_key, dirty, computed_at, metadata_json)
       VALUES(?, 1, ?, ?)
       ON CONFLICT(projection_key) DO UPDATE SET
         metadata_json = excluded.metadata_json`,
    )
    .run(GLOBAL_KEY, at, JSON.stringify(metadata));
}

async function markRetainedSizeFresh(at) {
  const metadata = {
    state: 'fresh',
    stale_since: null,
    rebuild_status: 'idle',
    last_error: null,
  };
  if (isPostgresStorageBackend()) {
    await postgresQuery(
      `UPDATE retained_size_global SET dirty = 0, computed_at = $1, metadata_json = $2::jsonb
        WHERE projection_key = $3`,
      [at, JSON.stringify(metadata), GLOBAL_KEY],
    );
    return;
  }
  getDb()
    .prepare(
      `UPDATE retained_size_global SET dirty = 0, computed_at = ?, metadata_json = ?
        WHERE projection_key = ?`,
    )
    .run(at, JSON.stringify(metadata), GLOBAL_KEY);
}

async function markRetainedSizeFailed(err) {
  const metadata = {
    state: 'failed',
    stale_since: nowIso(),
    rebuild_status: 'failed',
    last_error: sanitizeProjectionError(err),
  };
  try {
    if (isPostgresStorageBackend()) {
      await postgresQuery(
        `INSERT INTO retained_size_global(projection_key, dirty, computed_at, metadata_json)
         VALUES($1, 1, $2, $3::jsonb)
         ON CONFLICT (projection_key) DO UPDATE SET
           dirty = 1,
           metadata_json = $3::jsonb`,
        [GLOBAL_KEY, nowIso(), JSON.stringify(metadata)],
      );
    } else {
      getDb()
        .prepare(
          `INSERT INTO retained_size_global(projection_key, dirty, computed_at, metadata_json)
           VALUES(?, 1, ?, ?)
           ON CONFLICT(projection_key) DO UPDATE SET
             dirty = 1,
             metadata_json = excluded.metadata_json`,
        )
        .run(GLOBAL_KEY, nowIso(), JSON.stringify(metadata));
    }
  } catch {
    // Best-effort.
  }
}

// ---------------------------------------------------------------------------
// Exports for limits / constants (test surface)
// ---------------------------------------------------------------------------

export const RETAINED_SIZE_LIMITS = Object.freeze({
  MAX_TOP_LIMIT,
  DEFAULT_TOP_LIMIT,
  VALID_TOP_SCOPES: [...VALID_TOP_SCOPES],
  VALID_TOP_MEASURES: [...VALID_TOP_MEASURES],
});
