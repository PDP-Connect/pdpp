/**
 * PDPP Resource Server — record storage and grant-enforced query
 */
import { getDb } from './db.js';
import {
  lexicalIndexDelete,
  lexicalIndexDeleteByConnectorStream,
  lexicalIndexUpsert,
} from './search.js';

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

  const current = db.prepare(`
    SELECT record_json, deleted
    FROM records
    WHERE connector_id = ? AND stream = ? AND record_key = ?
  `).get(connectorId, stream, recordKey) || null;

  if (op === 'delete' && (!current || current.deleted)) {
    return { accepted: true, changed: false };
  }

  if (op !== 'delete' && current && !current.deleted && current.record_json === recordJson) {
    return { accepted: true, changed: false };
  }

  // Get next version
  const vcRow = db.prepare(
    'SELECT max_version FROM version_counter WHERE connector_id = ? AND stream = ?'
  ).get(connectorId, stream);
  const nextVersion = vcRow ? vcRow.max_version + 1 : 1;

  const effectiveEmittedAt = emitted_at || nowIso();

  if (op === 'delete') {
    db.prepare(`
      UPDATE records
      SET deleted = 1, deleted_at = ?, version = ?
      WHERE connector_id = ? AND stream = ? AND record_key = ?
    `).run(effectiveEmittedAt, nextVersion, connectorId, stream, recordKey);
    db.prepare(`
      INSERT INTO record_changes(connector_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
      VALUES(?, ?, ?, ?, ?, ?, 1, ?)
    `).run(connectorId, stream, recordKey, nextVersion, current.record_json, effectiveEmittedAt, effectiveEmittedAt);
    await lexicalIndexDelete({ connectorId, stream, recordKey });
  } else {
    db.prepare(`
      INSERT INTO records(connector_id, stream, record_key, record_json, emitted_at, version)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(connector_id, stream, record_key) DO UPDATE SET
        record_json = excluded.record_json,
        emitted_at = excluded.emitted_at,
        version = excluded.version,
        deleted = 0,
        deleted_at = NULL
    `).run(connectorId, stream, recordKey, recordJson, effectiveEmittedAt, nextVersion);
    db.prepare(`
      INSERT INTO record_changes(connector_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
      VALUES(?, ?, ?, ?, ?, ?, 0, NULL)
    `).run(connectorId, stream, recordKey, nextVersion, recordJson, effectiveEmittedAt);
    await lexicalIndexUpsert({ connectorId, stream, recordKey, data });
  }

  // Advance version counter
  db.prepare(`
    INSERT INTO version_counter(connector_id, stream, max_version)
    VALUES(?, ?, ?)
    ON CONFLICT(connector_id, stream) DO UPDATE SET max_version = excluded.max_version
  `).run(connectorId, stream, nextVersion);

  const changeHistoryLimit = getChangeHistoryLimit();
  if (changeHistoryLimit > 0) {
    db.prepare(`
      DELETE FROM record_changes
      WHERE connector_id = ?
        AND stream = ?
        AND version <= ?
    `).run(connectorId, stream, nextVersion - changeHistoryLimit);
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

const SUPPORTED_RANGE_OPERATORS = new Set(['gte', 'gt', 'lte', 'lt']);
const SUPPORTED_RECORD_QUERY_PARAMS = new Set([
  'changes_since',
  'connector_id',
  'cursor',
  'expand',
  'expand_limit',
  'fields',
  'filter',
  'limit',
  'order',
  'view',
]);

function invalidQueryError(message, code = 'invalid_request') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function normalizePrimaryKey(primaryKey) {
  if (Array.isArray(primaryKey)) return primaryKey.filter((field) => typeof field === 'string' && field.length > 0);
  if (typeof primaryKey === 'string' && primaryKey.length > 0) return [primaryKey];
  return [];
}

function getFieldSchema(manifestStream, field) {
  return manifestStream?.schema?.properties?.[field] || null;
}

function isScalarFieldSchema(fieldSchema) {
  return ['boolean', 'integer', 'number', 'string'].includes(fieldSchema?.type);
}

function isRangeQueryableSchema(fieldSchema) {
  return fieldSchema?.type === 'integer'
    || fieldSchema?.type === 'number'
    || (fieldSchema?.type === 'string' && ['date', 'date-time'].includes(fieldSchema?.format));
}

function parseIntegerValue(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null;
  return Number.parseInt(value.trim(), 10);
}

function parseNumberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDateValue(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function coerceComparableValue(value, fieldSchema, { strict = false } = {}) {
  if (value == null) return null;

  if (fieldSchema?.type === 'integer') {
    const parsed = parseIntegerValue(value);
    if (parsed == null && strict) throw invalidQueryError(`Invalid integer value for '${String(value)}'`);
    return parsed;
  }

  if (fieldSchema?.type === 'number') {
    const parsed = parseNumberValue(value);
    if (parsed == null && strict) throw invalidQueryError(`Invalid number value for '${String(value)}'`);
    return parsed;
  }

  if (fieldSchema?.type === 'string' && ['date', 'date-time'].includes(fieldSchema?.format)) {
    const parsed = parseDateValue(value);
    if (parsed == null && strict) throw invalidQueryError(`Invalid date value for '${String(value)}'`);
    return parsed;
  }

  return value == null ? null : String(value);
}

function compareComparableValues(left, right, fieldSchema) {
  const leftComparable = coerceComparableValue(left, fieldSchema);
  const rightComparable = coerceComparableValue(right, fieldSchema);

  if (typeof leftComparable === 'number' && typeof rightComparable === 'number') {
    return leftComparable - rightComparable;
  }

  return String(leftComparable ?? '').localeCompare(String(rightComparable ?? ''));
}

function normalizeExactFilterValue(value, field) {
  if (value != null && typeof value === 'object') {
    throw invalidQueryError(`Exact filter on '${field}' must use a scalar value`);
  }
  return String(value);
}

function compileRequestFilters(filter, streamGrant, manifestStream) {
  if (filter == null) return [];
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) {
    throw invalidQueryError('filter must use filter[field]=value or filter[field][op]=value');
  }

  const compiled = [];
  for (const [field, rawValue] of Object.entries(filter)) {
    if (streamGrant.fields && !streamGrant.fields.includes(field)) {
      throw invalidQueryError(`Filter on field '${field}' not in grant`, 'field_not_granted');
    }

    const fieldSchema = getFieldSchema(manifestStream, field);
    if (!fieldSchema) {
      throw invalidQueryError(`Unknown field: ${field}`);
    }

    if (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)) {
      const operatorEntries = Object.entries(rawValue);
      if (!operatorEntries.length) {
        throw invalidQueryError(`Range filter on '${field}' must include at least one operator`);
      }
      if (!isRangeQueryableSchema(fieldSchema)) {
        throw invalidQueryError(`Range filters are not supported on '${field}'`);
      }

      const declaredOperators = manifestStream?.query?.range_filters?.[field];
      if (!Array.isArray(declaredOperators) || !declaredOperators.length) {
        throw invalidQueryError(`Range filters are not declared for '${field}'`);
      }
      const declaredOperatorSet = new Set(declaredOperators);
      const operators = {};

      for (const [operator, operand] of operatorEntries) {
        if (!SUPPORTED_RANGE_OPERATORS.has(operator)) {
          throw invalidQueryError(`Unsupported range operator '${operator}' on '${field}'`);
        }
        if (!declaredOperatorSet.has(operator)) {
          throw invalidQueryError(`Range operator '${operator}' is not declared for '${field}'`);
        }
        const comparable = coerceComparableValue(operand, fieldSchema, { strict: true });
        if (comparable == null) {
          throw invalidQueryError(`Invalid range value for '${field}'`);
        }
        operators[operator] = comparable;
      }

      compiled.push({ field, kind: 'range', fieldSchema, operators });
      continue;
    }

    if (!isScalarFieldSchema(fieldSchema)) {
      throw invalidQueryError(`Exact filters are supported only on top-level scalar fields; '${field}' is not scalar`);
    }

    compiled.push({
      field,
      kind: 'exact',
      value: normalizeExactFilterValue(rawValue, field),
    });
  }

  return compiled;
}

function passesRequestFilters(data, filters) {
  if (!filters?.length) return true;

  for (const filter of filters) {
    const value = data?.[filter.field];

    if (filter.kind === 'exact') {
      if (String(value) !== filter.value) return false;
      continue;
    }

    const comparable = coerceComparableValue(value, filter.fieldSchema);
    if (comparable == null) return false;
    if (filter.operators.gte != null && comparable < filter.operators.gte) return false;
    if (filter.operators.gt != null && comparable <= filter.operators.gt) return false;
    if (filter.operators.lte != null && comparable > filter.operators.lte) return false;
    if (filter.operators.lt != null && comparable >= filter.operators.lt) return false;
  }

  return true;
}

function buildRecordSortPosition(rawData, recordKey, manifestStream) {
  const primaryKeyFields = normalizePrimaryKey(manifestStream?.primary_key);
  const decodedKey = decodeKey(recordKey);
  const decodedKeyParts = Array.isArray(decodedKey) ? decodedKey : [decodedKey];
  const primaryKey = primaryKeyFields.map((field, index) => {
    if (rawData?.[field] !== undefined) return rawData[field];
    return decodedKeyParts[index] ?? null;
  });

  return {
    cursor_value: manifestStream?.cursor_field ? (rawData?.[manifestStream.cursor_field] ?? null) : null,
    primary_key: primaryKey,
  };
}

function compareLogicalPositions(left, right, manifestStream, order) {
  const direction = order === 'ASC' ? 1 : -1;
  const cursorField = manifestStream?.cursor_field || null;

  if (cursorField) {
    const fieldSchema = getFieldSchema(manifestStream, cursorField);
    const leftMissing = left?.cursor_value == null || left.cursor_value === '';
    const rightMissing = right?.cursor_value == null || right.cursor_value === '';

    if (leftMissing !== rightMissing) {
      return leftMissing ? 1 : -1;
    }
    if (!leftMissing && !rightMissing) {
      const cursorComparison = compareComparableValues(left.cursor_value, right.cursor_value, fieldSchema);
      if (cursorComparison !== 0) return cursorComparison * direction;
    }
  }

  const primaryKeyFields = normalizePrimaryKey(manifestStream?.primary_key);
  for (let index = 0; index < primaryKeyFields.length; index += 1) {
    const fieldSchema = getFieldSchema(manifestStream, primaryKeyFields[index]);
    const comparison = compareComparableValues(
      left?.primary_key?.[index],
      right?.primary_key?.[index],
      fieldSchema,
    );
    if (comparison !== 0) return comparison * direction;
  }

  return 0;
}

function parsePageOrder(rawOrder) {
  if (rawOrder == null || rawOrder === '') return 'DESC';
  if (rawOrder === 'asc') return 'ASC';
  if (rawOrder === 'desc') return 'DESC';
  throw invalidQueryError('order must be asc or desc');
}

function normalizePaginationCursor(cursor, order) {
  if (!cursor) return null;
  if (cursor.session !== 'records') {
    throw invalidQueryError('Malformed cursor', 'invalid_cursor');
  }
  if (!Array.isArray(cursor.primary_key)) {
    throw invalidQueryError('Malformed cursor', 'invalid_cursor');
  }
  if (cursor.order !== order) {
    throw invalidQueryError('Cursor order does not match request order', 'invalid_cursor');
  }
  return {
    cursor_value: cursor.cursor_value ?? null,
    primary_key: cursor.primary_key,
  };
}

function validateTopLevelQueryParams(requestParams) {
  const unsupported = Object.keys(requestParams).filter((key) => !SUPPORTED_RECORD_QUERY_PARAMS.has(key));
  if (unsupported.length) {
    throw invalidQueryError(`Unsupported query parameter: ${unsupported.join(', ')}`);
  }
}

function normalizeExpandRequest(requestParams, stream, grant, manifestStream, order) {
  if (requestParams.expand_limit != null && (!requestParams.expand || requestParams.expand === '')) {
    throw invalidQueryError('expand_limit requires a matching expand relation', 'invalid_expand');
  }

  if (requestParams.expand == null || requestParams.expand === '') {
    if (requestParams.expand_limit != null) {
      throw invalidQueryError('expand_limit requires a matching expand relation', 'invalid_expand');
    }
    return [];
  }

  if (requestParams.expand && typeof requestParams.expand === 'object' && !Array.isArray(requestParams.expand)) {
    throw invalidQueryError('expand must be a relation name or repeated expand values', 'invalid_expand');
  }

  const requestedNames = (Array.isArray(requestParams.expand) ? requestParams.expand : [requestParams.expand])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (!requestedNames.length) {
    throw invalidQueryError('expand must include at least one relation name', 'invalid_expand');
  }

  const seenNames = new Set();
  const relationships = new Map((manifestStream?.relationships || []).map((relationship) => [relationship.name, relationship]));
  const capabilities = new Map((manifestStream?.query?.expand || []).map((capability) => [capability.name, capability]));
  const requestedLimits = requestParams.expand_limit == null
    ? {}
    : requestParams.expand_limit;

  if (requestedLimits && (typeof requestedLimits !== 'object' || Array.isArray(requestedLimits))) {
    throw invalidQueryError('expand_limit must use expand_limit[relation]=N', 'invalid_expand');
  }

  const expansions = [];
  for (const relationName of requestedNames) {
    if (seenNames.has(relationName)) continue;
    seenNames.add(relationName);

    if (relationName.includes('.')) {
      throw invalidQueryError(`Nested expansion '${relationName}' is not supported`, 'invalid_expand');
    }

    const relationship = relationships.get(relationName);
    const capability = capabilities.get(relationName);
    if (!relationship || !capability) {
      throw invalidQueryError(`Unsupported expand relation '${relationName}' on '${stream}'`, 'invalid_expand');
    }

    const childGrant = grant.streams.find((entry) => entry.name === relationship.stream);
    if (!childGrant) {
      throw invalidQueryError(`Expand relation '${relationName}' requires grant access to '${relationship.stream}'`, 'insufficient_scope');
    }

    const defaultLimit = parseIntegerValue(capability.default_limit) ?? 10;
    const maxLimit = parseIntegerValue(capability.max_limit) ?? 50;
    let appliedLimit = defaultLimit;

    if (requestedLimits && Object.prototype.hasOwnProperty.call(requestedLimits, relationName)) {
      if (relationship.cardinality !== 'has_many') {
        throw invalidQueryError(`expand_limit is only valid for has_many relations; '${relationName}' is ${relationship.cardinality}`, 'invalid_expand');
      }
      const parsedLimit = parseIntegerValue(requestedLimits[relationName]);
      if (parsedLimit == null || parsedLimit <= 0) {
        throw invalidQueryError(`expand_limit[${relationName}] must be a positive integer`, 'invalid_expand');
      }
      if (parsedLimit > maxLimit) {
        throw invalidQueryError(`expand_limit[${relationName}] exceeds max_limit ${maxLimit}`, 'invalid_expand');
      }
      appliedLimit = parsedLimit;
    }

    expansions.push({
      name: relationName,
      relationship,
      childGrant,
      limit: appliedLimit,
      order,
    });
  }

  if (requestedLimits) {
    for (const relationName of Object.keys(requestedLimits)) {
      if (!seenNames.has(relationName)) {
        throw invalidQueryError(`expand_limit[${relationName}] requires a matching expand relation`, 'invalid_expand');
      }
    }
  }

  return expansions;
}

function passesGrantVisibility(rawData, recordKey, effective, consentTimeField) {
  if (effective.timeRange && consentTimeField && !passesTimeRange(rawData, effective.timeRange, consentTimeField)) {
    return false;
  }
  if (effective.resources && !effective.resources.includes(recordKey)) return false;
  return true;
}

async function fetchVisibleRecordRows(db, connectorId, stream, effective, manifestStream, compiledFilters = []) {
  const rows = db.prepare(`
    SELECT record_key, record_json, emitted_at
    FROM records
    WHERE connector_id = ?
      AND stream = ?
      AND deleted = 0
  `).all(connectorId, stream);

  const consentTimeField = manifestStream?.consent_time_field;
  const visibleRows = [];

  for (const row of rows) {
    const rawData = JSON.parse(row.record_json);
    if (!passesGrantVisibility(rawData, row.record_key, effective, consentTimeField)) continue;
    if (!passesRequestFilters(rawData, compiledFilters)) continue;

    visibleRows.push({
      record_key: row.record_key,
      rawData,
      emitted_at: row.emitted_at,
      sortPosition: buildRecordSortPosition(rawData, row.record_key, manifestStream),
    });
  }

  return visibleRows;
}

function buildResponseRecord(stream, row, effective) {
  return {
    object: 'record',
    id: row.record_key,
    stream,
    data: projectFields(row.rawData, effective.fields),
    emitted_at: row.emitted_at,
  };
}

async function hydrateExpandedRelations({
  connectorId,
  db,
  effectiveParentRows,
  expansions,
  manifest,
  grant,
}) {
  if (!expansions.length || !effectiveParentRows.length) return;

  for (const expansion of expansions) {
    const childManifestStream = manifest?.streams?.find((entry) => entry.name === expansion.relationship.stream);
    const childRequiredFields = childManifestStream?.schema?.required || [];
    const childEffective = buildEffectiveFilter(expansion.childGrant, {}, childRequiredFields);
    const childRows = await fetchVisibleRecordRows(
      db,
      connectorId,
      expansion.relationship.stream,
      childEffective,
      childManifestStream,
    );
    // Expanded children follow the related stream's natural stable order rather
    // than inheriting the parent's list order.
    childRows.sort((left, right) => compareLogicalPositions(left.sortPosition, right.sortPosition, childManifestStream, 'ASC'));

    const groupedChildren = new Map();
    for (const childRow of childRows) {
      const foreignKeyValue = childRow.rawData?.[expansion.relationship.foreign_key];
      if (foreignKeyValue == null) continue;
      const relationKey = encodeKey(foreignKeyValue);
      if (!groupedChildren.has(relationKey)) groupedChildren.set(relationKey, []);
      groupedChildren.get(relationKey).push(buildResponseRecord(expansion.relationship.stream, childRow, childEffective));
    }

    for (const parentRow of effectiveParentRows) {
      const relationKey = parentRow.record_key;
      const matches = groupedChildren.get(relationKey) || [];
      if (!parentRow.responseRecord.expanded) parentRow.responseRecord.expanded = {};

      if (expansion.relationship.cardinality === 'has_one') {
        parentRow.responseRecord.expanded[expansion.name] = matches[0] || null;
        continue;
      }

      parentRow.responseRecord.expanded[expansion.name] = {
        object: 'list',
        has_more: matches.length > expansion.limit,
        data: matches.slice(0, expansion.limit),
      };
    }
  }
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
  if (decoded.kind !== 'page' || typeof decoded.session !== 'string') return null;
  return decoded;
}

function encodeRecordsPageCursor(position, order) {
  return encodeCursor({
    kind: 'page',
    session: 'records',
    order,
    cursor_value: position?.cursor_value ?? null,
    primary_key: position?.primary_key || [],
  });
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
  const row = db.prepare(`
    SELECT record_json, emitted_at, deleted, deleted_at, version
    FROM record_changes
    WHERE connector_id = ?
      AND stream = ?
      AND record_key = ?
      AND version <= ?
    ORDER BY version DESC
    LIMIT 1
  `).get(connectorId, stream, recordKey, version);

  if (!row) return null;

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

  // Find manifest stream for stream-specific query capability declarations.
  const mStream = manifest?.streams?.find(s => s.name === stream);
  const consentTimeField = mStream?.consent_time_field;
  const requiredFields = mStream?.schema?.required || [];
  const order = parsePageOrder(requestParams.order);

  validateTopLevelQueryParams(requestParams);

  // Validate request fields against grant
  if (requestParams.fields && streamGrant.fields) {
    const unauthorized = requestParams.fields.filter(f => !streamGrant.fields.includes(f));
    if (unauthorized.length) {
      const err = new Error(`Fields not in grant: ${unauthorized.join(', ')}`);
      err.code = 'field_not_granted';
      throw err;
    }
  }

  const compiledFilters = compileRequestFilters(requestParams.filter, streamGrant, mStream);

  const effective = buildEffectiveFilter(streamGrant, requestParams, requiredFields);
  const expansions = normalizeExpandRequest(requestParams, stream, grant, mStream, order);

  const limit = Math.min(parseInt(requestParams.limit) || 25, 100);

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

  if ((changesSince !== null || paginationCursor?.session === 'changes') && expansions.length) {
    throw invalidQueryError('expand is not supported with changes_since', 'invalid_expand');
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

    const vcRow = db.prepare(
      'SELECT max_version FROM version_counter WHERE connector_id = ? AND stream = ?'
    ).get(connectorId, stream);
    const currentMaxVersion = vcRow ? vcRow.max_version : 0;
    const effectiveSessionMaxVersion = changesSince ? currentMaxVersion : sessionMaxVersion;

    const minChangeRow = db.prepare(
      'SELECT MIN(version) as min_version FROM record_changes WHERE connector_id = ? AND stream = ?'
    ).get(connectorId, stream);
    const minVersion = minChangeRow?.min_version ?? null;
    if (minVersion !== null && sinceVersion < (minVersion - 1)) {
      const err = new Error('changes_since cursor is too old; full re-sync required');
      err.code = 'cursor_expired';
      throw err;
    }

    const visibleChanges = [];
    let pageAfterVersion = afterVersion;
    const batchSize = limit + 1;

    while (visibleChanges.length <= limit) {
      const changeGroups = db.prepare(`
        SELECT record_key, MAX(version) as latest_version
        FROM record_changes
        WHERE connector_id = ?
          AND stream = ?
          AND version > ?
          AND version <= ?
        GROUP BY record_key
        ORDER BY latest_version ASC
        LIMIT ?
      `).all(connectorId, stream, pageAfterVersion, effectiveSessionMaxVersion, batchSize);

      if (!changeGroups.length) break;

      for (const group of changeGroups) {
        const previous = await getSnapshotAtVersion(db, connectorId, stream, group.record_key, sinceVersion);
        const current = await getSnapshotAtVersion(db, connectorId, stream, group.record_key, group.latest_version);

        const previousVisible = isVisibleSnapshot(previous, effective, consentTimeField);
        const currentVisible = isVisibleSnapshot(current, effective, consentTimeField);

        if (current?.deleted) {
          if (!previousVisible || !passesRequestFilters(previous.data, compiledFilters)) continue;
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

        if (!currentVisible || !passesRequestFilters(current.data, compiledFilters)) continue;

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

  const cursorPosition = normalizePaginationCursor(paginationCursor, order);
  let visibleRows = await fetchVisibleRecordRows(
    db,
    connectorId,
    stream,
    effective,
    mStream,
    compiledFilters,
  );
  visibleRows.sort((left, right) => compareLogicalPositions(left.sortPosition, right.sortPosition, mStream, order));

  if (cursorPosition) {
    visibleRows = visibleRows.filter((row) => compareLogicalPositions(row.sortPosition, cursorPosition, mStream, order) > 0);
  }

  const pagedRows = visibleRows.slice(0, limit + 1);
  const hasMore = pagedRows.length > limit;
  const effectivePageRows = pagedRows.slice(0, limit).map((row) => ({
    ...row,
    responseRecord: buildResponseRecord(stream, row, effective),
  }));

  await hydrateExpandedRelations({
    connectorId,
    db,
    effectiveParentRows: effectivePageRows,
    expansions,
    manifest,
    order,
    grant,
  });

  const data = effectivePageRows.map((row) => row.responseRecord);

  const response = {
    object: 'list',
    has_more: hasMore,
    data,
  };

  if (hasMore && data.length) {
    response.next_cursor = encodeRecordsPageCursor(effectivePageRows[effectivePageRows.length - 1].sortPosition, order);
  }

  return response;
}

/**
 * Get a single record by key, under grant enforcement
 */
export async function getRecord(storageTarget, stream, recordId, grant, manifest = null, requestParams = {}) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const db = getDb();

  const streamGrant = grant.streams.find(s => s.name === stream);
  if (!streamGrant) {
    const err = new Error(`Stream '${stream}' not in grant`);
    err.code = 'grant_stream_not_allowed';
    throw err;
  }

  const row = db.prepare(`
    SELECT record_key, record_json, emitted_at
    FROM records
    WHERE connector_id = ?
      AND stream = ?
      AND record_key = ?
      AND deleted = 0
  `).get(connectorId, stream, recordId);

  if (!row) {
    const err = new Error('Record not found');
    err.code = 'not_found';
    throw err;
  }

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

  const responseRow = {
    record_key: row.record_key,
    rawData,
    emitted_at: row.emitted_at,
    sortPosition: buildRecordSortPosition(rawData, row.record_key, mStream),
    responseRecord: buildResponseRecord(stream, {
      record_key: row.record_key,
      rawData,
      emitted_at: row.emitted_at,
    }, effective),
  };

  const expansions = normalizeExpandRequest({
    expand: requestParams.expand,
    expand_limit: requestParams.expand_limit,
  }, stream, grant, mStream, 'ASC');

  await hydrateExpandedRelations({
    connectorId,
    db,
    effectiveParentRows: [responseRow],
    expansions,
    manifest,
    grant,
  });

  return responseRow.responseRecord;
}

/**
 * Delete a record (owner-authenticated)
 */
export async function deleteRecord(storageTarget, stream, recordId) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const db = getDb();
  const now = nowIso();
  const current = db.prepare(`
    SELECT record_json, deleted
    FROM records
    WHERE connector_id = ? AND stream = ? AND record_key = ?
  `).get(connectorId, stream, recordId);
  if (!current || current.deleted) return 0;

  const vcRow = db.prepare(
    'SELECT max_version FROM version_counter WHERE connector_id = ? AND stream = ?'
  ).get(connectorId, stream);
  const nextVersion = vcRow ? vcRow.max_version + 1 : 1;

  db.prepare(`
    UPDATE records
    SET deleted = 1, deleted_at = ?, version = ?
    WHERE connector_id = ? AND stream = ? AND record_key = ?
  `).run(now, nextVersion, connectorId, stream, recordId);

  db.prepare(`
    INSERT INTO record_changes(connector_id, stream, record_key, version, record_json, emitted_at, deleted, deleted_at)
    VALUES(?, ?, ?, ?, ?, ?, 1, ?)
  `).run(connectorId, stream, recordId, nextVersion, current.record_json, now, now);

  db.prepare(`
    INSERT INTO version_counter(connector_id, stream, max_version)
    VALUES(?, ?, ?)
    ON CONFLICT(connector_id, stream) DO UPDATE SET max_version = excluded.max_version
  `).run(connectorId, stream, nextVersion);

  await lexicalIndexDelete({ connectorId, stream, recordKey: recordId });

  const changeHistoryLimit = getChangeHistoryLimit();
  if (changeHistoryLimit > 0) {
    db.prepare(`
      DELETE FROM record_changes
      WHERE connector_id = ?
        AND stream = ?
        AND version <= ?
    `).run(connectorId, stream, nextVersion - changeHistoryLimit);
  }

  return 1;
}

export async function listAllStreams(storageTarget) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const rows = getDb().prepare(`
    SELECT stream, COUNT(*) as count, MAX(emitted_at) as last_updated
    FROM records
    WHERE connector_id = ? AND deleted = 0
    GROUP BY stream
    ORDER BY stream ASC
  `).all(connectorId);

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
  const countRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM records
    WHERE connector_id = ? AND stream = ?
  `).get(connectorId, stream);
  const deletedRecordCount = countRow?.count || 0;
  db.prepare('DELETE FROM records WHERE connector_id = ? AND stream = ?').run(connectorId, stream);
  db.prepare('DELETE FROM record_changes WHERE connector_id = ? AND stream = ?').run(connectorId, stream);
  db.prepare('DELETE FROM version_counter WHERE connector_id = ? AND stream = ?').run(connectorId, stream);
  await lexicalIndexDeleteByConnectorStream({ connectorId, stream });
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
    const rows = db.prepare(`
      SELECT record_key, record_json, emitted_at
      FROM records
      WHERE connector_id = ? AND stream = ? AND deleted = 0
    `).all(connectorId, sg.name);
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
    ? db.prepare(
        'SELECT stream, state_json, updated_at FROM grant_connector_state WHERE connector_id = ? AND grant_id = ?'
      ).all(connectorId, grantId)
    : db.prepare(
        'SELECT stream, state_json, updated_at FROM connector_state WHERE connector_id = ?'
      ).all(connectorId);
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
      db.prepare(`
        INSERT INTO grant_connector_state(grant_id, connector_id, stream, state_json, updated_at)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(grant_id, connector_id, stream) DO UPDATE SET
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `).run(grantId, connectorId, stream, JSON.stringify(cursor), now);
      continue;
    }

    db.prepare(`
      INSERT INTO connector_state(connector_id, stream, state_json, updated_at)
      VALUES(?, ?, ?, ?)
      ON CONFLICT(connector_id, stream) DO UPDATE SET
        state_json = excluded.state_json,
        updated_at = excluded.updated_at
    `).run(connectorId, stream, JSON.stringify(cursor), now);
  }
  return getSyncState(connectorId, { grantId, allowedStreams });
}

/**
 * Aggregate dataset summary used by the reference `/_ref/dataset/summary` surface
 * powering the operator-console hero band.
 *
 * Semantics:
 * - `record_count`, `connector_count`, `stream_count`, and `record_json_bytes`
 *   count only live (non-soft-deleted) records — what normal reads would
 *   surface.
 * - `connector_count` and `stream_count` are distinct `(connector_id, stream)`
 *   observations in the live records table, not manifest-declared counts.
 * - `record_changes_json_bytes` sums the `record_changes` table — historical
 *   versions retained by design for change tracking. Included in
 *   `total_retained_bytes` because the substrate is honestly holding them.
 * - `blob_bytes` sums the whole `blobs` table (blobs are not soft-deleted).
 * - `total_retained_bytes = record_json_bytes + record_changes_json_bytes + blob_bytes`.
 *   Three concepts kept separately labeled so callers can disambiguate.
 * - Byte fields use `LENGTH(CAST(... AS BLOB))` so multibyte JSON counts real
 *   bytes, not codepoints.
 * - `earliest_record_time` / `latest_record_time` are real-world timestamps
 *   pulled from record payloads via each stream's manifest-declared
 *   `consent_time_field`. Streams without a `consent_time_field` don't
 *   contribute — only streams the manifest itself has named as temporally
 *   meaningful. All PDPP `consent_time_field`s observed in practice are
 *   ISO-lexicographically comparable strings (date or date-time), so the
 *   global min/max is honestly computed across connectors.
 * - `earliest_ingested_at` / `latest_ingested_at` are the substrate's own
 *   `emitted_at` bounds (when the runtime wrote the row). These are always
 *   available and useful for operator observability; they are *not* the real
 *   age of the data.
 */
export async function getDatasetSummary() {
  const db = getDb();

  const recordAgg = db.prepare(`
    SELECT
      COUNT(*)                                         AS record_count,
      COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS record_json_bytes,
      MIN(emitted_at)                                  AS earliest_ingested_at,
      MAX(emitted_at)                                  AS latest_ingested_at,
      COUNT(DISTINCT connector_id)                     AS connector_count,
      COUNT(DISTINCT connector_id || char(10) || stream) AS stream_count
    FROM records
    WHERE deleted = 0
  `).get();

  const changeAgg = db.prepare(`
    SELECT COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS record_changes_json_bytes
    FROM record_changes
    WHERE record_json IS NOT NULL
  `).get();

  const blobAgg = db.prepare(
    'SELECT COALESCE(SUM(size_bytes), 0) AS blob_bytes FROM blobs'
  ).get();

  const recordCount = Number(recordAgg?.record_count || 0);
  const connectorCount = Number(recordAgg?.connector_count || 0);
  const streamCount = Number(recordAgg?.stream_count || 0);
  const recordJsonBytes = Number(recordAgg?.record_json_bytes || 0);
  const recordChangesJsonBytes = Number(changeAgg?.record_changes_json_bytes || 0);
  const blobBytes = Number(blobAgg?.blob_bytes || 0);

  const realWorldBounds =
    recordCount > 0 ? await getRealWorldTimeBounds() : { earliest: null, latest: null };

  return {
    object: 'dataset_summary',
    connector_count: connectorCount,
    stream_count: streamCount,
    record_count: recordCount,
    record_json_bytes: recordJsonBytes,
    record_changes_json_bytes: recordChangesJsonBytes,
    blob_bytes: blobBytes,
    total_retained_bytes: recordJsonBytes + recordChangesJsonBytes + blobBytes,
    earliest_record_time: realWorldBounds.earliest,
    latest_record_time: realWorldBounds.latest,
    earliest_ingested_at: recordCount > 0 ? recordAgg?.earliest_ingested_at || null : null,
    latest_ingested_at: recordCount > 0 ? recordAgg?.latest_ingested_at || null : null,
    top_connectors: await getTopConnectorsByRecordCount(3),
  };
}

/**
 * Compute the real-world earliest/latest record timestamps across all streams
 * whose manifest declares a `consent_time_field`. Streams without that field
 * (workspace metadata, label dictionaries, etc.) don't contribute because the
 * manifest itself did not name them as temporally meaningful.
 *
 * This is O(streams_with_consent_time_field) queries — ~50 for the full
 * 10-connector corpus. Each query uses the existing
 * (connector_id, stream, record_key) index for the WHERE clause; the
 * `json_extract` MIN/MAX still scans rows, but only within one stream at a
 * time. Measured at ~210ms for the largest populated stream on a 772k-row DB.
 */
async function getRealWorldTimeBounds() {
  const db = getDb();

  const connectors = db.prepare('SELECT connector_id, manifest FROM connectors').all();

  let earliest = null;
  let latest = null;

  for (const row of connectors) {
    let manifest;
    try {
      manifest = JSON.parse(row.manifest);
    } catch {
      continue;
    }
    if (!Array.isArray(manifest?.streams)) continue;

    for (const stream of manifest.streams) {
      const field = stream?.consent_time_field;
      const streamName = stream?.name;
      if (typeof field !== 'string' || !field || typeof streamName !== 'string') continue;

      // `json_extract` path is `$.<field>`. The field name is a manifest-declared
      // JSON property name, which in practice is a safe identifier. We still
      // interpolate literally because SQLite parameter binding is for values,
      // not for the JSON path. Reject anything that could break out of the
      // `$.<field>` form.
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) continue;

      const jsonPath = `$.${field}`;
      const result = db.prepare(`
        SELECT
          MIN(json_extract(record_json, ?)) AS min_time,
          MAX(json_extract(record_json, ?)) AS max_time
        FROM records
        WHERE connector_id = ?
          AND stream = ?
          AND deleted = 0
      `).get(jsonPath, jsonPath, row.connector_id, streamName);
      if (!result) continue;
      const minTime = typeof result.min_time === 'string' ? result.min_time : null;
      const maxTime = typeof result.max_time === 'string' ? result.max_time : null;
      if (minTime && (earliest === null || minTime < earliest)) earliest = minTime;
      if (maxTime && (latest === null || maxTime > latest)) latest = maxTime;
    }
  }

  return { earliest, latest };
}

/**
 * Top N connectors by live record count, used by the operator-console hero
 * "quiet breadth row". Returns `[{ connector_id, record_count }]` sorted by
 * record_count descending. Excludes soft-deleted rows.
 */
async function getTopConnectorsByRecordCount(limit) {
  const rows = getDb().prepare(`
    SELECT connector_id, COUNT(*) AS record_count
    FROM records
    WHERE deleted = 0
    GROUP BY connector_id
    ORDER BY record_count DESC, connector_id ASC
    LIMIT ?
  `).all(limit);
  return rows.map((row) => ({
    object: 'dataset_connector_summary',
    connector_id: row.connector_id,
    record_count: Number(row.record_count || 0),
  }));
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
