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
  assertGrantedManifestReadAuthority,
  assertManifestReadAuthority,
} from './manifest-read-authority.ts';
import { advancePostgresDeviceIngestPrefix } from './stores/device-exporter-store.ts';
import {
  assertRecordIdentity,
  assertSafeJsonField,
  buildEffectiveFilter,
  normalizeExpandRequest,
  normalizePrimaryKey,
} from './record-expand-helpers.js';
import { createPostgresConnectorInstanceStore } from './stores/connector-instance-store.js';
import {
  buildLimitClampedWarning,
  clampRecordsPageLimit,
  enforceConnectionNarrowing,
  projectStorageDisplayName,
  resolveRequestConnectionId,
} from './connection-id-request.js';
import { canonicalConnectorKey } from './connector-key.js';
import { withConnectorInstanceWrite } from './connector-instance-write-coordinator.ts';
import {
  getChangeHistoryLimit,
  nowIso,
  resolveStorageConnectorId,
  resolveStorageConnectorInstanceId,
} from './storage-utils.ts';
import {
  compileRequestFilters,
  nonNullSchemaTypes,
  passesRequestFilters,
  passesTimeRange,
} from './record-filters.js';
import {
  assertFieldPath,
  assertFieldVisibleToGrant,
  assertReadableStringField,
  buildWindowEnvelope,
  classifyFieldType,
  fieldWindowError,
  normalizeWindowSelector,
} from './record-field-window.js';

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
// discipline as the SQLite path AND computes `meta.window` to parity via
// computePostgresRecordWindow: a JSON-extract min/max scan over the logical
// `consent_time_field` whose timestamp normalization matches the SQLite
// reference's `new Date(...)` parse.
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

function mergeMetaWindow(existingMeta, window) {
  const base = existingMeta && typeof existingMeta === 'object' && !Array.isArray(existingMeta)
    ? { ...existingMeta }
    : {};
  base.window = window;
  return base;
}
const KEY_SEPARATOR = '\u0001';
let postgresRecordSortBackfillPhaseHook = null;

/** Test-only seam for deterministic registration/backfill ordering. */
export function __setPostgresRecordSortBackfillPhaseHookForTest(hook) {
  postgresRecordSortBackfillPhaseHook = typeof hook === 'function' ? hook : null;
}

async function maybePostgresRecordSortBackfillPhaseForTest(point, context) {
  await postgresRecordSortBackfillPhaseHook?.(point, context);
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

// Below this, a numeric timestamp is treated as Unix SECONDS; at or above it, as
// Unix MILLISECONDS. Mirrors search-record-timestamps.ts and the SQLite ingest
// path in records.js so all three coerce timestamps identically.
const SEMANTIC_TIME_EPOCH_MS_THRESHOLD = 1e12;

function coerceSemanticTimeValue(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const ms = value >= SEMANTIC_TIME_EPOCH_MS_THRESHOLD ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

// SEMANTIC time (when the thing happened) to stamp on a record at ingest, for
// the Explore merged-timeline sort. Resolves the manifest consent_time_field
// (preferred) then cursor_field from `data`, coerced epoch-aware, falling back
// to `effectiveEmittedAt` when no semantic field is declared or the value is
// missing/unparseable. Never empty. Mirrors computeIngestSemanticTime in the
// SQLite path (records.js).
function semanticTimeValue(data, manifestStream, effectiveEmittedAt) {
  if (!data || typeof data !== 'object') return effectiveEmittedAt;
  const candidates = [];
  for (const field of [manifestStream?.consent_time_field, manifestStream?.cursor_field]) {
    if (typeof field === 'string' && field && !candidates.includes(field)) {
      candidates.push(field);
    }
  }
  for (const field of candidates) {
    const coerced = coerceSemanticTimeValue(data[field]);
    if (coerced) return coerced;
  }
  return effectiveEmittedAt;
}

const manifestStreamCache = new Map();

function manifestStreamCacheKey(connectorId, stream) {
  return `${connectorId}\u0000${stream}`;
}

export function invalidatePostgresRecordManifestCache(connectorId = null) {
  if (!connectorId) {
    manifestStreamCache.clear();
    return;
  }
  const prefix = `${connectorId}\u0000`;
  for (const key of manifestStreamCache.keys()) {
    if (key.startsWith(prefix)) manifestStreamCache.delete(key);
  }
}

function normalizeManifestRow(row) {
  if (!row?.manifest) return null;
  if (typeof row.manifest === 'string') {
    try {
      return JSON.parse(row.manifest);
    } catch {
      return null;
    }
  }
  return row.manifest;
}

async function getCachedPostgresManifestStream(connectorId, stream) {
  const key = manifestStreamCacheKey(connectorId, stream);
  if (manifestStreamCache.has(key)) return manifestStreamCache.get(key);

  const result = await postgresQuery(
    `SELECT manifest
       FROM connectors
      WHERE connector_id = $1`,
    [connectorId],
  );
  const manifest = normalizeManifestRow(result.rows[0]);
  const manifestStream = getManifestStream(manifest, stream);
  manifestStreamCache.set(key, manifestStream);
  return manifestStream;
}

function manifestConnectorId(manifest) {
  const raw = manifest?.connector_key || manifest?.connector_id;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  return canonicalConnectorKey(raw) ?? raw.trim();
}

export async function postgresBackfillRecordSortPositionsForManifest(manifest) {
  const connectorId = manifestConnectorId(manifest);
  if (!connectorId || !Array.isArray(manifest?.streams)) {
    return { updated: 0 };
  }

  const streamFacts = manifest.streams
    .map((manifestStream) => ({
      stream: typeof manifestStream?.name === 'string' ? manifestStream.name : null,
      cursorField: safeJsonField(manifestStream?.cursor_field),
      consentTimeField: safeJsonField(manifestStream?.consent_time_field),
      primaryKey: primaryKeyFieldsFor(manifestStream),
    }))
    .filter(({ stream }) => stream);
  if (streamFacts.length === 0) return { updated: 0 };

  // Enumerate once, then retain one fence while repairing every manifest
  // stream for that instance. Cursor, primary key, and semantic time are all
  // manifest-derived durable facts; keep them coherent with one generation
  // without allocating a new record version or emitting a notification.
  const instances = await postgresQuery(
    `SELECT DISTINCT connector_instance_id
       FROM records
      WHERE connector_id = $1
        AND stream = ANY($2::text[])
      ORDER BY connector_instance_id`,
    [connectorId, streamFacts.map(({ stream }) => stream)],
  );
  let updated = 0;
  for (const { connector_instance_id: connectorInstanceId } of instances.rows) {
    await maybePostgresRecordSortBackfillPhaseForTest('before-instance-fence', {
      connectorId,
      connectorInstanceId,
    });
    await withConnectorInstanceWrite(connectorInstanceId, async () => {
      await maybePostgresRecordSortBackfillPhaseForTest('inside-instance-fence', {
        connectorId,
        connectorInstanceId,
      });
      for (const facts of streamFacts) {
        let afterRecordKey = null;
        // Registration can rebuild a large local history, so paginate by the
        // stable canonical key while retaining the per-instance writer fence.
        for (;;) {
          const page = await postgresQuery(
            `SELECT record_key, record_json::text AS record_json, emitted_at,
                    cursor_value, primary_key_text, semantic_time
               FROM records
              WHERE connector_id = $1
                AND connector_instance_id = $2
                AND stream = $3
                AND deleted = FALSE
                AND ($4::text IS NULL OR record_key > $4)
              ORDER BY record_key
              LIMIT 256`,
            [connectorId, connectorInstanceId, facts.stream, afterRecordKey],
          );
          if (page.rows.length === 0) break;
          for (const row of page.rows) {
            const data = typeof row.record_json === 'string' ? JSON.parse(row.record_json) : row.record_json;
            const manifestStream = {
              primary_key: facts.primaryKey,
              cursor_field: facts.cursorField,
              consent_time_field: facts.consentTimeField,
            };
            const cursor = cursorValue(data, manifestStream);
            const primary = primaryKeyText(data, row.record_key, manifestStream);
            const semanticTime = semanticTimeValue(data, manifestStream, row.emitted_at);
            const result = await postgresQuery(
              `UPDATE records
                  SET cursor_value = $5, primary_key_text = $6, semantic_time = $7
                WHERE connector_id = $1
                  AND connector_instance_id = $2
                  AND record_key = $3
                  AND stream = $4
                  AND deleted = FALSE
                  AND (cursor_value IS DISTINCT FROM $5
                    OR primary_key_text IS DISTINCT FROM $6
                    OR semantic_time IS DISTINCT FROM $7)`,
              [connectorId, connectorInstanceId, row.record_key, facts.stream, cursor, primary, semanticTime],
            );
            updated += Number(result.rowCount || 0);
          }
          afterRecordKey = page.rows[page.rows.length - 1].record_key;
          if (page.rows.length < 256) break;
        }
      }
    });
  }
  invalidatePostgresRecordManifestCache(connectorId);
  return { updated };
}

/**
 * Resolve skipped final device-ingest keys from the current authoritative Postgres
 * projection and repair the manifest-derived columns in the same transaction.
 * The caller holds the connector-instance fence (or the records module has
 * re-entered it), so a retry cannot read one payload and repair indexes from a
 * different writer's payload. This is deliberately version-free: it repairs
 * cursor/primary-key/semantic facts only and never appends history or emits a
 * client event.
 */
export async function postgresPrepareDeviceFinalRecords(storageTarget, plan, attemptContext) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  return withPostgresTransaction(async (client) => {
    const result = [];
    for (const entry of plan) {
      const input = entry.record;
      const recordKey = encodeKey(input.key);
      const currentResult = await client.query(
        `SELECT record_json, emitted_at, deleted
           FROM records
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
          FOR UPDATE`,
        [connectorInstanceId, input.stream, recordKey],
      );
      const current = currentResult.rows[0] || null;
      if (!current || current.deleted) {
        result.push({
          ...entry,
          record: { ...input, data: {}, op: 'delete' },
        });
        continue;
      }

      const data = typeof current.record_json === 'string'
        ? JSON.parse(current.record_json)
        : current.record_json;
      const facts = attemptContext?.streams?.[input.stream] ?? null;
      const manifestStream = facts
        ? {
            primary_key: facts.primaryKey,
            cursor_field: facts.cursorField,
            consent_time_field: facts.consentTimeField,
          }
        : null;
      const semanticTime = semanticTimeValue(data, manifestStream, current.emitted_at || input.emitted_at || nowIso());
      const cursor = cursorValue(data, manifestStream);
      const primary = primaryKeyText(data, recordKey, manifestStream);
      await client.query(
        `UPDATE records
            SET cursor_value = $4,
                primary_key_text = $5,
                semantic_time = $6
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
            AND deleted = FALSE`,
        [connectorInstanceId, input.stream, recordKey, cursor, primary, semanticTime],
      );
      result.push({
        ...entry,
        record: {
          ...input,
          data,
          emitted_at: current.emitted_at || input.emitted_at,
          op: 'upsert',
        },
      });
    }
    return result;
  });
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

function postgresRangeCastForField(fieldSchema) {
  const types = nonNullSchemaTypes(fieldSchema);
  if (types.size !== 1) return 'text';
  const [only] = [...types];
  if (only === 'integer' || only === 'number') return 'numeric';
  if (only === 'string' && fieldSchema?.format === 'date') return 'date';
  if (only === 'string' && fieldSchema?.format === 'date-time') return 'timestamptz';
  return 'text';
}

function buildFilterClause(compiledFilters, rawFilter, params) {
  if (!Array.isArray(compiledFilters) || compiledFilters.length === 0) return '';
  const clauses = [];
  for (const filter of compiledFilters) {
    assertSafeJsonField(filter.field, 'filter');
    const fieldExpr = jsonStringExpr(filter.field);
    if (filter.kind === 'range') {
      const rawOperators = rawFilter?.[filter.field];
      const rawOperatorMap = rawOperators && typeof rawOperators === 'object' && !Array.isArray(rawOperators)
        ? rawOperators
        : {};
      const cast = postgresRangeCastForField(filter.fieldSchema);
      const lhs = `${fieldExpr}::${cast}`;
      clauses.push(`record_json ? '${filter.field}'`);
      clauses.push(`${fieldExpr} IS NOT NULL`);
      for (const op of ['gte', 'gt', 'lte', 'lt']) {
        if (!Object.hasOwn(filter.operators, op)) continue;
        const operator = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
        const value = Object.hasOwn(rawOperatorMap, op)
          ? rawOperatorMap[op]
          : filter.operators[op];
        params.push(value);
        clauses.push(`${lhs} ${operator} $${params.length}::${cast}`);
      }
      continue;
    }
    params.push(filter.value);
    clauses.push(`${fieldExpr} = $${params.length}`);
  }
  return clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '';
}

export function __buildPostgresFilterClauseForTest(filter, streamGrant, manifestStream) {
  const compiledFilters = compileRequestFilters(filter, streamGrant, manifestStream);
  const params = [];
  return {
    clause: buildFilterClause(compiledFilters, filter, params),
    params,
  };
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
  return {
    cursorSql: cursorField ? 'cursor_value' : 'emitted_at',
    primarySql: 'primary_key_text',
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

/**
 * Atomically allocate the next stream version for a
 * `(connector_instance_id, stream)` pair, strictly above every durable
 * floor: the `version_counter` row, the max retained `record_changes`
 * version, and the max current `records` version.
 *
 * The plain `max_version + 1` counter bump is unsafe whenever the counter
 * has fallen *behind* the durable history/current state — observed live as
 * GitHub current-projection drift where `records.version` and
 * `record_changes.version` were already ahead of `version_counter.max_version`
 * (counter lagging by one). An unanchored-row self-heal then re-allocated an
 * already-used stream version, and the subsequent `record_changes` insert
 * collided on `PRIMARY KEY(connector_instance_id, stream, version)`, rejecting
 * the row inside an otherwise-"succeeded" batch.
 *
 * Construction (single statement, concurrency-safe):
 *   - `GREATEST(counter, max(record_changes.version), max(records.version))+1`
 *     is computed in one INSERT…ON CONFLICT…RETURNING. The two `MAX`
 *     subqueries are correlated to the scoped pair and `COALESCE`d to 0 so an
 *     empty history/current set degrades to the pure counter behavior.
 *   - On first allocation (no conflicting row) the floor is taken in the
 *     `VALUES` subselects; on conflict the `ON CONFLICT DO UPDATE` re-reads
 *     `version_counter.max_version` (now row-locked) and folds the same two
 *     floors back in.
 *   - Two concurrent allocators serialize on the `version_counter` row lock
 *     the upsert takes, and `version_counter.max_version` is always part of
 *     the `GREATEST`, so the second allocator observes the first's committed
 *     increment and cannot return the same version. The history/current
 *     floors only ever raise the result; they never let it repeat.
 *
 * Mirrors the SQLite reference allocator's intent (single durable
 * statement, no read-then-write window); the floor folding is Postgres-only
 * because the live drift was Postgres-only.
 */
async function allocateNextVersion(client, connectorId, connectorInstanceId, stream) {
  const result = await client.query(
    `INSERT INTO version_counter (connector_id, connector_instance_id, stream, max_version)
     VALUES (
       $1, $2, $3,
       GREATEST(
         1,
         COALESCE((SELECT MAX(version) FROM record_changes
                    WHERE connector_instance_id = $2 AND stream = $3), 0) + 1,
         COALESCE((SELECT MAX(version) FROM records
                    WHERE connector_instance_id = $2 AND stream = $3), 0) + 1
       )
     )
     ON CONFLICT (connector_instance_id, stream) DO UPDATE
       SET max_version = GREATEST(
             version_counter.max_version,
             COALESCE((SELECT MAX(version) FROM record_changes
                        WHERE connector_instance_id = version_counter.connector_instance_id
                          AND stream = version_counter.stream), 0),
             COALESCE((SELECT MAX(version) FROM records
                        WHERE connector_instance_id = version_counter.connector_instance_id
                          AND stream = version_counter.stream), 0)
           ) + 1
     RETURNING max_version`,
    [connectorId, connectorInstanceId, stream],
  );
  return Number(result.rows[0].max_version);
}

export async function postgresIngestRecord(storageTarget, record, options = {}) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const { stream, key, data, emitted_at: emittedAt, op = 'upsert' } = record;
  const recordKey = encodeKey(key);
  const recordJson = data ? JSON.stringify(data) : null;

  // Validate record identity against the manifest-declared primary_key (covers
  // non-`id` and compound keys), via the same shared guard the SQLite store
  // uses. Falls back to the legacy data.id check when no primary_key is known.
  const attemptStreamFacts = options.attemptContext?.streams?.[stream] ?? null;
  const attemptManifestStream = attemptStreamFacts
    ? {
        primary_key: attemptStreamFacts.primaryKey,
        cursor_field: attemptStreamFacts.cursorField,
        consent_time_field: attemptStreamFacts.consentTimeField,
      }
    : null;
  const identityManifestStream = attemptManifestStream ?? await getCachedPostgresManifestStream(connectorId, stream);
  assertRecordIdentity(normalizePrimaryKey(identityManifestStream?.primary_key), key, data);

  const effectiveEmittedAt = emittedAt || nowIso();
  const changeHistoryLimit = getChangeHistoryLimit();
  const manifestStream = op === 'delete'
    ? null
    : attemptManifestStream ?? await getCachedPostgresManifestStream(connectorId, stream);
  const storedCursorValue = op === 'delete' ? null : cursorValue(data, manifestStream);
  const storedPrimaryKeyText = op === 'delete'
    ? recordKey
    : primaryKeyText(data, recordKey, manifestStream);
  // SEMANTIC time for the Explore merged-timeline sort (upserts only; a delete
  // keeps the row's existing semantic_time). Falls back to emitted_at.
  const storedSemanticTime = op === 'delete'
    ? null
    : semanticTimeValue(data, manifestStream, effectiveEmittedAt);

  const outcome = await withPostgresTransaction(async (client) => {
    const finishDurableOutcome = async (value) => {
      if (options.deviceReservation) {
        await advancePostgresDeviceIngestPrefix(
          client,
          options.deviceReservation,
          options.deviceReservation.inputIndex,
        );
      }
      return value;
    };
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
              version,
              COALESCE(octet_length(record_json::text), 0)::bigint AS record_json_bytes,
              ($4::jsonb IS NOT DISTINCT FROM record_json) AS is_identical
       FROM records
       WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
       FOR UPDATE`,
      [connectorInstanceId, stream, recordKey, recordJson],
    );
    const current = currentResult.rows[0] || null;

    if (op === 'delete' && (!current || current.deleted)) {
      return finishDurableOutcome({ kind: 'noop' });
    }

    // Self-heal of an unanchored current row. An unchanged reingest is
    // normally suppressed (this is what prevented the Slack `workspace`
    // 31k-version churn). But history pruning by stream-global version cutoff
    // can remove the only retained `record_changes` anchor for a still-current,
    // unchanged record (a cold key stranded below the horizon while a hot key
    // churns the stream forward) — the unresolved_pruned class the offline
    // repair tool refuses to reconstruct. The source just re-sent a
    // byte-identical payload, proving the current projection correct, so we
    // re-anchor it at a NEW stream version rather than the stale existing one
    // (which would re-prune on the next changed write). Mirrors the SQLite
    // path in records.js.
    let selfHeal = false;
    if (op !== 'delete' && current && !current.deleted && current.is_identical) {
      const anchorResult = await client.query(
        `SELECT 1 FROM record_changes
          WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3 AND version = $4
          LIMIT 1`,
        [connectorInstanceId, stream, recordKey, current.version],
      );
      if (anchorResult.rows.length > 0) {
        // A processing retry can refresh its frozen manifest facts before a
        // remaining suffix record proves byte-identical. Repair the durable
        // cursor/primary/semantic facts in this same transaction so the no-op
        // and reservation-prefix advance cannot accept stale derived state.
        if (options.attemptContext) {
          await client.query(
            `UPDATE records
                SET cursor_value = $4,
                    primary_key_text = $5,
                    semantic_time = $6
              WHERE connector_instance_id = $1 AND stream = $2 AND record_key = $3
                AND deleted = FALSE`,
            [
              connectorInstanceId,
              stream,
              recordKey,
              storedCursorValue,
              storedPrimaryKeyText,
              storedSemanticTime,
            ],
          );
        }
        return finishDurableOutcome({ kind: 'noop' });
      }
      // Anchor missing → fall through to the changed-write path to re-anchor.
      selfHeal = true;
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
           (connector_id, connector_instance_id, stream, record_key, record_json, emitted_at, version, deleted, deleted_at, cursor_value, primary_key_text, semantic_time)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, FALSE, NULL, $8, $9, $10)
         ON CONFLICT (connector_instance_id, stream, record_key) DO UPDATE
           SET connector_id = EXCLUDED.connector_id,
               record_json = EXCLUDED.record_json,
               emitted_at = EXCLUDED.emitted_at,
               version = EXCLUDED.version,
               deleted = FALSE,
               deleted_at = NULL,
               cursor_value = EXCLUDED.cursor_value,
               primary_key_text = EXCLUDED.primary_key_text,
               semantic_time = EXCLUDED.semantic_time
         RETURNING COALESCE(octet_length(record_json::text), 0)::bigint AS record_json_bytes`,
        [
          connectorId,
          connectorInstanceId,
          stream,
          recordKey,
          recordJson,
          effectiveEmittedAt,
          nextVersion,
          storedCursorValue,
          storedPrimaryKeyText,
          storedSemanticTime,
        ],
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
      // Anchor preservation: never count, sum, or delete the `record_changes`
      // row that projects a still-current `records` row for the same key. A
      // pure stream-version cutoff strands the unchanged current row of a cold
      // key once OTHER keys advance the per-stream version past its retention
      // horizon — the live Chase / USAA / reddit / github drift. The SELECT and
      // the DELETE carry the IDENTICAL `NOT EXISTS` clause so the retained-size
      // delta accounting matches the rows actually removed. Mirrors the SQLite
      // `PRUNE_ANCHOR_PRESERVE_CLAUSE` in records.js.
      const pruned = await client.query(
        `SELECT COUNT(*)::bigint AS count,
                COALESCE(SUM(octet_length(COALESCE(record_json::text, ''))), 0)::bigint AS bytes
           FROM record_changes rc
          WHERE rc.connector_instance_id = $1 AND rc.stream = $2 AND rc.version <= $3
            AND NOT EXISTS (
              SELECT 1 FROM records r
               WHERE r.connector_instance_id = rc.connector_instance_id
                 AND r.stream = rc.stream
                 AND r.record_key = rc.record_key
                 AND r.version = rc.version
            )`,
        [connectorInstanceId, stream, nextVersion - changeHistoryLimit],
      );
      prunedRowsForDelta = Number(pruned.rows[0]?.count || 0);
      prunedBytesForDelta = Number(pruned.rows[0]?.bytes || 0);
      await client.query(
        `DELETE FROM record_changes rc
         WHERE rc.connector_instance_id = $1 AND rc.stream = $2 AND rc.version <= $3
           AND NOT EXISTS (
             SELECT 1 FROM records r
              WHERE r.connector_instance_id = rc.connector_instance_id
                AND r.stream = rc.stream
                AND r.record_key = rc.record_key
                AND r.version = rc.version
           )`,
        [connectorInstanceId, stream, nextVersion - changeHistoryLimit],
      );
    }

    return finishDurableOutcome({
      kind: 'changed',
      op,
      version: nextVersion,
      selfHeal,
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
    });
  });

  if (outcome.kind === 'noop') {
    return { accepted: true, changed: false };
  }
  // Preserve the version allocated by the authoritative transaction until the
  // composition seam has emitted its after-commit notification.  HTTP callers
  // do not serialize this adapter result, but dropping the field here made
  // every PostgreSQL notification publish version 0 while SQLite published the
  // real stream version.
  const result = {
    accepted: true,
    changed: true,
    version: outcome.version,
    retainedSizeDelta: outcome.retainedSizeDelta,
  };
  if (outcome.selfHeal) result.self_healed = true;
  return result;
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
  assertManifestReadAuthority(manifest, stream, { actor: 'internal' });
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
  // A valid `window=exact` produces `meta.window` to parity with SQLite via
  // computePostgresRecordWindow below.
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
  where += buildFilterClause(compiledFilters, requestParams.filter, params);
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
    connectorInstanceId,
    stream,
    effective,
  });
  if (countOutcome) {
    response.meta = mergeMetaCount(response.meta, countOutcome.count);
  }
  const windowOutcome = await computePostgresRecordWindow({
    requestParams,
    countWhere,
    countParams,
    consentTimeField: manifestStream?.consent_time_field || null,
  });
  if (windowOutcome) {
    response.meta = mergeMetaWindow(response.meta, windowOutcome);
  }
  attachRequestWarningsToResponse(response, requestWarnings);
  return response;
}

// Compute the bounded `meta.window` aggregate for the Postgres list path,
// mirroring computeRecordWindow in records.js: `total` is the count of
// grant-visible rows under the same WHERE clause as the graded count, and
// `earliest_at`/`latest_at` are the min/max of the manifest's
// consent_time_field over those rows. Returns null when window is not
// requested. Closes the parity gap where the Postgres path omitted meta.window.
async function computePostgresRecordWindow({ requestParams, countWhere, countParams, consentTimeField }) {
  const requested = typeof requestParams.window === 'string' ? requestParams.window : null;
  if (!requested || requested === 'none') return null;

  // total uses the identical grant-visible scope the count query uses.
  const totalResult = await postgresQuery(
    `SELECT COUNT(*)::bigint AS total FROM records ${countWhere}`,
    countParams,
  );
  const total = Number(totalResult.rows[0]?.total || 0);
  const window = { total };

  if (consentTimeField) {
    assertSafeJsonField(consentTimeField, 'consent_time_field');
    const ctExpr = jsonStringExpr(consentTimeField);
    // MIN/MAX must compare CHRONOLOGICALLY, not lexicographically. Plain text
    // MIN/MAX picks the wrong bound for non-UTC offsets (e.g. a "...T00:00-07:00"
    // string sorts before "...T06:00+00:00" textually but is later in time), and
    // a lexically-small non-date string (e.g. "-bad-date") would win MIN and
    // then fail to parse, silently dropping bounds. Cast to timestamptz so
    // Postgres orders by instant, and use pg_input_is_valid so unparseable rows
    // are skipped instead of aborting the query, mirroring the SQLite path's
    // per-row `Number.isNaN(...) ? continue` behavior. timestamptz results come
    // back UTC-normalized, so downstream new Date(...).toISOString() is correct.
    const validTimestamp = `pg_input_is_valid(${ctExpr}, 'timestamp with time zone')`;
    const boundsResult = await postgresQuery(
      `SELECT MIN((${ctExpr})::timestamptz) AS earliest, MAX((${ctExpr})::timestamptz) AS latest
         FROM records ${countWhere}
        AND ${ctExpr} IS NOT NULL AND ${ctExpr} <> '' AND ${validTimestamp}`,
      countParams,
    );
    const earliest = boundsResult.rows[0]?.earliest;
    const latest = boundsResult.rows[0]?.latest;
    if (earliest != null && latest != null) {
      // Normalize to ISO 8601 UTC, matching the SQLite path's new Date(...) form.
      const earliestMs = new Date(earliest).getTime();
      const latestMs = new Date(latest).getTime();
      if (!Number.isNaN(earliestMs) && !Number.isNaN(latestMs)) {
        window.earliest_at = new Date(earliestMs).toISOString();
        window.latest_at = new Date(latestMs).toISOString();
      }
    }
  }
  return window;
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
function hasRequestFilters(requestParams) {
  const filter = requestParams?.filter;
  return !!filter && typeof filter === 'object' && !Array.isArray(filter) && Object.keys(filter).length > 0;
}

async function readProjectedRecordCount({ connectorInstanceId, stream, requestParams, effective }) {
  if (hasRequestFilters(requestParams)) return null;
  if (effective?.timeRange) return null;
  if (Array.isArray(effective?.resources) && effective.resources.length > 0) return null;

  const result = await postgresQuery(
    `SELECT record_count
       FROM retained_size_stream
      WHERE connector_instance_id = $1
        AND stream = $2
        AND dirty = 0`,
    [connectorInstanceId, stream],
  );
  const value = Number(result.rows[0]?.record_count);
  return Number.isFinite(value) ? value : null;
}

async function computePostgresGradedRecordCount({
  requestParams,
  countWhere,
  countParams,
  connectorInstanceId,
  stream,
  effective,
}) {
  const requested = typeof requestParams.count === 'string' ? requestParams.count : null;
  if (!requested || requested === 'none') return null;

  const projectedValue = await readProjectedRecordCount({
    connectorInstanceId,
    stream,
    requestParams,
    effective,
  });
  if (projectedValue != null) {
    return { count: { kind: 'exact', value: projectedValue } };
  }

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
  assertManifestReadAuthority(manifest, stream, { actor: 'internal' });
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

export async function postgresGetRecordFieldWindow(
  storageTarget,
  stream,
  recordId,
  fieldPath,
  grant,
  manifest = null,
  requestParams = {},
) {
  try {
    assertManifestReadAuthority(manifest, stream, { actor: 'internal' });
  } catch (error) {
    if (error?.code === 'stream_not_declared') {
      throw fieldWindowError(error.code, error.message, error.statusCode);
    }
    throw error;
  }
  assertFieldPath(fieldPath);
  const selector = normalizeWindowSelector(requestParams);

  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const streamGrant = getStreamGrant(grant, stream);
  const manifestStream = getManifestStream(manifest, stream);
  const effective = buildEffectiveFilter(streamGrant, requiredFieldsFor(manifestStream));

  assertFieldVisibleToGrant(fieldPath, effective.fields);

  const { warnings: requestWarnings } = resolveRequestConnectionId(requestParams);
  enforceConnectionNarrowing(requestParams, connectorInstanceId);

  const consentTimeField = manifestStream?.consent_time_field || null;
  const query = selector.mode === 'query' ? selector.query : null;
  const result = await postgresQuery(
    `WITH selected AS (
       SELECT
         record_key,
         jsonb_typeof(record_json -> $4::text) AS field_type,
         record_json ->> $4::text AS field_text,
         CASE WHEN $6::text IS NULL THEN NULL ELSE record_json ->> $6::text END AS consent_time_value
       FROM records
       WHERE connector_instance_id = $1
         AND stream = $2
         AND record_key = $3
         AND deleted = FALSE
       LIMIT 1
     ), positioned AS (
       SELECT
         record_key,
         field_type,
         field_text,
         CASE WHEN field_type = 'string' THEN char_length(field_text) ELSE NULL END AS total_chars,
         CASE WHEN $5::text IS NOT NULL AND field_type = 'string'
           THEN strpos(lower(field_text), lower($5::text))
           ELSE NULL
         END AS match_pos,
         consent_time_value
       FROM selected
     )
     SELECT
       record_key,
       field_type,
       total_chars,
       CASE WHEN field_type = 'string' AND ($5::text IS NULL OR match_pos > 0)
         THEN substring(
           field_text
           FROM CASE
             WHEN $5::text IS NOT NULL THEN greatest(1, match_pos - $7::integer)
             ELSE $8::integer
           END
           FOR $9::integer
         )
         ELSE NULL
       END AS window_text,
       match_pos,
       consent_time_value
     FROM positioned`,
    [
      connectorInstanceId,
      stream,
      recordId,
      fieldPath,
      query,
      consentTimeField,
      selector.mode === 'query' ? selector.before : 0,
      selector.mode === 'query' ? 1 : selector.offset + 1,
      selector.limit,
    ],
  );

  const row = result.rows[0];
  if (!row) {
    throw fieldWindowError('not_found', 'Record not found', 404);
  }

  if (effective.resources && !effective.resources.includes(row.record_key)) {
    throw fieldWindowError('not_found', 'Record not found', 404);
  }
  if (effective.timeRange && consentTimeField) {
    const consentData = { [consentTimeField]: row.consent_time_value };
    if (!passesTimeRange(consentData, effective.timeRange, consentTimeField)) {
      throw fieldWindowError('not_found', 'Record not found', 404);
    }
  }

  const fieldClass = classifyFieldType(row.field_type);
  assertReadableStringField(fieldPath, fieldClass);
  const matchStart = selector.mode === 'query' ? Number(row.match_pos) - 1 : null;
  if (selector.mode === 'query' && (!Number.isFinite(matchStart) || matchStart < 0)) {
    throw fieldWindowError('query_not_found', `q was not found in field '${fieldPath}'`, 404);
  }
  const windowOffset = selector.mode === 'query'
    ? Math.max(0, matchStart - selector.before)
    : selector.offset;

  const window = buildWindowEnvelope({
    text: row.window_text ?? '',
    totalChars: Number(row.total_chars ?? 0),
    offset: windowOffset,
    limit: selector.limit,
    matchStartChars: selector.mode === 'query' ? matchStart : null,
    matchEndChars: selector.mode === 'query' ? matchStart + selector.query.length : null,
  });

  const warnings = [...requestWarnings];
  if (selector.limitClamped) {
    warnings.push({ code: 'limit_clamped', message: `limit_chars clamped to ${selector.limit}` });
  }

  return {
    record_key: row.record_key,
    field_path: fieldPath,
    field_type: fieldClass,
    window,
    warnings,
  };
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
  assertGrantedManifestReadAuthority(manifest, grant, null);
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
    await advancePostgresRecordResetGenerationForStreams(client, connectorInstanceId, [stream]);
    await deletePostgresRecordTailForPair(client, connectorInstanceId, stream);
    return deletedRecordCount;
  });
}

/**
 * Advance `connector_instances.record_reset_generation` by the count of
 * distinct candidate streams that, BEFORE this reset's deletes run in the
 * same transaction, have either a `version_counter` row or a live
 * (non-deleted) canonical record. This is the union rule from
 * design.md's "Exact reset-safe record checkpoint": a stream whose counter
 * was already lost still counts if it has live records, so a subsequent
 * reset+reinsertion can never reproduce the earlier composite checkpoint.
 * A no-op reset (neither input present for any candidate) advances nothing.
 * Spec: openspec/changes/reconcile-active-summary-evidence/design.md
 */
async function advancePostgresRecordResetGenerationForStreams(client, connectorInstanceId, streams) {
  if (streams.length === 0) {
    return;
  }
  const countersResult = await client.query(
    'SELECT DISTINCT stream FROM version_counter WHERE connector_instance_id = $1 AND stream = ANY($2::text[])',
    [connectorInstanceId, streams],
  );
  const withCounter = new Set(countersResult.rows.map((row) => row.stream));
  const remaining = streams.filter((stream) => !withCounter.has(stream));
  let withLiveRecord = new Set();
  if (remaining.length > 0) {
    const liveResult = await client.query(
      `SELECT DISTINCT stream FROM records
        WHERE connector_instance_id = $1 AND stream = ANY($2::text[]) AND deleted = FALSE`,
      [connectorInstanceId, remaining],
    );
    withLiveRecord = new Set(liveResult.rows.map((row) => row.stream));
  }
  const touchedCount = withCounter.size + withLiveRecord.size;
  if (touchedCount === 0) {
    return;
  }
  await client.query(
    'UPDATE connector_instances SET record_reset_generation = record_reset_generation + $1 WHERE connector_instance_id = $2',
    [touchedCount, connectorInstanceId],
  );
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

export async function postgresPersistContentAddressedBlob({
  connectorId,
  connectorInstanceId,
  stream,
  recordKey,
  mimeType,
  data,
  coordinatorOwnership = null,
}) {
  const effectiveConnectorInstanceId = connectorInstanceId || resolveStorageConnectorInstanceId(null, connectorId);
  return withConnectorInstanceWrite(
    effectiveConnectorInstanceId,
    () => postgresPersistContentAddressedBlobWithinFence({
      connectorId,
      connectorInstanceId: effectiveConnectorInstanceId,
      stream,
      recordKey,
      mimeType,
      data,
    }),
    coordinatorOwnership,
  );
}

async function postgresPersistContentAddressedBlobWithinFence({ connectorId, connectorInstanceId, stream, recordKey, mimeType, data }) {
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
    // extractions. See docs/reference/binary-content-invariant-design-brief.md §4.6.
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
