/**
 * PDPP Resource Server — record storage and grant-enforced query
 */
import { getDb, sql } from './db.js';

function nowIso() {
  return new Date().toISOString();
}

/**
 * Encode a compound key to its canonical string form (minified JSON array or plain string)
 */
export function encodeKey(key) {
  if (Array.isArray(key)) return JSON.stringify(key);
  return String(key);
}

/**
 * Decode a canonical key string back to string|string[]
 */
export function decodeKey(keyStr) {
  try {
    const parsed = JSON.parse(keyStr);
    if (Array.isArray(parsed)) return parsed;
    return keyStr;
  } catch {
    return keyStr;
  }
}

/**
 * Ingest a RECORD envelope (owner-authenticated)
 */
export async function ingestRecord(connectorId, record) {
  const db = getDb();
  const { stream, key, data, emitted_at, op = 'upsert' } = record;
  const recordKey = encodeKey(key);

  // Validate record identity: if primary_key is ["id"] (i.e., key is a single string "id"),
  // data.id must match key
  if (typeof key === 'string' && data.id !== undefined && data.id !== key) {
    const err = new Error(`key and data.id disagree: key=${key}, data.id=${data.id}`);
    err.code = 'invalid_record_identity';
    throw err;
  }
  if (Array.isArray(key) && key.length === 1 && data.id !== undefined && data.id !== key[0]) {
    const err = new Error(`key and data.id disagree: key=${key[0]}, data.id=${data.id}`);
    err.code = 'invalid_record_identity';
    throw err;
  }

  // Get next version
  const vcRows = await db.query(sql`
    SELECT max_version FROM version_counter WHERE connector_id = ${connectorId} AND stream = ${stream}
  `);
  const nextVersion = vcRows.length ? vcRows[0].max_version + 1 : 1;

  if (op === 'delete') {
    await db.query(sql`
      UPDATE records
      SET deleted = 1, deleted_at = ${emitted_at || nowIso()}, version = ${nextVersion}
      WHERE connector_id = ${connectorId} AND stream = ${stream} AND record_key = ${recordKey}
    `);
  } else {
    await db.query(sql`
      INSERT INTO records(connector_id, stream, record_key, record_json, emitted_at, version)
      VALUES(${connectorId}, ${stream}, ${recordKey}, ${JSON.stringify(data)}, ${emitted_at || nowIso()}, ${nextVersion})
      ON CONFLICT(connector_id, stream, record_key) DO UPDATE SET
        record_json = excluded.record_json,
        emitted_at = excluded.emitted_at,
        version = excluded.version,
        deleted = 0,
        deleted_at = NULL
    `);
  }

  // Advance version counter
  await db.query(sql`
    INSERT INTO version_counter(connector_id, stream, max_version)
    VALUES(${connectorId}, ${stream}, ${nextVersion})
    ON CONFLICT(connector_id, stream) DO UPDATE SET max_version = excluded.max_version
  `);

  return { accepted: true };
}

/**
 * Build an effective filter from grant + request params.
 * Returns { fieldFilter, timeRangeFilter, resourceFilter } for use in queries.
 */
function buildEffectiveFilter(streamGrant, requestParams) {
  const effective = {
    fields: streamGrant.fields || null,          // null = all fields
    timeRange: streamGrant.time_range || null,
    resources: streamGrant.resources || null,
    consentTimeField: null,
  };

  // Request can only narrow, not widen
  if (requestParams.fields && effective.fields) {
    // Intersect: request fields must be subset of grant fields
    effective.fields = requestParams.fields.filter(f => effective.fields.includes(f));
  } else if (requestParams.fields && !effective.fields) {
    effective.fields = requestParams.fields;
  }

  return effective;
}

/**
 * Apply field projection to a record's data object
 */
function projectFields(data, fields) {
  if (!fields) return data;
  const result = {};
  for (const f of fields) {
    if (f in data) result[f] = data[f];
  }
  return result;
}

/**
 * Check if a record passes time_range filter given the manifest's consent_time_field
 */
function passesTimeRange(data, timeRange, consentTimeField) {
  if (!timeRange || !consentTimeField) return true;
  const val = data[consentTimeField];
  if (!val) return false;
  const t = new Date(val).getTime();
  if (isNaN(t)) return false;
  if (timeRange.since && t < new Date(timeRange.since).getTime()) return false;
  if (timeRange.until && t >= new Date(timeRange.until).getTime()) return false;
  return true;
}

/**
 * Query records for a stream under grant enforcement
 */
export async function queryRecords(connectorId, stream, grant, requestParams = {}, manifest = null) {
  const db = getDb();

  // Find stream grant
  const streamGrant = grant.streams.find(s => s.name === stream);
  if (!streamGrant) {
    const err = new Error(`Stream '${stream}' not in grant`);
    err.code = 'grant_stream_not_allowed';
    throw err;
  }

  // Find manifest stream for consent_time_field
  const mStream = manifest?.streams?.find(s => s.name === stream);
  const consentTimeField = mStream?.consent_time_field;

  // Validate request fields against grant
  if (requestParams.fields && streamGrant.fields) {
    const unauthorized = requestParams.fields.filter(f => !streamGrant.fields.includes(f));
    if (unauthorized.length) {
      const err = new Error(`Fields not in grant: ${unauthorized.join(', ')}`);
      err.code = 'field_not_granted';
      throw err;
    }
  }

  // Validate filter fields against grant projection (early, before DB query)
  // Express qs parses filter[field]=val as requestParams.filter = { field: val }
  if (streamGrant.fields && requestParams.filter && typeof requestParams.filter === 'object') {
    for (const field of Object.keys(requestParams.filter)) {
      if (!streamGrant.fields.includes(field)) {
        const err = new Error(`Filter on field '${field}' not in grant`);
        err.code = 'field_not_granted';
        throw err;
      }
    }
  }

  const effective = buildEffectiveFilter(streamGrant, requestParams);

  const limit = Math.min(parseInt(requestParams.limit) || 25, 100);
  const order = requestParams.order === 'asc' ? 'ASC' : 'DESC';

  // Parse changes_since cursor
  const changesSince = requestParams.changes_since ? decodeCursor(requestParams.changes_since) : null;
  const paginationCursor = requestParams.cursor ? decodeCursor(requestParams.cursor) : null;

  let rows;

  if (changesSince !== null) {
    // Incremental sync: return records changed since version
    rows = await db.query(sql`
      SELECT record_key, record_json, emitted_at, version, deleted, deleted_at
      FROM records
      WHERE connector_id = ${connectorId}
        AND stream = ${stream}
        AND version > ${changesSince.version}
      ORDER BY version ASC
      LIMIT ${limit + 1}
    `);
  } else {
    // Normal pagination
    let cursorClause = sql``;
    if (paginationCursor) {
      if (order === 'DESC') {
        cursorClause = sql`AND id < ${paginationCursor.id}`;
      } else {
        cursorClause = sql`AND id > ${paginationCursor.id}`;
      }
    }

    rows = await db.query(sql`
      SELECT id, record_key, record_json, emitted_at, version, deleted, deleted_at
      FROM records
      WHERE connector_id = ${connectorId}
        AND stream = ${stream}
        AND deleted = 0
        ${cursorClause}
      ORDER BY id ${order === 'ASC' ? sql`ASC` : sql`DESC`}
      LIMIT ${limit + 1}
    `);
  }

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  // Get current max version for next_changes_since
  const vcRows = await db.query(sql`
    SELECT max_version FROM version_counter
    WHERE connector_id = ${connectorId} AND stream = ${stream}
  `);
  const maxVersion = vcRows.length ? vcRows[0].max_version : 0;

  const data = [];

  for (const row of pageRows) {
    if (changesSince !== null && row.deleted) {
      // Tombstone
      data.push({
        object: 'record',
        id: row.record_key,
        stream,
        deleted: true,
        deleted_at: row.deleted_at,
        emitted_at: row.emitted_at,
      });
      continue;
    }

    if (row.deleted) continue; // skip deleted in normal pagination

    const rawData = JSON.parse(row.record_json);

    // Apply time_range filter
    if (effective.timeRange && consentTimeField) {
      if (!passesTimeRange(rawData, effective.timeRange, consentTimeField)) continue;
    }

    // Apply resources filter
    if (effective.resources && !effective.resources.includes(row.record_key)) continue;

    // Apply field projection
    const projected = projectFields(rawData, effective.fields);

    // Apply request-level field filters (exact match)
    // Express qs parses filter[field]=val as requestParams.filter = { field: val }
    let passes = true;
    if (requestParams.filter && typeof requestParams.filter === 'object') {
      for (const [field, val] of Object.entries(requestParams.filter)) {
        if (String(rawData[field]) !== String(val)) { passes = false; break; }
      }
    }
    if (!passes) continue;

    data.push({
      object: 'record',
      id: row.record_key,
      stream,
      data: projected,
      emitted_at: row.emitted_at,
    });
  }

  const response = {
    object: 'list',
    has_more: hasMore,
    data,
  };

  if (hasMore && pageRows.length) {
    const lastRow = pageRows[pageRows.length - 1];
    if (changesSince !== null) {
      response.next_cursor = encodeCursor({ version: lastRow.version });
    } else {
      response.next_cursor = encodeCursor({ id: lastRow.id });
    }
  }

  // Always include next_changes_since when doing a changes_since query
  if (changesSince !== null) {
    response.next_changes_since = encodeCursor({ version: maxVersion });
  }

  return response;
}

/**
 * Get a single record by key, under grant enforcement
 */
export async function getRecord(connectorId, stream, recordId, grant, manifest = null) {
  const db = getDb();

  const streamGrant = grant.streams.find(s => s.name === stream);
  if (!streamGrant) {
    const err = new Error(`Stream '${stream}' not in grant`);
    err.code = 'grant_stream_not_allowed';
    throw err;
  }

  const rows = await db.query(sql`
    SELECT record_key, record_json, emitted_at
    FROM records
    WHERE connector_id = ${connectorId}
      AND stream = ${stream}
      AND record_key = ${recordId}
      AND deleted = 0
  `);

  if (!rows.length) {
    const err = new Error('Record not found');
    err.code = 'not_found';
    throw err;
  }

  const row = rows[0];
  const rawData = JSON.parse(row.record_json);
  const mStream = manifest?.streams?.find(s => s.name === stream);
  const consentTimeField = mStream?.consent_time_field;

  const effective = buildEffectiveFilter(streamGrant, {});
  if (effective.timeRange && consentTimeField) {
    if (!passesTimeRange(rawData, effective.timeRange, consentTimeField)) {
      const err = new Error('Record not found');
      err.code = 'not_found';
      throw err;
    }
  }

  return {
    object: 'record',
    id: row.record_key,
    stream,
    data: projectFields(rawData, effective.fields),
    emitted_at: row.emitted_at,
  };
}

/**
 * Delete a record (owner-authenticated)
 */
export async function deleteRecord(connectorId, stream, recordId) {
  const db = getDb();
  const now = nowIso();

  const vcRows = await db.query(sql`
    SELECT max_version FROM version_counter WHERE connector_id = ${connectorId} AND stream = ${stream}
  `);
  const nextVersion = vcRows.length ? vcRows[0].max_version + 1 : 1;

  await db.query(sql`
    UPDATE records
    SET deleted = 1, deleted_at = ${now}, version = ${nextVersion}
    WHERE connector_id = ${connectorId} AND stream = ${stream} AND record_key = ${recordId}
  `);

  await db.query(sql`
    INSERT INTO version_counter(connector_id, stream, max_version)
    VALUES(${connectorId}, ${stream}, ${nextVersion})
    ON CONFLICT(connector_id, stream) DO UPDATE SET max_version = excluded.max_version
  `);
}

/**
 * Delete all records for a connector+stream (owner-authenticated, demo reset use)
 */
export async function deleteAllRecords(connectorId, stream) {
  const db = getDb();
  await db.query(sql`
    DELETE FROM records
    WHERE connector_id = ${connectorId} AND stream = ${stream}
  `);
  await db.query(sql`
    DELETE FROM version_counter
    WHERE connector_id = ${connectorId} AND stream = ${stream}
  `);
}

/**
 * List streams available under a grant, with record counts
 */
export async function listStreams(connectorId, grant) {
  const db = getDb();
  const result = [];

  for (const sg of grant.streams) {
    const rows = await db.query(sql`
      SELECT COUNT(*) as count, MAX(emitted_at) as last_updated
      FROM records
      WHERE connector_id = ${connectorId} AND stream = ${sg.name} AND deleted = 0
    `);
    result.push({
      object: 'stream',
      name: sg.name,
      record_count: rows[0]?.count || 0,
      last_updated: rows[0]?.last_updated || null,
    });
  }

  return result;
}

/**
 * Get/put sync state (Collection Profile, owner-authenticated)
 */
export async function getSyncState(connectorId) {
  const db = getDb();
  const rows = await db.query(sql`
    SELECT stream, state_json, updated_at FROM connector_state WHERE connector_id = ${connectorId}
  `);
  const state = {};
  let updatedAt = null;
  for (const row of rows) {
    state[row.stream] = JSON.parse(row.state_json);
    if (!updatedAt || row.updated_at > updatedAt) updatedAt = row.updated_at;
  }
  return {
    object: 'stream_state',
    connector_id: connectorId,
    state,
    updated_at: updatedAt,
  };
}

export async function putSyncState(connectorId, stateMap) {
  const db = getDb();
  const now = nowIso();
  for (const [stream, cursor] of Object.entries(stateMap)) {
    await db.query(sql`
      INSERT INTO connector_state(connector_id, stream, state_json, updated_at)
      VALUES(${connectorId}, ${stream}, ${JSON.stringify(cursor)}, ${now})
      ON CONFLICT(connector_id, stream) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `);
  }
  return getSyncState(connectorId);
}

// --- Cursor encoding ---

function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

function decodeCursor(str) {
  try {
    return JSON.parse(Buffer.from(str, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}
