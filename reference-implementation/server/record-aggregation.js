/**
 * record-aggregation: request normalization + time-bucketing + metric/schema validation.
 *
 * Invariant: every normalizedAggregateRequest returned by normalizeAggregateRequest
 * is valid under metric/field/schema/zone/grouping rules — callers may execute
 * the aggregation without re-checking these constraints.
 *
 * This module is import-direction clean: it imports from record-filters.js and
 * connection-id-request.js, but NEVER from records.js (no back-edge).
 */

import {
  getFieldSchema,
  invalidQueryError,
  nonNullSchemaTypes,
  parseDateValue,
} from './record-filters.js';
import { validateConnectionAlias } from './connection-id-request.js';

const SUPPORTED_AGGREGATE_METRICS = new Set(['count', 'sum', 'min', 'max', 'count_distinct']);
const MAX_AGGREGATE_GROUP_LIMIT = 100;
const DEFAULT_AGGREGATE_GROUP_LIMIT = 10;
// Calendar `date_trunc` granularity set for `group_by_time` (weeks start
// Monday). See openspec/changes/add-aggregate-time-buckets-and-distinct.
const SUPPORTED_AGGREGATE_GRANULARITIES = new Set([
  'minute', 'hour', 'day', 'week', 'month', 'quarter', 'year',
]);

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

// --- group_by_time calendar bucketing --------------------------------------
//
// The in-process aggregate floor computes time buckets with calendar
// `date_trunc` semantics (weeks start Monday) in the effective IANA zone,
// using `Intl.DateTimeFormat` so day/week/month/quarter/year boundaries
// respect the zone and DST without a SQL round trip. Bucket keys are ISO
// strings: a date (`YYYY-MM-DD`) for day/week/month/quarter/year, and a
// minute/hour timestamp (`YYYY-MM-DDTHH:MM:00Z`-style, zone-qualified) for the
// sub-day units. See openspec/changes/add-aggregate-time-buckets-and-distinct.

export function resolveAggregateTimeZone(rawZone) {
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
export function bucketStartForGranularity(value, granularity, timeZone) {
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

export function normalizeAggregateRequest(requestParams, streamGrant, manifestStream) {
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

