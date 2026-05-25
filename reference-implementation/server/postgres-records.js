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
import {
  createPostgresConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from './stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from './owner-auth.ts';
import {
  projectStorageDisplayName,
  resolveRequestConnectionId,
} from './connection-id-request.js';

/**
 * Resolve `(connection_id, display_name)` identity for a postgres-backed
 * record read. Returns `null` when the binding is absent and a
 * `display_name`-less identity when the store row has only a placeholder
 * label. Mirrors `resolveRecordIdentityForBinding` in records.js so the
 * Postgres branch decorates records the same shape SQLite emits.
 */
async function resolveRecordIdentityForBinding(connectorInstanceId, connectorId) {
  if (!connectorInstanceId) return null;
  const identity = { connectionId: connectorInstanceId };
  try {
    const store = createPostgresConnectorInstanceStore();
    const instance = await store.get(connectorInstanceId);
    if (instance) {
      const displayName = projectStorageDisplayName(instance.displayName, {
        connectorId: connectorId || instance.connectorId,
        connectorInstanceId,
      });
      if (displayName) identity.displayName = displayName;
    }
  } catch {
    // Identity lookup failures degrade to connection_id-only decoration.
  }
  return identity;
}

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

function resolveStorageConnectorInstanceId(storageTarget, connectorId) {
  if (storageTarget?.connector_instance_id) return storageTarget.connector_instance_id;
  if (storageTarget?.connectorInstanceId) return storageTarget.connectorInstanceId;
  return makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId);
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

function responseRecord({ stream, row, fields, identity = null }) {
  const record = {
    object: 'record',
    id: row.record_key,
    stream,
    data: projectFields(row.record_json, fields),
    emitted_at: row.emitted_at,
  };
  decorateRecordWithConnectionIdentity(record, identity);
  return record;
}

function deletedResponseRecord({ stream, row, identity = null }) {
  const record = {
    object: 'record',
    id: row.record_key,
    stream,
    deleted: true,
    deleted_at: row.deleted_at || row.emitted_at,
    emitted_at: row.emitted_at,
  };
  decorateRecordWithConnectionIdentity(record, identity);
  return record;
}

/**
 * Attach canonical `connection_id` and the deprecated `connector_instance_id`
 * alias to a response record when the runtime knows the binding without
 * guessing. Mirrors `decorateRecordWithConnectionIdentity` in records.js so
 * Postgres-backed responses match SQLite-backed responses.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 */
function decorateRecordWithConnectionIdentity(record, identity) {
  if (!record || !identity) return;
  const connectionId = typeof identity.connectionId === 'string' ? identity.connectionId.trim() : '';
  if (connectionId) {
    record.connection_id = connectionId;
    record.connector_instance_id = connectionId;
  }
  const displayName = typeof identity.displayName === 'string' ? identity.displayName.trim() : '';
  if (displayName) {
    record.display_name = displayName;
  }
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

async function allocateNextVersion(client, connectorId, connectorInstanceId, stream) {
  const result = await client.query(
    `INSERT INTO version_counter (connector_id, connector_instance_id, stream, max_version)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (connector_instance_id, stream) DO UPDATE
       SET max_version = version_counter.max_version + 1
     RETURNING max_version`,
    [connectorId, connectorInstanceId, stream],
  );
  return Number(result.rows[0].max_version);
}

export async function postgresIngestRecord(storageTarget, record) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
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
      `SELECT record_json, deleted,
              COALESCE(octet_length(record_json::text), 0)::bigint AS record_json_bytes
       FROM records
       WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
       FOR UPDATE`,
      [connectorInstanceId, stream, recordKey],
    );
    const current = currentResult.rows[0] || null;

    if (op === 'delete' && (!current || current.deleted)) {
      return { kind: 'noop' };
    }
    if (op !== 'delete' && current && !current.deleted && JSON.stringify(current.record_json) === recordJson) {
      return { kind: 'noop' };
    }

    const nextVersion = await allocateNextVersion(client, connectorId, connectorInstanceId, stream);
    const currentRecordJsonBytes = current && !current.deleted
      ? Number(current.record_json_bytes || 0)
      : 0;
    let nextRecordJsonBytes = 0;

    if (op === 'delete') {
      await client.query(
        `UPDATE records
         SET connector_id = $6, deleted = TRUE, deleted_at = $4, emitted_at = $4, version = $5
         WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3`,
        [connectorInstanceId, stream, recordKey, effectiveEmittedAt, nextVersion, connectorId],
      );
      await client.query(
        `INSERT INTO record_changes
           (connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, TRUE, $7)`,
        [connectorId, connectorInstanceId, stream, recordKey, nextVersion, JSON.stringify(current.record_json), effectiveEmittedAt],
      );
    } else {
      const stored = await client.query(
        `INSERT INTO records
           (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, deleted_at, cursor_value, primary_key_text)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, NULL, $8, $9)
         ON CONFLICT (connector_instance_id, stream, record_key) DO UPDATE
           SET connector_id = EXCLUDED.connector_id,
               record_json = EXCLUDED.record_json,
               emitted_at = EXCLUDED.emitted_at,
               version = EXCLUDED.version,
               deleted = FALSE,
               deleted_at = NULL,
               cursor_value = EXCLUDED.cursor_value,
               primary_key_text = EXCLUDED.primary_key_text
         RETURNING COALESCE(octet_length(record_json::text), 0)::bigint AS record_json_bytes`,
        [connectorId, connectorInstanceId, stream, recordKey, recordJson, effectiveEmittedAt, nextVersion, null, recordKey],
      );
      nextRecordJsonBytes = Number(stored.rows[0]?.record_json_bytes || 0);
      await client.query(
        `INSERT INTO record_changes
           (connector_id, connector_instance_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, FALSE, NULL)`,
        [connectorId, connectorInstanceId, stream, recordKey, nextVersion, recordJson, effectiveEmittedAt],
      );
    }

    const insertedChangeJsonBytes = op === 'delete' ? currentRecordJsonBytes : nextRecordJsonBytes;
    let prunedBytesForDelta = 0;
    let prunedRowsForDelta = 0;
    if (changeHistoryLimit > 0) {
      const pruned = await client.query(
        `SELECT COUNT(*)::bigint AS count,
                COALESCE(SUM(octet_length(COALESCE(record_json::text, ''))), 0)::bigint AS bytes
           FROM record_changes
          WHERE connector_instance_id = $1 AND stream = $2 AND version <= $3`,
        [connectorInstanceId, stream, nextVersion - changeHistoryLimit],
      );
      prunedRowsForDelta = Number(pruned.rows[0]?.count || 0);
      prunedBytesForDelta = Number(pruned.rows[0]?.bytes || 0);
      await client.query(
        `DELETE FROM record_changes
         WHERE connector_instance_id = $1 AND stream = $2 AND version <= $3`,
        [connectorInstanceId, stream, nextVersion - changeHistoryLimit],
      );
    }

    return {
      kind: 'changed',
      op,
      retainedSizeDelta: {
        connectorInstanceId,
        connectorId,
        stream,
        currentRecordJsonBytesDelta: op === 'delete'
          ? -currentRecordJsonBytes
          : nextRecordJsonBytes - currentRecordJsonBytes,
        recordHistoryJsonBytesDelta: insertedChangeJsonBytes - prunedBytesForDelta,
        recordCountDelta: op === 'delete' ? -1 : current?.deleted ? 1 : current ? 0 : 1,
        recordHistoryCountDelta: 1 - prunedRowsForDelta,
      },
    };
  });

  return outcome.kind === 'noop'
    ? { accepted: true, changed: false }
    : { accepted: true, changed: true, retainedSizeDelta: outcome.retainedSizeDelta };
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
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const streamGrant = getStreamGrant(grant, stream);
  const manifestStream = getManifestStream(manifest, stream);
  const fields = fieldsFor(streamGrant, requestParams.fields, requiredFieldsFor(manifestStream));
  const { cursorSql, primarySql } = recordOrderExpressions(manifestStream);
  const order = requestParams.order === 'desc' ? 'desc' : 'asc';
  const limit = parseLimit(requestParams.limit);
  const { warnings: requestWarnings } = resolveRequestConnectionId(requestParams);
  const identity = await resolveRecordIdentityForBinding(connectorInstanceId, connectorId);

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
      `SELECT max_version FROM version_counter WHERE connector_instance_id = $1 AND stream = $2`,
      [connectorInstanceId, stream],
    );
    const sessionMax = maxResult.rows[0] ? Number(maxResult.rows[0].max_version) : 0;
    const rows = await postgresQuery(
      `SELECT DISTINCT ON (record_key)
              record_key, record_json, deleted, deleted_at, emitted_at, version
       FROM record_changes
       WHERE connector_instance_id = $1 AND stream = $2
         AND version > $3 AND version <= $4
       ORDER BY record_key, version DESC`,
      [connectorInstanceId, stream, decoded.v, sessionMax],
    );
    const sorted = [...rows.rows].sort((a, b) => Number(a.version) - Number(b.version));
    const changesResponse = {
      object: 'list',
      has_more: false,
      data: sorted.map((row) => row.deleted
        ? deletedResponseRecord({ stream, row, identity })
        : responseRecord({ stream, row, fields, identity })),
      next_changes_since: encodeCursor({ v: sessionMax }),
    };
    attachRequestWarningsToResponse(changesResponse, requestWarnings);
    return changesResponse;
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

  const params = [connectorInstanceId, stream];
  let where = 'WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE';
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
    data: pageRows.map((row) => responseRecord({ stream, row, fields, identity })),
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
  attachRequestWarningsToResponse(response, requestWarnings);
  return response;
}

/**
 * Attach a `meta.warnings[]` envelope to a public-read response only when
 * the runtime has non-empty structured warnings to surface. Mirrors
 * `attachRequestWarningsToResponse` in records.js.
 */
function attachRequestWarningsToResponse(response, warnings) {
  if (!response || typeof response !== 'object') return;
  if (!Array.isArray(warnings) || warnings.length === 0) return;
  const existingMeta = response.meta && typeof response.meta === 'object' && !Array.isArray(response.meta)
    ? response.meta
    : null;
  const existingWarnings = existingMeta && Array.isArray(existingMeta.warnings)
    ? existingMeta.warnings
    : [];
  response.meta = {
    ...(existingMeta || {}),
    warnings: [...existingWarnings, ...warnings],
  };
}

export async function postgresGetRecord(storageTarget, stream, recordId, grant, manifest = null) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const streamGrant = getStreamGrant(grant, stream);
  const manifestStream = getManifestStream(manifest, stream);
  const fields = fieldsFor(streamGrant, null, requiredFieldsFor(manifestStream));
  const result = await postgresQuery(
    `SELECT record_key, record_json, emitted_at
     FROM records
     WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3 AND deleted = FALSE`,
    [connectorInstanceId, stream, recordId],
  );
  const row = result.rows[0];
  if (!row) {
    const err = new Error('Record not found');
    err.code = 'not_found';
    throw err;
  }
  const identity = await resolveRecordIdentityForBinding(connectorInstanceId, connectorId);
  return responseRecord({ stream, row, fields, identity });
}

export async function postgresListAllStreams(storageTarget) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const result = await postgresQuery(
    `SELECT stream AS name, COUNT(*)::int AS record_count, MAX(emitted_at) AS last_updated
     FROM records
     WHERE connector_instance_id = $1 AND deleted = FALSE
     GROUP BY stream
     ORDER BY stream`,
    [connectorInstanceId],
  );
  return result.rows;
}

export async function postgresListStreams(storageTarget, grant, manifest = null) {
  const rows = await postgresListAllStreams(storageTarget);
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
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const semanticScopePrefix = `[${JSON.stringify(stream)},`;
  const countResult = await postgresQuery(
    `SELECT COUNT(*)::int AS count FROM records
     WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE`,
    [connectorInstanceId, stream],
  );
  const deletedRecordCount = Number(countResult.rows[0]?.count || 0);
  await postgresQuery(
    `DELETE FROM record_changes WHERE connector_instance_id = $1 AND stream = $2;
     DELETE FROM records WHERE connector_instance_id = $1 AND stream = $2;
     DELETE FROM version_counter WHERE connector_instance_id = $1 AND stream = $2;
     DELETE FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2;
     DELETE FROM lexical_search_meta WHERE connector_instance_id = $1 AND stream = $2;
     DELETE FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key LIKE $3;
     DELETE FROM semantic_search_meta WHERE connector_instance_id = $1 AND stream = $2;
     DELETE FROM semantic_search_backfill_progress WHERE connector_instance_id = $1 AND stream = $2;`,
    [connectorInstanceId, stream, `${semanticScopePrefix}%`],
  );
  return deletedRecordCount;
}

export async function postgresPersistContentAddressedBlob({ connectorId, connectorInstanceId, stream, recordKey, mimeType, data }) {
  const effectiveConnectorInstanceId = connectorInstanceId || resolveStorageConnectorInstanceId(null, connectorId);
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const blobId = `blob_sha256_${sha256}`;
  const sizeBytes = bytes.byteLength;

  const row = await withPostgresTransaction(async (client) => {
    await client.query(
      `INSERT INTO blobs
         (blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (blob_id) DO NOTHING`,
      [blobId, connectorId, effectiveConnectorInstanceId, stream, recordKey, mimeType, sizeBytes, sha256, bytes],
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
    // json_path = '@record' marks this as a record-level attachment-style
    // binding (the blob belongs to the record as a whole). The
    // migrate-storage tool uses RFC 6901 JSON Pointers for field-level
    // extractions. See docs/binary-content-invariant-design-brief.md §4.6.
    const binding = await client.query(
      `INSERT INTO blob_bindings (blob_id, connector_id, connector_instance_id, stream, record_key, json_path)
       VALUES ($1, $2, $3, $4, $5, '@record')
       ON CONFLICT DO NOTHING
       RETURNING blob_id`,
      [blobId, connectorId, effectiveConnectorInstanceId, stream, recordKey],
    );
    return { ...storedRow, binding_inserted: binding.rowCount > 0 };
  });

  return {
    blob_id: blobId,
    sha256,
    size_bytes: Number(row.size_bytes),
    mime_type: row.mime_type || mimeType,
    binding_inserted: Boolean(row.binding_inserted),
  };
}

export async function postgresLoadContentAddressedBlob(blobId) {
  const result = await postgresQuery(
    `SELECT blob_id, connector_id, connector_instance_id, stream, record_key, mime_type, size_bytes, sha256, data
     FROM blobs
     WHERE blob_id = $1`,
    [blobId],
  );
  return result.rows[0] || null;
}

export async function postgresListBlobBindings(blobId, { limit = 1024 } = {}) {
  const result = await postgresQuery(
    `SELECT connector_id, connector_instance_id, stream, record_key
     FROM (
       SELECT connector_id, connector_instance_id, stream, record_key FROM blobs WHERE blob_id = $1
       UNION
       SELECT connector_id, connector_instance_id, stream, record_key FROM blob_bindings WHERE blob_id = $1
     ) bindings
     ORDER BY connector_id, connector_instance_id, stream, record_key
     LIMIT $2`,
    [blobId, limit],
  );
  return result.rows;
}

export async function postgresGetDatasetRecordsAggregate() {
  const result = await postgresQuery(`
    SELECT
      COUNT(*)::int AS record_count,
      COUNT(DISTINCT connector_instance_id)::int AS connector_count,
      COUNT(DISTINCT connector_instance_id || ':' || stream)::int AS stream_count,
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
  const connectors = await postgresQuery(
    `SELECT connector_id, manifest
     FROM connectors
     ORDER BY connector_id`,
  );

  let earliest = null;
  let latest = null;
  for (const row of connectors.rows) {
    const manifest = row.manifest;
    if (!Array.isArray(manifest?.streams)) continue;

    for (const stream of manifest.streams) {
      const field = stream?.consent_time_field;
      const streamName = stream?.name;
      if (typeof field !== 'string' || !field || typeof streamName !== 'string') continue;
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) continue;

      const result = await postgresQuery(
        `SELECT
           MIN(record_json ->> $1) AS min_time,
           MAX(record_json ->> $1) AS max_time
         FROM records
         WHERE connector_id = $2
           AND stream = $3
           AND deleted = FALSE
           AND record_json ? $1`,
        [field, row.connector_id, streamName],
      );
      const minTime = typeof result.rows[0]?.min_time === 'string' ? result.rows[0].min_time : null;
      const maxTime = typeof result.rows[0]?.max_time === 'string' ? result.rows[0].max_time : null;
      if (minTime && (earliest === null || minTime < earliest)) earliest = minTime;
      if (maxTime && (latest === null || maxTime > latest)) latest = maxTime;
    }
  }

  return { earliest, latest };
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
