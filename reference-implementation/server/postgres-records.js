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
  assertSafeJsonField,
  buildEffectiveFilter,
  normalizeExpandRequest,
} from './record-expand-helpers.js';
import {
  createPostgresConnectorInstanceStore,
  makeDefaultAccountConnectorInstanceId,
} from './stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from './owner-auth.ts';
import {
  buildLimitClampedWarning,
  clampRecordsPageLimit,
  enforceConnectionNarrowing,
  projectStorageDisplayName,
  resolveRequestConnectionId,
} from './connection-id-request.js';
import { canonicalConnectorKey } from './connector-key.js';
import {
  compileRequestFilters,
  passesRequestFilters,
  passesTimeRange,
} from './record-filters.js';

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


// Canonical public-read graded-count vocabulary. Mirrors
// `SUPPORTED_COUNT_KINDS` in records.js. Kept in sync by duplication so
// postgres-records.js does not import from records.js (records.js
// dispatches into postgres-records.js — the dep must run one way only).
//
// Spec: openspec/changes/canonicalize-public-read-contract/specs/
//       reference-implementation-architecture/spec.md
//       (#"Counts are opt-in and cost-graded").
const SUPPORTED_COUNT_KINDS_PG = new Set(['none', 'estimated', 'exact']);

function invalidQueryError(message, code = 'invalid_request') {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * Validate the requested count grade against the canonical
 * `none|estimated|exact` vocabulary. Empty / absent passes through;
 * the server applies `none` as the default. Mirrors the SQLite path.
 */
function validateCountKind(value) {
  if (value == null || value === '') return;
  if (typeof value !== 'string' || !SUPPORTED_COUNT_KINDS_PG.has(value)) {
    throw invalidQueryError(`count must be one of: ${[...SUPPORTED_COUNT_KINDS_PG].join(', ')}`);
  }
}

// Canonical `window` opt-in vocabulary, mirrored from records.js's
// `SUPPORTED_WINDOW_KINDS` (see the one-way-dependency note above). The
// Postgres list path validates the `window` value with the same strict
// discipline as the SQLite path, but does NOT yet compute `meta.window`:
// an honest bounded window over the logical `consent_time_field` requires a
// JSON-extract min/max scan whose timestamp-parse semantics match the SQLite
// reference's `new Date(...)` parse. Until that parity scan lands, the
// Postgres path omits `meta.window` rather than substituting ingest time —
// consumers treat the absence as "not available" per the spec.
//
// Spec: openspec/changes/complete-explorer-slvp-ideal/specs/
//       reference-implementation-architecture/spec.md
//       (#"The record-list read MAY expose bounded window aggregate metadata").
const SUPPORTED_WINDOW_KINDS_PG = new Set(['none', 'exact']);

/**
 * Validate the requested window grade against the canonical `none|exact`
 * vocabulary. Empty / absent / `none` passes through (the server omits
 * `meta.window`); any other value is a typed invalid-query error. Mirrors the
 * SQLite path's `validateWindowKind`.
 */
function validateWindowKind(value) {
  if (value == null || value === '') return;
  if (typeof value !== 'string' || !SUPPORTED_WINDOW_KINDS_PG.has(value)) {
    throw invalidQueryError(`window must be one of: ${[...SUPPORTED_WINDOW_KINDS_PG].join(', ')}`);
  }
}

function rejectListOnlyParamsForChangesFeed(requestParams) {
  const unsupported = [];
  for (const key of ['sort', 'count', 'order', 'window']) {
    if (requestParams[key] != null && requestParams[key] !== '') unsupported.push(key);
  }
  if (!unsupported.length) return;
  throw invalidQueryError(
    `${unsupported.join(', ')} ${unsupported.length === 1 ? 'is' : 'are'} not supported with changes_since`,
    'invalid_request',
  );
}

/**
 * Validate the canonical `sort` parameter against the manifest stream's
 * declared cursor field, and return the resolved direction the runtime
 * will apply. Mirrors `validateCanonicalSort` in records.js for the
 * Postgres-backed path — sign-prefix controls direction, the only
 * advertised sortable field is the stream's cursor field, and anything
 * else is rejected with a typed `invalid_sort` error.
 *
 * Returns `null` when no `sort` is supplied, or
 *   `{ field, direction: 'ASC' | 'DESC' }`.
 */
function validateCanonicalSort(value, manifestStream) {
  if (value == null || value === '') return null;
  const raw = Array.isArray(value) ? value.join(',') : String(value);
  const entries = raw.split(',').map((part) => part.trim()).filter(Boolean);
  if (entries.length === 0) return null;
  const cursorField = manifestStream?.cursor_field || null;
  const sortableFields = cursorField ? new Set([cursorField]) : new Set();
  let resolved = null;
  for (const entry of entries) {
    const direction = entry.startsWith('-') ? 'DESC' : 'ASC';
    const field = direction === 'DESC' ? entry.slice(1) : entry;
    if (!field) {
      const err = invalidQueryError('Empty sort field', 'invalid_sort');
      err.param = 'sort';
      throw err;
    }
    if (sortableFields.size === 0 || !sortableFields.has(field)) {
      const err = invalidQueryError(
        `Sort field '${field}' is not advertised as sortable; check /v1/schema for the canonical sort vocabulary.`,
        'invalid_sort',
      );
      err.param = 'sort';
      throw err;
    }
    if (resolved && resolved.direction !== direction) {
      const err = invalidQueryError(
        `Conflicting sort directions for field '${field}'`,
        'invalid_sort',
      );
      err.param = 'sort';
      throw err;
    }
    resolved = { field, direction };
  }
  return resolved;
}

function parsePageOrder(rawOrder) {
  if (rawOrder == null || rawOrder === '') return 'DESC';
  if (rawOrder === 'asc') return 'ASC';
  if (rawOrder === 'desc') return 'DESC';
  throw invalidQueryError('order must be asc or desc');
}

/**
 * Resolve the effective list order from the canonical `sort` parameter
 * and the legacy `order` parameter. Mirrors `resolveListOrder` in
 * records.js: canonical `sort` wins; legacy `order` is honored only when
 * `sort` is absent; if both are sent and disagree, reject with
 * `invalid_sort` rather than silently picking one.
 */
function resolveListOrder(rawOrder, resolvedSort) {
  if (resolvedSort) {
    if (rawOrder != null && rawOrder !== '') {
      const legacyOrder = parsePageOrder(rawOrder);
      if (legacyOrder !== resolvedSort.direction) {
        const err = invalidQueryError(
          `sort and order disagree: sort resolves to ${resolvedSort.direction}, order=${rawOrder}. Send only canonical \`sort\`.`,
          'invalid_sort',
        );
        err.param = 'sort';
        throw err;
      }
    }
    return resolvedSort.direction;
  }
  return parsePageOrder(rawOrder);
}

function mergeMetaCount(existingMeta, count) {
  const base = existingMeta && typeof existingMeta === 'object' && !Array.isArray(existingMeta)
    ? { ...existingMeta }
    : {};
  base.count = count;
  return base;
}
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
  const normalize = (value) => {
    const trimmed = typeof value === 'string' ? value.trim() : null;
    if (!trimmed) return null;
    return canonicalConnectorKey(trimmed) ?? trimmed;
  };
  if (typeof storageTarget === 'string') return normalize(storageTarget);
  if (storageTarget?.connector_id) return normalize(storageTarget.connector_id);
  if (storageTarget?.connectorId) return normalize(storageTarget.connectorId);
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

function appendGrantVisibilityClauses(whereParts, params, effective, manifestStream) {
  const consentTimeField = manifestStream?.consent_time_field || null;
  if (effective.timeRange && consentTimeField) {
    assertSafeJsonField(consentTimeField, 'consent_time_field');
    const ctExpr = jsonStringExpr(consentTimeField);
    whereParts.push(`${ctExpr} IS NOT NULL`);
    if (effective.timeRange.since != null) {
      params.push(new Date(effective.timeRange.since).toISOString());
      whereParts.push(`${ctExpr} >= $${params.length}`);
    }
    if (effective.timeRange.until != null) {
      params.push(new Date(effective.timeRange.until).toISOString());
      whereParts.push(`${ctExpr} < $${params.length}`);
    }
  }

  if (effective.resources && effective.resources.length > 0) {
    params.push(effective.resources);
    whereParts.push(`record_key = ANY($${params.length}::text[])`);
  }
}

function isVisiblePostgresSnapshot(snapshot, effective, consentTimeField) {
  if (!snapshot || snapshot.deleted || !snapshot.data) return false;
  if (effective.resources && !effective.resources.includes(snapshot.record_key)) return false;
  if (effective.timeRange && consentTimeField && !passesTimeRange(snapshot.data, effective.timeRange, consentTimeField)) return false;
  return true;
}

async function getPostgresSnapshotAtVersion(connectorInstanceId, stream, recordKey, version) {
  if (!Number.isInteger(version) || version < 0) return null;
  const result = await postgresQuery(
    `SELECT version, record_json, emitted_at, deleted, deleted_at
       FROM record_changes
      WHERE connector_instance_id = $1
        AND stream = $2
        AND record_key = $3
        AND version <= $4
      ORDER BY version DESC
      LIMIT 1`,
    [connectorInstanceId, stream, recordKey, version],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    record_key: recordKey,
    version: Number(row.version),
    data: row.record_json && typeof row.record_json === 'string'
      ? JSON.parse(row.record_json)
      : row.record_json,
    emitted_at: row.emitted_at,
    deleted: row.deleted === true,
    deleted_at: row.deleted_at,
  };
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

function rejectExpandWithChangesSince(requestParams) {
  if (requestParams?.changes_since == null) return;
  if (requestParams?.expand == null && requestParams?.expand_limit == null) return;
  const err = new Error('expand is not supported with changes_since');
  err.code = 'invalid_expand';
  throw err;
}

function jsonStringExpr(field) {
  // record_json is JSONB on Postgres; `->>` returns the field as text.
  // Field comes from the manifest and is re-validated against SAFE_JSON_FIELD
  // before reaching this builder, so quoting it as a SQL literal is safe.
  assertSafeJsonField(field, 'json_string');
  return `(record_json->>'${field}')`;
}

function childResponseRecord({ stream, row, fields }) {
  const rawData = typeof row.record_json === 'string'
    ? JSON.parse(row.record_json)
    : row.record_json;
  return {
    object: 'record',
    id: row.record_key,
    stream,
    data: projectFields(rawData, fields),
    emitted_at: row.emitted_at,
  };
}

/**
 * Postgres equivalent of `records.js#hydrateExpandedRelations`.
 *
 * For each requested expansion, runs one window-function batched query
 * to fetch child rows for the entire parent page in a single round
 * trip. Children are partitioned by foreign key and ranked by the child
 * stream's manifest-declared (cursor_field, primary_key) basis so the
 * per-parent slice and per-parent `has_more` signal match the SQLite
 * engine. Grant projection (`fields`, `time_range`, `resources`) is
 * enforced in SQL exactly as the SQLite path enforces it.
 *
 * Throws `invalid_expand` if the child manifest is missing or declares
 * a child stream whose foreign-key/primary-key fields fail the
 * SAFE_JSON_FIELD regex.
 *
 * Spec: openspec/changes/add-postgres-expand-hydration/specs/
 *       reference-implementation-architecture/spec.md
 */
async function hydratePostgresExpandedRelations({
  connectorInstanceId,
  expansions,
  parentRows,
  manifest,
}) {
  if (!expansions.length || !parentRows.length) return;

  for (const expansion of expansions) {
    const childStream = expansion.relationship.stream;
    const childManifestStream = manifest?.streams?.find((entry) => entry.name === childStream);
    if (!childManifestStream) {
      const err = new Error(`Expand relation '${expansion.name}' targets unknown stream '${childStream}'`);
      err.code = 'invalid_expand';
      throw err;
    }

    const foreignKeyField = expansion.relationship.foreign_key;
    assertSafeJsonField(foreignKeyField, 'foreign_key');

    const primaryKeyFields = Array.isArray(childManifestStream.primary_key)
      ? childManifestStream.primary_key
      : typeof childManifestStream.primary_key === 'string'
        ? [childManifestStream.primary_key]
        : ['id'];
    if (primaryKeyFields.length === 0) {
      const err = new Error(`Expand relation '${expansion.name}' child '${childStream}' is missing a primary_key`);
      err.code = 'invalid_expand';
      throw err;
    }
    if (primaryKeyFields.length > 1) {
      // Mirrors the SQLite path: every first-party stream uses ["id"].
      const err = new Error(`Expand relation '${expansion.name}' child '${childStream}' uses a multi-part primary_key (not implemented)`);
      err.code = 'invalid_expand';
      throw err;
    }
    assertSafeJsonField(primaryKeyFields[0], 'primary_key');

    const childRequiredFields = Array.isArray(childManifestStream?.schema?.required)
      ? childManifestStream.schema.required
      : [];
    const childEffective = buildEffectiveFilter(expansion.childGrant, {}, childRequiredFields);
    const childFields = childEffective.fields;
    const cursorField = childManifestStream.cursor_field || null;
    const consentTimeField = childManifestStream.consent_time_field || null;

    const fkExpr = jsonStringExpr(foreignKeyField);
    const pkExpr = jsonStringExpr(primaryKeyFields[0]);

    // Build ORDER BY: cursor first (nulls last), then primary key.
    const orderByParts = [];
    if (cursorField) {
      const cursorExpr = jsonStringExpr(cursorField);
      orderByParts.push(`${cursorExpr} ASC NULLS LAST`);
    }
    orderByParts.push(`${pkExpr} ASC`);
    const orderBySql = orderByParts.join(', ');

    const params = [connectorInstanceId, childStream];
    const whereParts = [
      'connector_instance_id = $1',
      'stream = $2',
      'deleted = FALSE',
    ];

    if (childEffective.timeRange && consentTimeField) {
      assertSafeJsonField(consentTimeField, 'consent_time_field');
      const ctExpr = jsonStringExpr(consentTimeField);
      whereParts.push(`${ctExpr} IS NOT NULL`);
      if (childEffective.timeRange.since != null) {
        params.push(new Date(childEffective.timeRange.since).toISOString());
        whereParts.push(`${ctExpr} >= $${params.length}`);
      }
      if (childEffective.timeRange.until != null) {
        params.push(new Date(childEffective.timeRange.until).toISOString());
        whereParts.push(`${ctExpr} < $${params.length}`);
      }
    }

    if (childEffective.resources && childEffective.resources.length > 0) {
      params.push(childEffective.resources);
      whereParts.push(`record_key = ANY($${params.length}::text[])`);
    }

    // Parent foreign-key narrowing — one batched IN-list per relation.
    const parentKeys = parentRows.map((row) => row.record_key);
    params.push(parentKeys);
    whereParts.push(`${fkExpr} = ANY($${params.length}::text[])`);

    // Per-partition cap.
    //   has_one  → rn = 1   (take one per parent).
    //   has_many → rn <= limit + 1   (+1 gives the caller a `has_more` signal).
    const rankBound = expansion.relationship.cardinality === 'has_one'
      ? 1
      : expansion.limit + 1;
    params.push(rankBound);

    const sql = `
      WITH ranked AS (
        SELECT
          record_key,
          record_json,
          emitted_at,
          ${fkExpr} AS __fk,
          ROW_NUMBER() OVER (
            PARTITION BY ${fkExpr}
            ORDER BY ${orderBySql}
          ) AS __rn
        FROM records
        WHERE ${whereParts.join(' AND ')}
      )
      SELECT record_key, record_json, emitted_at, __fk
      FROM ranked
      WHERE __rn <= $${params.length}
    `;

    const result = await postgresQuery(sql, params);

    const buckets = new Map();
    for (const row of result.rows) {
      const fk = row.__fk == null ? '' : String(row.__fk);
      if (!buckets.has(fk)) buckets.set(fk, []);
      buckets.get(fk).push(row);
    }

    for (const parentRow of parentRows) {
      if (!parentRow.responseRecord.expanded) parentRow.responseRecord.expanded = {};
      const fk = parentRow.record_key;
      const matches = buckets.get(fk) || [];

      if (expansion.relationship.cardinality === 'has_one') {
        const first = matches[0];
        parentRow.responseRecord.expanded[expansion.name] = first
          ? childResponseRecord({ stream: childStream, row: first, fields: childFields })
          : null;
        continue;
      }

      const sliced = matches.slice(0, expansion.limit);
      parentRow.responseRecord.expanded[expansion.name] = {
        object: 'list',
        has_more: matches.length > expansion.limit,
        data: sliced.map((row) => childResponseRecord({ stream: childStream, row, fields: childFields })),
      };
    }
  }
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
    // No-op equivalence is computed at the `jsonb` level via a server-side
    // `record_json = $::jsonb` comparison. The naive `JSON.stringify` of
    // the JS object node-postgres parses out of jsonb does not round-trip
    // to the bytes the connector emitted: Postgres' `::text` output adds
    // whitespace and the parsed object's key order matches Postgres'
    // internal storage. Either gap silently turns identical re-ingests
    // into version churn, observed in production as Slack `workspace`
    // accumulating 31k+ versions of the same payload. `jsonb` equality is
    // structural and ignores both incidental layout differences.
    const currentResult = await client.query(
      `SELECT record_json,
              deleted,
              COALESCE(octet_length(record_json::text), 0)::bigint AS record_json_bytes,
              ($4::jsonb IS NOT DISTINCT FROM record_json) AS is_identical
       FROM records
       WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
       FOR UPDATE`,
      [connectorInstanceId, stream, recordKey, recordJson],
    );
    const current = currentResult.rows[0] || null;

    if (op === 'delete' && (!current || current.deleted)) {
      return { kind: 'noop' };
    }
    if (op !== 'delete' && current && !current.deleted && current.is_identical) {
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
  const effective = buildEffectiveFilter(streamGrant, {}, requiredFieldsFor(manifestStream));
  effective.fields = fields;
  const compiledFilters = compileRequestFilters(requestParams.filter, streamGrant, manifestStream);
  const { cursorSql, primarySql } = recordOrderExpressions(manifestStream);

  // Canonical contract enforcement: `count` and `sort` go through the same
  // validation discipline as the SQLite reference path, regardless of
  // which branch (changes_since vs. paginated list) we end up taking.
  // `sort` (sign-prefix over the advertised cursor field) controls
  // direction; legacy `order=` is honored only when `sort` is absent. If
  // both disagree we reject with `invalid_sort` rather than silently
  // picking one — the public-read contract forbids silent no-ops.
  //
  // Spec: openspec/changes/canonicalize-public-read-contract/specs/
  //       reference-implementation-architecture/spec.md
  //       (#"Sort", #"Counts").
  validateCountKind(requestParams.count);
  // Validate the `window` opt-in with the same strict discipline as `count`.
  // The Postgres path does not yet emit `meta.window` (see
  // SUPPORTED_WINDOW_KINDS_PG); a valid `window=exact` is accepted and the
  // window is omitted, never estimated.
  validateWindowKind(requestParams.window);
  const resolvedSort = validateCanonicalSort(requestParams.sort, manifestStream);
  const orderDirection = resolveListOrder(requestParams.order, resolvedSort);
  const order = orderDirection === 'ASC' ? 'asc' : 'desc';
  const { limit, clamped: limitClamped, requested: requestedLimit } =
    clampRecordsPageLimit(requestParams.limit);
  const { warnings: requestWarnings } = resolveRequestConnectionId(requestParams);
  if (limitClamped) {
    requestWarnings.push(buildLimitClampedWarning(requestedLimit));
  }
  enforceConnectionNarrowing(requestParams, connectorInstanceId);
  const identity = await resolveRecordIdentityForBinding(connectorInstanceId, connectorId);

  rejectExpandWithChangesSince(requestParams);
  // Resolve and validate expansions up front so misuse rejects before any
  // SQL runs. SQLite path does the same in records.js#normalizeExpandRequest.
  const expansions = normalizeExpandRequest(
    requestParams,
    stream,
    grant,
    manifestStream,
    order === 'asc' ? 'ASC' : 'DESC',
  );

  if (requestParams.changes_since != null) {
    rejectListOnlyParamsForChangesFeed(requestParams);
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
    const minChangeResult = await postgresQuery(
      `SELECT MIN(version)::bigint AS min_version
         FROM record_changes
        WHERE connector_instance_id = $1 AND stream = $2`,
      [connectorInstanceId, stream],
    );
    const minVersion = minChangeResult.rows[0]?.min_version == null
      ? null
      : Number(minChangeResult.rows[0].min_version);
    if (minVersion !== null && decoded.v < (minVersion - 1)) {
      const err = new Error('changes_since cursor is too old; full re-sync required');
      err.code = 'cursor_expired';
      throw err;
    }
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
    const consentTimeField = manifestStream?.consent_time_field || null;
    const visibleChanges = [];
    for (const row of sorted) {
      const previous = await getPostgresSnapshotAtVersion(connectorInstanceId, stream, row.record_key, decoded.v);
      const current = await getPostgresSnapshotAtVersion(connectorInstanceId, stream, row.record_key, Number(row.version));

      const previousVisible = isVisiblePostgresSnapshot(previous, effective, consentTimeField);
      const currentVisible = isVisiblePostgresSnapshot(current, effective, consentTimeField);

      if (row.deleted) {
        if (!previousVisible || !passesRequestFilters(previous.data, compiledFilters)) continue;
        visibleChanges.push(deletedResponseRecord({ stream, row, identity }));
        continue;
      }

      if (!currentVisible || !passesRequestFilters(current.data, compiledFilters)) continue;
      const previousProjection = previousVisible ? projectFields(previous.data, effective.fields) : null;
      const currentProjection = projectFields(current.data, effective.fields);
      if (previousProjection && JSON.stringify(previousProjection) === JSON.stringify(currentProjection)) continue;

      visibleChanges.push(responseRecord({
        stream,
        row: {
          ...row,
          record_json: currentProjection,
        },
        fields: null,
        identity,
      }));
    }
    const changesResponse = {
      object: 'list',
      has_more: false,
      data: visibleChanges,
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
  const whereParts = ['connector_instance_id = $1', 'stream = $2', 'deleted = FALSE'];
  appendGrantVisibilityClauses(whereParts, params, effective, manifestStream);
  let where = `WHERE ${whereParts.join(' AND ')}`;
  where += buildFilterClause(requestParams.filter, params);
  // Snapshot the filter-only WHERE clause / params for the graded-count
  // query. The count MUST reflect matching visible rows BEFORE pagination
  // or the cursor — matching the SQLite semantics in
  // `countVisibleRecordsForStream` — so the cursor narrowing below is
  // intentionally excluded.
  const countWhere = where;
  const countParams = [...params];

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
  const responseRows = pageRows.map((row) => ({
    record_key: row.record_key,
    responseRecord: responseRecord({ stream, row, fields, identity }),
  }));
  await hydratePostgresExpandedRelations({
    connectorInstanceId,
    expansions,
    parentRows: responseRows,
    manifest,
  });
  const response = {
    object: 'list',
    has_more: hasMore,
    data: responseRows.map((entry) => entry.responseRecord),
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
  const countOutcome = await computePostgresGradedRecordCount({
    requestParams,
    countWhere,
    countParams,
  });
  if (countOutcome) {
    response.meta = mergeMetaCount(response.meta, countOutcome.count);
  }
  attachRequestWarningsToResponse(response, requestWarnings);
  return response;
}

/**
 * Compute the requested graded count for a Postgres-backed records list
 * response. Mirrors `computeGradedRecordCount` in records.js:
 *
 *   - absent or `none`: return `null` (callers omit `meta.count`).
 *   - `exact`:     `{ count: { kind: 'exact', value } }`.
 *   - `estimated`: `{ count: { kind: 'exact', value } }` (silent upgrade).
 *
 * `count_downgraded` is reserved for the strict case where the server
 * actually returns a *lower* grade than requested. Returning a
 * higher-fidelity grade than asked for is not a downgrade, so this
 * helper does not emit a warning either.
 *
 * The count uses the filter-only WHERE clause (no cursor narrowing), so
 * the value reflects matching visible rows BEFORE pagination — matching
 * the SQLite semantics of `countVisibleRecordsForStream`.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract design.md
 *       (#"Counts") and specs/reference-implementation-architecture/
 *       spec.md (#"Requested count is downgraded").
 */
async function computePostgresGradedRecordCount({ requestParams, countWhere, countParams }) {
  const requested = typeof requestParams.count === 'string' ? requestParams.count : null;
  if (!requested || requested === 'none') return null;

  const result = await postgresQuery(
    `SELECT COUNT(*)::bigint AS value FROM records ${countWhere}`,
    countParams,
  );
  const value = Number(result.rows[0]?.value || 0);

  if (requested === 'exact' || requested === 'estimated') {
    return { count: { kind: 'exact', value } };
  }
  return null;
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

export async function postgresGetRecord(storageTarget, stream, recordId, grant, manifest = null, requestParams = {}) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const streamGrant = getStreamGrant(grant, stream);
  const manifestStream = getManifestStream(manifest, stream);
  const fields = fieldsFor(streamGrant, null, requiredFieldsFor(manifestStream));
  const effective = buildEffectiveFilter(streamGrant, {}, requiredFieldsFor(manifestStream));
  effective.fields = fields;
  const { warnings: requestWarnings } = resolveRequestConnectionId(requestParams);
  enforceConnectionNarrowing(requestParams, connectorInstanceId);
  // Single-record fetch does not support changes_since, so only validate
  // expansion request shape here.
  const expansions = normalizeExpandRequest(requestParams, stream, grant, manifestStream, 'ASC');
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
  if (effective.resources && !effective.resources.includes(row.record_key)) {
    const err = new Error('Record not found');
    err.code = 'not_found';
    throw err;
  }
  if (effective.timeRange && manifestStream?.consent_time_field) {
    const rawData = typeof row.record_json === 'string'
      ? JSON.parse(row.record_json)
      : row.record_json;
    if (!passesTimeRange(rawData, effective.timeRange, manifestStream.consent_time_field)) {
      const err = new Error('Record not found');
      err.code = 'not_found';
      throw err;
    }
  }
  const identity = await resolveRecordIdentityForBinding(connectorInstanceId, connectorId);
  const response = responseRecord({ stream, row, fields, identity });
  if (expansions.length) {
    await hydratePostgresExpandedRelations({
      connectorInstanceId,
      expansions,
      parentRows: [{ record_key: row.record_key, responseRecord: response }],
      manifest,
    });
  }
  attachRequestWarningsToResponse(response, requestWarnings);
  return response;
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
  return withPostgresTransaction(async (client) => {
    const countResult = await client.query(
      `SELECT COUNT(*)::int AS count FROM records
       WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE`,
      [connectorInstanceId, stream],
    );
    const deletedRecordCount = Number(countResult.rows[0]?.count || 0);
    await deletePostgresRecordTailForPair(client, connectorInstanceId, stream);
    return deletedRecordCount;
  });
}

/**
 * Delete the durable record-tail rows for a single
 * `(connector_instance_id, stream)` pair: record_changes, records,
 * version_counter, and the lexical/semantic search tables scoped to that
 * stream. Mirrors the SQLite per-stream delete shape, which clears the
 * core record tables and lets the outer caller decide whether to also drop
 * blob_bindings (per-stream owner reset does not; per-connector
 * invalidation does).
 *
 * The pg pool's prepared-statement protocol rejects multi-statement
 * parameterized queries, so each DELETE is its own statement. The caller
 * shares one transactional client so the set is atomic.
 *
 * Stays inside the Postgres records boundary so raw SQL does not scatter
 * through higher layers (see design.md alternatives considered).
 */
async function deletePostgresRecordTailForPair(client, connectorInstanceId, stream) {
  const semanticScopePrefix = `[${JSON.stringify(stream)},`;
  await client.query(
    'DELETE FROM record_changes WHERE connector_instance_id = $1 AND stream = $2',
    [connectorInstanceId, stream],
  );
  await client.query(
    'DELETE FROM records WHERE connector_instance_id = $1 AND stream = $2',
    [connectorInstanceId, stream],
  );
  await client.query(
    'DELETE FROM version_counter WHERE connector_instance_id = $1 AND stream = $2',
    [connectorInstanceId, stream],
  );
  await client.query(
    'DELETE FROM lexical_search_index WHERE connector_instance_id = $1 AND stream = $2',
    [connectorInstanceId, stream],
  );
  await client.query(
    'DELETE FROM lexical_search_meta WHERE connector_instance_id = $1 AND stream = $2',
    [connectorInstanceId, stream],
  );
  await client.query(
    'DELETE FROM semantic_search_blob WHERE connector_instance_id = $1 AND scope_key LIKE $2',
    [connectorInstanceId, `${semanticScopePrefix}%`],
  );
  await client.query(
    'DELETE FROM semantic_search_meta WHERE connector_instance_id = $1 AND stream = $2',
    [connectorInstanceId, stream],
  );
  await client.query(
    'DELETE FROM semantic_search_backfill_progress WHERE connector_instance_id = $1 AND stream = $2',
    [connectorInstanceId, stream],
  );
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
