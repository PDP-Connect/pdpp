/**
 * PDPP Resource Server — record storage and grant-enforced query
 */
import { getDb } from './db.js';

// Optional post-commit hook for outbound client event subscriptions. The
// hook is invoked after a `record_changes` row has been durably committed
// for an `ingestRecord` call. It is intentionally untyped here so the
// records module stays decoupled from the subscriptions store; the host
// adapter installs the real implementation in `startServer`.
let __clientEventEnqueueHook = null;
export function setClientEventEnqueueHook(fn) {
  __clientEventEnqueueHook = typeof fn === 'function' ? fn : null;
}
function __invokeClientEventEnqueueHook(change) {
  if (!__clientEventEnqueueHook) return;
  try {
    const result = __clientEventEnqueueHook(change);
    if (result && typeof result.catch === 'function') {
      result.catch(() => { /* surfaced via attempt log */ });
    }
  } catch {
    /* hook errors must not retroactively roll back ingest */
  }
}

import {
  allowUnboundedReadAcknowledged,
  exec,
  execReturningOne,
  getMany,
  getOne,
  iterate,
  iterateDynamicSqlAcknowledged,
  referenceQueries,
  writeTransaction,
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
import {
  postgresDeleteAllRecords,
  postgresDeleteRecord,
  postgresGetDatasetBlobBytes,
  postgresGetDatasetRecordChangesBytes,
  postgresGetDatasetRecordsAggregate,
  postgresGetDatasetRecordTimeBounds,
  postgresGetRecord,
  postgresIngestRecord,
  postgresListAllStreams,
  postgresListDatasetTopConnectorCandidates,
  postgresListStreams,
  postgresQueryRecords,
} from './postgres-records.js';
import { isPostgresStorageBackend, postgresQuery } from './postgres-storage.js';
import { canonicalConnectorKey } from './connector-key.js';
import { getDefaultConnectorStateStore } from './stores/connector-state-store.ts';
import { makeDefaultAccountConnectorInstanceId } from './stores/connector-instance-store.js';
import { OWNER_AUTH_DEFAULT_SUBJECT_ID } from './owner-auth.ts';
import {
  applyDatasetSummaryRecordDelta,
  markDatasetSummaryProjectionStale,
} from './dataset-summary-read-model.js';
import {
  applyRetainedSizeRecordDelta,
  markRetainedSizeConnectionDirty,
  markRetainedSizeStreamDirty,
} from './retained-size-read-model.js';
import {
  buildLimitClampedWarning,
  CANONICAL_WARNING_CODES,
  clampRecordsPageLimit,
  CONNECTION_ALIAS_DEPRECATED_WARNING_CODE,
  enforceConnectionNarrowing,
  projectStorageDisplayName,
  resolveRequestConnectionId,
  validateConnectionAlias as validateConnectionAliasShared,
} from './connection-id-request.js';
import {
  createPostgresConnectorInstanceStore,
  createSqliteConnectorInstanceStore,
} from './stores/connector-instance-store.js';
import {
  AmbiguousConnectionError,
  lookupConnectionDisplayName,
  projectBindingForWire,
  resolveRecordIdentityForBinding,
  resolveRequestBindings,
} from './connection-identity.js';
import {
  SAFE_JSON_FIELD,
  assertSafeJsonField,
  buildEffectiveFilter,
  invalidQueryError,
  normalizeExpandRequest,
  normalizePrimaryKey,
  parseIntegerValue,
} from './record-expand-helpers.js';

export { resolveRecordIdentityForBinding };

function nowIso() {
  return new Date().toISOString();
}

function resolveStorageConnectorId(storageTarget) {
  const normalize = (value) => {
    const trimmed = typeof value === 'string' ? value.trim() : null;
    if (!trimmed) return null;
    return canonicalConnectorKey(trimmed) ?? trimmed;
  };
  if (typeof storageTarget === 'string' && storageTarget.trim()) {
    return normalize(storageTarget);
  }
  if (storageTarget && typeof storageTarget === 'object' && typeof storageTarget.connector_id === 'string' && storageTarget.connector_id.trim()) {
    return normalize(storageTarget.connector_id);
  }
  return null;
}

function resolveStorageConnectorInstanceId(storageTarget, connectorId) {
  if (
    storageTarget
    && typeof storageTarget === 'object'
    && typeof storageTarget.connector_instance_id === 'string'
    && storageTarget.connector_instance_id.trim()
  ) {
    return storageTarget.connector_instance_id.trim();
  }
  if (typeof connectorId !== 'string' || !connectorId.trim()) {
    const err = new Error('connector_id is required for connector sync state.');
    err.code = 'invalid_connector_id';
    throw err;
  }
  return makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId);
}

function getChangeHistoryLimit() {
  return Math.max(parseInt(process.env.PDPP_CHANGE_HISTORY_LIMIT || '0', 10) || 0, 0);
}

function byteLength(value) {
  return value == null ? 0 : Buffer.byteLength(String(value));
}

function getPrunedRecordChangeJsonBytes(connectorInstanceId, stream, versionBefore) {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS bytes
         FROM record_changes
        WHERE connector_instance_id = ?
          AND stream = ?
          AND version <= ?`,
    )
    .get(connectorInstanceId, stream, versionBefore);
  return Number(row?.bytes || 0);
}

function getPrunedRecordChangeCount(connectorInstanceId, stream, versionBefore) {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS count
         FROM record_changes
        WHERE connector_instance_id = ?
          AND stream = ?
          AND version <= ?`,
    )
    .get(connectorInstanceId, stream, versionBefore);
  return Number(row?.count || 0);
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

// Test-only fault injection. Production callers never set these. Tests can
// install a hook via `__setIngestFaultHookForTest` /
// `__setDeleteFaultHookForTest` to throw between durable mutation steps and
// prove the surrounding transaction rolls the whole unit back. The hooks
// are invoked at well-named points inside the durable mutation transaction;
// if unset, they are no-ops. Ingest and direct-delete have separate hooks so
// each test pins the path it actually exercises.
let ingestFaultHook = null;
let deleteFaultHook = null;

export function __setIngestFaultHookForTest(hook) {
  ingestFaultHook = typeof hook === 'function' ? hook : null;
}

export function __setDeleteFaultHookForTest(hook) {
  deleteFaultHook = typeof hook === 'function' ? hook : null;
}

function maybeFault(point, ctx) {
  if (ingestFaultHook) ingestFaultHook(point, ctx);
}

function maybeDeleteFault(point, ctx) {
  if (deleteFaultHook) deleteFaultHook(point, ctx);
}

/**
 * Ingest a RECORD envelope (owner-authenticated).
 *
 * Atomicity: durable record mutation — current-state read, no-op decision,
 * atomic version allocation (`recordsIngestAllocateNextVersion` upserts
 * `version_counter` and returns the freshly-allocated `max_version` in one
 * statement), live `records` mutation, `record_changes` append, and history
 * pruning — runs inside one explicit SQLite `BEGIN IMMEDIATE` write
 * transaction (`writeTransaction`). The write lock is acquired at
 * transaction start so concurrent same-stream ingests serialize on the
 * read, not on the first write. The atomic allocator collapses the prior
 * read-then-write pattern so per-`(connector_id, stream)` versions are
 * unique under any writer model — including future PostgreSQL-compatible
 * adapters that do not rely on SQLite's serial writer guarantee. Lexical
 * and semantic index maintenance run after the durable commit and are
 * deliberately *not* part of the atomic unit; an index-maintenance failure
 * must not roll back the durable record write.
 *
 * Spec: openspec/changes/harden-record-version-allocation-atomicity/specs/
 *       reference-implementation-architecture/spec.md
 */
export async function ingestRecord(storageTarget, record) {
  if (isPostgresStorageBackend()) {
    const outcome = await postgresIngestRecord(storageTarget, record);
    if (outcome.changed) {
      const connectorId = resolveStorageConnectorId(storageTarget);
      const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
      const { stream, key, data, op = 'upsert' } = record;
      const recordKey = encodeKey(key);
      if (outcome.retainedSizeDelta) {
        await applyRetainedSizeRecordDelta(outcome.retainedSizeDelta);
      } else {
        await markRetainedSizeStreamDirty({ connectorInstanceId, stream });
      }
      if (op === 'delete') {
        await lexicalIndexDelete({ connectorId, connectorInstanceId, stream, recordKey });
        await semanticIndexDelete({ connectorId, connectorInstanceId, stream, recordKey });
      } else {
        await lexicalIndexUpsert({ connectorId, connectorInstanceId, stream, recordKey, data });
        await semanticIndexUpsert({ connectorId, connectorInstanceId, stream, recordKey, data });
      }
    }
    return outcome;
  }

  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
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

  const effectiveEmittedAt = emitted_at || nowIso();
  const changeHistoryLimit = getChangeHistoryLimit();

  // Durable mutation unit: returns the operation outcome so derived index
  // maintenance can run *after* the commit succeeds.
  const outcome = writeTransaction(() => {
    const current = getOne(
      referenceQueries.recordsIngestGetCurrentRecordState,
      [connectorInstanceId, stream, recordKey],
    );

    if (op === 'delete' && (!current || current.deleted)) {
      return { kind: 'noop' };
    }

    if (op !== 'delete' && current && !current.deleted && current.record_json === recordJson) {
      return { kind: 'noop' };
    }

    const allocated = execReturningOne(
      referenceQueries.recordsIngestAllocateNextVersion,
      [connectorId, connectorInstanceId, stream],
    );
    const nextVersion = allocated.max_version;

    maybeFault('after-version-allocation', { connectorId, connectorInstanceId, stream, recordKey, nextVersion });

    if (op === 'delete') {
      exec(
        referenceQueries.recordsIngestMarkRecordDeleted,
        [effectiveEmittedAt, nextVersion, connectorInstanceId, stream, recordKey],
      );
      maybeFault('after-records-mutation', { connectorId, connectorInstanceId, stream, recordKey, nextVersion, op });
      exec(
        referenceQueries.recordsIngestInsertRecordChangeDeleted,
        [connectorId, connectorInstanceId, stream, recordKey, nextVersion, current.record_json, effectiveEmittedAt, effectiveEmittedAt],
      );
    } else {
      exec(
        referenceQueries.recordsIngestUpsertRecord,
        [connectorId, connectorInstanceId, stream, recordKey, recordJson, effectiveEmittedAt, nextVersion],
      );
      maybeFault('after-records-mutation', { connectorId, connectorInstanceId, stream, recordKey, nextVersion, op });
      exec(
        referenceQueries.recordsIngestInsertRecordChangeUpsert,
        [connectorId, connectorInstanceId, stream, recordKey, nextVersion, recordJson, effectiveEmittedAt],
      );
    }

    maybeFault('after-record-changes-append', { connectorId, connectorInstanceId, stream, recordKey, nextVersion, op });

    const sharedRecordCountDelta = op === 'delete' ? -1 : current?.deleted ? 1 : current ? 0 : 1;
    const sharedRecordJsonBytesDelta = op === 'delete'
      ? -byteLength(current.record_json)
      : byteLength(recordJson) - (current && !current.deleted ? byteLength(current.record_json) : 0);
    const insertedChangeJsonBytes = byteLength(op === 'delete' ? current.record_json : recordJson);
    let prunedBytesForDelta = 0;
    let prunedRowsForDelta = 0;
    if (changeHistoryLimit > 0) {
      prunedBytesForDelta = getPrunedRecordChangeJsonBytes(connectorInstanceId, stream, nextVersion - changeHistoryLimit);
      prunedRowsForDelta = getPrunedRecordChangeCount(connectorInstanceId, stream, nextVersion - changeHistoryLimit);
      exec(
        referenceQueries.recordsIngestPruneRecordChanges,
        [connectorInstanceId, stream, nextVersion - changeHistoryLimit],
      );
    }
    applyDatasetSummaryRecordDelta({
      connectorId,
      stream,
      emittedAt: effectiveEmittedAt,
      consentTimeField: getManifestConsentTimeField(connectorId, stream),
      recordCountDelta: sharedRecordCountDelta,
      recordJsonBytesDelta: sharedRecordJsonBytesDelta,
      recordChangesJsonBytesDelta: insertedChangeJsonBytes - prunedBytesForDelta,
      dirtyRecordTimeBounds: true,
    });
    // Retained-size projection delta mirrors the dataset-summary delta but
    // is grain-aware (connector_instance_id, connector_id, stream). The
    // dataset-summary projection is global only; the retained-size
    // projection serves the bounded `_ref` reads at every supported grain.
    // Maintenance failures cannot retroactively roll back the durable record
    // mutation — the projection module marks rows dirty internally.
    applyRetainedSizeRecordDelta({
      connectorInstanceId,
      connectorId,
      stream,
      currentRecordJsonBytesDelta: sharedRecordJsonBytesDelta,
      recordHistoryJsonBytesDelta: insertedChangeJsonBytes - prunedBytesForDelta,
      recordCountDelta: sharedRecordCountDelta,
      recordHistoryCountDelta: 1 - prunedRowsForDelta,
    });

    return { kind: 'changed', op, version: nextVersion };
  });

  if (outcome.kind === 'noop') {
    return { accepted: true, changed: false };
  }

  // Derived index maintenance runs after the durable commit. Failures here
  // are not allowed to retroactively roll back the durable record mutation;
  // recovery is the search-index drift detector's job.
  if (outcome.op === 'delete') {
    await lexicalIndexDelete({ connectorId, connectorInstanceId, stream, recordKey });
    await semanticIndexDelete({ connectorId, connectorInstanceId, stream, recordKey });
  } else {
    await lexicalIndexUpsert({ connectorId, connectorInstanceId, stream, recordKey, data });
    await semanticIndexUpsert({ connectorId, connectorInstanceId, stream, recordKey, data });
  }

  // After-commit notification for client event subscriptions. Failures
  // here MUST NOT retroactively roll back the durable record mutation.
  __invokeClientEventEnqueueHook({
    connectorId,
    connectorInstanceId,
    connectionId: connectorInstanceId,
    stream,
    version: outcome.version ?? null,
    emittedAt: effectiveEmittedAt,
  });

  return { accepted: true, changed: true };
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

// Canonical public read query-param allowlist. `connection_id` is the
// canonical public connection identifier; `connector_instance_id` is the
// deprecated wire alias accepted during the migration window defined by
// `openspec/changes/expose-connection-identity-on-public-read`. Both are
// optional filters today; when storage enumerates multiple connections per
// owner they will narrow the result set. `subject_id` is forwarded by some
// MCP / dashboard clients for diagnostic context and is allowlisted alongside
// `connector_id` for parity with `/v1/streams` and `/v1/schema`.
const SUPPORTED_RECORD_QUERY_PARAMS = new Set([
  'changes_since',
  'connection_id',
  'connector_id',
  'connector_instance_id',
  'count',
  'cursor',
  'expand',
  'expand_limit',
  'fields',
  'filter',
  'limit',
  'order',
  'sort',
  'subject_id',
  'view',
  'window',
]);

// Canonical graded-count vocabulary. Spec:
//   openspec/changes/canonicalize-public-read-contract design.md ("Counts")
//   reference-contract `CountKindSchema`
const SUPPORTED_COUNT_KINDS = new Set(['none', 'estimated', 'exact']);

// Canonical bounded-window opt-in vocabulary. `meta.window` is opt-in via the
// `window` query parameter, mirroring the `count` opt-in discipline: absence,
// empty, or `none` omits `meta.window`; `exact` requests the bounded aggregate
// over the filtered, grant-scoped corpus. Any other value is a typed
// invalid-query error. Spec:
//   openspec/changes/complete-explorer-slvp-ideal/specs/
//   reference-implementation-architecture/spec.md
//   (#"The record-list read MAY expose bounded window aggregate metadata")
const SUPPORTED_WINDOW_KINDS = new Set(['none', 'exact']);
const SUPPORTED_AGGREGATE_QUERY_PARAMS = new Set([
  'connection_id',
  'connector_id',
  'connector_instance_id',
  'field',
  'filter',
  'granularity',
  'group_by',
  'group_by_time',
  'limit',
  'metric',
  'subject_id',
  'time_zone',
]);

/**
 * Re-export the canonical alias contract helpers so existing imports from
 * `./records.js` continue to work. The single source of truth is
 * `./connection-id-request.js`, which records.js, postgres-records.js, and
 * future read-path runtime share without duplication.
 */
export { resolveRequestConnectionId, CONNECTION_ALIAS_DEPRECATED_WARNING_CODE };
export const validateConnectionAlias = validateConnectionAliasShared;
const SUPPORTED_AGGREGATE_METRICS = new Set(['count', 'sum', 'min', 'max', 'count_distinct']);
const MAX_AGGREGATE_GROUP_LIMIT = 100;
const DEFAULT_AGGREGATE_GROUP_LIMIT = 10;
// Calendar `date_trunc` granularity set for `group_by_time` (weeks start
// Monday). See openspec/changes/add-aggregate-time-buckets-and-distinct.
const SUPPORTED_AGGREGATE_GRANULARITIES = new Set([
  'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year',
]);

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

// --- group_by_time calendar bucketing --------------------------------------
//
// The in-process aggregate floor computes time buckets with calendar
// `date_trunc` semantics (weeks start Monday) in the effective IANA zone,
// using `Intl.DateTimeFormat` so day/week/month/quarter/year boundaries
// respect the zone and DST without a SQL round trip. Bucket keys are ISO
// strings: a date (`YYYY-MM-DD`) for day/week/month/quarter/year, and a
// minute/hour timestamp (`YYYY-MM-DDTHH:MM:00Z`-style, zone-qualified) for the
// sub-day units. See openspec/changes/add-aggregate-time-buckets-and-distinct.

function resolveAggregateTimeZone(rawZone) {
  if (!rawZone) return 'UTC';
  try {
    // Throws RangeError for an unknown IANA zone.
    new Intl.DateTimeFormat('en-US', { timeZone: rawZone });
    return rawZone;
  } catch {
    throw invalidQueryError(`Unknown time_zone: '${rawZone}'`);
  }
}

// Decompose an absolute instant into wall-clock parts for the given IANA zone.
function zonedParts(epochMs, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  // `Intl` emits hour "24" at midnight in some engines; normalize to 0.
  const hour = parts.hour === '24' ? 0 : Number(parts.hour);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

// ISO day-of-week (1 = Monday .. 7 = Sunday) for a Y/M/D in proleptic
// Gregorian terms. Used to snap weeks to a Monday start.
function isoDayOfWeek(year, month, day) {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0=Sun
  return dow === 0 ? 7 : dow;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Calendar-truncate the instant `value` to the start of its `granularity`
 * bucket in `timeZone`, returning a stable ISO key string. Returns `null`
 * when the value is null or unparseable so the caller can route it to the
 * single null bucket.
 */
function bucketStartForGranularity(value, granularity, timeZone) {
  const epochMs = parseDateValue(value);
  if (epochMs == null) return null;
  const { year, month, day, hour, minute } = zonedParts(epochMs, timeZone);

  switch (granularity) {
    case 'minute':
      return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`;
    case 'hour':
      return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:00`;
    case 'day':
      return `${year}-${pad2(month)}-${pad2(day)}`;
    case 'week': {
      // Snap back to Monday in the zone's wall-clock calendar.
      const offset = isoDayOfWeek(year, month, day) - 1;
      const monday = new Date(Date.UTC(year, month - 1, day - offset));
      return `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`;
    }
    case 'month':
      return `${year}-${pad2(month)}-01`;
    case 'quarter': {
      const quarterStartMonth = month - ((month - 1) % 3);
      return `${year}-${pad2(quarterStartMonth)}-01`;
    }
    case 'year':
      return `${year}-01-01`;
    default:
      return null;
  }
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

/**
 * Resolve the effective list order from the canonical `sort` parameter
 * and the legacy `order` parameter.
 *
 * Canonical `sort` wins: `sort=-emitted_at` is DESC, `sort=emitted_at` is
 * ASC. Legacy `order` is honored only when `sort` is absent. If both are
 * sent and disagree, we reject with `invalid_sort` rather than silently
 * picking one — this is the strict-validation discipline the contract
 * requires for sort behavior.
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

function validateTopLevelQueryParams(requestParams, manifestStream = null) {
  const unsupported = Object.keys(requestParams).filter((key) => !SUPPORTED_RECORD_QUERY_PARAMS.has(key));
  if (unsupported.length) {
    throw invalidQueryError(`Unsupported query parameter: ${unsupported.join(', ')}`);
  }
  validateConnectionAlias(requestParams);
  validateCountKind(requestParams.count);
  validateWindowKind(requestParams.window);
  return validateCanonicalSort(requestParams.sort, manifestStream);
}

/**
 * Validate the requested count grade against the canonical
 * `none|estimated|exact` vocabulary. Absent / empty values pass through;
 * the server applies `none` as the default. Spec:
 *   openspec/changes/canonicalize-public-read-contract/specs/
 *   reference-implementation-architecture/spec.md (#"Counts are opt-in
 *   and cost-graded").
 */
function validateCountKind(value) {
  if (value == null || value === '') return;
  if (typeof value !== 'string' || !SUPPORTED_COUNT_KINDS.has(value)) {
    throw invalidQueryError(`count must be one of: ${[...SUPPORTED_COUNT_KINDS].join(', ')}`);
  }
}

/**
 * Validate the requested `window` grade against the canonical
 * `none|exact` vocabulary. Absent / empty / `none` values pass through; the
 * server omits `meta.window` for those. `exact` requests the bounded
 * aggregate. Any other value is a typed invalid-query error, mirroring the
 * strict-validation discipline used for `count`. Spec:
 *   openspec/changes/complete-explorer-slvp-ideal/specs/
 *   reference-implementation-architecture/spec.md
 *   (#"The record-list read MAY expose bounded window aggregate metadata").
 */
function validateWindowKind(value) {
  if (value == null || value === '') return;
  if (typeof value !== 'string' || !SUPPORTED_WINDOW_KINDS.has(value)) {
    throw invalidQueryError(`window must be one of: ${[...SUPPORTED_WINDOW_KINDS].join(', ')}`);
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
 * will apply.
 *
 * The wire vocabulary is sign-prefix CSV (`sort=-emitted_at`). Today the
 * reference runtime supports ordering by the stream's declared cursor
 * field only, so any other field is rejected with a typed `invalid_sort`
 * error. The sign prefix MUST control direction: `sort=field` is asc,
 * `sort=-field` is desc — silently ignoring the sign would amount to
 * accepting `sort` as a no-op, which the canonical contract forbids.
 *
 * Returns `null` when no `sort` is supplied, or
 *   `{ field: <cursor_field>, direction: 'ASC' | 'DESC' }`
 * when a single-field sort matches the advertised cursor field. Multi-key
 * sort (`sort=-emitted_at,name`) is not yet implemented; if a caller
 * supplies more than one entry that all happen to be the same advertised
 * field, we still resolve to its direction. Anything else is rejected.
 *
 * Conformance: every advertised sort field MUST be enforced by the
 * runtime. The reference runtime advertises only the cursor field as
 * sortable via `/v1/schema` (see operations/rs-schema-get); this helper
 * rejects all other fields rather than silently no-oping.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract design.md
 *       (#"Sort").
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
      const err = invalidQueryError(`Empty sort field`, 'invalid_sort');
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

function validateTopLevelAggregateParams(requestParams) {
  const unsupported = Object.keys(requestParams).filter((key) => !SUPPORTED_AGGREGATE_QUERY_PARAMS.has(key));
  if (unsupported.length) {
    throw invalidQueryError(`Unsupported query parameter: ${unsupported.join(', ')}`);
  }
  validateConnectionAlias(requestParams);
}

function normalizeAggregateMetric(value) {
  const metric = String(value || '').trim();
  if (!SUPPORTED_AGGREGATE_METRICS.has(metric)) {
    throw invalidQueryError('metric must be one of count, sum, min, max, count_distinct');
  }
  return metric;
}

function normalizeAggregateLimit(value, grouped) {
  if (!grouped) {
    if (value != null) throw invalidQueryError('limit is only supported with group_by or group_by_time');
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
  const groupByTime = requestParams.group_by_time == null || requestParams.group_by_time === ''
    ? null
    : String(requestParams.group_by_time).trim();
  const granularityRaw = requestParams.granularity == null || requestParams.granularity === ''
    ? null
    : String(requestParams.granularity).trim();
  const timeZoneRaw = requestParams.time_zone == null || requestParams.time_zone === ''
    ? null
    : String(requestParams.time_zone).trim();

  // Exactly one grouping dimension in v1: group_by XOR group_by_time.
  if (groupBy && groupByTime) {
    throw invalidQueryError('group_by and group_by_time cannot be combined; choose one grouping dimension');
  }
  const grouped = Boolean(groupBy || groupByTime);
  const limit = normalizeAggregateLimit(requestParams.limit, grouped);

  // granularity is required with group_by_time and forbidden otherwise.
  let granularity = null;
  let timeZone = null;
  if (groupByTime) {
    if (!granularityRaw) {
      throw invalidQueryError('granularity is required when group_by_time is present');
    }
    if (!SUPPORTED_AGGREGATE_GRANULARITIES.has(granularityRaw)) {
      throw invalidQueryError(`granularity must be one of ${[...SUPPORTED_AGGREGATE_GRANULARITIES].join(', ')}`);
    }
    granularity = granularityRaw;
    timeZone = resolveAggregateTimeZone(timeZoneRaw);
  } else {
    if (granularityRaw) {
      throw invalidQueryError('granularity is only supported with group_by_time');
    }
    if (timeZoneRaw) {
      throw invalidQueryError('time_zone is only supported with group_by_time');
    }
  }

  if (metric === 'count') {
    if (field) throw invalidQueryError('field is not supported for count');
    if (aggregations.count !== true) {
      throw invalidQueryError(`Count aggregation is not declared for stream '${manifestStream?.name || ''}'`);
    }
  } else if (metric === 'count_distinct') {
    if (grouped) throw invalidQueryError('count_distinct does not support grouping; omit group_by and group_by_time');
    if (!field) throw invalidQueryError('field is required for count_distinct');
    const fieldSchema = getFieldSchema(manifestStream, field);
    if (!fieldSchema) throw invalidQueryError(`Unknown field: ${field}`, 'unknown_field');
    requireAggregateFieldGranted(streamGrant, field);
    requireDeclaredAggregate(manifestStream, 'count_distinct', field);
    if (!isScalarAggregateSchema(fieldSchema)) {
      throw invalidQueryError(`count_distinct requires a scalar field; '${field}' is not scalar`);
    }
  } else {
    if (grouped) throw invalidQueryError(`${metric} does not support grouping; group_by and group_by_time are only valid with metric=count`);
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

  if (groupByTime) {
    if (metric !== 'count') {
      throw invalidQueryError('group_by_time is only valid with metric=count');
    }
    const timeSchema = getFieldSchema(manifestStream, groupByTime);
    if (!timeSchema) throw invalidQueryError(`Unknown field: ${groupByTime}`, 'unknown_field');
    requireAggregateFieldGranted(streamGrant, groupByTime);
    requireDeclaredAggregate(manifestStream, 'group_by_time', groupByTime);
    if (!isMinMaxAggregateSchema(timeSchema) || nonNullSchemaTypes(timeSchema).has('string') === false) {
      // group_by_time fields are declared date/date-time strings (validated at
      // manifest time); reject anything that slipped through as non-date.
      throw invalidQueryError(`group_by_time requires a date or date-time field; '${groupByTime}' is not supported`);
    }
  }

  return { metric, field, groupBy, groupByTime, granularity, timeZone, limit };
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
  connectorInstanceId,
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
  const whereParts = ['connector_instance_id = ?', 'stream = ?', 'deleted = 0'];
  const whereBinds = [connectorInstanceId, stream];
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
  connectorInstanceId,
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
      connectorInstanceId,
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
  const whereParts = ['connector_instance_id = ?', 'stream = ?', 'deleted = 0'];
  const whereBinds = [connectorInstanceId, stream];

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

function buildResponseRecord(stream, row, effective, identity = null) {
  const record = {
    object: 'record',
    id: row.record_key,
    stream,
    data: projectFields(row.rawData, effective.fields),
    emitted_at: row.emitted_at,
  };
  decorateRecordWithConnectionIdentity(record, identity);
  return record;
}

/**
 * Attach `connection_id` (canonical) and the deprecated `connector_instance_id`
 * alias to a response record when the runtime knows the binding without
 * guessing. `identity` is `null` (e.g. legacy callers) or
 * `{ connectionId, displayName? }`. Empty/missing values are skipped so we
 * never fabricate identity for pre-binding rows.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
 *       (#"Records, search, and blob items SHALL carry canonical connection identity")
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

async function hydrateExpandedRelations({
  connectorId,
  connectorInstanceId,
  db,
  effectiveParentRows,
  expansions,
  manifest,
  childIdentity: childIdentityOverride = null,
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
      connectorInstanceId,
      childStream: expansion.relationship.stream,
      childManifestStream,
      childEffective,
      foreignKeyField: expansion.relationship.foreign_key,
      parentKeys,
      cardinality: expansion.relationship.cardinality,
      limit: expansion.limit,
    });

    // Expansion children belong to the same connector_instance_id as the
    // parent, so reuse the resolved record identity (including display_name)
    // rather than constructing a bare `{ connectionId }` shape.
    const childIdentity = childIdentityOverride || { connectionId: connectorInstanceId };
    for (const parentRow of effectiveParentRows) {
      const relationKey = parentRow.record_key;
      const matches = groupedChildren.get(relationKey) || [];
      if (!parentRow.responseRecord.expanded) parentRow.responseRecord.expanded = {};

      if (expansion.relationship.cardinality === 'has_one') {
        const first = matches[0];
        parentRow.responseRecord.expanded[expansion.name] = first
          ? buildResponseRecord(expansion.relationship.stream, first, childEffective, childIdentity)
          : null;
        continue;
      }

      parentRow.responseRecord.expanded[expansion.name] = {
        object: 'list',
        has_more: matches.length > expansion.limit,
        data: matches.slice(0, expansion.limit).map((childRow) =>
          buildResponseRecord(expansion.relationship.stream, childRow, childEffective, childIdentity),
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
  connectorInstanceId,
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

  const whereParts = ['connector_instance_id = ?', 'stream = ?', 'deleted = 0'];
  const whereBinds = [connectorInstanceId, childStream];
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
  connectorInstanceId,
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
      connectorInstanceId,
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

  const whereParts = ['connector_instance_id = ?', 'stream = ?', 'deleted = 0'];
  const whereBinds = [connectorInstanceId, childStream];

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

async function getSnapshotAtVersion(connectorInstanceId, stream, recordKey, version) {
  if (!Number.isInteger(version) || version < 0) return null;
  const row = getOne(
    referenceQueries.recordsSnapshotsGetSnapshotAtVersion,
    [connectorInstanceId, stream, recordKey, version],
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
 * Stream on which local collectors emit coverage diagnostics. Records on
 * this stream carry `{ id, store, stream, status, reason }`; the reader
 * below projects only the safe `store`/`stream`/`status` triple.
 */
const LOCAL_COVERAGE_DIAGNOSTICS_STREAM = 'coverage_diagnostics';

const SAFE_COVERAGE_STATUSES = new Set([
  'collected',
  'inventory_only',
  'excluded',
  'deferred',
  'missing',
  'unsupported',
  'unaccounted',
]);

function projectCoverageRow(rawData) {
  if (!rawData || typeof rawData !== 'object') {
    return null;
  }
  const store = typeof rawData.store === 'string' && rawData.store ? rawData.store : null;
  if (!store) {
    return null;
  }
  const status =
    typeof rawData.status === 'string' && SAFE_COVERAGE_STATUSES.has(rawData.status)
      ? rawData.status
      : 'unaccounted';
  const stream =
    typeof rawData.stream === 'string' && rawData.stream ? rawData.stream : null;
  // Deliberately omit `id`, `reason`, and anything else: the operator
  // diagnostic only needs the safe store/stream/status triple, never the
  // reason free-text or any payload.
  return { store, stream, status };
}

/**
 * Read the latest `coverage_diagnostics` records for one connector instance
 * and return only the safe `{ store, stream, status }` triple per store.
 *
 * This is the server-side source for Section 5.3 operator completeness
 * diagnostics. It reads live records (the inventory rebuilds them each run,
 * so the live row is the latest), and never returns paths, payloads, the
 * coverage `reason` text, or secrets. Returns an empty array when the
 * instance has no coverage records (a run that never requested the stream).
 */
export async function listLocalCoverageDiagnostics(storageTarget) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  if (!connectorInstanceId) {
    return [];
  }

  const byStore = new Map();
  if (isPostgresStorageBackend()) {
    const result = await postgresQuery(
      `SELECT record_key, record_json FROM records
         WHERE connector_instance_id = $1 AND stream = $2 AND deleted = FALSE
         ORDER BY record_key ASC`,
      [connectorInstanceId, LOCAL_COVERAGE_DIAGNOSTICS_STREAM],
    );
    for (const row of result.rows) {
      const projected = projectCoverageRow(
        typeof row.record_json === 'string' ? JSON.parse(row.record_json) : row.record_json,
      );
      if (projected) {
        byStore.set(projected.store, projected);
      }
    }
  } else {
    const rows = getDb()
      .prepare(
        `SELECT record_key, record_json FROM records
           WHERE connector_instance_id = ? AND stream = ? AND deleted = 0
           ORDER BY record_key ASC`,
      )
      .all(connectorInstanceId, LOCAL_COVERAGE_DIAGNOSTICS_STREAM);
    for (const row of rows) {
      const projected = projectCoverageRow(JSON.parse(row.record_json));
      if (projected) {
        byStore.set(projected.store, projected);
      }
    }
  }

  return [...byStore.values()].sort((a, b) => a.store.localeCompare(b.store));
}

/**
 * Query records for a stream under grant enforcement
 */
export async function queryRecords(storageTarget, stream, grant, requestParams = {}, manifest = null) {
  if (isPostgresStorageBackend()) {
    return postgresQueryRecords(storageTarget, stream, grant, requestParams, manifest);
  }

  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
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
  const resolvedSort = validateTopLevelQueryParams(requestParams, mStream);
  const order = resolveListOrder(requestParams.order, resolvedSort);
  const { warnings: requestWarnings } = resolveRequestConnectionId(requestParams);
  // Public-read contract: a `connection_id` (or deprecated alias) that does
  // not address this grant's bound storage MUST be a typed error, never a
  // silent zero-result narrowing. Today the reference runtime pins one
  // binding per grant, so any other value is unaddressable.
  enforceConnectionNarrowing(requestParams, connectorInstanceId);

  // Resolve the canonical record identity once for this request. When the
  // runtime can pin (connector_instance_id, display_name) from the store
  // this populates `display_name`; otherwise we fall back to connection_id
  // only. Identity is reused across the changes_since branch, the primary
  // page rows, and one-hop expansion children so the wire shape stays
  // consistent without a per-record store roundtrip.
  const recordIdentity = await resolveRecordIdentityForBinding(connectorInstanceId, connectorId);

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

  const { limit, clamped: limitClamped, requested: requestedLimit } =
    clampRecordsPageLimit(requestParams.limit);
  if (limitClamped) {
    requestWarnings.push(buildLimitClampedWarning(requestedLimit));
  }

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

  if (changesSince !== null || paginationCursor?.session === 'changes') {
    rejectListOnlyParamsForChangesFeed(requestParams);
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
      [connectorInstanceId, stream],
    );
    const currentMaxVersion = vcRow ? vcRow.max_version : 0;
    const effectiveSessionMaxVersion = changesSince ? currentMaxVersion : sessionMaxVersion;

    const minChangeRow = getOne(
      referenceQueries.recordsSnapshotsGetMinRecordChangeVersion,
      [connectorInstanceId, stream],
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
        [connectorInstanceId, stream, pageAfterVersion, effectiveSessionMaxVersion],
      )) {
        changeGroups.push(row);
        if (changeGroups.length >= batchSize) break;
      }

      if (!changeGroups.length) break;

      for (const group of changeGroups) {
        const previous = await getSnapshotAtVersion(connectorInstanceId, stream, group.record_key, sinceVersion);
        const current = await getSnapshotAtVersion(connectorInstanceId, stream, group.record_key, group.latest_version);

        const previousVisible = isVisibleSnapshot(previous, effective, consentTimeField);
        const currentVisible = isVisibleSnapshot(current, effective, consentTimeField);

        if (current?.deleted) {
          if (!previousVisible || !passesRequestFilters(previous.data, compiledFilters)) continue;
          const deletedRecord = {
            object: 'record',
            id: group.record_key,
            stream,
            deleted: true,
            deleted_at: current.deleted_at,
            emitted_at: current.emitted_at,
          };
          decorateRecordWithConnectionIdentity(deletedRecord, recordIdentity);
          visibleChanges.push({
            latestVersion: group.latest_version,
            responseRecord: deletedRecord,
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

        const changeRecord = {
          object: 'record',
          id: group.record_key,
          stream,
          data: currentProjection,
          emitted_at: current.emitted_at,
        };
        decorateRecordWithConnectionIdentity(changeRecord, recordIdentity);
        visibleChanges.push({
          latestVersion: group.latest_version,
          responseRecord: changeRecord,
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
    attachRequestWarningsToResponse(response, requestWarnings);
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
    connectorInstanceId,
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
    responseRecord: buildResponseRecord(stream, row, effective, recordIdentity),
  }));

  await hydrateExpandedRelations({
    connectorId,
    connectorInstanceId,
    db,
    effectiveParentRows: effectivePageRows,
    expansions,
    manifest,
    childIdentity: recordIdentity,
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

  const countOutcome = computeGradedRecordCount({
    requestParams,
    connectorInstanceId,
    stream,
    effective,
    compiledFilters,
    consentTimeField,
  });
  if (countOutcome) {
    response.meta = mergeMetaCount(response.meta, countOutcome.count);
    if (countOutcome.warning) {
      attachRequestWarningsToResponse(response, [countOutcome.warning]);
    }
  }

  // `meta.window` is the bounded corpus aggregate (total + logical min/max).
  // Like `meta.count` it is opt-in and page-independent: it reflects the whole
  // filtered, grant-scoped result set, so `limit=1` still reports full bounds.
  // It is intentionally NOT emitted on the `changes_since` branch above (a
  // delta feed has no meaningful corpus window).
  const windowOutcome = computeRecordWindow({
    requestParams,
    connectorInstanceId,
    stream,
    effective,
    compiledFilters,
    consentTimeField,
  });
  if (windowOutcome) {
    response.meta = mergeMetaWindow(response.meta, windowOutcome);
  }

  attachRequestWarningsToResponse(response, requestWarnings);

  return response;
}

/**
 * Compute the requested graded count for a records list response.
 *
 * The canonical grades are `none`, `estimated`, and `exact`. This first
 * surface implements `exact` by scanning the same visible-row set the
 * records list would have scanned for the aggregate path (cheap on the
 * SQLite reference; future tranches can add planner-style estimates).
 *
 * Behavior:
 *   - `count` absent or `none`: return `null` (callers omit `meta.count`).
 *   - `count=exact`:     returns `{ count: { kind: 'exact', value } }`.
 *   - `count=estimated`: returns `{ count: { kind: 'exact', value } }`
 *     (silent upgrade). `count_downgraded` is reserved for the strict
 *     case where the server returned a *lower* grade than requested
 *     (e.g. `count=exact` -> delivered `estimated`/`none`). Returning a
 *     higher-fidelity value than asked for is not a downgrade, so the
 *     reference does not invent a warning for it.
 *
 * Spec: openspec/changes/canonicalize-public-read-contract design.md
 *       (#"Counts") and specs/reference-implementation-architecture/
 *       spec.md (#"Requested count is downgraded").
 */
function computeGradedRecordCount({ requestParams, connectorInstanceId, stream, effective, compiledFilters, consentTimeField }) {
  const requested = typeof requestParams.count === 'string' ? requestParams.count : null;
  if (!requested || requested === 'none') return null;

  const exactValue = countVisibleRecordsForStream({
    connectorInstanceId,
    stream,
    effective,
    compiledFilters,
    consentTimeField,
  });

  if (requested === 'exact' || requested === 'estimated') {
    return { count: { kind: 'exact', value: exactValue } };
  }

  return null;
}

/**
 * Scan visible records under the same grant + filter set the list path
 * uses and return the visible count. Mirrors `aggregateRecords` count
 * semantics so the two surfaces stay in lock-step.
 */
function countVisibleRecordsForStream({ connectorInstanceId, stream, effective, compiledFilters, consentTimeField }) {
  if (isPostgresStorageBackend()) {
    // Postgres path falls back to scanning visible rows; postgres-records.js
    // owns the storage-specific count helper. For now records.js's count
    // helper only handles the SQLite reference because the Postgres list
    // path runs entirely through postgres-records.js.
    return 0;
  }
  const rows = iterate(
    referenceQueries.recordsAggregateIterateStreamRecordsForAggregation,
    [connectorInstanceId, stream],
  );
  let visibleCount = 0;
  for (const row of rows) {
    const rawData = JSON.parse(row.record_json);
    if (effective.resources && !effective.resources.includes(row.record_key)) continue;
    if (effective.timeRange && consentTimeField && !passesTimeRange(rawData, effective.timeRange, consentTimeField)) continue;
    if (compiledFilters.length && !passesRequestFilters(rawData, compiledFilters)) continue;
    visibleCount += 1;
  }
  return visibleCount;
}

/**
 * Merge a `meta.count` payload into an existing response.meta, preserving
 * `warnings` and any other meta members. Returns the new meta object.
 */
function mergeMetaCount(existingMeta, count) {
  const base = existingMeta && typeof existingMeta === 'object' && !Array.isArray(existingMeta)
    ? { ...existingMeta }
    : {};
  base.count = count;
  return base;
}

/**
 * Merge a `meta.window` payload into an existing response.meta, preserving
 * `count`, `warnings`, and any other meta members. Returns the new meta
 * object.
 */
function mergeMetaWindow(existingMeta, window) {
  const base = existingMeta && typeof existingMeta === 'object' && !Array.isArray(existingMeta)
    ? { ...existingMeta }
    : {};
  base.window = window;
  return base;
}

/**
 * Compute the bounded `meta.window` aggregate for a records list response,
 * when the request opted in via `window=exact`.
 *
 * The window describes the *whole filtered, grant-scoped corpus* — not the
 * paginated page — so `limit=1` still reports the full bounds. It reuses the
 * exact visible-row scan `countVisibleRecordsForStream` uses (same grant
 * resources, time-range, and compiled filters), so the two surfaces stay in
 * lock-step and we never duplicate grant/filter semantics on a divergent path.
 *
 * Timestamp source is the stream's logical `consent_time_field` — the same
 * field `passesTimeRange` filters on — never the storage ingest `emitted_at`.
 *
 * Honest-omission rules (never estimate; see spec scenario "Window metadata is
 * omitted rather than estimated"):
 *   - `window` absent / empty / `none`: return `null` (callers omit
 *     `meta.window`).
 *   - empty filtered corpus: `{ total: 0 }` with no timestamps.
 *   - stream declares no `consent_time_field`: `{ total: N }` with no
 *     timestamps (do NOT substitute `emitted_at`).
 *   - rows whose `consent_time_field` value is missing/unparseable are
 *     excluded from min/max; if every visible row lacks a parseable value,
 *     emit `{ total: N }` with no timestamps.
 *   - `earliest_at` and `latest_at` are emitted together or both omitted.
 *
 * Spec: openspec/changes/complete-explorer-slvp-ideal/specs/
 *       reference-implementation-architecture/spec.md.
 */
function computeRecordWindow({ requestParams, connectorInstanceId, stream, effective, compiledFilters, consentTimeField }) {
  const requested = typeof requestParams.window === 'string' ? requestParams.window : null;
  if (!requested || requested === 'none') return null;

  if (isPostgresStorageBackend()) {
    // The Postgres list path runs entirely through postgres-records.js, which
    // owns its own (currently omitted) window computation. Guard here so a
    // SQLite-only helper never silently returns a zero window under Postgres.
    return null;
  }

  const rows = iterate(
    referenceQueries.recordsAggregateIterateStreamRecordsForAggregation,
    [connectorInstanceId, stream],
  );

  let total = 0;
  let earliestMs = null;
  let latestMs = null;

  for (const row of rows) {
    const rawData = JSON.parse(row.record_json);
    if (effective.resources && !effective.resources.includes(row.record_key)) continue;
    if (effective.timeRange && consentTimeField && !passesTimeRange(rawData, effective.timeRange, consentTimeField)) continue;
    if (compiledFilters.length && !passesRequestFilters(rawData, compiledFilters)) continue;

    total += 1;

    if (!consentTimeField) continue;
    const value = rawData[consentTimeField];
    if (value == null || value === '') continue;
    const ms = new Date(value).getTime();
    if (Number.isNaN(ms)) continue;
    if (earliestMs == null || ms < earliestMs) earliestMs = ms;
    if (latestMs == null || ms > latestMs) latestMs = ms;
  }

  const window = { total };
  if (earliestMs != null && latestMs != null) {
    // Normalize to ISO 8601 UTC via the same `new Date(...)` parse the
    // time-range filter uses; `earliest_at`/`latest_at` are emitted together.
    window.earliest_at = new Date(earliestMs).toISOString();
    window.latest_at = new Date(latestMs).toISOString();
  }
  return window;
}

/**
 * Attach a `meta.warnings[]` envelope to a public-read response only when
 * the runtime has non-empty structured warnings to surface. Keeps the wire
 * shape backwards-compatible for the common no-warning case while opening
 * the canonical `meta.warnings` slot for deprecated-alias usage and any
 * future graded outcomes (skipped sources, count downgrade, etc.).
 *
 * Spec: openspec/changes/canonicalize-public-read-contract/specs/
 *       reference-implementation-architecture/spec.md
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

/**
 * Aggregate records for one stream under the same grant and filter semantics
 * used by record listing. This first surface deliberately scans visible rows
 * in-process instead of adding aggregate indexes; it is a semantic floor.
 */
export async function aggregateRecords(storageTarget, stream, grant, requestParams = {}, manifest = null) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);

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
  const { warnings: requestWarnings } = resolveRequestConnectionId(requestParams);
  enforceConnectionNarrowing(requestParams, connectorInstanceId);
  const compiledFilters = compileRequestFilters(requestParams.filter, streamGrant, manifestStream);
  const effective = buildEffectiveFilter(streamGrant, {});
  const consentTimeField = manifestStream?.consent_time_field || null;

  const rows = iterate(
    referenceQueries.recordsAggregateIterateStreamRecordsForAggregation,
    [connectorInstanceId, stream],
  );

  let visibleCount = 0;
  let sum = 0;
  let bestComparable = null;
  let bestValue = null;
  const groups = new Map();
  // group_by_time buckets keyed by ISO bucket start; the null/unparseable
  // bucket is keyed separately and sorted last.
  const timeBuckets = new Map();
  // count_distinct: distinct non-null values keyed by canonical JSON.
  const distinctValues = new Set();
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

    if (aggregateRequest.groupByTime) {
      const bucketKey = bucketStartForGranularity(
        rawData[aggregateRequest.groupByTime] ?? null,
        aggregateRequest.granularity,
        aggregateRequest.timeZone,
      );
      const mapKey = bucketKey == null ? '__null__' : bucketKey;
      const entry = timeBuckets.get(mapKey) || { key: bucketKey, count: 0 };
      entry.count += 1;
      timeBuckets.set(mapKey, entry);
      continue;
    }

    if (aggregateRequest.metric === 'count_distinct') {
      const value = rawData[aggregateRequest.field] ?? null;
      if (value != null) distinctValues.add(JSON.stringify(value));
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
    // Additive time-bucket fields: null for non-time aggregations so the
    // payload stays backward-compatible.
    group_by_time: aggregateRequest.groupByTime,
    granularity: aggregateRequest.granularity,
    time_zone: aggregateRequest.timeZone,
    // The in-process floor is exact; only a future accelerated estimator
    // would flip this to true.
    approximate: false,
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
  } else if (aggregateRequest.groupByTime) {
    response.limit = aggregateRequest.limit;
    // Time buckets are a series: order by bucket start ascending, with the
    // null/unparseable bucket sorted last.
    response.groups = [...timeBuckets.values()]
      .sort((left, right) => {
        if (left.key == null) return right.key == null ? 0 : 1;
        if (right.key == null) return -1;
        return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
      })
      .slice(0, aggregateRequest.limit);
  } else if (aggregateRequest.metric === 'count') {
    response.value = visibleCount;
  } else if (aggregateRequest.metric === 'count_distinct') {
    response.value = distinctValues.size;
  } else if (aggregateRequest.metric === 'sum') {
    response.value = sum;
  } else {
    response.value = bestValue;
  }

  attachRequestWarningsToResponse(response, requestWarnings);

  return response;
}

/**
 * Get a single record by key, under grant enforcement
 */
export async function getRecord(storageTarget, stream, recordId, grant, manifest = null, requestParams = {}) {
  if (isPostgresStorageBackend()) {
    return postgresGetRecord(storageTarget, stream, recordId, grant, manifest, requestParams);
  }

  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const db = getDb();

  const streamGrant = grant.streams.find(s => s.name === stream);
  if (!streamGrant) {
    const err = new Error(`Stream '${stream}' not in grant`);
    err.code = 'grant_stream_not_allowed';
    throw err;
  }

  const { warnings: requestWarnings } = resolveRequestConnectionId(requestParams);
  enforceConnectionNarrowing(requestParams, connectorInstanceId);

  const row = getOne(
    referenceQueries.recordsGetLiveRecordByKey,
    [connectorInstanceId, stream, recordId],
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

  const recordIdentity = await resolveRecordIdentityForBinding(connectorInstanceId, connectorId);

  const responseRow = {
    record_key: row.record_key,
    rawData,
    emitted_at: row.emitted_at,
    sortPosition: buildRecordSortPosition(rawData, row.record_key, mStream),
    responseRecord: buildResponseRecord(stream, {
      record_key: row.record_key,
      rawData,
      emitted_at: row.emitted_at,
    }, effective, recordIdentity),
  };

  const expansions = normalizeExpandRequest({
    expand: requestParams.expand,
    expand_limit: requestParams.expand_limit,
  }, stream, grant, mStream, 'ASC');

  await hydrateExpandedRelations({
    connectorId,
    connectorInstanceId,
    db,
    effectiveParentRows: [responseRow],
    expansions,
    manifest,
    grant,
    childIdentity: recordIdentity,
  });

  attachRequestWarningsToResponse(responseRow.responseRecord, requestWarnings);
  return responseRow.responseRecord;
}

/**
 * Delete a record (owner-authenticated).
 *
 * Atomicity: durable record mutation — current-state read, absent /
 * already-deleted no-op decision, atomic version allocation
 * (`recordsIngestAllocateNextVersion` upserts `version_counter` and returns
 * the freshly-allocated `max_version` in one statement), live `records`
 * delete-marker mutation, `record_changes` deleted-row append, and history
 * pruning — runs inside one explicit SQLite `BEGIN IMMEDIATE` write
 * transaction (`writeTransaction`). The write lock is acquired at
 * transaction start so concurrent writers (direct delete and ingest both
 * target the same per-`(connector_id, stream)` version state) serialize on
 * the read, not on the first write.
 *
 * Lexical and semantic index deletes run after the durable commit and are
 * deliberately *not* part of the atomic unit; an index-maintenance failure
 * must not roll back the durable record write.
 *
 * Spec: openspec/changes/harden-record-version-allocation-atomicity/specs/
 *       reference-implementation-architecture/spec.md
 */
export async function deleteRecord(storageTarget, stream, recordId) {
  if (isPostgresStorageBackend()) {
    const outcome = await postgresDeleteRecord(storageTarget, stream, recordId);
    if (outcome.changed) {
      const connectorId = resolveStorageConnectorId(storageTarget);
      const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
      if (outcome.retainedSizeDelta) {
        await applyRetainedSizeRecordDelta(outcome.retainedSizeDelta);
      } else {
        await markRetainedSizeStreamDirty({ connectorInstanceId, stream });
      }
      await lexicalIndexDelete({ connectorId, connectorInstanceId, stream, recordKey: recordId });
      await semanticIndexDelete({ connectorId, connectorInstanceId, stream, recordKey: recordId });
    }
    return outcome;
  }

  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const now = nowIso();
  const changeHistoryLimit = getChangeHistoryLimit();

  const outcome = writeTransaction(() => {
    const current = getOne(
      referenceQueries.recordsIngestGetCurrentRecordState,
      [connectorInstanceId, stream, recordId],
    );
    if (!current || current.deleted) {
      return { kind: 'noop' };
    }

    const allocated = execReturningOne(
      referenceQueries.recordsIngestAllocateNextVersion,
      [connectorId, connectorInstanceId, stream],
    );
    const nextVersion = allocated.max_version;

    maybeDeleteFault('after-version-allocation', { connectorId, connectorInstanceId, stream, recordId, nextVersion });

    exec(
      referenceQueries.recordsIngestMarkRecordDeleted,
      [now, nextVersion, connectorInstanceId, stream, recordId],
    );

    maybeDeleteFault('after-records-mutation', { connectorId, connectorInstanceId, stream, recordId, nextVersion });

    exec(
      referenceQueries.recordsIngestInsertRecordChangeDeleted,
      [connectorId, connectorInstanceId, stream, recordId, nextVersion, current.record_json, now, now],
    );

    maybeDeleteFault('after-record-changes-append', { connectorId, connectorInstanceId, stream, recordId, nextVersion });

    let prunedBytesForDelta = 0;
    let prunedRowsForDelta = 0;
    if (changeHistoryLimit > 0) {
      prunedBytesForDelta = getPrunedRecordChangeJsonBytes(connectorInstanceId, stream, nextVersion - changeHistoryLimit);
      prunedRowsForDelta = getPrunedRecordChangeCount(connectorInstanceId, stream, nextVersion - changeHistoryLimit);
      exec(
        referenceQueries.recordsIngestPruneRecordChanges,
        [connectorInstanceId, stream, nextVersion - changeHistoryLimit],
      );
    }
    applyDatasetSummaryRecordDelta({
      connectorId,
      stream,
      emittedAt: now,
      consentTimeField: getManifestConsentTimeField(connectorId, stream),
      recordCountDelta: -1,
      recordJsonBytesDelta: -byteLength(current.record_json),
      recordChangesJsonBytesDelta: byteLength(current.record_json) - prunedBytesForDelta,
      dirtyRecordTimeBounds: true,
    });
    applyRetainedSizeRecordDelta({
      connectorInstanceId,
      connectorId,
      stream,
      currentRecordJsonBytesDelta: -byteLength(current.record_json),
      recordHistoryJsonBytesDelta: byteLength(current.record_json) - prunedBytesForDelta,
      recordCountDelta: -1,
      recordHistoryCountDelta: 1 - prunedRowsForDelta,
    });

    return { kind: 'changed' };
  });

  if (outcome.kind === 'noop') return 0;

  // Derived index maintenance runs after the durable commit. Failures here
  // are not allowed to retroactively roll back the durable record mutation;
  // recovery is the search-index drift detector's job.
  await lexicalIndexDelete({ connectorId, connectorInstanceId, stream, recordKey: recordId });
  await semanticIndexDelete({ connectorId, connectorInstanceId, stream, recordKey: recordId });

  return 1;
}

export async function listAllStreams(storageTarget) {
  if (isPostgresStorageBackend()) {
    return postgresListAllStreams(storageTarget);
  }

  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  // REVIEWED-BOUNDED: rows are one per (connector, stream) pair; a single
  // connector's manifest declares at most a few dozen streams, well under
  // the registry's @max_rows=256 cap on the records table read.
  const rows = allowUnboundedReadAcknowledged(
    referenceQueries.recordsAggregateStreamsByConnectorInstance,
    [connectorId, connectorInstanceId],
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
  if (isPostgresStorageBackend()) {
    const deletedRecordCount = await postgresDeleteAllRecords(storageTarget, stream);
    const connectorId = resolveStorageConnectorId(storageTarget);
    const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
    if (deletedRecordCount > 0) {
      await markRetainedSizeStreamDirty({ connectorInstanceId, stream });
    }
    await lexicalIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
    await semanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
    return deletedRecordCount;
  }

  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const countRow = getOne(
    referenceQueries.recordsDeleteCountRecordsByStream,
    [connectorInstanceId, stream],
  );
  const deletedRecordCount = countRow?.count || 0;
  exec(referenceQueries.recordsDeleteDeleteRecordsByStream, [connectorInstanceId, stream]);
  exec(referenceQueries.recordsDeleteDeleteRecordChangesByStream, [connectorInstanceId, stream]);
  exec(referenceQueries.recordsDeleteDeleteVersionCounterByStream, [connectorInstanceId, stream]);
  if (deletedRecordCount > 0) {
    markDatasetSummaryProjectionStale('bulk stream record delete bypassed exact dataset summary projection deltas');
    await markRetainedSizeStreamDirty({ connectorInstanceId, stream });
  }
  await lexicalIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
  await semanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
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
  if (isPostgresStorageBackend()) {
    return postgresDeleteAllRecordsForConnector(connectorId);
  }
  // REVIEWED-BOUNDED: rows are one per distinct (connector instance, stream)
  // pair a connector type has produced. Manifest stream counts are bounded by
  // the registry cap; instance cardinality is the connector-instance registry's
  // configured connection set, not record-table cardinality.
  const namespaceRows = allowUnboundedReadAcknowledged(
    referenceQueries.recordsDeleteListInstanceStreamsByConnector,
    [connectorId],
  );
  const countRow = getOne(
    referenceQueries.recordsDeleteCountRecordsByConnector,
    [connectorId],
  );
  const deletedCount = countRow?.count || 0;
  const streams = Array.from(new Set(namespaceRows.map((row) => row.stream)));

  for (const row of namespaceRows) {
    const connectorInstanceId = row.connector_instance_id;
    const stream = row.stream;
    exec(referenceQueries.recordsDeleteDeleteRecordsByStream, [connectorInstanceId, stream]);
    exec(referenceQueries.recordsDeleteDeleteRecordChangesByStream, [connectorInstanceId, stream]);
    exec(referenceQueries.recordsDeleteDeleteVersionCounterByStream, [connectorInstanceId, stream]);
    exec(referenceQueries.recordsDeleteDeleteBlobBindingsByStream, [connectorInstanceId, stream]);
    await markRetainedSizeStreamDirty({ connectorInstanceId, stream });
    await lexicalIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
    await semanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
  }
  if (deletedCount > 0) {
    markDatasetSummaryProjectionStale('bulk connector record delete bypassed exact dataset summary projection deltas');
    await markRetainedSizeConnectionDirty({ connectorInstanceId: null });
  }

  return { deletedCount, streams };
}

// Postgres equivalent of `deleteAllRecordsForConnector`. The reconcile loop
// runs at every startup in Postgres deployments
// (`shouldAutoReconcilePolyfillManifests` defaults on for the postgres
// backend), so the connector-wide invalidation contract must reach Postgres
// records — not the empty/legacy rows in the SQLite shadow table — when the
// reference-fixture → polyfill fingerprint transition fires.
//
// Strategy: discover (connector_instance_id, stream) pairs from the
// authoritative postgres `records ∪ record_changes ∪ blob_bindings` set for
// this connector_id, count the live (deleted = FALSE) records to mirror the
// SQLite path's return-shape contract, then compose the per-stream
// `postgresDeleteAllRecords` helper once per pair (records, record_changes,
// version_counter, lexical/semantic search tables) and drop `blob_bindings`
// separately, mirroring the SQLite per-connector path's extra fourth delete
// vs. the per-stream owner-reset path.
async function postgresDeleteAllRecordsForConnector(connectorId) {
  // Union of (instance, stream) pairs across `records`, `record_changes`,
  // and `blob_bindings` so a stream that has only history rows or only
  // surviving blob bindings (records already pruned) is still discovered.
  const pairsResult = await postgresQuery(
    `SELECT DISTINCT connector_instance_id, stream FROM (
       SELECT connector_instance_id, stream FROM records WHERE connector_id = $1
       UNION
       SELECT connector_instance_id, stream FROM record_changes WHERE connector_id = $1
       UNION
       SELECT connector_instance_id, stream FROM blob_bindings WHERE connector_id = $1
     ) AS t
     ORDER BY connector_instance_id, stream`,
    [connectorId],
  );
  const namespaceRows = pairsResult.rows;
  const streams = Array.from(new Set(namespaceRows.map((row) => row.stream)));

  const countResult = await postgresQuery(
    `SELECT COUNT(*)::int AS count FROM records
       WHERE connector_id = $1 AND deleted = FALSE`,
    [connectorId],
  );
  const deletedCount = Number(countResult.rows[0]?.count || 0);

  for (const row of namespaceRows) {
    const connectorInstanceId = row.connector_instance_id;
    const stream = row.stream;
    const storageTarget = { connector_id: connectorId, connector_instance_id: connectorInstanceId };
    // Per-stream tail: records, record_changes, version_counter, and the
    // lexical/semantic search tables for the (instance, stream) pair. The
    // shared helper runs atomically inside withPostgresTransaction.
    await postgresDeleteAllRecords(storageTarget, stream);
    // blob_bindings is the connector-wide extra that the per-stream owner
    // reset does not touch (mirrors the SQLite per-connector path's fourth
    // delete vs. the SQLite per-stream path's three).
    await postgresQuery(
      `DELETE FROM blob_bindings WHERE connector_instance_id = $1 AND stream = $2`,
      [connectorInstanceId, stream],
    );
    await markRetainedSizeStreamDirty({ connectorInstanceId, stream });
    // The lexical/semantic index helpers already branch on
    // isPostgresStorageBackend() internally and clear the postgres
    // lexical_search_* / semantic_search_* tables for the (instance, stream)
    // pair, matching the SQLite path's index teardown. This second call is
    // a no-op against the rows postgresDeleteAllRecords already cleared, but
    // it keeps the connector-wide path's shape identical to the SQLite arm
    // and lets the search helpers own any future backend-specific cleanup.
    await lexicalIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
    await semanticIndexDeleteByConnectorStream({ connectorId, connectorInstanceId, stream });
  }

  if (deletedCount > 0) {
    // Postgres dashboard summary reads from the retained-size projection
    // (see `getRetainedSizeDatasetSummaryProjection` in server/index.js).
    // The SQLite `dataset_summary_projection` is unused in Postgres mode,
    // so only the retained-size projection is marked dirty here.
    await markRetainedSizeConnectionDirty({ connectorInstanceId: null });
  }

  return { deletedCount, streams };
}

/**
 * List streams available under a grant, with record counts
 */
export async function listStreams(storageTarget, grant, manifest = null) {
  if (isPostgresStorageBackend()) {
    return postgresListStreams(storageTarget, grant, manifest);
  }

  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const result = [];

  for (const sg of grant.streams) {
    const rows = iterate(referenceQueries.recordsListStreamVisibleCandidates, [connectorInstanceId, sg.name]);
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

// ─── Multi-binding fan-in helpers ──────────────────────────────────────────
//
// Closes the deferred runtime work tracked under
// `openspec/changes/expose-connection-identity-on-public-read/tasks.md`
// Section 3 / 4 / 6. These helpers wrap the existing per-binding storage
// primitives (`queryRecords`, `getRecord`, `listStreams`, `aggregateRecords`,
// `getBlob`-style flows) with the canonical (connection_id, stream)
// addressing rule from the public read contract:
//
//   - omitted `connection_id` SHALL fan in across the granted connections;
//   - exactly one matching connection SHALL be auto-selected;
//   - record/blob identifier ambiguity SHALL raise the typed
//     `ambiguous_connection` error with `available_connections`.
//
// The helpers stay deliberately thin: they iterate the existing per-binding
// SQL paths and union results so the storage layer does not need a new
// query shape. A future tranche can push fan-in into the SQL itself for
// pagination performance.

function buildBindingStorageTarget(connectorId, connectorInstanceId) {
  return { connector_id: connectorId, connector_instance_id: connectorInstanceId };
}

function mergeMetaWarnings(target, incoming) {
  if (!incoming) return target;
  const next = { ...(target || {}) };
  if (Array.isArray(incoming.warnings) && incoming.warnings.length) {
    const seen = new Set();
    const merged = [];
    for (const w of [...(next.warnings || []), ...incoming.warnings]) {
      const key = `${w.code}|${w.param || ''}|${w.message || ''}|${JSON.stringify(w.detail || null)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(w);
    }
    next.warnings = merged;
  }
  return next;
}

function appendUniqueWarning(meta, warning) {
  const next = { ...(meta || {}) };
  const existing = Array.isArray(next.warnings) ? next.warnings : [];
  const key = `${warning.code}|${warning.param || ''}|${warning.message || ''}|${JSON.stringify(warning.detail || null)}`;
  for (const w of existing) {
    const k = `${w.code}|${w.param || ''}|${w.message || ''}|${JSON.stringify(w.detail || null)}`;
    if (k === key) {
      next.warnings = existing;
      return next;
    }
  }
  next.warnings = [...existing, warning];
  return next;
}

function ensureBindingsOrThrow(bindings, { connectorId, missingMessage }) {
  if (!bindings || bindings.length === 0) {
    const err = new Error(
      missingMessage
        || `No active connection is available for connector '${connectorId}'.`,
    );
    err.code = 'connection_not_found';
    throw err;
  }
}

/**
 * Fan-in records list across multiple bindings under one grant.
 *
 * Returns a canonical list envelope whose `data` is the union of records
 * across the addressed bindings. Each record carries `connection_id`,
 * deprecated `connector_instance_id`, and `display_name` when known —
 * already wired by per-binding `queryRecords`.
 *
 * Cursor / count honesty under fan-in:
 *
 * - `changes_since` is NOT supported under multi-binding fan-in. The
 *   per-binding `next_changes_since` cursors are per-(connector_instance_id,
 *   stream) version counters, and merging them across bindings would either
 *   silently skip changes on the binding(s) whose counter lags or wrap
 *   numeric semantics in a base64 lexical comparison. We reject `changes_since`
 *   with a typed `invalid_argument` carrying recovery guidance (narrow the
 *   call with `connection_id`). Spec: P1 fix in
 *   `tmp/workstreams/fan-in-branch-owner-review-report.md`.
 *
 * - Per-binding `next_cursor` cannot be safely unioned today. When any
 *   binding has more pages, the response emits a structured
 *   `meta.warnings[{code:"partial_results"}]` so callers know that fan-in
 *   pagination is partial and they should narrow with `connection_id` to
 *   page exhaustively. `next_cursor` is intentionally omitted on the
 *   multi-binding envelope.
 *
 * - `meta.count` is summed across bindings only when every binding produced
 *   an `exact` count over the same shape; if any binding omits or downgrades
 *   it, the fan-in response drops `meta.count` and emits a
 *   `count_downgraded` warning. The previous behavior (carrying whichever
 *   binding's count ran last) is removed.
 */
export async function queryRecordsAcrossBindings(bindings, stream, grant, requestParams, manifest, opts = {}) {
  ensureBindingsOrThrow(bindings, { connectorId: bindings?.[0]?.connectorId, missingMessage: 'No active connection is available under this grant.' });

  const extraWarnings = Array.isArray(opts.extraWarnings) ? opts.extraWarnings : [];

  if (bindings.length === 1) {
    const single = await queryRecords(
      buildBindingStorageTarget(bindings[0].connectorId, bindings[0].connectorInstanceId),
      stream,
      grant,
      requestParams,
      manifest,
    );
    if (extraWarnings.length) {
      let meta = single.meta && typeof single.meta === 'object' && !Array.isArray(single.meta)
        ? { ...single.meta }
        : null;
      for (const w of extraWarnings) meta = appendUniqueWarning(meta, w);
      single.meta = meta;
    }
    return single;
  }

  // P1: reject `changes_since` under multi-binding fan-in. Per-binding
  // version counters cannot be combined into a single forward-progress
  // cursor without silently skipping changes on a lagging binding. The
  // caller must narrow with `connection_id` to get a sound cursor.
  const changesSinceRaw = requestParams?.changes_since;
  const changesSinceProvided =
    typeof changesSinceRaw === 'string' && changesSinceRaw.length > 0;
  if (changesSinceProvided) {
    const err = new Error(
      '`changes_since` is not supported across multiple connections. Retry with `connection_id` to bind the cursor to a single connection.',
    );
    err.code = 'invalid_argument';
    err.param = 'changes_since';
    err.retry_with = 'connection_id';
    err.available_connections = bindings
      .map((b) => projectBindingForWire({
        connectorInstanceId: b.connectorInstanceId,
        connectorId: b.connectorId,
        displayName: b.displayName,
      }))
      .filter(Boolean);
    throw err;
  }

  // Drop request-time connection_id when fanning in across multiple bindings;
  // queryRecords would reject an unrelated id with connection_not_found, but
  // here we have already filtered the binding list per the grant + request.
  const perBindingParams = { ...requestParams };
  delete perBindingParams.connection_id;
  delete perBindingParams.connector_instance_id;

  const unioned = [];
  let hasMoreAny = false;
  let meta = null;

  // For meta.count fan-in: sum exact-grade counts only when every binding
  // produced one; otherwise drop count and warn count_downgraded.
  const requestedCount = typeof requestParams?.count === 'string' ? requestParams.count : null;
  let countAllExact = !!requestedCount && requestedCount !== 'none';
  let countSum = 0;

  // For meta.window fan-in: merge only when every binding produced a window.
  // `total` sums; `earliest_at` is the global min; `latest_at` is the global
  // max. If any binding cannot produce a window, the merged window is omitted
  // (all-or-omit), mirroring the count fan-in honesty rule. A binding whose
  // window carries only `total` (no timestamps) collapses the merged
  // timestamps too: we can still sum totals, but we cannot honestly claim
  // bounds the binding did not report.
  const requestedWindow = typeof requestParams?.window === 'string' ? requestParams.window : null;
  let windowAllPresent = !!requestedWindow && requestedWindow !== 'none';
  let windowTotalSum = 0;
  let windowEarliestMs = null;
  let windowLatestMs = null;
  let windowBoundsAllPresent = true;

  for (const binding of bindings) {
    const target = buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId);
    const result = await queryRecords(target, stream, grant, perBindingParams, manifest);
    if (Array.isArray(result?.data)) unioned.push(...result.data);
    if (result?.has_more) hasMoreAny = true;
    meta = mergeMetaWarnings(meta, result?.meta);
    if (countAllExact) {
      const c = result?.meta?.count;
      if (c && c.kind === 'exact' && Number.isFinite(Number(c.value))) {
        countSum += Number(c.value);
      } else {
        countAllExact = false;
      }
    }
    if (windowAllPresent) {
      const w = result?.meta?.window;
      if (w && Number.isFinite(Number(w.total))) {
        windowTotalSum += Number(w.total);
        const hasBounds = typeof w.earliest_at === 'string' && typeof w.latest_at === 'string';
        if (hasBounds) {
          const e = new Date(w.earliest_at).getTime();
          const l = new Date(w.latest_at).getTime();
          if (Number.isNaN(e) || Number.isNaN(l)) {
            windowBoundsAllPresent = false;
          } else {
            if (windowEarliestMs == null || e < windowEarliestMs) windowEarliestMs = e;
            if (windowLatestMs == null || l > windowLatestMs) windowLatestMs = l;
          }
        } else {
          windowBoundsAllPresent = false;
        }
      } else {
        windowAllPresent = false;
      }
    }
  }

  const response = {
    object: 'list',
    has_more: hasMoreAny,
    data: unioned,
  };

  // P2: explicit structured warning when fan-in collapses pagination. We do
  // not emit `next_cursor` here because per-binding cursors cannot be
  // unioned today.
  if (hasMoreAny) {
    meta = appendUniqueWarning(meta, {
      code: CANONICAL_WARNING_CODES.PARTIAL_RESULTS,
      param: 'connection_id',
      message:
        'has_more=true and next_cursor is not emitted under multi-connection fan-in. Retry with `connection_id` to page a single connection.',
    });
  }

  // P3: honest meta.count under fan-in.
  if (requestedCount && requestedCount !== 'none') {
    if (countAllExact) {
      meta = { ...(meta || {}), count: { kind: 'exact', value: countSum } };
    } else {
      meta = appendUniqueWarning(meta, {
        code: CANONICAL_WARNING_CODES.COUNT_DOWNGRADED,
        param: 'count',
        message:
          'Requested count grade could not be produced as a single value across multiple connections. Retry with `connection_id` to receive an exact per-connection count.',
      });
    }
  }

  // Honest meta.window under fan-in: merge only all-present windows. `total`
  // sums; bounds are the global min/max, and are emitted only when every
  // binding reported them. If any binding omits its window, the merged window
  // is omitted entirely (no warning — absence already means "not available").
  if (requestedWindow && requestedWindow !== 'none' && windowAllPresent) {
    const mergedWindow = { total: windowTotalSum };
    if (windowBoundsAllPresent && windowEarliestMs != null && windowLatestMs != null) {
      mergedWindow.earliest_at = new Date(windowEarliestMs).toISOString();
      mergedWindow.latest_at = new Date(windowLatestMs).toISOString();
    }
    meta = { ...(meta || {}), window: mergedWindow };
  }

  // P3: resolver-supplied warnings (e.g. deprecated_alias_used) are
  // stripped from per-binding params for multi-binding fan-in, so they
  // would never appear on the response unless the route threads them
  // back in here.
  for (const w of extraWarnings) meta = appendUniqueWarning(meta, w);

  if (meta && Object.keys(meta).length) response.meta = meta;
  return response;
}

/**
 * Fan-in records detail across multiple bindings under one grant.
 *
 * Emits the typed `ambiguous_connection` error when the identifier resolves
 * to more than one binding. Returns the single record otherwise. Falls back
 * to a normal `not_found` when no binding holds the identifier.
 */
export async function getRecordAcrossBindings(bindings, stream, recordId, grant, manifest, requestParams = {}, opts = {}) {
  ensureBindingsOrThrow(bindings, { connectorId: bindings?.[0]?.connectorId });

  const extraWarnings = Array.isArray(opts.extraWarnings) ? opts.extraWarnings : [];

  function applyExtraWarnings(record) {
    if (!record || !extraWarnings.length) return record;
    let meta = record.meta && typeof record.meta === 'object' && !Array.isArray(record.meta)
      ? { ...record.meta }
      : null;
    for (const w of extraWarnings) meta = appendUniqueWarning(meta, w);
    record.meta = meta;
    return record;
  }

  if (bindings.length === 1) {
    const single = await getRecord(
      buildBindingStorageTarget(bindings[0].connectorId, bindings[0].connectorInstanceId),
      stream,
      recordId,
      grant,
      manifest,
      requestParams,
    );
    return applyExtraWarnings(single);
  }

  const perBindingParams = { ...requestParams };
  delete perBindingParams.connection_id;
  delete perBindingParams.connector_instance_id;

  const matches = [];
  for (const binding of bindings) {
    const target = buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId);
    try {
      const record = await getRecord(target, stream, recordId, grant, manifest, perBindingParams);
      matches.push({ binding, record });
    } catch (err) {
      if (err?.code === 'not_found') continue;
      throw err;
    }
  }

  if (matches.length === 0) {
    const err = new Error('Record not found');
    err.code = 'not_found';
    throw err;
  }
  if (matches.length === 1) {
    return applyExtraWarnings(matches[0].record);
  }
  const candidates = matches
    .map(({ binding }) => projectBindingForWire({
      connectorInstanceId: binding.connectorInstanceId,
      connectorId: binding.connectorId,
      displayName: binding.displayName,
    }))
    .filter(Boolean);
  throw new AmbiguousConnectionError(
    `Record '${recordId}' is present under more than one connection. Retry with \`connection_id\`.`,
    candidates,
  );
}

/**
 * Fan-in records aggregate across multiple bindings.
 *
 * The reference computes each binding with the same aggregate semantic floor
 * and only merges operations that are mathematically composable across
 * disjoint connection partitions.
 */
export async function aggregateRecordsAcrossBindings(bindings, stream, grant, requestParams, manifest, opts = {}) {
  ensureBindingsOrThrow(bindings, { connectorId: bindings?.[0]?.connectorId });

  const extraWarnings = Array.isArray(opts.extraWarnings) ? opts.extraWarnings : [];

  if (bindings.length === 1) {
    const single = await aggregateRecords(
      buildBindingStorageTarget(bindings[0].connectorId, bindings[0].connectorInstanceId),
      stream,
      grant,
      requestParams,
      manifest,
    );
    if (extraWarnings.length) {
      let meta = single.meta && typeof single.meta === 'object' && !Array.isArray(single.meta)
        ? { ...single.meta }
        : null;
      for (const w of extraWarnings) meta = appendUniqueWarning(meta, w);
      single.meta = meta;
    }
    return single;
  }

  const perBindingParams = { ...requestParams };
  delete perBindingParams.connection_id;
  delete perBindingParams.connector_instance_id;

  // Exact count_distinct cannot be soundly merged from per-binding distinct
  // counts (summing would overcount values shared across connections). Rather
  // than silently return a wrong number, reject the cross-connection case and
  // tell the caller to scope with `connection_id`. This preserves the
  // semantic-floor contract: never diverge from the exact distinct meaning.
  if ((requestParams.metric || '') === 'count_distinct') {
    throw invalidQueryError(
      'count_distinct across multiple connections is not supported; scope with connection_id',
    );
  }

  const isTimeBucket = typeof requestParams.group_by_time === 'string'
    && requestParams.group_by_time.trim() !== '';
  const isScalarGroup = typeof requestParams.group_by === 'string'
    && requestParams.group_by.trim() !== '';
  const metric = requestParams.metric || 'count';
  const manifestStream = manifest?.streams?.find((entry) => entry.name === stream);
  const aggregateFieldSchema = requestParams.field && manifestStream
    ? getFieldSchema(manifestStream, requestParams.field)
    : null;

  let value = metric === 'sum' || metric === 'count' ? 0 : null;
  let filteredRecordCount = 0;
  let bestComparable = null;
  let meta = null;
  let responseShape = null;
  // Merge grouped buckets across disjoint bindings: counts in the same bucket
  // key are additive because each binding sees a disjoint record set.
  const mergedBuckets = new Map();
  let mergedLimit = null;
  for (const binding of bindings) {
    const target = buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId);
    const result = await aggregateRecords(target, stream, grant, perBindingParams, manifest);
    if (!responseShape) {
      responseShape = {
        metric: result.metric,
        field: result.field ?? null,
        group_by: result.group_by ?? null,
        group_by_time: result.group_by_time ?? null,
        granularity: result.granularity ?? null,
        time_zone: result.time_zone ?? null,
        approximate: result.approximate === true,
      };
    }
    filteredRecordCount += Number(result?.filtered_record_count || 0);
    meta = mergeMetaWarnings(meta, result?.meta);
    if ((isScalarGroup || isTimeBucket) && Array.isArray(result?.groups)) {
      mergedLimit = result.limit ?? mergedLimit;
      for (const bucket of result.groups) {
        const mapKey = JSON.stringify(bucket.key ?? null);
        const entry = mergedBuckets.get(mapKey) || { key: bucket.key ?? null, count: 0 };
        entry.count += Number(bucket.count || 0);
        mergedBuckets.set(mapKey, entry);
      }
      continue;
    }
    if (metric === 'sum' || metric === 'count') {
      value += Number(result?.value || 0);
      continue;
    }
    if (metric === 'min' || metric === 'max') {
      const comparable = coerceComparableValue(result?.value, aggregateFieldSchema);
      if (comparable == null) continue;
      const shouldReplace = bestComparable == null
        || (metric === 'min' ? comparable < bestComparable : comparable > bestComparable);
      if (shouldReplace) {
        bestComparable = comparable;
        value = result.value;
      }
    }
  }
  for (const w of extraWarnings) meta = appendUniqueWarning(meta, w);

  responseShape ||= {
    metric,
    field: requestParams.field ?? null,
    group_by: requestParams.group_by ?? null,
    group_by_time: requestParams.group_by_time ?? null,
    granularity: requestParams.granularity ?? null,
    time_zone: null,
    approximate: false,
  };

  const response = {
    object: 'aggregation',
    stream,
    metric: responseShape.metric,
    field: responseShape.field,
    group_by: responseShape.group_by,
    group_by_time: responseShape.group_by_time,
    granularity: responseShape.granularity,
    time_zone: responseShape.time_zone,
    approximate: responseShape.approximate,
    filtered_record_count: filteredRecordCount,
  };

  if (isScalarGroup || isTimeBucket) {
    const groupedResponse = {
      ...response,
      groups: [...mergedBuckets.values()]
        .sort((left, right) => {
          if (isScalarGroup) {
            const countCmp = right.count - left.count;
            if (countCmp !== 0) return countCmp;
            return JSON.stringify(left.key).localeCompare(JSON.stringify(right.key));
          }
          if (left.key == null) return right.key == null ? 0 : 1;
          if (right.key == null) return -1;
          return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
        })
        .slice(0, mergedLimit ?? undefined),
    };
    if (mergedLimit != null) groupedResponse.limit = mergedLimit;
    if (meta && Object.keys(meta).length) groupedResponse.meta = meta;
    return groupedResponse;
  }

  response.value = value;
  if (meta && Object.keys(meta).length) response.meta = meta;
  return response;
}

/**
 * Fan-in stream-list summaries across multiple bindings.
 *
 * Emits one entry per (stream, connection_id) so multi-connection
 * deployments can disambiguate. Single-binding deployments preserve the
 * pre-existing shape with `connection_id`/`display_name` populated from
 * the sole active binding.
 *
 * When the grant pins per-stream `connection_id`, those streams resolve
 * against the named binding(s) only; streams without the constraint fan
 * in across `defaultBindings`. The `resolveBindingsForStream` callback
 * lets the route adapter apply the same `(request connection_id, grant
 * per-stream connection_id)` rules per stream. When callers do not pass
 * a resolver, the helper falls back to using `defaultBindings` for every
 * stream (preserving the prior single-resolution behavior for callers
 * that do not need per-stream constraint accuracy).
 */
export async function listStreamsAcrossBindings(defaultBindings, grant, manifest, opts = {}) {
  ensureBindingsOrThrow(defaultBindings, { connectorId: defaultBindings?.[0]?.connectorId });

  const resolveBindingsForStream = typeof opts.resolveBindingsForStream === 'function'
    ? opts.resolveBindingsForStream
    : null;

  const summaries = [];
  const grantStreams = Array.isArray(grant?.streams) ? grant.streams : [];

  // When no per-stream resolver is wired, fall back to the prior shape:
  // iterate every (binding, stream-in-grant) pair once.
  if (!resolveBindingsForStream) {
    for (const binding of defaultBindings) {
      const target = buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId);
      const perBinding = await listStreams(target, grant, manifest);
      const wireBinding = projectBindingForWire({
        connectorInstanceId: binding.connectorInstanceId,
        connectorId: binding.connectorId,
        displayName: binding.displayName,
      });
      for (const summary of perBinding) {
        const decorated = { ...summary };
        if (wireBinding?.connection_id) {
          decorated.connection_id = wireBinding.connection_id;
          decorated.connector_instance_id = wireBinding.connection_id;
          if (wireBinding.display_name) decorated.display_name = wireBinding.display_name;
        }
        summaries.push(decorated);
      }
    }
    return summaries;
  }

  // Per-stream resolver path: each stream's bindings honor its own
  // grant-scope `connection_id` constraint. Streams whose grant entry
  // pins different connections do not bleed each other's counts.
  for (const streamGrant of grantStreams) {
    if (!streamGrant?.name) continue;
    let bindingsForStream;
    try {
      bindingsForStream = await resolveBindingsForStream(streamGrant);
    } catch (err) {
      // A per-stream resolution failure (e.g. grant-pinned connection no
      // longer active) is surfaced honestly rather than swallowed: the
      // caller's grant references a connection that we cannot serve.
      throw err;
    }
    if (!bindingsForStream || bindingsForStream.length === 0) continue;
    const singleStreamGrant = { ...grant, streams: [streamGrant] };
    for (const binding of bindingsForStream) {
      const target = buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId);
      const perBinding = await listStreams(target, singleStreamGrant, manifest);
      const wireBinding = projectBindingForWire({
        connectorInstanceId: binding.connectorInstanceId,
        connectorId: binding.connectorId,
        displayName: binding.displayName,
      });
      for (const summary of perBinding) {
        const decorated = { ...summary };
        if (wireBinding?.connection_id) {
          decorated.connection_id = wireBinding.connection_id;
          decorated.connector_instance_id = wireBinding.connection_id;
          if (wireBinding.display_name) decorated.display_name = wireBinding.display_name;
        }
        summaries.push(decorated);
      }
    }
  }
  return summaries;
}

/**
 * Fan-in stream-detail summaries across multiple bindings.
 *
 * Returns a single stream view aggregating record counts and last_updated
 * across bindings, plus `available_connections` so callers can disambiguate
 * if they want to follow up with a `connection_id` filter.
 */
export async function getStreamDetailAcrossBindings(bindings, streamName, grant, manifest) {
  ensureBindingsOrThrow(bindings, { connectorId: bindings?.[0]?.connectorId });

  let recordCount = 0;
  let lastUpdated = null;
  const available = [];
  for (const binding of bindings) {
    const target = buildBindingStorageTarget(binding.connectorId, binding.connectorInstanceId);
    const summaries = await listStreams(target, { streams: grant.streams.filter((s) => s.name === streamName) }, manifest);
    const summary = summaries.find((s) => s.name === streamName);
    if (summary) {
      recordCount += Number(summary.record_count || 0);
      if (!lastUpdated || (summary.last_updated && summary.last_updated > lastUpdated)) {
        lastUpdated = summary.last_updated || lastUpdated;
      }
    }
    const wire = projectBindingForWire({
      connectorInstanceId: binding.connectorInstanceId,
      connectorId: binding.connectorId,
      displayName: binding.displayName,
    });
    if (wire) available.push(wire);
  }
  return {
    object: 'stream',
    name: streamName,
    record_count: recordCount,
    last_updated: lastUpdated,
    available_connections: available,
  };
}

/**
 * Resolve the request's bindings for a public-read route.
 *
 * Returns `{ bindings, requestConnectionId, warnings }`. `bindings` carries
 * `{ connectorInstanceId, connectorId, displayName? }` entries the caller
 * should iterate. `warnings` contains the deprecated-alias warning when
 * the caller used `connector_instance_id` on the wire.
 *
 * Honors per-stream `grant.streams[].connection_id` when present; absent
 * constraint preserves cross-connection (fan-in) semantics.
 */
export async function resolveReadRequestBindings({
  ownerSubjectId,
  storageBinding,
  grant,
  requestParams,
  streamName,
  nativeProviderStorage = false,
}) {
  // Canonicalize the storage binding's connector_id at the shared admission
  // boundary. A grant or owner storage binding may still carry the legacy
  // URL-shaped connector id (e.g. https://registry.pdpp.org/connectors/gmail);
  // connector_instances and records are keyed by the canonical key (`gmail`),
  // so listActiveByConnector must look up under that same canonical key or it
  // returns zero rows and the read fails connection_not_found. This mirrors
  // getConnectorManifestRow, which already accepts the URL alias at the
  // boundary and resolves canonically. See canonicalize-connector-keys
  // Decision 1: storage bindings and grants key by connector_key.
  const rawConnectorId = storageBinding?.connector_id || null;
  const connectorId = rawConnectorId
    ? canonicalConnectorKey(rawConnectorId) ?? rawConnectorId
    : null;
  if (nativeProviderStorage && connectorId) {
    const { connectionId } = resolveRequestConnectionId(requestParams);
    if (connectionId) {
      const err = new Error('connection_id is not applicable to provider_native sources.');
      err.code = 'invalid_argument';
      err.param =
        typeof requestParams?.connection_id === 'string' && requestParams.connection_id
          ? 'connection_id'
          : 'connector_instance_id';
      throw err;
    }
    return {
      bindings: [{
        connectorId,
        connectorInstanceId: storageBinding?.connector_instance_id
          || makeDefaultAccountConnectorInstanceId(OWNER_AUTH_DEFAULT_SUBJECT_ID, connectorId),
        displayName: null,
      }],
      requestConnectionId: null,
      warnings: [],
    };
  }

  const connectorInstanceIdHint = storageBinding?.connector_instance_id || null;
  const streamGrant = grant?.streams?.find?.((s) => s.name === streamName) || null;
  const grantStreamConnectionId = streamGrant?.connection_id || null;
  return await resolveRequestBindings({
    ownerSubjectId,
    connectorId,
    connectorInstanceIdHint,
    requestParams,
    grantStreamConnectionId,
  });
}

/**
 * Get/put sync state (Collection Profile, owner-authenticated).
 *
 * Persistence is delegated to the production `ConnectorStateStore`; this
 * function preserves the legacy signature (string | { connector_id }
 * storage target, `allowedStreams` accepts Set/array/null) so existing
 * route handlers and the runtime caller don't change shape.
 */
export async function getSyncState(storageTarget, opts = {}) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const { grantId = null, allowedStreams = null } = opts;
  return getDefaultConnectorStateStore().getState(
    { connectorId, connectorInstanceId, grantId },
    { allowedStreams },
  );
}

export async function putSyncState(storageTarget, stateMap, opts = {}) {
  const connectorId = resolveStorageConnectorId(storageTarget);
  const connectorInstanceId = resolveStorageConnectorInstanceId(storageTarget, connectorId);
  const { grantId = null, allowedStreams = null } = opts;
  const store = getDefaultConnectorStateStore();
  await store.putState({ connectorId, connectorInstanceId, grantId }, stateMap);
  return store.getState({ connectorId, connectorInstanceId, grantId }, { allowedStreams });
}

/**
 * Native capability inputs for the canonical `ref.dataset.summary` operation
 * (`reference-implementation/operations/ref-dataset-summary`). The operation
 * owns envelope assembly, `total_retained_bytes` derivation, top-connector
 * sort/limit, and the empty-corpus collapse rule; the helpers below are the
 * native dependency wiring the route hands in.
 *
 * Semantics preserved from the previous combined `getDatasetSummary`:
 * - `record_count`, `connector_count`, `stream_count`, and `record_json_bytes`
 *   count only live (non-soft-deleted) records — what normal reads would
 *   surface.
 * - `connector_count` is the legacy wire name for live configured
 *   connections (`connector_instance_id`); `stream_count` counts distinct
 *   `(connector_instance_id, stream)` observations in the live records table,
 *   not manifest-declared counts.
 * - `record_changes_json_bytes` sums the `record_changes` table — historical
 *   versions retained by design for change tracking. Included in
 *   `total_retained_bytes` because the substrate is honestly holding them.
 * - `blob_bytes` sums the whole `blobs` table (blobs are not soft-deleted).
 * - Byte fields use `LENGTH(CAST(... AS BLOB))` so multibyte JSON counts real
 *   bytes, not codepoints.
 * - `record_json_bytes` is an adapter-native operator diagnostic per
 *   `define-reference-operation-environments` contract correction (4); the
 *   operation preserves this and does not present it as a PDPP-stable metric.
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

/**
 * One-row aggregate over the live records substrate: counts and the
 * substrate's own ingest-time bounds. Coerces nullable / `BigInt`-shaped
 * SQLite outputs into the plain numbers the operation expects.
 */
export function getDatasetRecordsAggregate() {
  if (isPostgresStorageBackend()) {
    return postgresGetDatasetRecordsAggregate();
  }

  const recordAgg = getOne(referenceQueries.recordsDatasetGetRecordsAggregate);
  return {
    record_count: Number(recordAgg?.record_count || 0),
    connector_count: Number(recordAgg?.connector_count || 0),
    stream_count: Number(recordAgg?.stream_count || 0),
    record_json_bytes: Number(recordAgg?.record_json_bytes || 0),
    earliest_ingested_at:
      typeof recordAgg?.earliest_ingested_at === 'string'
        ? recordAgg.earliest_ingested_at
        : null,
    latest_ingested_at:
      typeof recordAgg?.latest_ingested_at === 'string'
        ? recordAgg.latest_ingested_at
        : null,
  };
}

/** Sum of `record_changes` JSON bytes (historical versions). */
export function getDatasetRecordChangesBytes() {
  if (isPostgresStorageBackend()) {
    return postgresGetDatasetRecordChangesBytes();
  }

  const changeAgg = getOne(referenceQueries.recordsDatasetGetRecordChangesBytes);
  return Number(changeAgg?.record_changes_json_bytes || 0);
}

/** Sum of `blobs` table bytes. */
export function getDatasetBlobBytes() {
  if (isPostgresStorageBackend()) {
    return postgresGetDatasetBlobBytes();
  }

  const blobAgg = getOne(referenceQueries.recordsDatasetGetBlobBytes);
  return Number(blobAgg?.blob_bytes || 0);
}

/**
 * Real-world record-time bounds across streams the manifest declares as
 * temporally meaningful (`consent_time_field`). Exposed so the
 * `ref.dataset.summary` operation's `getRecordTimeBounds` dependency can
 * call it on the native side.
 */
export async function getDatasetRecordTimeBounds() {
  if (isPostgresStorageBackend()) {
    return postgresGetDatasetRecordTimeBounds();
  }

  return getRealWorldTimeBounds();
}

/**
 * Candidate connectors for the top-N slot. The underlying SQL already orders
 * by `record_count DESC, connector_id ASC`, but the operation reapplies the
 * sort and limit so both adapters cannot drift. We collect every row here
 * (the connector corpus is small — tens of entries at most, well under the
 * registry's bounded-row cap) and let the operation own the limit.
 */
export function listDatasetTopConnectorCandidates() {
  if (isPostgresStorageBackend()) {
    return postgresListDatasetTopConnectorCandidates();
  }

  const candidates = [];
  for (const row of iterate(
    referenceQueries.recordsDatasetGetTopConnectorsByRecordCount,
  )) {
    candidates.push({
      connector_id: row.connector_id,
      record_count: Number(row.record_count || 0),
    });
  }
  return candidates;
}

export function listDatasetSummaryStreamProjectionSeeds() {
  if (isPostgresStorageBackend()) {
    return [];
  }

  const streamRows = getDb()
    .prepare(
      `SELECT connector_id,
              stream,
              COUNT(*) AS record_count,
              COALESCE(SUM(LENGTH(CAST(record_json AS BLOB))), 0) AS record_json_bytes,
              MIN(emitted_at) AS earliest_ingested_at,
              MAX(emitted_at) AS latest_ingested_at,
              0 AS dirty_record_time_bounds
         FROM records
        WHERE deleted = 0
        GROUP BY connector_id, stream`,
    )
    .all()
    .map((row) => seedDatasetSummaryStreamProjection(row));
  return streamRows;
}

export function getDatasetSummaryStreamRecordTimeBounds(connectorId, stream, consentTimeField) {
  if (isPostgresStorageBackend()) {
    return { earliest: null, latest: null };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(consentTimeField || '')) {
    throw new Error('unsafe consent_time_field for dataset summary stream reconciliation');
  }

  const jsonPath = `$.${consentTimeField}`;
  const result = getOne(
    referenceQueries.recordsDatasetGetStreamTimeBounds,
    [jsonPath, jsonPath, connectorId, stream],
  );
  return {
    earliest: typeof result?.min_time === 'string' ? result.min_time : null,
    latest: typeof result?.max_time === 'string' ? result.max_time : null,
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

function seedDatasetSummaryStreamProjection(row) {
  const consentTimeField = getManifestConsentTimeField(row.connector_id, row.stream);
  const recordTimeBounds = consentTimeField
    ? getDatasetSummaryStreamRecordTimeBounds(row.connector_id, row.stream, consentTimeField)
    : { earliest: null, latest: null };
  return {
    connector_id: row.connector_id,
    stream: row.stream,
    record_count: Number(row.record_count || 0),
    record_json_bytes: Number(row.record_json_bytes || 0),
    earliest_ingested_at: row.earliest_ingested_at || null,
    latest_ingested_at: row.latest_ingested_at || null,
    earliest_record_time: recordTimeBounds.earliest,
    latest_record_time: recordTimeBounds.latest,
    consent_time_field: consentTimeField,
    dirty_record_time_bounds: 0,
  };
}

function getManifestConsentTimeField(connectorId, streamName) {
  const row = getOne(referenceQueries.authConnectorsGetManifestById, [connectorId]);
  if (!row?.manifest) return null;

  let manifest;
  try {
    manifest = JSON.parse(row.manifest);
  } catch {
    return null;
  }
  const stream = Array.isArray(manifest?.streams)
    ? manifest.streams.find((candidate) => candidate?.name === streamName)
    : null;
  const field = stream?.consent_time_field;
  if (typeof field !== 'string' || !field) return null;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(field) ? field : null;
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
