/**
 * Postgres-backed record and blob runtime capabilities.
 *
 * This module intentionally sits behind the existing async record/blob
 * capability functions. Operation modules keep receiving host-provided
 * capabilities and do not import this file.
 *
 * Spec: openspec/changes/add-postgres-runtime-storage/
 */

import { createHash } from 'node:crypto';

import { postgresQuery, withPostgresTransaction } from './postgres-storage.js';

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const KEY_SEPARATOR = '\u0001';

function nowIso() {
  return new Date().toISOString();
}

function encodeKey(key) {
  return Array.isArray(key) ? JSON.stringify(key) : String(key);
}

function decodeKey(keyStr) {
  try {
    const parsed = JSON.parse(keyStr);
    return Array.isArray(parsed) ? parsed : keyStr;
  } catch {
    return keyStr;
  }
}

function resolveStorageConnectorId(storageTarget) {
  if (typeof storageTarget === 'string') return storageTarget;
  if (storageTarget?.connector_id) return storageTarget.connector_id;
  if (storageTarget?.connectorId) return storageTarget.connectorId;
  throw new Error('storage target must include connector_id');
}

function getChangeHistoryLimit() {
  return Math.max(Number.parseInt(process.env.PDPP_CHANGE_HISTORY_LIMIT || '0', 10) || 0, 0);
}

function getStreamGrant(grant, stream) {
  const streamGrant = grant?.streams?.find((entry) => entry.name === stream);
  if (!streamGrant) {
    const err = new Error(`Stream '${stream}' not in grant`);
    err.code = 'grant_stream_not_allowed';
    throw err;
  }
  return streamGrant;
}

function getManifestStream(manifest, stream) {
  return manifest?.streams?.find((entry) => entry.name === stream) || null;
}

function requiredFieldsFor(manifestStream) {
  return Array.isArray(manifestStream?.schema?.required) ? manifestStream.schema.required : [];
}

function primaryKeyFieldsFor(manifestStream) {
  const primary = manifestStream?.primary_key;
  if (Array.isArray(primary)) return primary;
  if (typeof primary === 'string') return [primary];
  return ['id'];
}

function fieldsFor(streamGrant, requestFields, requiredFields) {
  let effective = null;
  if (Array.isArray(streamGrant?.fields) && streamGrant.fields.length > 0) {
    effective = [...streamGrant.fields];
  }
  if (Array.isArray(requestFields) && requestFields.length > 0) {
    if (effective) {
      const unauthorized = requestFields.filter((field) => !effective.includes(field));
      if (unauthorized.length > 0) {
        const err = new Error(`Fields not in grant: ${unauthorized.join(', ')}`);
        err.code = 'field_not_granted';
        throw err;
      }
      effective = requestFields.filter((field) => effective.includes(field));
    } else {
      effective = [...requestFields];
    }
  }
  if (effective) {
    const seen = new Set(effective);
    for (const required of requiredFields) {
      if (!seen.has(required)) {
        effective.push(required);
        seen.add(required);
      }
    }
  }
  return effective;
}

function projectFields(data, fields) {
  if (!fields) return data;
  const out = {};
  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      out[field] = data[field];
    }
  }
  return out;
}

function primaryKeyText(data, recordKey, manifestStream) {
  const parts = primaryKeyFieldsFor(manifestStream).map((field) => {
    const value = data?.[field];
    return value === undefined || value === null ? recordKey : value;
  });
  return parts.map((part) => String(part ?? '')).join(KEY_SEPARATOR);
}

function cursorValue(data, manifestStream) {
  const field = manifestStream?.cursor_field;
  if (!field) return null;
  const value = data?.[field];
  return value === undefined || value === null ? null : String(value);
}

function encodeCursor(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodeCursor(token) {
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function responseRecord({ stream, row, fields }) {
  return {
    object: 'record',
    id: row.record_key,
    stream,
    data: projectFields(row.record_json, fields),
    emitted_at: row.emitted_at,
  };
}

function deletedResponseRecord({ stream, row }) {
  return {
    object: 'record',
    id: row.record_key,
    stream,
    deleted: true,
    deleted_at: row.deleted_at || row.emitted_at,
    emitted_at: row.emitted_at,
  };
}

function parseLimit(value) {
  const parsed = Number.parseInt(String(value ?? DEFAULT_LIMIT), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function buildFilterClause(filter, params) {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return '';
  const clauses = [];
  for (const [field, raw] of Object.entries(filter)) {
    if (!/^[A-Za-z0-9_]+$/.test(field)) {
      const err = new Error(`Invalid filter field: ${field}`);
      err.code = 'invalid_request';
      throw err;
    }
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      clauses.push(`record_json ? '${field}'`);
      for (const [op, value] of Object.entries(raw)) {
        const operator = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
        if (!operator) continue;
        params.push(value);
        clauses.push(`record_json->>'${field}' ${operator} $${params.length}`);
      }
    } else {
      params.push(String(raw));
      clauses.push(`record_json->>'${field}' = $${params.length}`);
    }
  }
  return clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '';
}

function safeJsonField(field) {
  if (!field || !/^[A-Za-z0-9_]+$/.test(field)) return null;
  return field;
}

function recordOrderExpressions(manifestStream) {
  const cursorField = safeJsonField(manifestStream?.cursor_field);
  const primaryField = safeJsonField(primaryKeyFieldsFor(manifestStream)[0]);
  return {
    cursorSql: cursorField ? `(record_json->>'${cursorField}')` : 'emitted_at',
    primarySql: primaryField ? `COALESCE(record_json->>'${primaryField}', record_key)` : 'record_key',
  };
}

async function allocateNextVersion(client, connectorId, stream) {
  const result = await client.query(
    `INSERT INTO version_counter (connector_id, stream, max_version)
     VALUES ($1, $2, 1)
     ON CONFLICT (connector_id, stream) DO UPDATE
       SET max_version = version_counter.max_version + 1
     RETURNING max_version`,
    [connectorId, stream],
  );
  return Number(result.rows[0].max_version);
}

export async function postgresIngestRecord(storageTarget, record) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const { stream, key, data, emitted_at: emittedAt, op = 'upsert' } = record;
  const recordKey = encodeKey(key);
  const recordJson = data ? JSON.stringify(data) : null;

  if (typeof key === 'string' && data?.id !== undefined && data.id !== key) {
    const err = new Error(`key and data.id disagree: key=${key}, data.id=${data.id}`);
    err.code = 'invalid_record_identity';
    throw err;
  }
  if (Array.isArray(key) && key.length === 1 && data?.id !== undefined && data.id !== key[0]) {
    const err = new Error(`key and data.id disagree: key=${key[0]}, data.id=${data.id}`);
    err.code = 'invalid_record_identity';
    throw err;
  }

  const effectiveEmittedAt = emittedAt || nowIso();
  const changeHistoryLimit = getChangeHistoryLimit();

  const outcome = await withPostgresTransaction(async (client) => {
    const currentResult = await client.query(
      `SELECT record_json, deleted
       FROM records
       WHERE connector_id = $1 AND stream = $2 AND record_key = $3
       FOR UPDATE`,
      [connectorId, stream, recordKey],
    );
    const current = currentResult.rows[0] || null;

    if (op === 'delete' && (!current || current.deleted)) {
      return { kind: 'noop' };
    }
    if (op !== 'delete' && current && !current.deleted && JSON.stringify(current.record_json) === recordJson) {
      return { kind: 'noop' };
    }

    const nextVersion = await allocateNextVersion(client, connectorId, stream);

    if (op === 'delete') {
      await client.query(
        `UPDATE records
         SET deleted = TRUE, deleted_at = $4, emitted_at = $4, version = $5
         WHERE connector_id = $1 AND stream = $2 AND record_key = $3`,
        [connectorId, stream, recordKey, effectiveEmittedAt, nextVersion],
      );
      await client.query(
        `INSERT INTO record_changes
           (connector_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, TRUE, $6)`,
        [connectorId, stream, recordKey, nextVersion, JSON.stringify(current.record_json), effectiveEmittedAt],
      );
    } else {
      await client.query(
        `INSERT INTO records
           (connector_id, stream, record_key, record_json, emitted_at, version, deleted, deleted_at, cursor_value, primary_key_text)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, FALSE, NULL, $7, $8)
         ON CONFLICT (connector_id, stream, record_key) DO UPDATE
           SET record_json = EXCLUDED.record_json,
               emitted_at = EXCLUDED.emitted_at,
               version = EXCLUDED.version,
               deleted = FALSE,
               deleted_at = NULL,
               cursor_value = EXCLUDED.cursor_value,
               primary_key_text = EXCLUDED.primary_key_text`,
        [connectorId, stream, recordKey, recordJson, effectiveEmittedAt, nextVersion, null, recordKey],
      );
      await client.query(
        `INSERT INTO record_changes
           (connector_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, FALSE, NULL)`,
        [connectorId, stream, recordKey, nextVersion, recordJson, effectiveEmittedAt],
      );
    }

    if (changeHistoryLimit > 0) {
      await client.query(
        `DELETE FROM record_changes
         WHERE connector_id = $1 AND stream = $2 AND version <= $3`,
        [connectorId, stream, nextVersion - changeHistoryLimit],
      );
    }

    return { kind: 'changed', op };
  });

  return outcome.kind === 'noop'
    ? { accepted: true, changed: false }
    : { accepted: true, changed: true };
}

export async function postgresDeleteRecord(storageTarget, stream, recordId) {
  return postgresIngestRecord(storageTarget, {
    stream,
    key: decodeKey(recordId),
    data: {},
    op: 'delete',
  });
}

export async function postgresQueryRecords(storageTarget, stream, grant, requestParams = {}, manifest = null) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const streamGrant = getStreamGrant(grant, stream);
  const manifestStream = getManifestStream(manifest, stream);
  const fields = fieldsFor(streamGrant, requestParams.fields, requiredFieldsFor(manifestStream));
  const { cursorSql, primarySql } = recordOrderExpressions(manifestStream);
  const order = requestParams.order === 'desc' ? 'desc' : 'asc';
  const limit = parseLimit(requestParams.limit);

  if (requestParams.changes_since != null) {
    const decoded = requestParams.changes_since === 'beginning'
      ? { v: 0 }
      : decodeCursor(requestParams.changes_since);
    if (!decoded || !Number.isInteger(decoded.v)) {
      const err = new Error('Malformed changes_since cursor');
      err.code = 'invalid_cursor';
      throw err;
    }
    const maxResult = await postgresQuery(
      `SELECT max_version FROM version_counter WHERE connector_id = $1 AND stream = $2`,
      [connectorId, stream],
    );
    const sessionMax = maxResult.rows[0] ? Number(maxResult.rows[0].max_version) : 0;
    const rows = await postgresQuery(
      `SELECT DISTINCT ON (record_key)
              record_key, record_json, deleted, deleted_at, emitted_at, version
       FROM record_changes
       WHERE connector_id = $1 AND stream = $2
         AND version > $3 AND version <= $4
       ORDER BY record_key, version DESC`,
      [connectorId, stream, decoded.v, sessionMax],
    );
    const sorted = [...rows.rows].sort((a, b) => Number(a.version) - Number(b.version));
    return {
      object: 'list',
      has_more: false,
      data: sorted.map((row) => row.deleted
        ? deletedResponseRecord({ stream, row })
        : responseRecord({ stream, row, fields })),
      next_changes_since: encodeCursor({ v: sessionMax }),
    };
  }

  let cursorPosition = null;
  if (requestParams.cursor) {
    cursorPosition = decodeCursor(requestParams.cursor);
    if (!cursorPosition || cursorPosition.k !== 'pg:records' || cursorPosition.order !== order) {
      const err = new Error('Malformed cursor');
      err.code = 'invalid_cursor';
      throw err;
    }
  }

  const params = [connectorId, stream];
  let where = 'WHERE connector_id = $1 AND stream = $2 AND deleted = FALSE';
  where += buildFilterClause(requestParams.filter, params);

  if (cursorPosition) {
    if (order === 'asc') {
      params.push(cursorPosition.cursor_value, cursorPosition.primary_key_text);
      where += ` AND (
        (${cursorSql} = $${params.length - 1} AND ${primarySql} > $${params.length})
        OR (${cursorSql} IS NOT NULL AND ${cursorSql} > $${params.length - 1})
        OR (${cursorSql} IS NULL AND $${params.length - 1} IS NOT NULL)
      )`;
    } else {
      params.push(cursorPosition.cursor_value, cursorPosition.primary_key_text);
      where += ` AND (
        (${cursorSql} = $${params.length - 1} AND ${primarySql} < $${params.length})
        OR (${cursorSql} IS NOT NULL AND ${cursorSql} < $${params.length - 1})
      )`;
    }
  }

  const dir = order === 'asc' ? 'ASC' : 'DESC';
  const nulls = order === 'asc' ? 'NULLS LAST' : 'NULLS FIRST';
  params.push(limit + 1);
  const result = await postgresQuery(
    `SELECT record_key, record_json, emitted_at,
            ${cursorSql} AS cursor_value,
            ${primarySql} AS primary_key_text
     FROM records
     ${where}
     ORDER BY ${cursorSql} ${dir} ${nulls}, ${primarySql} ${dir}
     LIMIT $${params.length}`,
    params,
  );
  const hasMore = result.rows.length > limit;
  const pageRows = result.rows.slice(0, limit);
  const response = {
    object: 'list',
    has_more: hasMore,
    data: pageRows.map((row) => responseRecord({ stream, row, fields })),
  };
  if (hasMore && pageRows.length > 0) {
    const last = pageRows[pageRows.length - 1];
    response.next_cursor = encodeCursor({
      k: 'pg:records',
      order,
      cursor_value: last.cursor_value ?? null,
      primary_key_text: last.primary_key_text,
    });
  }
  return response;
}

export async function postgresGetRecord(storageTarget, stream, recordId, grant, manifest = null) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const streamGrant = getStreamGrant(grant, stream);
  const manifestStream = getManifestStream(manifest, stream);
  const fields = fieldsFor(streamGrant, null, requiredFieldsFor(manifestStream));
  const result = await postgresQuery(
    `SELECT record_key, record_json, emitted_at
     FROM records
     WHERE connector_id = $1 AND stream = $2 AND record_key = $3 AND deleted = FALSE`,
    [connectorId, stream, recordId],
  );
  const row = result.rows[0];
  if (!row) {
    const err = new Error('Record not found');
    err.code = 'not_found';
    throw err;
  }
  return responseRecord({ stream, row, fields });
}

export async function postgresListAllStreams(storageTarget) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const result = await postgresQuery(
    `SELECT stream AS name, COUNT(*)::int AS record_count, MAX(emitted_at) AS last_updated
     FROM records
     WHERE connector_id = $1 AND deleted = FALSE
     GROUP BY stream
     ORDER BY stream`,
    [connectorId],
  );
  return result.rows;
}

export async function postgresListStreams(storageTarget, grant, manifest = null) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const rows = await postgresListAllStreams(connectorId);
  const byName = new Map(rows.map((row) => [row.name, row]));
  return (grant?.streams || []).map((streamGrant) => {
    const manifestStream = getManifestStream(manifest, streamGrant.name);
    const stored = byName.get(streamGrant.name);
    return {
      name: streamGrant.name,
      schema: manifestStream?.schema || null,
      record_count: stored?.record_count || 0,
      last_updated: stored?.last_updated || null,
    };
  });
}

export async function postgresDeleteAllRecords(storageTarget, stream) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const semanticScopePrefix = `[${JSON.stringify(stream)},`;
  const countResult = await postgresQuery(
    `SELECT COUNT(*)::int AS count FROM records
     WHERE connector_id = $1 AND stream = $2 AND deleted = FALSE`,
    [connectorId, stream],
  );
  const deletedRecordCount = Number(countResult.rows[0]?.count || 0);
  await postgresQuery(
    `DELETE FROM record_changes WHERE connector_id = $1 AND stream = $2;
     DELETE FROM records WHERE connector_id = $1 AND stream = $2;
     DELETE FROM version_counter WHERE connector_id = $1 AND stream = $2;
     DELETE FROM lexical_search_index WHERE connector_id = $1 AND stream = $2;
     DELETE FROM lexical_search_meta WHERE connector_id = $1 AND stream = $2;
     DELETE FROM semantic_search_blob WHERE connector_id = $1 AND scope_key LIKE $2;
     DELETE FROM semantic_search_meta WHERE connector_id = $1 AND stream = $2;
     DELETE FROM semantic_search_backfill_progress WHERE connector_id = $1 AND stream = $2;`,
    [connectorId, stream, `${semanticScopePrefix}%`],
  );
  return deletedRecordCount;
}

export async function postgresPersistContentAddressedBlob({ connectorId, stream, recordKey, mimeType, data }) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const blobId = `blob_sha256_${sha256}`;
  const sizeBytes = bytes.byteLength;

  const row = await withPostgresTransaction(async (client) => {
    await client.query(
      `INSERT INTO blobs
         (blob_id, connector_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (blob_id) DO NOTHING`,
      [blobId, connectorId, stream, recordKey, mimeType, sizeBytes, sha256, bytes],
    );
    const stored = await client.query(
      `SELECT blob_id, mime_type, size_bytes, sha256 FROM blobs WHERE blob_id = $1`,
      [blobId],
    );
    const storedRow = stored.rows[0];
    if (!storedRow || storedRow.sha256 !== sha256 || Number(storedRow.size_bytes) !== sizeBytes) {
      const err = new Error('Blob storage collision');
      err.code = 'api_error';
      throw err;
    }
    await client.query(
      `INSERT INTO blob_bindings (blob_id, connector_id, stream, record_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT DO NOTHING`,
      [blobId, connectorId, stream, recordKey],
    );
    return storedRow;
  });

  return {
    blob_id: blobId,
    sha256,
    size_bytes: Number(row.size_bytes),
    mime_type: row.mime_type || mimeType,
  };
}

export async function postgresLoadContentAddressedBlob(blobId) {
  const result = await postgresQuery(
    `SELECT blob_id, connector_id, stream, record_key, mime_type, size_bytes, sha256, data
     FROM blobs
     WHERE blob_id = $1`,
    [blobId],
  );
  return result.rows[0] || null;
}

export async function postgresListBlobBindings(blobId, { limit = 1024 } = {}) {
  const result = await postgresQuery(
    `SELECT connector_id, stream, record_key
     FROM (
       SELECT connector_id, stream, record_key FROM blobs WHERE blob_id = $1
       UNION
       SELECT connector_id, stream, record_key FROM blob_bindings WHERE blob_id = $1
     ) bindings
     ORDER BY connector_id, stream, record_key
     LIMIT $2`,
    [blobId, limit],
  );
  return result.rows;
}

export async function postgresGetDatasetRecordsAggregate() {
  const result = await postgresQuery(`
    SELECT
      COUNT(*)::int AS record_count,
      COUNT(DISTINCT connector_id)::int AS connector_count,
      COUNT(DISTINCT connector_id || ':' || stream)::int AS stream_count,
      COALESCE(SUM(octet_length(record_json::text)), 0)::bigint AS record_json_bytes,
      MIN(emitted_at) AS earliest_ingested_at,
      MAX(emitted_at) AS latest_ingested_at
    FROM records
    WHERE deleted = FALSE
  `);
  const row = result.rows[0] || {};
  return {
    record_count: Number(row.record_count || 0),
    connector_count: Number(row.connector_count || 0),
    stream_count: Number(row.stream_count || 0),
    record_json_bytes: Number(row.record_json_bytes || 0),
    earliest_ingested_at: row.earliest_ingested_at || null,
    latest_ingested_at: row.latest_ingested_at || null,
  };
}

export async function postgresGetDatasetRecordChangesBytes() {
  const result = await postgresQuery(`
    SELECT COALESCE(SUM(octet_length(record_json::text)), 0)::bigint AS record_changes_json_bytes
    FROM record_changes
  `);
  return Number(result.rows[0]?.record_changes_json_bytes || 0);
}

export async function postgresGetDatasetBlobBytes() {
  const result = await postgresQuery('SELECT COALESCE(SUM(size_bytes), 0)::bigint AS blob_bytes FROM blobs');
  return Number(result.rows[0]?.blob_bytes || 0);
}

export async function postgresGetDatasetRecordTimeBounds() {
  return { earliest: null, latest: null };
}

export async function postgresListDatasetTopConnectorCandidates() {
  const result = await postgresQuery(`
    SELECT connector_id, COUNT(*)::int AS record_count
    FROM records
    WHERE deleted = FALSE
    GROUP BY connector_id
    ORDER BY record_count DESC, connector_id ASC
  `);
  return result.rows.map((row) => ({
    connector_id: row.connector_id,
    record_count: Number(row.record_count || 0),
  }));
}
