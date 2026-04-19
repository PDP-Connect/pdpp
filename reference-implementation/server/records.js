/**
 * PDPP Resource Server — record storage and grant-enforced query
 */
import { getDb, sql } from './db.js';

function nowIso() {
  return new Date().toISOString();
}

function resolveStorageConnectorId(storageTarget) {
  if (typeof storageTarget === 'string' && storageTarget.trim()) {
    return storageTarget.trim();
  }
  if (storageTarget && typeof storageTarget === 'object' && typeof storageTarget.connector_id === 'string' && storageTarget.connector_id.trim()) {
    return storageTarget.connector_id.trim();
  }
  return null;
}

function getChangeHistoryLimit() {
  return Math.max(parseInt(process.env.PDPP_CHANGE_HISTORY_LIMIT || '0', 10) || 0, 0);
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
export async function ingestRecord(storageTarget, record) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const db = getDb();
  const { stream, key, data, emitted_at, op = 'upsert' } = record;
  const recordKey = encodeKey(key);
  const recordJson = data ? JSON.stringify(data) : null;

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

  const currentRows = await db.query(sql`
    SELECT record_json, deleted
    FROM records
    WHERE connector_id = ${connectorId} AND stream = ${stream} AND record_key = ${recordKey}
  `);
  const current = currentRows[0] || null;

  if (op === 'delete' && (!current || current.deleted)) {
    return { accepted: true, changed: false };
  }

  if (op !== 'delete' && current && !current.deleted && current.record_json === recordJson) {
    return { accepted: true, changed: false };
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
    await db.query(sql`
      INSERT INTO record_changes(connector_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
      VALUES(
        ${connectorId},
        ${stream},
        ${recordKey},
        ${nextVersion},
        ${current.record_json},
        ${emitted_at || nowIso()},
        1,
        ${emitted_at || nowIso()}
      )
    `);
  } else {
    await db.query(sql`
      INSERT INTO records(connector_id, stream, record_key, record_json, emitted_at, version)
      VALUES(${connectorId}, ${stream}, ${recordKey}, ${recordJson}, ${emitted_at || nowIso()}, ${nextVersion})
      ON CONFLICT(connector_id, stream, record_key) DO UPDATE SET
        record_json = excluded.record_json,
        emitted_at = excluded.emitted_at,
        version = excluded.version,
        deleted = 0,
        deleted_at = NULL
    `);
    await db.query(sql`
      INSERT INTO record_changes(connector_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
      VALUES(
        ${connectorId},
        ${stream},
        ${recordKey},
        ${nextVersion},
        ${recordJson},
        ${emitted_at || nowIso()},
        0,
        NULL
      )
    `);
  }

  // Advance version counter
  await db.query(sql`
    INSERT INTO version_counter(connector_id, stream, max_version)
    VALUES(${connectorId}, ${stream}, ${nextVersion})
    ON CONFLICT(connector_id, stream) DO UPDATE SET max_version = excluded.max_version
  `);

  const changeHistoryLimit = getChangeHistoryLimit();
  if (changeHistoryLimit > 0) {
    await db.query(sql`
      DELETE FROM record_changes
      WHERE connector_id = ${connectorId}
        AND stream = ${stream}
        AND version <= ${nextVersion - changeHistoryLimit}
    `);
  }

  return { accepted: true, changed: true };
}

/**
 * Build an effective filter from grant + request params.
 * Returns { fieldFilter, timeRangeFilter, resourceFilter } for use in queries.
 */
function buildEffectiveFilter(streamGrant, requestParams, requiredFields = []) {
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

  if (effective.fields) {
    effective.fields = [...new Set([...requiredFields, ...effective.fields])];
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

function passesRequestFilters(data, filter) {
  if (!filter || typeof filter !== 'object') return true;
  for (const [field, val] of Object.entries(filter)) {
    if (String(data[field]) !== String(val)) return false;
  }
  return true;
}

function isVisibleSnapshot(snapshot, effective, consentTimeField) {
  if (!snapshot || snapshot.deleted || !snapshot.data) return false;
  if (effective.resources && !effective.resources.includes(snapshot.record_key)) return false;
  if (effective.timeRange && consentTimeField && !passesTimeRange(snapshot.data, effective.timeRange, consentTimeField)) return false;
  return true;
}

function parseChangesSinceCursor(str) {
  const decoded = decodeCursor(str);
  if (!decoded) return null;
  if (!decoded.kind) {
    return Number.isInteger(decoded.version) ? { version: decoded.version } : null;
  }
  if (decoded.kind !== 'changes_since' || !Number.isInteger(decoded.version)) return null;
  return decoded;
}

function parsePageCursor(str) {
  const decoded = decodeCursor(str);
  if (!decoded) return null;
  if (!decoded.kind) {
    if (Number.isInteger(decoded.id)) return { kind: 'page', session: 'records', id: decoded.id };
    return null;
  }
  if (decoded.kind !== 'page' || typeof decoded.session !== 'string') return null;
  return decoded;
}

function encodeRecordsPageCursor(id) {
  return encodeCursor({ kind: 'page', session: 'records', id });
}

function encodeChangesPageCursor({ sinceVersion, afterVersion, sessionMaxVersion }) {
  return encodeCursor({
    kind: 'page',
    session: 'changes',
    since_version: sinceVersion,
    after_version: afterVersion,
    session_max_version: sessionMaxVersion,
  });
}

function encodeChangesSinceCursor(version) {
  return encodeCursor({ kind: 'changes_since', version });
}

async function getSnapshotAtVersion(db, connectorId, stream, recordKey, version) {
  if (!Number.isInteger(version) || version < 0) return null;
  const rows = await db.query(sql`
    SELECT record_json, emitted_at, deleted, deleted_at, version
    FROM record_changes
    WHERE connector_id = ${connectorId}
      AND stream = ${stream}
      AND record_key = ${recordKey}
      AND version <= ${version}
    ORDER BY version DESC
    LIMIT 1
  `);

  if (!rows.length) return null;

  const row = rows[0];
  return {
    record_key: recordKey,
    version: row.version,
    data: row.record_json ? JSON.parse(row.record_json) : null,
    emitted_at: row.emitted_at,
    deleted: !!row.deleted,
    deleted_at: row.deleted_at,
  };
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
export async function queryRecords(storageTarget, stream, grant, requestParams = {}, manifest = null) {
  const connectorId = resolveStorageConnectorId(storageTarget);
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
  const requiredFields = mStream?.schema?.required || [];

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

  const effective = buildEffectiveFilter(streamGrant, requestParams, requiredFields);

  const limit = Math.min(parseInt(requestParams.limit) || 25, 100);
  const order = requestParams.order === 'asc' ? 'ASC' : 'DESC';

  // Parse changes_since cursor
  const changesSince = requestParams.changes_since ? parseChangesSinceCursor(requestParams.changes_since) : null;
  const paginationCursor = requestParams.cursor ? parsePageCursor(requestParams.cursor) : null;

  if (requestParams.changes_since && !changesSince) {
    const err = new Error('Malformed changes_since cursor');
    err.code = 'invalid_cursor';
    throw err;
  }

  if (requestParams.cursor && !paginationCursor) {
    const err = new Error('Malformed cursor');
    err.code = 'invalid_cursor';
    throw err;
  }

  if (changesSince !== null || paginationCursor?.session === 'changes') {
    const sinceVersion = changesSince ? changesSince.version : paginationCursor.since_version;
    const afterVersion = changesSince ? changesSince.version : paginationCursor.after_version;
    const sessionMaxVersion = changesSince ? null : paginationCursor.session_max_version;

    if (![sinceVersion, afterVersion].every(Number.isInteger)) {
      const err = new Error('Malformed changes_since cursor');
      err.code = 'invalid_cursor';
      throw err;
    }

    const vcRows = await db.query(sql`
      SELECT max_version FROM version_counter
      WHERE connector_id = ${connectorId} AND stream = ${stream}
    `);
    const currentMaxVersion = vcRows.length ? vcRows[0].max_version : 0;
    const effectiveSessionMaxVersion = changesSince ? currentMaxVersion : sessionMaxVersion;

    const minChangeRows = await db.query(sql`
      SELECT MIN(version) as min_version
      FROM record_changes
      WHERE connector_id = ${connectorId} AND stream = ${stream}
    `);
    const minVersion = minChangeRows[0]?.min_version ?? null;
    if (minVersion !== null && sinceVersion < (minVersion - 1)) {
      const err = new Error('changes_since cursor is too old; full re-sync required');
      err.code = 'cursor_expired';
      throw err;
    }

    const visibleChanges = [];
    let pageAfterVersion = afterVersion;
    const batchSize = limit + 1;

    while (visibleChanges.length <= limit) {
      const changeGroups = await db.query(sql`
        SELECT record_key, MAX(version) as latest_version
        FROM record_changes
        WHERE connector_id = ${connectorId}
          AND stream = ${stream}
          AND version > ${pageAfterVersion}
          AND version <= ${effectiveSessionMaxVersion}
        GROUP BY record_key
        ORDER BY latest_version ASC
        LIMIT ${batchSize}
      `);

      if (!changeGroups.length) break;

      for (const group of changeGroups) {
        const previous = await getSnapshotAtVersion(db, connectorId, stream, group.record_key, sinceVersion);
        const current = await getSnapshotAtVersion(db, connectorId, stream, group.record_key, group.latest_version);

        const previousVisible = isVisibleSnapshot(previous, effective, consentTimeField);
        const currentVisible = isVisibleSnapshot(current, effective, consentTimeField);

        if (current?.deleted) {
          if (!previousVisible || !passesRequestFilters(previous.data, requestParams.filter)) continue;
          visibleChanges.push({
            latestVersion: group.latest_version,
            responseRecord: {
              object: 'record',
              id: group.record_key,
              stream,
              deleted: true,
              deleted_at: current.deleted_at,
              emitted_at: current.emitted_at,
            },
          });
          if (visibleChanges.length > limit) break;
          continue;
        }

        if (!currentVisible || !passesRequestFilters(current.data, requestParams.filter)) continue;

        const previousProjection = previousVisible ? projectFields(previous.data, effective.fields) : null;
        const currentProjection = projectFields(current.data, effective.fields);

        if (previousProjection && JSON.stringify(previousProjection) === JSON.stringify(currentProjection)) {
          continue;
        }

        visibleChanges.push({
          latestVersion: group.latest_version,
          responseRecord: {
            object: 'record',
            id: group.record_key,
            stream,
            data: currentProjection,
            emitted_at: current.emitted_at,
          },
        });
        if (visibleChanges.length > limit) break;
      }

      if (visibleChanges.length > limit || changeGroups.length < batchSize) break;
      pageAfterVersion = changeGroups[changeGroups.length - 1].latest_version;
    }

    const hasMore = visibleChanges.length > limit;
    const data = visibleChanges.slice(0, limit).map((change) => change.responseRecord);

    const response = {
      object: 'list',
      has_more: hasMore,
      data,
    };

    if (hasMore && data.length) {
      const lastGroup = visibleChanges[limit - 1];
      response.next_cursor = encodeChangesPageCursor({
        sinceVersion,
        afterVersion: lastGroup.latestVersion,
        sessionMaxVersion: effectiveSessionMaxVersion,
      });
    }

    response.next_changes_since = encodeChangesSinceCursor(effectiveSessionMaxVersion);
    return response;
  }

  if (changesSince !== null) {
    const err = new Error('Malformed changes_since cursor');
    err.code = 'invalid_cursor';
    throw err;
  }

  // Normal pagination
  let pageCursorId = null;
  if (paginationCursor) {
    if (paginationCursor.session !== 'records' || !Number.isInteger(paginationCursor.id)) {
      const err = new Error('Malformed cursor');
      err.code = 'invalid_cursor';
      throw err;
    }
    pageCursorId = paginationCursor.id;
  }

  const visibleRows = [];
  const batchSize = limit + 1;

  // `has_more` should reflect additional visible records, not merely additional raw rows.
  while (visibleRows.length <= limit) {
    let cursorClause = sql``;
    if (pageCursorId != null) {
      cursorClause = order === 'DESC'
        ? sql`AND id < ${pageCursorId}`
        : sql`AND id > ${pageCursorId}`;
    }

    const rows = await db.query(sql`
      SELECT id, record_key, record_json, emitted_at, version, deleted, deleted_at
      FROM records
      WHERE connector_id = ${connectorId}
        AND stream = ${stream}
        AND deleted = 0
        ${cursorClause}
      ORDER BY id ${order === 'ASC' ? sql`ASC` : sql`DESC`}
      LIMIT ${batchSize}
    `);

    if (!rows.length) break;

    for (const row of rows) {
      if (row.deleted) continue;

      const rawData = JSON.parse(row.record_json);

      if (effective.timeRange && consentTimeField) {
        if (!passesTimeRange(rawData, effective.timeRange, consentTimeField)) continue;
      }

      if (effective.resources && !effective.resources.includes(row.record_key)) continue;

      if (!passesRequestFilters(rawData, requestParams.filter)) continue;

      visibleRows.push({
        rowId: row.id,
        responseRecord: {
          object: 'record',
          id: row.record_key,
          stream,
          data: projectFields(rawData, effective.fields),
          emitted_at: row.emitted_at,
        },
      });

      if (visibleRows.length > limit) break;
    }

    if (visibleRows.length > limit || rows.length < batchSize) break;
    pageCursorId = rows[rows.length - 1].id;
  }

  const hasMore = visibleRows.length > limit;
  const data = visibleRows.slice(0, limit).map((row) => row.responseRecord);

  const response = {
    object: 'list',
    has_more: hasMore,
    data,
  };

  if (hasMore && data.length) {
    response.next_cursor = encodeRecordsPageCursor(visibleRows[limit - 1].rowId);
  }

  return response;
}

/**
 * Get a single record by key, under grant enforcement
 */
export async function getRecord(storageTarget, stream, recordId, grant, manifest = null) {
  const connectorId = resolveStorageConnectorId(storageTarget);
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
  const requiredFields = mStream?.schema?.required || [];

  const effective = buildEffectiveFilter(streamGrant, {}, requiredFields);
  if (effective.resources && !effective.resources.includes(row.record_key)) {
    const err = new Error('Record not found');
    err.code = 'not_found';
    throw err;
  }
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
export async function deleteRecord(storageTarget, stream, recordId) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const db = getDb();
  const now = nowIso();
  const currentRows = await db.query(sql`
    SELECT record_json, deleted
    FROM records
    WHERE connector_id = ${connectorId} AND stream = ${stream} AND record_key = ${recordId}
  `);
  const current = currentRows[0] || null;
  if (!current || current.deleted) return 0;

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
    INSERT INTO record_changes(connector_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
    VALUES(
      ${connectorId},
      ${stream},
      ${recordId},
      ${nextVersion},
      ${current.record_json},
      ${now},
      1,
      ${now}
    )
  `);

  await db.query(sql`
    INSERT INTO version_counter(connector_id, stream, max_version)
    VALUES(${connectorId}, ${stream}, ${nextVersion})
    ON CONFLICT(connector_id, stream) DO UPDATE SET max_version = excluded.max_version
  `);

  const changeHistoryLimit = getChangeHistoryLimit();
  if (changeHistoryLimit > 0) {
    await db.query(sql`
      DELETE FROM record_changes
      WHERE connector_id = ${connectorId}
        AND stream = ${stream}
        AND version <= ${nextVersion - changeHistoryLimit}
    `);
  }

  return 1;
}

export async function listAllStreams(storageTarget) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const db = getDb();
  const rows = await db.query(sql`
    SELECT stream, COUNT(*) as count, MAX(emitted_at) as last_updated
    FROM records
    WHERE connector_id = ${connectorId} AND deleted = 0
    GROUP BY stream
    ORDER BY stream ASC
  `);

  return rows.map((row) => ({
    object: 'stream',
    name: row.stream,
    record_count: row.count || 0,
    last_updated: row.last_updated || null,
  }));
}

/**
 * Delete all records for a connector+stream (owner-authenticated reference reset use)
 */
export async function deleteAllRecords(storageTarget, stream) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const db = getDb();
  const countRows = await db.query(sql`
    SELECT COUNT(*) AS count
    FROM records
    WHERE connector_id = ${connectorId} AND stream = ${stream}
  `);
  const deletedRecordCount = countRows[0]?.count || 0;
  await db.query(sql`
    DELETE FROM records
    WHERE connector_id = ${connectorId} AND stream = ${stream}
  `);
  await db.query(sql`
    DELETE FROM record_changes
    WHERE connector_id = ${connectorId} AND stream = ${stream}
  `);
  await db.query(sql`
    DELETE FROM version_counter
    WHERE connector_id = ${connectorId} AND stream = ${stream}
  `);
  return deletedRecordCount;
}

/**
 * List streams available under a grant, with record counts
 */
export async function listStreams(storageTarget, grant, manifest = null) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const db = getDb();
  const result = [];

  for (const sg of grant.streams) {
    const rows = await db.query(sql`
      SELECT record_key, record_json, emitted_at
      FROM records
      WHERE connector_id = ${connectorId} AND stream = ${sg.name} AND deleted = 0
    `);
    const effective = buildEffectiveFilter(sg, {});
    const manifestStream = manifest?.streams?.find((stream) => stream.name === sg.name);
    const consentTimeField = manifestStream?.consent_time_field || null;
    let visibleCount = 0;
    let lastUpdated = null;

    for (const row of rows) {
      const rawData = JSON.parse(row.record_json);
      if (effective.timeRange && consentTimeField) {
        if (!passesTimeRange(rawData, effective.timeRange, consentTimeField)) continue;
      }
      if (effective.resources && !effective.resources.includes(row.record_key)) continue;
      visibleCount += 1;
      if (!lastUpdated || row.emitted_at > lastUpdated) {
        lastUpdated = row.emitted_at;
      }
    }

    result.push({
      object: 'stream',
      name: sg.name,
      record_count: visibleCount,
      last_updated: lastUpdated,
    });
  }

  return result;
}

/**
 * Get/put sync state (Collection Profile, owner-authenticated)
 */
export async function getSyncState(storageTarget, opts = {}) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const db = getDb();
  const { grantId = null, allowedStreams = null } = opts;
  const allowedStreamSet = allowedStreams instanceof Set
    ? allowedStreams
    : (Array.isArray(allowedStreams) ? new Set(allowedStreams) : null);
  const rows = grantId
    ? await db.query(sql`
      SELECT stream, state_json, updated_at
      FROM grant_connector_state
      WHERE connector_id = ${connectorId} AND grant_id = ${grantId}
    `)
    : await db.query(sql`
      SELECT stream, state_json, updated_at
      FROM connector_state
      WHERE connector_id = ${connectorId}
    `);
  const state = {};
  let updatedAt = null;
  for (const row of rows) {
    if (allowedStreamSet && !allowedStreamSet.has(row.stream)) continue;
    state[row.stream] = JSON.parse(row.state_json);
    if (!updatedAt || row.updated_at > updatedAt) updatedAt = row.updated_at;
  }
  return {
    object: 'stream_state',
    connector_id: connectorId,
    grant_id: grantId,
    state,
    updated_at: updatedAt,
  };
}

export async function putSyncState(storageTarget, stateMap, opts = {}) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const db = getDb();
  const { grantId = null, allowedStreams = null } = opts;
  const now = nowIso();
  for (const [stream, cursor] of Object.entries(stateMap)) {
    if (grantId) {
      await db.query(sql`
        INSERT INTO grant_connector_state(grant_id, connector_id, stream, state_json, updated_at)
        VALUES(${grantId}, ${connectorId}, ${stream}, ${JSON.stringify(cursor)}, ${now})
        ON CONFLICT(grant_id, connector_id, stream) DO UPDATE SET
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `);
      continue;
    }

    await db.query(sql`
      INSERT INTO connector_state(connector_id, stream, state_json, updated_at)
      VALUES(${connectorId}, ${stream}, ${JSON.stringify(cursor)}, ${now})
      ON CONFLICT(connector_id, stream) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `);
  }
  return getSyncState(connectorId, { grantId, allowedStreams });
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
