// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { AggregateGranularity } from "./aggregate-time-buckets.ts";
import { resolveAggregateTimeZone, SUPPORTED_AGGREGATE_GRANULARITIES } from "./aggregate-time-buckets.ts";
import { validateConnectionAlias as validateConnectionAliasShared } from "./connection-id-request.js";
import { invalidQueryError } from "./record-expand-helpers.js";
import { type FieldSchema, getFieldSchema, nonNullSchemaTypes } from "./schema-coercion.ts";

interface StreamGrantShape {
  fields?: string[] | null;
}

interface ManifestStreamSchemaShape {
  properties?: Record<string, FieldSchema> | null;
  // Required for assignability to schema-coercion.ts's ManifestStreamSchema (exactOptionalPropertyTypes).
  [key: string]: unknown;
}

interface ManifestStreamAggregationsShape {
  count?: boolean;
  count_distinct?: string[];
  group_by?: string[];
  group_by_time?: string[];
  max?: string[];
  min?: string[];
  sum?: string[];
}

interface ManifestStreamQueryShape {
  aggregations?: ManifestStreamAggregationsShape | null;
}

interface ManifestStreamShape {
  name?: string | null;
  query?: ManifestStreamQueryShape | null;
  schema?: ManifestStreamSchemaShape | null;
  // Required for assignability to schema-coercion.ts's ManifestStream (exactOptionalPropertyTypes).
  [key: string]: unknown;
}

const SUPPORTED_AGGREGATE_QUERY_PARAMS = new Set([
  "connection_id",
  "connector_id",
  "connector_instance_id",
  "field",
  "filter",
  "granularity",
  "group_by",
  "group_by_time",
  "limit",
  "metric",
  "subject_id",
  "time_zone",
]);

const SUPPORTED_AGGREGATE_METRICS = new Set(["count", "sum", "min", "max", "count_distinct"]);
const MAX_AGGREGATE_GROUP_LIMIT = 100;
const DEFAULT_AGGREGATE_GROUP_LIMIT = 10;

const AGGREGATE_SCALAR_SCHEMA_TYPES = new Set(["boolean", "integer", "number", "string"]);

function isScalarAggregateSchema(fieldSchema: FieldSchema | null | undefined): boolean {
  const types = nonNullSchemaTypes(fieldSchema);
  if (types.size !== 1) {
    return false;
  }
  const only = [...types][0];
  return only !== undefined && AGGREGATE_SCALAR_SCHEMA_TYPES.has(only);
}

function isNumericAggregateSchema(fieldSchema: FieldSchema | null | undefined): boolean {
  const types = nonNullSchemaTypes(fieldSchema);
  return types.size === 1 && (types.has("integer") || types.has("number"));
}

function isMinMaxAggregateSchema(fieldSchema: FieldSchema | null | undefined): boolean {
  const types = nonNullSchemaTypes(fieldSchema);
  if (types.size !== 1) {
    return false;
  }
  if (types.has("integer") || types.has("number")) {
    return true;
  }
  return types.has("string") && (fieldSchema?.format === "date" || fieldSchema?.format === "date-time");
}

function validateTopLevelAggregateParams(requestParams: Record<string, unknown>): void {
  const unsupported = Object.keys(requestParams).filter((key) => !SUPPORTED_AGGREGATE_QUERY_PARAMS.has(key));
  if (unsupported.length) {
    throw invalidQueryError(`Unsupported query parameter: ${unsupported.join(", ")}`);
  }
  validateConnectionAliasShared(requestParams);
}

function normalizeAggregateMetric(value: unknown): string {
  const metric = String(value || "").trim();
  if (!SUPPORTED_AGGREGATE_METRICS.has(metric)) {
    throw invalidQueryError("metric must be one of count, sum, min, max, count_distinct");
  }
  return metric;
}

function normalizeAggregateLimit(value: unknown, grouped: boolean): number | null {
  if (!grouped) {
    if (value != null) {
      throw invalidQueryError("limit is only supported with group_by or group_by_time");
    }
    return null;
  }
  if (value == null || value === "") {
    return DEFAULT_AGGREGATE_GROUP_LIMIT;
  }
  if (Array.isArray(value) || (typeof value === "object" && value !== null)) {
    throw invalidQueryError("limit must be an integer");
  }
  const limit = Number.parseInt(String(value), 10);
  if (
    !Number.isInteger(limit) ||
    String(limit) !== String(value).trim() ||
    limit < 1 ||
    limit > MAX_AGGREGATE_GROUP_LIMIT
  ) {
    throw invalidQueryError(`limit must be an integer between 1 and ${MAX_AGGREGATE_GROUP_LIMIT}`);
  }
  return limit;
}

function getDeclaredAggregateFields(manifestStream: ManifestStreamShape | null | undefined, kind: string): string[] {
  const aggs = manifestStream?.query?.aggregations;
  if (!aggs || typeof aggs !== "object") {
    return [];
  }
  const fields = (aggs as Record<string, unknown>)[kind];
  return Array.isArray(fields) ? (fields as string[]) : [];
}

function requireDeclaredAggregate(
  manifestStream: ManifestStreamShape | null | undefined,
  kind: string,
  field: string
): void {
  if (!getDeclaredAggregateFields(manifestStream, kind).includes(field)) {
    throw invalidQueryError(`Aggregation ${kind} is not declared for '${field}'`);
  }
}

function requireAggregateFieldGranted(streamGrant: StreamGrantShape, field: string): void {
  if (streamGrant.fields && !streamGrant.fields.includes(field)) {
    throw invalidQueryError(`Aggregation field '${field}' not in grant`, "field_not_granted");
  }
}

export interface AggregateRequestParams {
  field?: unknown;
  granularity?: unknown;
  group_by?: unknown;
  group_by_time?: unknown;
  limit?: unknown;
  metric?: unknown;
  time_zone?: unknown;
  [key: string]: unknown;
}

export interface NormalizedAggregateRequest {
  field: string | null;
  granularity: AggregateGranularity | null;
  groupBy: string | null;
  groupByTime: string | null;
  limit: number | null;
  metric: string;
  timeZone: string | null;
}

function resolveGranularityAndTimeZone(
  groupByTime: string | null,
  granularityRaw: string | null,
  timeZoneRaw: string | null
): { granularity: AggregateGranularity | null; timeZone: string | null } {
  // granularity is required with group_by_time and forbidden otherwise.
  if (groupByTime) {
    if (!granularityRaw) {
      throw invalidQueryError("granularity is required when group_by_time is present");
    }
    if (!SUPPORTED_AGGREGATE_GRANULARITIES.has(granularityRaw)) {
      throw invalidQueryError(`granularity must be one of ${[...SUPPORTED_AGGREGATE_GRANULARITIES].join(", ")}`);
    }
    return { granularity: granularityRaw as AggregateGranularity, timeZone: resolveAggregateTimeZone(timeZoneRaw) };
  }
  if (granularityRaw) {
    throw invalidQueryError("granularity is only supported with group_by_time");
  }
  if (timeZoneRaw) {
    throw invalidQueryError("time_zone is only supported with group_by_time");
  }
  return { granularity: null, timeZone: null };
}

function validateCountMetric(
  field: string | null,
  aggregations: ManifestStreamAggregationsShape,
  manifestStream: ManifestStreamShape | null | undefined
): void {
  if (field) {
    throw invalidQueryError("field is not supported for count");
  }
  if (aggregations.count !== true) {
    throw invalidQueryError(`Count aggregation is not declared for stream '${manifestStream?.name || ""}'`);
  }
}

function validateCountDistinctMetric(
  field: string | null,
  grouped: boolean,
  streamGrant: StreamGrantShape,
  manifestStream: ManifestStreamShape | null | undefined
): void {
  if (grouped) {
    throw invalidQueryError("count_distinct does not support grouping; omit group_by and group_by_time");
  }
  if (!field) {
    throw invalidQueryError("field is required for count_distinct");
  }
  const fieldSchema = getFieldSchema(manifestStream, field);
  if (!fieldSchema) {
    throw invalidQueryError(`Unknown field: ${field}`, "unknown_field");
  }
  requireAggregateFieldGranted(streamGrant, field);
  requireDeclaredAggregate(manifestStream, "count_distinct", field);
  if (!isScalarAggregateSchema(fieldSchema)) {
    throw invalidQueryError(`count_distinct requires a scalar field; '${field}' is not scalar`);
  }
}

function validateNumericMetric(
  metric: string,
  field: string | null,
  grouped: boolean,
  streamGrant: StreamGrantShape,
  manifestStream: ManifestStreamShape | null | undefined
): void {
  if (grouped) {
    throw invalidQueryError(
      `${metric} does not support grouping; group_by and group_by_time are only valid with metric=count`
    );
  }
  if (!field) {
    throw invalidQueryError(`field is required for ${metric}`);
  }
  const fieldSchema = getFieldSchema(manifestStream, field);
  if (!fieldSchema) {
    throw invalidQueryError(`Unknown field: ${field}`, "unknown_field");
  }
  requireAggregateFieldGranted(streamGrant, field);
  requireDeclaredAggregate(manifestStream, metric, field);
  if (metric === "sum" && !isNumericAggregateSchema(fieldSchema)) {
    throw invalidQueryError(`Aggregation sum requires a numeric field; '${field}' is not numeric`);
  }
  if ((metric === "min" || metric === "max") && !isMinMaxAggregateSchema(fieldSchema)) {
    throw invalidQueryError(
      `Aggregation ${metric} requires a numeric, date, or date-time field; '${field}' is not supported`
    );
  }
}

function validateGroupBy(
  groupBy: string,
  streamGrant: StreamGrantShape,
  manifestStream: ManifestStreamShape | null | undefined
): void {
  const groupSchema = getFieldSchema(manifestStream, groupBy);
  if (!groupSchema) {
    throw invalidQueryError(`Unknown field: ${groupBy}`, "unknown_field");
  }
  requireAggregateFieldGranted(streamGrant, groupBy);
  requireDeclaredAggregate(manifestStream, "group_by", groupBy);
  if (!isScalarAggregateSchema(groupSchema)) {
    throw invalidQueryError(`Grouped counts require a scalar field; '${groupBy}' is not scalar`);
  }
}

function validateGroupByTime(
  groupByTime: string,
  metric: string,
  streamGrant: StreamGrantShape,
  manifestStream: ManifestStreamShape | null | undefined
): void {
  if (metric !== "count") {
    throw invalidQueryError("group_by_time is only valid with metric=count");
  }
  const timeSchema = getFieldSchema(manifestStream, groupByTime);
  if (!timeSchema) {
    throw invalidQueryError(`Unknown field: ${groupByTime}`, "unknown_field");
  }
  requireAggregateFieldGranted(streamGrant, groupByTime);
  requireDeclaredAggregate(manifestStream, "group_by_time", groupByTime);
  if (!isMinMaxAggregateSchema(timeSchema) || nonNullSchemaTypes(timeSchema).has("string") === false) {
    // group_by_time fields are declared date/date-time strings (validated at
    // manifest time); reject anything that slipped through as non-date.
    throw invalidQueryError(`group_by_time requires a date or date-time field; '${groupByTime}' is not supported`);
  }
}

function toOptionalString(value: unknown): string | null {
  return value == null || value === "" ? null : String(value).trim();
}

function parseAggregateRequestDimensions(requestParams: AggregateRequestParams): {
  field: string | null;
  groupBy: string | null;
  groupByTime: string | null;
  granularityRaw: string | null;
  timeZoneRaw: string | null;
} {
  return {
    field: toOptionalString(requestParams.field),
    groupBy: toOptionalString(requestParams.group_by),
    groupByTime: toOptionalString(requestParams.group_by_time),
    granularityRaw: toOptionalString(requestParams.granularity),
    timeZoneRaw: toOptionalString(requestParams.time_zone),
  };
}

export function normalizeAggregateRequest(
  requestParams: AggregateRequestParams,
  streamGrant: StreamGrantShape,
  manifestStream: ManifestStreamShape | null | undefined
): NormalizedAggregateRequest {
  validateTopLevelAggregateParams(requestParams);

  const aggregations = manifestStream?.query?.aggregations;
  if (!aggregations || typeof aggregations !== "object" || Array.isArray(aggregations)) {
    throw invalidQueryError(`Aggregations are not declared for stream '${manifestStream?.name || ""}'`);
  }

  const metric = normalizeAggregateMetric(requestParams.metric);
  const { field, groupBy, groupByTime, granularityRaw, timeZoneRaw } = parseAggregateRequestDimensions(requestParams);

  // Exactly one grouping dimension in v1: group_by XOR group_by_time.
  if (groupBy && groupByTime) {
    throw invalidQueryError("group_by and group_by_time cannot be combined; choose one grouping dimension");
  }
  const grouped = Boolean(groupBy || groupByTime);
  const limit = normalizeAggregateLimit(requestParams.limit, grouped);

  const { granularity, timeZone } = resolveGranularityAndTimeZone(groupByTime, granularityRaw, timeZoneRaw);

  if (metric === "count") {
    validateCountMetric(field, aggregations, manifestStream);
  } else if (metric === "count_distinct") {
    validateCountDistinctMetric(field, grouped, streamGrant, manifestStream);
  } else {
    validateNumericMetric(metric, field, grouped, streamGrant, manifestStream);
  }

  if (groupBy) {
    validateGroupBy(groupBy, streamGrant, manifestStream);
  }

  if (groupByTime) {
    validateGroupByTime(groupByTime, metric, streamGrant, manifestStream);
  }

  return { metric, field, groupBy, groupByTime, granularity, timeZone, limit };
}
