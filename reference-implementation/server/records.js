/**
 * PDPP Resource Server — record storage and grant-enforced query
 */
import { getDb } from './db.js';
import {
  allowUnboundedReadAcknowledged,
  exec,
  getMany,
  getOne,
  iterate,
  iterateDynamicSqlAcknowledged,
  referenceQueries,
} from '../lib/db.ts';
import {
  lexicalIndexDelete,
  lexicalIndexDeleteByConnectorStream,
  lexicalIndexUpsert,
} from './search.js';
import {
  semanticIndexDelete,
  semanticIndexDeleteByConnectorStream,
  semanticIndexUpsert,
} from './search-semantic.js';
import {
  compileRequestFilters,
  passesRequestFilters,
  passesTimeRange,
} from './record-filters.js';

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

  const current = getOne(
    referenceQueries.recordsIngestGetCurrentRecordState,
    [connectorId, stream, recordKey],
  );

  if (op === 'delete' && (!current || current.deleted)) {
    return { accepted: true, changed: false };
  }

  if (op !== 'delete' && current && !current.deleted && current.record_json === recordJson) {
    return { accepted: true, changed: false };
  }

  // Get next version
  const vcRow = getOne(
    referenceQueries.recordsIngestGetVersionCounter,
    [connectorId, stream],
  );
  const nextVersion = vcRow ? vcRow.max_version + 1 : 1;

  const effectiveEmittedAt = emitted_at || nowIso();

  if (op === 'delete') {
    exec(
      referenceQueries.recordsIngestMarkRecordDeleted,
      [effectiveEmittedAt, nextVersion, connectorId, stream, recordKey],
    );
    exec(
      referenceQueries.recordsIngestInsertRecordChangeDeleted,
      [connectorId, stream, recordKey, nextVersion, current.record_json, effectiveEmittedAt, effectiveEmittedAt],
    );
    await lexicalIndexDelete({ connectorId, stream, recordKey });
    await semanticIndexDelete({ connectorId, stream, recordKey });
  } else {
    exec(
      referenceQueries.recordsIngestUpsertRecord,
      [connectorId, stream, recordKey, recordJson, effectiveEmittedAt, nextVersion],
    );
    exec(
      referenceQueries.recordsIngestInsertRecordChangeUpsert,
      [connectorId, stream, recordKey, nextVersion, recordJson, effectiveEmittedAt],
    );
    await lexicalIndexUpsert({ connectorId, stream, recordKey, data });
    await semanticIndexUpsert({ connectorId, stream, recordKey, data });
  }

  // Advance version counter
  exec(
    referenceQueries.recordsIngestUpsertVersionCounter,
    [connectorId, stream, nextVersion],
  );

  const changeHistoryLimit = getChangeHistoryLimit();
  if (changeHistoryLimit > 0) {
    exec(
      referenceQueries.recordsIngestPruneRecordChanges,
      [connectorId, stream, nextVersion - changeHistoryLimit],
    );
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
const SUPPORTED_AGGREGATE_QUERY_PARAMS = new Set([
  'connector_id',
  'field',
  'filter',
  'group_by',
  'limit',
  'metric',
  'subject_id',
]);
const SUPPORTED_AGGREGATE_METRICS = new Set(['count', 'sum', 'min', 'max']);
const MAX_AGGREGATE_GROUP_LIMIT = 100;
const DEFAULT_AGGREGATE_GROUP_LIMIT = 10;

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

/**
 * JSON Schema allows `type` to be either a string (`"string"`) or an array
 * (`["string", "null"]`). For cursor-field parity checks and filter
 * validation/coercion we care about the underlying non-null type(s).
 * Returns a Set of type names with `"null"` stripped out. An empty set means
 * "type not declared". A size-1 set represents a cleanly-typed scalar
 * (possibly nullable); callers that need a single type should bail otherwise.
 */
function nonNullSchemaTypes(schema) {
  const raw = schema?.type;
  if (raw == null) return new Set();
  const list = Array.isArray(raw) ? raw : [raw];
  return new Set(list.filter((t) => t !== 'null'));
}

const AGGREGATE_SCALAR_SCHEMA_TYPES = new Set(['boolean', 'integer', 'number', 'string']);

function isScalarAggregateSchema(fieldSchema) {
  const types = nonNullSchemaTypes(fieldSchema);
  if (types.size !== 1) return false;
  return AGGREGATE_SCALAR_SCHEMA_TYPES.has([...types][0]);
}

function isNumericAggregateSchema(fieldSchema) {
  const types = nonNullSchemaTypes(fieldSchema);
  return types.size === 1 && (types.has('integer') || types.has('number'));
}

function isMinMaxAggregateSchema(fieldSchema) {
  const types = nonNullSchemaTypes(fieldSchema);
  if (types.size !== 1) return false;
  if (types.has('integer') || types.has('number')) return true;
  return types.has('string') && (fieldSchema?.format === 'date' || fieldSchema?.format === 'date-time');
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

  // Branch on the non-null component of the declared type so that nullable
  // scalar schemas (`["integer", "null"]` etc.) coerce the same way as their
  // bare counterparts. An ambiguous `type` (e.g. `["string","integer"]`)
  // falls through to string coercion — that matches pre-nullable behavior
  // for any schema we wouldn't have accepted as range-queryable anyway.
  const types = nonNullSchemaTypes(fieldSchema);
  const only = types.size === 1 ? [...types][0] : null;

  if (only === 'integer') {
    const parsed = parseIntegerValue(value);
    if (parsed == null && strict) throw invalidQueryError(`Invalid integer value for '${String(value)}'`);
    return parsed;
  }

  if (only === 'number') {
    const parsed = parseNumberValue(value);
    if (parsed == null && strict) throw invalidQueryError(`Invalid number value for '${String(value)}'`);
    return parsed;
  }

  if (only === 'string' && ['date', 'date-time'].includes(fieldSchema?.format)) {
    const parsed = parseDateValue(value);
    if (parsed == null && strict) throw invalidQueryError(`Invalid date value for '${String(value)}'`);
    return parsed;
  }

  return String(value);
}

/**
 * Compare two values under the semantics of a declared field schema, used by
 * the in-memory fallback sort/seek path. Mirrors the old JS comparator: numeric
 * compare for integer/number (and date-coerced), `localeCompare` for strings,
 * with null values sorted after present values (the seek builder handles the
 * missing-bucket toggle separately).
 */
function compareComparableValues(left, right, fieldSchema) {
  const l = coerceComparableValue(left, fieldSchema);
  const r = coerceComparableValue(right, fieldSchema);
  if (typeof l === 'number' && typeof r === 'number') return l - r;
  return String(l ?? '').localeCompare(String(r ?? ''));
}

/**
 * (cursor_value, primary_key) → (cursor_value, primary_key) comparison with
 * the manifest-declared schema types. `order === 'ASC'` produces ascending
 * order, `'DESC'` descending. Missing cursor values (null/'') bucket last in
 * ASC and first in DESC — matches the SQL path's `__cursor_missing` keyway.
 */
function compareLogicalPositions(left, right, manifestStream, order) {
  const direction = order === 'ASC' ? 1 : -1;
  const cursorField = manifestStream?.cursor_field || null;

  if (cursorField) {
    const fieldSchema = getFieldSchema(manifestStream, cursorField);
    const leftMissing = left?.cursor_value == null || left.cursor_value === '';
    const rightMissing = right?.cursor_value == null || right.cursor_value === '';
    if (leftMissing !== rightMissing) {
      // Missing bucket is after present in ASC, before in DESC.
      return (leftMissing ? 1 : -1) * direction;
    }
    if (!leftMissing && !rightMissing) {
      const cmp = compareComparableValues(left.cursor_value, right.cursor_value, fieldSchema);
      if (cmp !== 0) return cmp * direction;
    }
  }

  const primaryKeyFields = normalizePrimaryKey(manifestStream?.primary_key);
  for (let i = 0; i < primaryKeyFields.length; i += 1) {
    const fieldSchema = getFieldSchema(manifestStream, primaryKeyFields[i]);
    const cmp = compareComparableValues(left?.primary_key?.[i], right?.primary_key?.[i], fieldSchema);
    if (cmp !== 0) return cmp * direction;
  }
  return 0;
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

function validateTopLevelAggregateParams(requestParams) {
  const unsupported = Object.keys(requestParams).filter((key) => !SUPPORTED_AGGREGATE_QUERY_PARAMS.has(key));
  if (unsupported.length) {
    throw invalidQueryError(`Unsupported query parameter: ${unsupported.join(', ')}`);
  }
}

function normalizeAggregateMetric(value) {
  const metric = String(value || '').trim();
  if (!SUPPORTED_AGGREGATE_METRICS.has(metric)) {
    throw invalidQueryError('metric must be one of count, sum, min, max');
  }
  return metric;
}

function normalizeAggregateLimit(value, groupBy) {
  if (!groupBy) {
    if (value != null) throw invalidQueryError('limit is only supported with group_by');
    return null;
  }
  if (value == null || value === '') return DEFAULT_AGGREGATE_GROUP_LIMIT;
  if (Array.isArray(value) || (typeof value === 'object' && value !== null)) {
    throw invalidQueryError('limit must be an integer');
  }
  const limit = Number.parseInt(String(value), 10);
  if (!Number.isInteger(limit) || String(limit) !== String(value).trim() || limit < 1 || limit > MAX_AGGREGATE_GROUP_LIMIT) {
    throw invalidQueryError(`limit must be an integer between 1 and ${MAX_AGGREGATE_GROUP_LIMIT}`);
  }
  return limit;
}

function getDeclaredAggregateFields(manifestStream, kind) {
  const fields = manifestStream?.query?.aggregations?.[kind];
  return Array.isArray(fields) ? fields : [];
}

function requireDeclaredAggregate(manifestStream, kind, field) {
  if (!getDeclaredAggregateFields(manifestStream, kind).includes(field)) {
    throw invalidQueryError(`Aggregation ${kind} is not declared for '${field}'`);
  }
}

function requireAggregateFieldGranted(streamGrant, field) {
  if (streamGrant.fields && !streamGrant.fields.includes(field)) {
    throw invalidQueryError(`Aggregation field '${field}' not in grant`, 'field_not_granted');
  }
}

function normalizeAggregateRequest(requestParams, streamGrant, manifestStream) {
  validateTopLevelAggregateParams(requestParams);

  const aggregations = manifestStream?.query?.aggregations;
  if (!aggregations || typeof aggregations !== 'object' || Array.isArray(aggregations)) {
    throw invalidQueryError(`Aggregations are not declared for stream '${manifestStream?.name || ''}'`);
  }

  const metric = normalizeAggregateMetric(requestParams.metric);
  const field = requestParams.field == null || requestParams.field === ''
    ? null
    : String(requestParams.field).trim();
  const groupBy = requestParams.group_by == null || requestParams.group_by === ''
    ? null
    : String(requestParams.group_by).trim();
  const limit = normalizeAggregateLimit(requestParams.limit, groupBy);

  if (metric === 'count') {
    if (field) throw invalidQueryError('field is not supported for count');
    if (aggregations.count !== true) {
      throw invalidQueryError(`Count aggregation is not declared for stream '${manifestStream?.name || ''}'`);
    }
  } else {
    if (groupBy) throw invalidQueryError('group_by is supported only with metric=count');
    if (!field) throw invalidQueryError(`field is required for ${metric}`);
    const fieldSchema = getFieldSchema(manifestStream, field);
    if (!fieldSchema) throw invalidQueryError(`Unknown field: ${field}`, 'unknown_field');
    requireAggregateFieldGranted(streamGrant, field);
    requireDeclaredAggregate(manifestStream, metric, field);
    if (metric === 'sum' && !isNumericAggregateSchema(fieldSchema)) {
      throw invalidQueryError(`Aggregation sum requires a numeric field; '${field}' is not numeric`);
    }
    if ((metric === 'min' || metric === 'max') && !isMinMaxAggregateSchema(fieldSchema)) {
      throw invalidQueryError(`Aggregation ${metric} requires a numeric, date, or date-time field; '${field}' is not supported`);
    }
  }

  if (groupBy) {
    const groupSchema = getFieldSchema(manifestStream, groupBy);
    if (!groupSchema) throw invalidQueryError(`Unknown field: ${groupBy}`, 'unknown_field');
    requireAggregateFieldGranted(streamGrant, groupBy);
    requireDeclaredAggregate(manifestStream, 'group_by', groupBy);
    if (!isScalarAggregateSchema(groupSchema)) {
      throw invalidQueryError(`Grouped counts require a scalar field; '${groupBy}' is not scalar`);
    }
  }

  return { metric, field, groupBy, limit };
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

// JSON-path identifiers that come from the manifest are already validated by
// `validateConnectorManifest`, but we re-validate here with a tight regex so
// the SQL builders can only produce safely-quoted `$.<field>` paths.
const SAFE_JSON_FIELD = /^[A-Za-z_][A-Za-z_0-9]*$/;

function assertSafeJsonField(field, label) {
  if (typeof field !== 'string' || !SAFE_JSON_FIELD.test(field)) {
    throw new Error(`[records] Unsafe JSON field ${label}: ${JSON.stringify(field)}`);
  }
}

function jsonExtractExpr(field) {
  assertSafeJsonField(field, 'json_extract');
  // record_json is our JSON TEXT column; $.<field> is the JSONPath.
  return `json_extract(record_json, '$.${field}')`;
}

/**
 * Exact-parity note (vs `compareLogicalPositions`):
 *
 * - The JS comparator sorts by `cursor_field` (if declared), with missing
 *   values (null or '') sorted **after** present values in ASC, **before**
 *   in DESC. We reproduce that with a `__cursor_missing` boolean in the
 *   SELECT list and an explicit two-key ORDER BY: `__cursor_missing ASC/DESC`
 *   first, then the field value.
 * - Within "present cursor" rows the JS comparator uses either numeric compare
 *   (integer/number schemas) or `localeCompare` (strings). SQLite's ORDER BY
 *   on `json_extract(...)` uses numeric ordering for SQLite's INTEGER/REAL
 *   affinity values and BINARY collation for TEXT. For our corpus every
 *   declared `cursor_field` is typed as integer/number or as a string with
 *   `format: date` / `format: date-time` (ISO-8601), where lexical BINARY
 *   order equals temporal order — semantic parity holds.
 * - Nullable variants like `["string", "null"]` or `["integer", "null"]` are
 *   semantically the same sort basis with additional null rows; those null
 *   rows fall into the `__cursor_missing` bucket which ORDER BY already
 *   places after present values in ASC (before in DESC). No parity break.
 * - For any cursor_field whose non-null type is not numeric and not ISO
 *   date/date-time (e.g. a plain `"string"` or `["string", "null"]` with no
 *   date/date-time format), we bail out rather than silently accept
 *   BINARY-vs-localeCompare drift. That leaves slice-2 handlers free to
 *   narrow the scope later without anyone relying on accidental parity today.
 * - `primary_key` parts fall through to the same rules. Every stream in
 *   our corpus uses `["id"]` primary keys — always strings of ASCII hex /
 *   UUID / etc. BINARY == localeCompare on ASCII.
 */
/**
 * Returns `{supported, reason}` for a stream's `cursor_field`. A supported
 * cursor field means the SQL-pushdown records path will produce results
 * consistent with the JS comparator. Unsupported shapes route the stream
 * through `fetchVisibleRecordRowsInMemory` instead — see the fallback in
 * `fetchVisibleRecordRowsPaginated`.
 */
function classifyCursorFieldSqlSupport(manifestStream) {
  const field = manifestStream?.cursor_field;
  if (!field) return { supported: true, reason: null };
  const schema = getFieldSchema(manifestStream, field);
  if (!schema) {
    return {
      supported: false,
      reason: `cursor_field '${field}' not in schema.properties`,
    };
  }
  const types = nonNullSchemaTypes(schema);
  const numeric = types.size === 1 && (types.has('integer') || types.has('number'));
  const isoDate =
    types.size === 1
    && types.has('string')
    && (schema.format === 'date' || schema.format === 'date-time');
  if (numeric || isoDate) return { supported: true, reason: null };
  const typeLabel = JSON.stringify(schema.type);
  return {
    supported: false,
    reason:
      `cursor_field '${field}' has schema type ${typeLabel}${schema.format ? ` format '${schema.format}'` : ''}; ` +
      'SQL-layer sort is only supported for numeric or ISO date/date-time cursor_fields ' +
      '(nullable variants allowed). Repair the manifest, or let the reference ' +
      'fallback handle it in-memory (logged at first use).',
  };
}

// Streams we've already logged a fallback for, so we don't flood stderr.
const _sqlFallbackLoggedStreams = new Set();
function logSqlFallbackOnce(connectorId, stream, reason) {
  const key = `${connectorId}::${stream}`;
  if (_sqlFallbackLoggedStreams.has(key)) return;
  _sqlFallbackLoggedStreams.add(key);
  // eslint-disable-next-line no-console
  console.warn(
    `[records] stream ${connectorId}/${stream} using in-memory pagination fallback: ${reason}`,
  );
}

/**
 * Build the seek predicate WHERE clause that selects rows strictly after
 * `cursorPosition` in the requested `order`, honoring the same missing/present
 * bucketing as `compareLogicalPositions`.
 *
 * Returns `{sql, binds}` where `sql` is a ready-to-inject predicate fragment
 * (no leading AND) and `binds` is the positional params in order.
 *
 * Assumes primary_key has exactly one scalar column (verified against the
 * current corpus; widening this requires a per-pk-column seek builder).
 */
function buildCursorSeekClause(manifestStream, cursorPosition, order) {
  const cursorField = manifestStream?.cursor_field || null;
  const primaryKeyFields = normalizePrimaryKey(manifestStream?.primary_key);
  if (primaryKeyFields.length === 0) {
    throw new Error('[records] cursor seek requires a manifest-declared primary_key');
  }
  if (primaryKeyFields.length > 1) {
    // Parity with `compareLogicalPositions` for multi-part primary keys would
    // require nested `OR (pk0 = pv0 AND (pk1 > pv1 OR …))` — worth building
    // when a corpus stream actually uses one. Today every stream has ["id"].
    throw new Error('[records] SQL cursor seek is not implemented for multi-part primary keys');
  }
  const pkField = primaryKeyFields[0];
  const pkExpr = jsonExtractExpr(pkField);

  const cursorMissing = cursorPosition.cursor_value == null || cursorPosition.cursor_value === '';
  const pkValue = cursorPosition.primary_key?.[0] ?? null;
  const cmp = order === 'ASC' ? '>' : '<';

  if (!cursorField) {
    // No cursor_field declared → sort key is just primary_key.
    return { sql: `AND ${pkExpr} ${cmp} ?`, binds: [pkValue] };
  }

  const cursorExpr = jsonExtractExpr(cursorField);
  // __cursor_missing in the SELECT is (cursor IS NULL OR cursor = '').
  // Missing-bucket sort position: ASC → last (1), DESC → first (1 still, since
  // we flip the direction of the `__cursor_missing` ORDER clause itself).
  if (cursorMissing) {
    if (order === 'ASC') {
      // Cursor is in the missing bucket; all non-missing rows came before this
      // page, so we only need to seek inside the missing bucket by pk.
      return {
        sql:
          `AND (${cursorExpr} IS NULL OR ${cursorExpr} = '') ` +
          `AND ${pkExpr} ${cmp} ?`,
        binds: [pkValue],
      };
    }
    // DESC: missing-bucket came first; the missing bucket's remainder is
    // pk-ordered DESC; the non-missing bucket hasn't started yet and still
    // needs to be served. Combine: "still in missing bucket and past pk" OR
    // "now in non-missing bucket".
    return {
      sql:
        `AND ((${cursorExpr} IS NULL OR ${cursorExpr} = '') AND ${pkExpr} ${cmp} ? ` +
        `  OR (${cursorExpr} IS NOT NULL AND ${cursorExpr} <> ''))`,
      binds: [pkValue],
    };
  }

  // Non-missing cursor.
  if (order === 'ASC') {
    // Strictly-after = same cursor+later pk, OR later cursor, OR missing bucket (after all non-missing).
    return {
      sql:
        `AND ((${cursorExpr} = ? AND ${pkExpr} ${cmp} ?) ` +
        `  OR (${cursorExpr} IS NOT NULL AND ${cursorExpr} <> '' AND ${cursorExpr} ${cmp} ?) ` +
        `  OR (${cursorExpr} IS NULL OR ${cursorExpr} = ''))`,
      binds: [cursorPosition.cursor_value, pkValue, cursorPosition.cursor_value],
    };
  }
  // DESC: missing bucket came first and is already consumed; now we're in
  // non-missing descending. Strictly-before = same cursor+earlier pk OR earlier cursor.
  return {
    sql:
      `AND ${cursorExpr} IS NOT NULL AND ${cursorExpr} <> '' ` +
      `AND ((${cursorExpr} = ? AND ${pkExpr} ${cmp} ?) ` +
      `  OR (${cursorExpr} ${cmp} ?))`,
    binds: [cursorPosition.cursor_value, pkValue, cursorPosition.cursor_value],
  };
}

/**
 * Streaming, SQL-pushdown variant of `fetchVisibleRecordRows` used by the
 * primary `/v1/streams/:stream/records` handler (not expansion — see
 * `hydrateExpandedRelations`, slated for slice 2 of the memory-pressure
 * change).
 *
 * Contract:
 *   - Access-control filters (time_range, resources) are applied in SQL.
 *   - ORDER BY is applied in SQL, reproducing `compareLogicalPositions`.
 *   - Cursor-based seek is applied in SQL; no result is materialized for
 *     rows before the cursor.
 *   - Request-side filters (compiledFilters) are kept in JS per the spec;
 *     the streaming loop yields up to `limit + 1` post-filter visible rows,
 *     reading in batches of `sqlBatchSize` from the driver iterator.
 *
 * Returns `{rows, hasMore}` where `rows` is at most `limit` post-filter
 * visible rows in SQL-sort-order, already carrying `rawData` + `sortPosition`
 * to match the shape `queryRecords` expects.
 */

/**
 * In-memory fallback used when a stream's `cursor_field` is not SQL-safe.
 * Loads the visible connector/stream records with access-control pushdown in
 * SQL (WHERE only; no ORDER BY / LIMIT), then sorts and seeks in JS using
 * `compareLogicalPositions`.
 *
 * Trade-offs vs the SQL path:
 *   - Memory: one pass over all visible records for the stream; acceptable for
 *     the reference but not for very large streams. The registration-time
 *     guardrail + manifest repairs are expected to keep this path rare.
 *   - Correctness: exact parity with the old JS comparator, including
 *     `localeCompare` on plain strings, which is what the SQL path bails on.
 */
function fetchVisibleRecordRowsInMemory({
  db,
  connectorId,
  stream,
  effective,
  manifestStream,
  compiledFilters = [],
  cursorPosition,
  limit,
  order,
}) {
  const consentTimeField = manifestStream?.consent_time_field;

  // Access-control pushdown: keep the same WHERE shape the SQL path uses, just
  // without ORDER BY / LIMIT / cursor-seek.
  const whereParts = ['connector_id = ?', 'stream = ?', 'deleted = 0'];
  const whereBinds = [connectorId, stream];
  if (effective.timeRange && consentTimeField) {
    assertSafeJsonField(consentTimeField, 'consent_time_field');
    const ctExpr = jsonExtractExpr(consentTimeField);
    whereParts.push(`${ctExpr} IS NOT NULL`);
    if (effective.timeRange.since != null) {
      whereParts.push(`${ctExpr} >= ?`);
      whereBinds.push(new Date(effective.timeRange.since).toISOString());
    }
    if (effective.timeRange.until != null) {
      whereParts.push(`${ctExpr} < ?`);
      whereBinds.push(new Date(effective.timeRange.until).toISOString());
    }
  }
  if (effective.resources && effective.resources.length > 0) {
    const placeholders = effective.resources.map(() => '?').join(', ');
    whereParts.push(`record_key IN (${placeholders})`);
    whereBinds.push(...effective.resources);
  }

  const sql = `
    SELECT record_key, record_json, emitted_at
    FROM records
    WHERE ${whereParts.join(' AND ')}
  `;

  // REVIEWED-DYNAMIC: in-memory fallback for streams whose cursor_field is
  // not SQL-safe; WHERE clause varies with grant time_range / resources;
  // intentionally no LIMIT — JS sort/seek needs the full visible set.
  const visible = [];
  for (const row of iterateDynamicSqlAcknowledged(sql, whereBinds)) {
    const rawData = JSON.parse(row.record_json);
    if (compiledFilters.length && !passesRequestFilters(rawData, compiledFilters)) continue;
    visible.push({
      record_key: row.record_key,
      rawData,
      emitted_at: row.emitted_at,
      sortPosition: buildRecordSortPosition(rawData, row.record_key, manifestStream),
    });
  }

  visible.sort((left, right) =>
    compareLogicalPositions(left.sortPosition, right.sortPosition, manifestStream, order),
  );

  const afterCursor = cursorPosition
    ? visible.filter(
        (row) =>
          compareLogicalPositions(row.sortPosition, cursorPosition, manifestStream, order) > 0,
      )
    : visible;

  const hasMore = afterCursor.length > limit;
  const rows = hasMore ? afterCursor.slice(0, limit) : afterCursor;
  return { rows, hasMore, scanned: visible.length, underread: false };
}

function fetchVisibleRecordRowsPaginated({
  db,
  connectorId,
  stream,
  effective,
  manifestStream,
  compiledFilters = [],
  cursorPosition,
  limit,
  order,
}) {
  // Graceful per-stream fallback for manifests whose cursor_field is not
  // compatible with the SQL sort path. Registration-time validation catches
  // this for freshly-registered connectors (see auth.js), but stale DB rows
  // predating the guardrail can still slip through — this keeps assistant-
  // critical browsing working rather than 500-ing.
  const sqlSupport = classifyCursorFieldSqlSupport(manifestStream);
  if (!sqlSupport.supported) {
    logSqlFallbackOnce(connectorId, stream, sqlSupport.reason);
    return fetchVisibleRecordRowsInMemory({
      db,
      connectorId,
      stream,
      effective,
      manifestStream,
      compiledFilters,
      cursorPosition,
      limit,
      order,
    });
  }

  const consentTimeField = manifestStream?.consent_time_field;
  const cursorField = manifestStream?.cursor_field || null;
  const primaryKeyFields = normalizePrimaryKey(manifestStream?.primary_key);
  if (primaryKeyFields.length === 0) {
    throw new Error('[records] manifest primary_key is required');
  }

  // --- SELECT list ---
  const selectParts = ['record_key', 'record_json', 'emitted_at'];
  if (cursorField) {
    selectParts.push(`${jsonExtractExpr(cursorField)} AS __cursor_val`);
    // 1 when missing (null/''), 0 otherwise. Always non-NULL, safe in ORDER BY.
    selectParts.push(
      `CASE WHEN ${jsonExtractExpr(cursorField)} IS NULL OR ${jsonExtractExpr(cursorField)} = '' ` +
      `     THEN 1 ELSE 0 END AS __cursor_missing`,
    );
  }

  // --- WHERE clause ---
  const whereParts = ['connector_id = ?', 'stream = ?', 'deleted = 0'];
  const whereBinds = [connectorId, stream];

  // time_range pushdown — only when the grant narrows AND the manifest
  // declares a consent_time_field.
  if (effective.timeRange && consentTimeField) {
    assertSafeJsonField(consentTimeField, 'consent_time_field');
    const ctExpr = jsonExtractExpr(consentTimeField);
    // The JS `passesTimeRange` rejects rows whose consent_time_field is
    // missing or unparsable as a Date. SQL equivalent: require the value
    // present and between bounds. For ISO date-time strings BETWEEN on
    // the lexical form is equivalent to chronological between.
    whereParts.push(`${ctExpr} IS NOT NULL`);
    if (effective.timeRange.since != null) {
      whereParts.push(`${ctExpr} >= ?`);
      whereBinds.push(new Date(effective.timeRange.since).toISOString());
    }
    if (effective.timeRange.until != null) {
      // JS uses strict `<` for `until` (see passesTimeRange). Reproduce.
      whereParts.push(`${ctExpr} < ?`);
      whereBinds.push(new Date(effective.timeRange.until).toISOString());
    }
  }

  // resources pushdown — `record_key IN (?, ?, ...)`.
  if (effective.resources && effective.resources.length > 0) {
    const placeholders = effective.resources.map(() => '?').join(', ');
    whereParts.push(`record_key IN (${placeholders})`);
    whereBinds.push(...effective.resources);
  }

  // Cursor seek pushdown.
  let seekSql = '';
  const seekBinds = [];
  if (cursorPosition) {
    const seek = buildCursorSeekClause(manifestStream, cursorPosition, order);
    seekSql = seek.sql;
    seekBinds.push(...seek.binds);
  }

  // --- ORDER BY ---
  // Cursor_missing first (ASC/DESC mirrors the request order so the missing
  // bucket ends up at the correct end); then cursor value; then pk0.
  // primary_key is always single-column for this slice (guarded above).
  const orderByParts = [];
  if (cursorField) {
    orderByParts.push(`__cursor_missing ${order}`);
    orderByParts.push(`__cursor_val ${order}`);
  }
  orderByParts.push(`${jsonExtractExpr(primaryKeyFields[0])} ${order}`);

  const whereSqlPart = `WHERE ${whereParts.join(' AND ')} ${seekSql}`;
  const orderBySql = `ORDER BY ${orderByParts.join(', ')}`;

  // --- SQL LIMIT strategy ---
  // Post-SQL we run request-side filters in JS. When request-filters reject
  // rows, we need to keep reading from the driver until we've collected
  // `limit + 1` post-filter rows. Use iterate() with a generous batch bound —
  // if the driver's LIMIT cuts us off before filling the page, we re-issue
  // with the offset advanced. For the no-request-filter case (the overwhelming
  // majority of traffic) one batch of `limit + 1` is enough.
  const hasRequestFilters = compiledFilters && compiledFilters.length > 0;
  const sqlLimit = hasRequestFilters
    ? Math.max(limit * 4, 100)  // headroom for rejections
    : limit + 1;

  const sql = `
    SELECT ${selectParts.join(', ')}
    FROM records
    ${whereSqlPart}
    ${orderBySql}
    LIMIT ?
  `;

  // REVIEWED-DYNAMIC: WHERE clause varies with grant time_range / resources
  // / cursor seek; SQL composed in JS as today; LIMIT N+1 included.
  const collected = [];
  let scanned = 0;

  for (const row of iterateDynamicSqlAcknowledged(sql, [...whereBinds, ...seekBinds, sqlLimit])) {
    scanned += 1;
    const rawData = JSON.parse(row.record_json);
    if (compiledFilters.length && !passesRequestFilters(rawData, compiledFilters)) continue;
    collected.push({
      record_key: row.record_key,
      rawData,
      emitted_at: row.emitted_at,
      sortPosition: buildRecordSortPosition(rawData, row.record_key, manifestStream),
    });
    if (collected.length > limit) break;
  }

  const hasMore = collected.length > limit;
  const rows = hasMore ? collected.slice(0, limit) : collected;

  // If we had request filters AND we exhausted the SQL batch without filling
  // the page, we under-return (hasMore=false even though more rows may exist
  // past our sqlLimit window). Acceptable for this tranche: the dashboard
  // doesn't use request filters in its hot paths. A follow-up slice can
  // loop the SQL offset forward in that case.
  return { rows, hasMore, scanned, underread: hasRequestFilters && !hasMore && scanned >= sqlLimit };
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
}) {
  if (!expansions.length || !effectiveParentRows.length) return;

  for (const expansion of expansions) {
    const childManifestStream = manifest?.streams?.find((entry) => entry.name === expansion.relationship.stream);
    const childRequiredFields = childManifestStream?.schema?.required || [];
    const childEffective = buildEffectiveFilter(expansion.childGrant, {}, childRequiredFields);

    const parentKeys = effectiveParentRows.map((row) => row.record_key);
    const groupedChildren = fetchExpansionChildrenGroupedByForeignKey({
      db,
      connectorId,
      childStream: expansion.relationship.stream,
      childManifestStream,
      childEffective,
      foreignKeyField: expansion.relationship.foreign_key,
      parentKeys,
      cardinality: expansion.relationship.cardinality,
      limit: expansion.limit,
    });

    for (const parentRow of effectiveParentRows) {
      const relationKey = parentRow.record_key;
      const matches = groupedChildren.get(relationKey) || [];
      if (!parentRow.responseRecord.expanded) parentRow.responseRecord.expanded = {};

      if (expansion.relationship.cardinality === 'has_one') {
        const first = matches[0];
        parentRow.responseRecord.expanded[expansion.name] = first
          ? buildResponseRecord(expansion.relationship.stream, first, childEffective)
          : null;
        continue;
      }

      parentRow.responseRecord.expanded[expansion.name] = {
        object: 'list',
        has_more: matches.length > expansion.limit,
        data: matches.slice(0, expansion.limit).map((childRow) =>
          buildResponseRecord(expansion.relationship.stream, childRow, childEffective),
        ),
      };
    }
  }
}

/**
 * Slice-2 replacement for the per-child full-scan. Builds one window-function
 * SQL query that:
 *   - narrows by `foreign_key IN (?, ?, ...)` to the current parent page,
 *   - applies the child grant's access-control filters (time_range, resources)
 *     in SQL,
 *   - assigns ROW_NUMBER() per foreign-key partition ordered by the child's
 *     manifest-declared (cursor_field, primary_key) basis,
 *   - clips the per-partition rank to (has_many: limit + 1) or (has_one: 1).
 *
 * Grant filtering stays in SQL: the child's time_range/resources come from
 * `childEffective` (derived from `expansion.childGrant`) and are pushed into
 * WHERE exactly as the primary path does.
 *
 * Returns a Map<encodedForeignKey, childRow[]> where each childRow carries the
 * `{record_key, rawData, emitted_at, sortPosition}` shape the caller expects
 * for `buildResponseRecord`.
 */
/**
 * In-memory fallback for `fetchExpansionChildrenGroupedByForeignKey`. Used
 * when the child stream's cursor_field is not SQL-safe. Same per-parent cap
 * semantics, but ordering + partitioning happen in JS.
 */
function fetchExpansionChildrenGroupedByForeignKeyInMemory({
  db,
  connectorId,
  childStream,
  childManifestStream,
  childEffective,
  foreignKeyField,
  parentKeys,
  cardinality,
  limit,
}) {
  const result = new Map();
  if (!parentKeys.length) return result;

  const consentTimeField = childManifestStream?.consent_time_field;
  const primaryKeyFields = normalizePrimaryKey(childManifestStream?.primary_key);
  if (primaryKeyFields.length === 0) {
    throw new Error('[records] child stream manifest primary_key is required for expansion');
  }

  const whereParts = ['connector_id = ?', 'stream = ?', 'deleted = 0'];
  const whereBinds = [connectorId, childStream];
  if (childEffective.timeRange && consentTimeField) {
    assertSafeJsonField(consentTimeField, 'consent_time_field');
    const ctExpr = jsonExtractExpr(consentTimeField);
    whereParts.push(`${ctExpr} IS NOT NULL`);
    if (childEffective.timeRange.since != null) {
      whereParts.push(`${ctExpr} >= ?`);
      whereBinds.push(new Date(childEffective.timeRange.since).toISOString());
    }
    if (childEffective.timeRange.until != null) {
      whereParts.push(`${ctExpr} < ?`);
      whereBinds.push(new Date(childEffective.timeRange.until).toISOString());
    }
  }
  if (childEffective.resources && childEffective.resources.length > 0) {
    const placeholders = childEffective.resources.map(() => '?').join(', ');
    whereParts.push(`record_key IN (${placeholders})`);
    whereBinds.push(...childEffective.resources);
  }
  assertSafeJsonField(foreignKeyField, 'foreign_key');
  const fkExpr = jsonExtractExpr(foreignKeyField);
  const parentPlaceholders = parentKeys.map(() => '?').join(', ');
  whereParts.push(`${fkExpr} IN (${parentPlaceholders})`);

  const sql = `
    SELECT record_key, record_json, emitted_at, ${fkExpr} AS __fk
    FROM records
    WHERE ${whereParts.join(' AND ')}
  `;

  // REVIEWED-DYNAMIC: in-memory expansion fallback for child streams whose
  // cursor_field is not SQL-safe; WHERE clause varies with child grant
  // time_range / resources and parent foreign-key IN-list; intentionally no
  // LIMIT — JS sort/per-parent slice needs the full visible child set for
  // the parent page.
  const rankBound = cardinality === 'has_one' ? 1 : limit + 1;
  const buckets = new Map();
  for (const row of iterateDynamicSqlAcknowledged(sql, [...whereBinds, ...parentKeys])) {
    const rawData = JSON.parse(row.record_json);
    const relationKey = encodeKey(row.__fk);
    const childRow = {
      record_key: row.record_key,
      rawData,
      emitted_at: row.emitted_at,
      sortPosition: buildRecordSortPosition(rawData, row.record_key, childManifestStream),
    };
    if (!buckets.has(relationKey)) buckets.set(relationKey, []);
    buckets.get(relationKey).push(childRow);
  }
  for (const [relationKey, bucket] of buckets) {
    bucket.sort((l, r) =>
      compareLogicalPositions(l.sortPosition, r.sortPosition, childManifestStream, 'ASC'),
    );
    result.set(relationKey, bucket.slice(0, rankBound));
  }
  return result;
}

function fetchExpansionChildrenGroupedByForeignKey({
  db,
  connectorId,
  childStream,
  childManifestStream,
  childEffective,
  foreignKeyField,
  parentKeys,
  cardinality,
  limit,
}) {
  const result = new Map();
  if (!parentKeys.length) return result;

  assertSafeJsonField(foreignKeyField, 'foreign_key');
  // If the child stream's cursor_field isn't SQL-safe, fall back to an
  // in-memory per-foreign-key group so the expansion still hydrates. Rare in
  // practice (expansion streams are typically the narrow, well-typed ones),
  // but keeps the whole read from failing over one badly-declared child.
  const childSqlSupport = classifyCursorFieldSqlSupport(childManifestStream);
  if (!childSqlSupport.supported) {
    logSqlFallbackOnce(connectorId, childStream, `expansion: ${childSqlSupport.reason}`);
    return fetchExpansionChildrenGroupedByForeignKeyInMemory({
      db,
      connectorId,
      childStream,
      childManifestStream,
      childEffective,
      foreignKeyField,
      parentKeys,
      cardinality,
      limit,
    });
  }

  const primaryKeyFields = normalizePrimaryKey(childManifestStream?.primary_key);
  if (primaryKeyFields.length === 0) {
    throw new Error('[records] child stream manifest primary_key is required for expansion');
  }
  if (primaryKeyFields.length > 1) {
    // Same reason as cursor seek: every stream in our corpus is ["id"].
    throw new Error('[records] expansion SQL pushdown is not implemented for multi-part child primary keys');
  }

  const fkExpr = jsonExtractExpr(foreignKeyField);
  const pkExpr = jsonExtractExpr(primaryKeyFields[0]);
  const cursorField = childManifestStream?.cursor_field || null;
  const consentTimeField = childManifestStream?.consent_time_field;

  const orderByParts = [];
  if (cursorField) {
    const cursorExpr = jsonExtractExpr(cursorField);
    orderByParts.push(
      `CASE WHEN ${cursorExpr} IS NULL OR ${cursorExpr} = '' THEN 1 ELSE 0 END ASC`,
    );
    orderByParts.push(`${cursorExpr} ASC`);
  }
  orderByParts.push(`${pkExpr} ASC`);
  const orderBySql = orderByParts.join(', ');

  const whereParts = ['connector_id = ?', 'stream = ?', 'deleted = 0'];
  const whereBinds = [connectorId, childStream];

  // time_range pushdown — same shape as fetchVisibleRecordRowsPaginated.
  if (childEffective.timeRange && consentTimeField) {
    assertSafeJsonField(consentTimeField, 'consent_time_field');
    const ctExpr = jsonExtractExpr(consentTimeField);
    whereParts.push(`${ctExpr} IS NOT NULL`);
    if (childEffective.timeRange.since != null) {
      whereParts.push(`${ctExpr} >= ?`);
      whereBinds.push(new Date(childEffective.timeRange.since).toISOString());
    }
    if (childEffective.timeRange.until != null) {
      whereParts.push(`${ctExpr} < ?`);
      whereBinds.push(new Date(childEffective.timeRange.until).toISOString());
    }
  }

  // resources pushdown.
  if (childEffective.resources && childEffective.resources.length > 0) {
    const placeholders = childEffective.resources.map(() => '?').join(', ');
    whereParts.push(`record_key IN (${placeholders})`);
    whereBinds.push(...childEffective.resources);
  }

  // Parent foreign-key narrowing.
  const parentPlaceholders = parentKeys.map(() => '?').join(', ');
  whereParts.push(`${fkExpr} IN (${parentPlaceholders})`);

  // Per-partition cap.
  //   has_one: rn = 1 (take one per parent).
  //   has_many: rn <= limit + 1 (the +1 gives the caller a has_more signal).
  const rankBound = cardinality === 'has_one' ? 1 : limit + 1;

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
    WHERE __rn <= ?
  `;

  // REVIEWED-DYNAMIC: SQL-pushdown expansion; WHERE clause varies with
  // child grant time_range / resources and parent foreign-key IN-list;
  // ORDER BY varies with the child manifest's cursor_field /
  // primary_key; per-partition rank bound (__rn <= ?) caps each parent's
  // child set instead of a top-level LIMIT.
  for (const row of iterateDynamicSqlAcknowledged(sql, [...whereBinds, ...parentKeys, rankBound])) {
    const rawData = JSON.parse(row.record_json);
    const relationKey = encodeKey(row.__fk);
    const childRow = {
      record_key: row.record_key,
      rawData,
      emitted_at: row.emitted_at,
      sortPosition: buildRecordSortPosition(rawData, row.record_key, childManifestStream),
    };
    if (!result.has(relationKey)) result.set(relationKey, []);
    result.get(relationKey).push(childRow);
  }

  return result;
}

function isVisibleSnapshot(snapshot, effective, consentTimeField) {
  if (!snapshot || snapshot.deleted || !snapshot.data) return false;
  if (effective.resources && !effective.resources.includes(snapshot.record_key)) return false;
  if (effective.timeRange && consentTimeField && !passesTimeRange(snapshot.data, effective.timeRange, consentTimeField)) return false;
  return true;
}

function parseChangesSinceCursor(str) {
  if (str === 'beginning') return { version: 0 };
  const decoded = decodeCursor(str);
  if (!decoded) return null;
  if (!decoded.kind) {
    return Number.isInteger(decoded.version) ? { version: decoded.version } : null;
  }
  if (decoded.kind !== 'changes_since' || !Number.isInteger(decoded.version)) return null;
  return decoded;
}

// Self-teaching error message: when a caller passes something other than the
// two legal forms (the `beginning` bootstrap sentinel or a `next_changes_since`
// value returned by a prior changes-feed response), name both forms so the
// caller can correct the request without reading the spec. Common cold-start
// mistake: passing an ISO timestamp like `2024-01-01T00:00:00Z`.
const CHANGES_SINCE_MALFORMED_MESSAGE =
  'Malformed changes_since cursor; pass `beginning` to bootstrap or the `next_changes_since` value returned by a prior /v1/streams/{stream}/records response';

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

async function getSnapshotAtVersion(connectorId, stream, recordKey, version) {
  if (!Number.isInteger(version) || version < 0) return null;
  const row = getOne(
    referenceQueries.recordsSnapshotsGetSnapshotAtVersion,
    [connectorId, stream, recordKey, version],
  );

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
    const err = new Error(CHANGES_SINCE_MALFORMED_MESSAGE);
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
      const err = new Error(CHANGES_SINCE_MALFORMED_MESSAGE);
      err.code = 'invalid_cursor';
      throw err;
    }

    const vcRow = getOne(
      referenceQueries.recordsIngestGetVersionCounter,
      [connectorId, stream],
    );
    const currentMaxVersion = vcRow ? vcRow.max_version : 0;
    const effectiveSessionMaxVersion = changesSince ? currentMaxVersion : sessionMaxVersion;

    const minChangeRow = getOne(
      referenceQueries.recordsSnapshotsGetMinRecordChangeVersion,
      [connectorId, stream],
    );
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
      // Stream change-groups for the (after, max] window in ascending
      // version order; collect at most `batchSize` per pass so we
      // mirror the prior batched LIMIT semantics on top of the
      // wrapper's iterate primitive.
      const changeGroups = [];
      for (const row of iterate(
        referenceQueries.recordsSnapshotsListChangeGroups,
        [connectorId, stream, pageAfterVersion, effectiveSessionMaxVersion],
      )) {
        changeGroups.push(row);
        if (changeGroups.length >= batchSize) break;
      }

      if (!changeGroups.length) break;

      for (const group of changeGroups) {
        const previous = await getSnapshotAtVersion(connectorId, stream, group.record_key, sinceVersion);
        const current = await getSnapshotAtVersion(connectorId, stream, group.record_key, group.latest_version);

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
    const err = new Error(CHANGES_SINCE_MALFORMED_MESSAGE);
    err.code = 'invalid_cursor';
    throw err;
  }

  const cursorPosition = normalizePaginationCursor(paginationCursor, order);
  const { rows: pagedRows, hasMore } = fetchVisibleRecordRowsPaginated({
    db,
    connectorId,
    stream,
    effective,
    manifestStream: mStream,
    compiledFilters,
    cursorPosition,
    limit,
    order,
  });
  const effectivePageRows = pagedRows.map((row) => ({
    ...row,
    responseRecord: buildResponseRecord(stream, row, effective),
  }));

  await hydrateExpandedRelations({
    connectorId,
    db,
    effectiveParentRows: effectivePageRows,
    expansions,
    manifest,
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
 * Aggregate records for one stream under the same grant and filter semantics
 * used by record listing. This first surface deliberately scans visible rows
 * in-process instead of adding aggregate indexes; it is a semantic floor.
 */
export async function aggregateRecords(storageTarget, stream, grant, requestParams = {}, manifest = null) {
  const connectorId = resolveStorageConnectorId(storageTarget);

  const streamGrant = grant.streams.find((entry) => entry.name === stream);
  if (!streamGrant) {
    const err = new Error(`Stream '${stream}' not in grant`);
    err.code = 'grant_stream_not_allowed';
    throw err;
  }

  const manifestStream = manifest?.streams?.find((entry) => entry.name === stream);
  if (!manifestStream) {
    const err = new Error(`Stream '${stream}' not found`);
    err.code = 'not_found';
    throw err;
  }

  const aggregateRequest = normalizeAggregateRequest(requestParams, streamGrant, manifestStream);
  const compiledFilters = compileRequestFilters(requestParams.filter, streamGrant, manifestStream);
  const effective = buildEffectiveFilter(streamGrant, {});
  const consentTimeField = manifestStream?.consent_time_field || null;

  const rows = iterate(
    referenceQueries.recordsAggregateIterateStreamRecordsForAggregation,
    [connectorId, stream],
  );

  let visibleCount = 0;
  let sum = 0;
  let bestComparable = null;
  let bestValue = null;
  const groups = new Map();
  const aggregateFieldSchema = aggregateRequest.field
    ? getFieldSchema(manifestStream, aggregateRequest.field)
    : null;

  for (const row of rows) {
    const rawData = JSON.parse(row.record_json);
    if (effective.resources && !effective.resources.includes(row.record_key)) continue;
    if (effective.timeRange && consentTimeField && !passesTimeRange(rawData, effective.timeRange, consentTimeField)) continue;
    if (compiledFilters.length && !passesRequestFilters(rawData, compiledFilters)) continue;

    visibleCount += 1;

    if (aggregateRequest.groupBy) {
      const rawGroupValue = rawData[aggregateRequest.groupBy] ?? null;
      const key = JSON.stringify(rawGroupValue);
      const entry = groups.get(key) || { key: rawGroupValue, count: 0 };
      entry.count += 1;
      groups.set(key, entry);
      continue;
    }

    if (aggregateRequest.metric === 'sum') {
      const comparable = coerceComparableValue(rawData[aggregateRequest.field], aggregateFieldSchema);
      if (typeof comparable === 'number' && Number.isFinite(comparable)) {
        sum += comparable;
      }
      continue;
    }

    if (aggregateRequest.metric === 'min' || aggregateRequest.metric === 'max') {
      const comparable = coerceComparableValue(rawData[aggregateRequest.field], aggregateFieldSchema);
      if (comparable == null) continue;
      const shouldReplace = bestComparable == null
        || (aggregateRequest.metric === 'min' ? comparable < bestComparable : comparable > bestComparable);
      if (shouldReplace) {
        bestComparable = comparable;
        bestValue = rawData[aggregateRequest.field];
      }
    }
  }

  const response = {
    object: 'aggregation',
    stream,
    metric: aggregateRequest.metric,
    field: aggregateRequest.field,
    group_by: aggregateRequest.groupBy,
    filtered_record_count: visibleCount,
  };

  if (aggregateRequest.groupBy) {
    response.limit = aggregateRequest.limit;
    response.groups = [...groups.values()]
      .sort((left, right) => {
        const countCmp = right.count - left.count;
        if (countCmp !== 0) return countCmp;
        return JSON.stringify(left.key).localeCompare(JSON.stringify(right.key));
      })
      .slice(0, aggregateRequest.limit);
  } else if (aggregateRequest.metric === 'count') {
    response.value = visibleCount;
  } else if (aggregateRequest.metric === 'sum') {
    response.value = sum;
  } else {
    response.value = bestValue;
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

  const row = getOne(
    referenceQueries.recordsGetLiveRecordByKey,
    [connectorId, stream, recordId],
  );

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
  const now = nowIso();
  const current = getOne(
    referenceQueries.recordsIngestGetCurrentRecordState,
    [connectorId, stream, recordId],
  );
  if (!current || current.deleted) return 0;

  const vcRow = getOne(
    referenceQueries.recordsIngestGetVersionCounter,
    [connectorId, stream],
  );
  const nextVersion = vcRow ? vcRow.max_version + 1 : 1;

  exec(
    referenceQueries.recordsIngestMarkRecordDeleted,
    [now, nextVersion, connectorId, stream, recordId],
  );

  exec(
    referenceQueries.recordsIngestInsertRecordChangeDeleted,
    [connectorId, stream, recordId, nextVersion, current.record_json, now, now],
  );

  exec(
    referenceQueries.recordsIngestUpsertVersionCounter,
    [connectorId, stream, nextVersion],
  );

  await lexicalIndexDelete({ connectorId, stream, recordKey: recordId });
  await semanticIndexDelete({ connectorId, stream, recordKey: recordId });

  const changeHistoryLimit = getChangeHistoryLimit();
  if (changeHistoryLimit > 0) {
    exec(
      referenceQueries.recordsIngestPruneRecordChanges,
      [connectorId, stream, nextVersion - changeHistoryLimit],
    );
  }

  return 1;
}

export async function listAllStreams(storageTarget) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  // REVIEWED-BOUNDED: rows are one per (connector, stream) pair; a single
  // connector's manifest declares at most a few dozen streams, well under
  // the registry's @max_rows=256 cap on the records table read.
  const rows = allowUnboundedReadAcknowledged(
    referenceQueries.recordsAggregateStreamsByConnector,
    [connectorId],
  );

  return rows.map((row) => ({
    object: 'stream',
    name: row.stream,
    record_count: row.record_count || 0,
    last_updated: row.last_updated || null,
  }));
}

/**
 * Delete all records for a connector+stream (owner-authenticated reference reset use)
 */
export async function deleteAllRecords(storageTarget, stream) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const countRow = getOne(
    referenceQueries.recordsDeleteCountRecordsByStream,
    [connectorId, stream],
  );
  const deletedRecordCount = countRow?.count || 0;
  exec(referenceQueries.recordsDeleteDeleteRecordsByStream, [connectorId, stream]);
  exec(referenceQueries.recordsDeleteDeleteRecordChangesByStream, [connectorId, stream]);
  exec(referenceQueries.recordsDeleteDeleteVersionCounterByStream, [connectorId, stream]);
  await lexicalIndexDeleteByConnectorStream({ connectorId, stream });
  await semanticIndexDeleteByConnectorStream({ connectorId, stream });
  return deletedRecordCount;
}

/**
 * Delete every persisted record for a connector across all of its streams.
 *
 * Invoked by the polyfill manifest reconciliation loop when it flips a
 * connector's persisted manifest fingerprint. Records emitted under the
 * prior-shape manifest are not safe to advertise as fresh data under the
 * new manifest's declarations, so we drop them and let the next real
 * connector run repopulate. See
 * openspec/changes/reconcile-invalidates-stale-records/.
 *
 * Returns the number of records deleted plus the list of stream names
 * that had records, so the caller can produce an informative log line.
 */
export async function deleteAllRecordsForConnector(connectorId) {
  if (typeof connectorId !== 'string' || !connectorId) {
    return { deletedCount: 0, streams: [] };
  }
  // REVIEWED-BOUNDED: rows are one per distinct stream a connector has ever
  // produced; manifests declare at most a few dozen streams, well under
  // the registry's @max_rows=256 cap.
  const streamRows = allowUnboundedReadAcknowledged(
    referenceQueries.recordsDeleteListDistinctStreamsByConnector,
    [connectorId],
  );
  const streams = streamRows.map((row) => row.stream);
  const countRow = getOne(
    referenceQueries.recordsDeleteCountRecordsByConnector,
    [connectorId],
  );
  const deletedCount = countRow?.count || 0;

  exec(referenceQueries.recordsDeleteDeleteRecordsByConnector, [connectorId]);
  exec(referenceQueries.recordsDeleteDeleteRecordChangesByConnector, [connectorId]);
  exec(referenceQueries.recordsDeleteDeleteVersionCounterByConnector, [connectorId]);
  exec(referenceQueries.recordsDeleteDeleteBlobBindingsByConnector, [connectorId]);

  for (const stream of streams) {
    await lexicalIndexDeleteByConnectorStream({ connectorId, stream });
    await semanticIndexDeleteByConnectorStream({ connectorId, stream });
  }

  return { deletedCount, streams };
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
  const { grantId = null, allowedStreams = null } = opts;
  const allowedStreamSet = allowedStreams instanceof Set
    ? allowedStreams
    : (Array.isArray(allowedStreams) ? new Set(allowedStreams) : null);
  // REVIEWED-BOUNDED: rows are one per (connector, [grant], stream); a
  // connector's manifest declares at most a few dozen streams, so the
  // result fits comfortably under the registry's @max_rows=256 cap.
  const rows = grantId
    ? allowUnboundedReadAcknowledged(
        referenceQueries.recordsSyncStateListGrantConnectorState,
        [connectorId, grantId],
      )
    : allowUnboundedReadAcknowledged(
        referenceQueries.recordsSyncStateListConnectorState,
        [connectorId],
      );
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
  const { grantId = null, allowedStreams = null } = opts;
  const now = nowIso();
  for (const [stream, cursor] of Object.entries(stateMap)) {
    if (grantId) {
      exec(
        referenceQueries.recordsSyncStateUpsertGrantConnectorState,
        [grantId, connectorId, stream, JSON.stringify(cursor), now],
      );
      continue;
    }

    exec(
      referenceQueries.recordsSyncStateUpsertConnectorState,
      [connectorId, stream, JSON.stringify(cursor), now],
    );
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
  const recordAgg = getOne(referenceQueries.recordsDatasetGetRecordsAggregate);
  const changeAgg = getOne(referenceQueries.recordsDatasetGetRecordChangesBytes);
  const blobAgg = getOne(referenceQueries.recordsDatasetGetBlobBytes);

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
  // REVIEWED-BOUNDED: rows are one per registered connector; the corpus is
  // tens of connectors at most, well under the registry's @max_rows=256
  // cap on the connectors table.
  const connectors = allowUnboundedReadAcknowledged(
    referenceQueries.listRegisteredConnectors,
  );

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
      const result = getOne(
        referenceQueries.recordsDatasetGetStreamTimeBounds,
        [jsonPath, jsonPath, row.connector_id, streamName],
      );
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
  const result = [];
  for (const row of iterate(
    referenceQueries.recordsDatasetGetTopConnectorsByRecordCount,
  )) {
    result.push({
      object: 'dataset_connector_summary',
      connector_id: row.connector_id,
      record_count: Number(row.record_count || 0),
    });
    if (result.length >= limit) break;
  }
  return result;
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
