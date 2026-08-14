// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";

export interface Schema {
  format?: string;
  type?: string | string[];
  [key: string]: unknown;
}
type JsonObject = Record<string, unknown>;
interface StreamGrant {
  fields?: string[] | null;
  resources?: string[];
  time_constraint?: TimeConstraint | null;
}
interface ManifestStream {
  consent_time_field?: string;
  name?: string;
  query?: {
    range_filters?: Record<string, string[]>;
    search?: { lexical_fields?: string[]; semantic_fields?: string[] };
  };
  schema?: { properties?: Record<string, Schema> };
}
export type CompiledFilter =
  | { field: string; kind: "exact"; value: string }
  | { field: string; kind: "range"; fieldSchema: Schema; operators: Record<string, number | string> };
interface CompiledFilterInput {
  field: string;
  fieldSchema?: Schema;
  kind?: string;
  operators?: Record<string, number | string | null>;
  value?: string;
}
interface SearchPlanEntry {
  connectorInstanceId?: string;
  searchableFields: string[];
  streamName: string;
}
interface SearchPlan {
  connectorId?: string;
  planEntries: SearchPlanEntry[];
}
interface RecordRow {
  record_json?: string | null;
  record_key: string;
}

class QueryError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export interface TimeConstraint {
  field: string;
  since?: string;
  until?: string;
}

interface TimeRange {
  since?: string;
  until?: string;
}

class GrantConstraintError extends Error {
  readonly code = "grant_invalid";
}

const SUPPORTED_RANGE_OPERATORS = new Set(["gte", "gt", "lte", "lt"]);

export function invalidQueryError(message: string, code = "invalid_request"): Error & { code: string } {
  return new QueryError(message, code);
}

/**
 * v0.1 client grants do not expose request-time filters or retain relationship
 * authorization. Keep this guard independent from manifest parsing so current
 * declaration metadata cannot reinterpret an issued grant. Owner reads retain
 * the current-capability query paths.
 */
export function rejectUnsupportedClientQuery(tokenKind: string | null | undefined, requestParams: unknown): void {
  if (tokenKind !== "client" || !requestParams || typeof requestParams !== "object" || Array.isArray(requestParams)) {
    return;
  }
  const params = requestParams as Record<string, unknown>;
  const unsupported = [
    { keys: ["expand", "expand[]"], message: "expand[]", param: "expand" },
    { keys: ["expand_limit", "expand_limit[]"], message: "expand_limit[...]", param: "expand_limit" },
    { keys: ["filter"], message: "filter[...]", param: "filter" },
  ].find(({ keys }) => keys.some((key) => Object.hasOwn(params, key)));
  if (!unsupported) {
    return;
  }
  const error = invalidQueryError(`${unsupported.message} is not supported for client-token reads in PDPP v0.1`);
  Object.assign(error, { param: unsupported.param });
  throw error;
}

export function getFieldSchema(manifestStream: ManifestStream | null | undefined, field: string): Schema | null {
  return manifestStream?.schema?.properties?.[field] || null;
}

function isNullish(value: unknown): value is null | undefined {
  return value === null || value === undefined;
}

export function nonNullSchemaTypes(schema: Schema | null | undefined): Set<string> {
  const raw = schema?.type;
  if (isNullish(raw)) {
    return new Set();
  }
  const list = Array.isArray(raw) ? raw : [raw];
  return new Set(list.filter((type): type is string => typeof type === "string" && type !== "null"));
}

const SCALAR_SCHEMA_TYPES = new Set(["boolean", "integer", "number", "string"]);

function isScalarFieldSchema(fieldSchema: Schema): boolean {
  const types = nonNullSchemaTypes(fieldSchema);
  if (types.size !== 1) {
    return false;
  }
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const only = [...types][0];
  return only !== undefined && SCALAR_SCHEMA_TYPES.has(only);
}

function isRangeQueryableSchema(fieldSchema: Schema): boolean {
  const types = nonNullSchemaTypes(fieldSchema);
  if (types.size !== 1) {
    return false;
  }
  if (types.has("integer") || types.has("number")) {
    return true;
  }
  if (types.has("string")) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    return fieldSchema?.format === "date" || fieldSchema?.format === "date-time";
  }
  return false;
}

function parseIntegerValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  if (typeof value !== "string" || !/^-?\d+$/.test(value.trim())) {
    return null;
  }
  return Number.parseInt(value.trim(), 10);
}

function parseNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseDateValue(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function requireTimeConstraint(value: unknown): TimeConstraint | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new GrantConstraintError("Grant time_constraint must be an object");
  }
  const constraint = value as Record<string, unknown>;
  const unsupported = Object.keys(constraint).filter((key) => !["field", "since", "until"].includes(key));
  const field = typeof constraint.field === "string" ? constraint.field : "";
  const { since, until } = constraint;
  const sinceMs = since === undefined ? null : parseDateValue(since);
  const untilMs = until === undefined ? null : parseDateValue(until);
  if (
    unsupported.length > 0 ||
    !field ||
    (since === undefined && until === undefined) ||
    (since !== undefined && sinceMs === null) ||
    (until !== undefined && untilMs === null) ||
    (sinceMs !== null && untilMs !== null && sinceMs > untilMs)
  ) {
    throw new GrantConstraintError("Grant time_constraint is malformed");
  }
  return {
    field,
    ...(typeof since === "string" ? { since } : {}),
    ...(typeof until === "string" ? { until } : {}),
  };
}

export function coerceComparableValue(
  value: unknown,
  fieldSchema: Schema | null | undefined,
  { strict = false }: { strict?: boolean } = {}
): string | number | null {
  if (isNullish(value)) {
    return null;
  }

  const types = nonNullSchemaTypes(fieldSchema);
  const only = types.size === 1 ? [...types][0] : null;

  if (only === "integer") {
    const parsed = parseIntegerValue(value);
    if (parsed === null && strict) {
      throw invalidQueryError(`Invalid integer value for '${String(value)}'`);
    }
    return parsed;
  }

  if (only === "number") {
    const parsed = parseNumberValue(value);
    if (parsed === null && strict) {
      throw invalidQueryError(`Invalid number value for '${String(value)}'`);
    }
    return parsed;
  }

  if (only === "string" && (fieldSchema?.format === "date" || fieldSchema?.format === "date-time")) {
    const parsed = parseDateValue(value);
    if (parsed === null && strict) {
      throw invalidQueryError(`Invalid date value for '${String(value)}'`);
    }
    return parsed;
  }

  return String(value);
}

function normalizeExactFilterValue(value: unknown, field: string): string {
  if (value !== null && typeof value === "object") {
    throw invalidQueryError(`Exact filter on '${field}' must use a scalar value`);
  }
  return String(value);
}

function compileRangeFilter(
  field: string,
  rawValue: Record<string, unknown>,
  fieldSchema: Schema,
  manifestStream: ManifestStream
): CompiledFilter {
  const operatorEntries = Object.entries(rawValue);
  if (!operatorEntries.length) {
    throw invalidQueryError(`Range filter on '${field}' must include at least one operator`);
  }
  if (!isRangeQueryableSchema(fieldSchema)) {
    throw invalidQueryError(`Range filters are not supported on '${field}'`);
  }

  const declaredOperators = manifestStream.query?.range_filters?.[field];
  if (!(Array.isArray(declaredOperators) && declaredOperators.length)) {
    throw invalidQueryError(`Range filters are not declared for '${field}'`);
  }
  const declaredOperatorSet = new Set(declaredOperators);
  const operators: Record<string, number | string> = {};

  for (const [operator, operand] of operatorEntries) {
    if (!SUPPORTED_RANGE_OPERATORS.has(operator)) {
      throw invalidQueryError(`Unsupported range operator '${operator}' on '${field}'`);
    }
    if (!declaredOperatorSet.has(operator)) {
      throw invalidQueryError(`Range operator '${operator}' is not declared for '${field}'`);
    }
    const comparable = coerceComparableValue(operand, fieldSchema, { strict: true });
    if (comparable === null) {
      throw invalidQueryError(`Invalid range value for '${field}'`);
    }
    operators[operator] = comparable;
  }

  return { field, fieldSchema, kind: "range", operators };
}

export function compileRequestFilters(
  filter: unknown,
  streamGrant: StreamGrant,
  manifestStream: ManifestStream
): CompiledFilter[] {
  if (isNullish(filter)) {
    return [];
  }
  if (typeof filter !== "object" || Array.isArray(filter)) {
    throw invalidQueryError("filter must use filter[field]=value or filter[field][op]=value");
  }

  // biome-ignore lint/suspicious/noEvolvingTypes: This runtime-untyped boundary requires staged type narrowing.
  const compiled = [];
  for (const [field, rawValue] of Object.entries(filter)) {
    if (streamGrant.fields && !streamGrant.fields.includes(field)) {
      throw invalidQueryError(`Filter on field '${field}' not in grant`, "field_not_granted");
    }

    const fieldSchema = getFieldSchema(manifestStream, field);
    if (!fieldSchema) {
      // Per-stream schema miss: field exists in the request but not this
      // stream's manifest schema. Code 'filter_field_not_in_schema' lets
      // fan-out owner-mode paths skip inapplicable connectors without
      // suppressing hard per-field errors (undeclared range, unsupported op).
      throw invalidQueryError(`Unknown field: ${field}`, "filter_field_not_in_schema");
    }

    if (rawValue && typeof rawValue === "object" && !Array.isArray(rawValue)) {
      compiled.push(compileRangeFilter(field, rawValue, fieldSchema, manifestStream));
      continue;
    }

    if (!isScalarFieldSchema(fieldSchema)) {
      throw invalidQueryError(`Exact filters are supported only on top-level scalar fields; '${field}' is not scalar`);
    }

    compiled.push({
      field,
      kind: "exact",
      value: normalizeExactFilterValue(rawValue, field),
    } satisfies CompiledFilter);
  }

  return compiled;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
export function passesRequestFilters(
  data: JsonObject | null,
  filters: readonly CompiledFilterInput[] | null | undefined
): boolean {
  if (!filters?.length) {
    return true;
  }

  for (const filter of filters) {
    const value = data?.[filter.field];

    if (filter.kind === "exact") {
      if (String(value) !== filter.value) {
        return false;
      }
      continue;
    }

    const comparable = coerceComparableValue(value, filter.fieldSchema);
    if (comparable === null) {
      return false;
    }
    const { gte, gt, lte, lt } = filter.operators ?? {};
    if (gte !== null && gte !== undefined && comparable < gte) {
      return false;
    }
    if (gt !== null && gt !== undefined && comparable <= gt) {
      return false;
    }
    if (lte !== null && lte !== undefined && comparable > lte) {
      return false;
    }
    if (lt !== null && lt !== undefined && comparable >= lt) {
      return false;
    }
  }

  return true;
}

export function passesTimeRange(
  data: JsonObject | null,
  timeRange: TimeRange | null | undefined,
  consentTimeField: string | null | undefined
): boolean {
  if (!(timeRange && consentTimeField)) {
    return true;
  }
  const val = data?.[consentTimeField];
  if (!val) {
    return false;
  }
  const t = new Date(typeof val === "string" || typeof val === "number" ? val : String(val)).getTime();
  if (Number.isNaN(t)) {
    return false;
  }
  if (timeRange.since && t < new Date(timeRange.since).getTime()) {
    return false;
  }
  if (timeRange.until && t >= new Date(timeRange.until).getTime()) {
    return false;
  }
  return true;
}

export function passesTimeConstraint(data: JsonObject | null, value: unknown): boolean {
  const constraint = requireTimeConstraint(value);
  if (!constraint) {
    return true;
  }
  const recordTime = parseDateValue(data?.[constraint.field]);
  if (recordTime === null) {
    return false;
  }
  const since = constraint.since === undefined ? null : parseDateValue(constraint.since);
  const until = constraint.until === undefined ? null : parseDateValue(constraint.until);
  return !((since !== null && recordTime < since) || (until !== null && recordTime >= until));
}

export function passesGrantRecordConstraints(
  data: JsonObject | null,
  recordKey: string,
  streamGrant: StreamGrant | null | undefined,
  _manifestStream: ManifestStream
): boolean {
  if (streamGrant?.resources?.length && !streamGrant.resources.includes(recordKey)) {
    return false;
  }
  return passesTimeConstraint(data, streamGrant?.time_constraint);
}

export function compileSingleStreamSearchFilter({
  manifest,
  grant,
  streamName,
  filter,
}: {
  manifest?: { streams?: ManifestStream[] } | null;
  grant?: { streams?: (StreamGrant & { name: string })[] } | null;
  streamName?: string | null;
  filter?: unknown;
}): { streamName: string; filters: CompiledFilter[] } | null {
  if (!streamName) {
    return null;
  }
  const manifestStream = (manifest?.streams || []).find((s) => s.name === streamName);
  if (!manifestStream) {
    return null;
  }
  const streamGrant = (grant?.streams || []).find((s) => s.name === streamName);
  if (!streamGrant) {
    return null;
  }
  return {
    filters: compileRequestFilters(filter, streamGrant, manifestStream),
    streamName,
  };
}

export function fingerprintDeclaredFields(declaredFields: string[]): string {
  const unique = Array.from(new Set(declaredFields));
  unique.sort();
  return JSON.stringify(unique);
}

export function jsonPathForTopLevelField(field: unknown): string {
  return `$."${String(field).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function generateSnapshotId() {
  return `snap_${randomBytes(8).toString("hex")}`;
}

export function hashSearchPlanSummary({
  perConnectorPlans,
  isOwner,
}: {
  perConnectorPlans: SearchPlan[];
  isOwner: boolean;
}): string {
  const summary = perConnectorPlans
    .map((p) => ({
      c: p.connectorId,
      e: p.planEntries
        .map((pe) => ({
          f: pe.searchableFields.slice().sort(),
          i: pe.connectorInstanceId || null,
          s: pe.streamName,
        }))
        .sort((a, b) => {
          const ia = a.i || "";
          const ib = b.i || "";
          if (ia !== ib) {
            return ia < ib ? -1 : 1;
          }
          // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
          return a.s < b.s ? -1 : a.s > b.s ? 1 : 0;
        }),
    }))
    // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
    .sort((a, b) => ((a.c || "") < (b.c || "") ? -1 : (a.c || "") > (b.c || "") ? 1 : 0));
  return JSON.stringify({ isOwner, summary });
}

export function hasGrantRecordConstraints(streamGrant: StreamGrant | null | undefined): boolean {
  return !!(
    streamGrant?.time_constraint ||
    (Array.isArray(streamGrant?.resources) && streamGrant.resources.length > 0)
  );
}

export function needsCandidateRecordScan(
  streamGrant: StreamGrant | null,
  compiledFilters: readonly CompiledFilterInput[] | null | undefined
): boolean {
  return !!(compiledFilters?.length || hasGrantRecordConstraints(streamGrant));
}

export function allowedCandidateRecordKeysFromRows(
  rows: RecordRow[],
  {
    streamGrant,
    manifestStream,
    compiledFilters,
  }: {
    streamGrant: StreamGrant;
    manifestStream: ManifestStream;
    compiledFilters: readonly CompiledFilterInput[];
  }
): string[] {
  // biome-ignore lint/suspicious/noEvolvingTypes: This runtime-untyped boundary requires staged type narrowing.
  const allowed = [];
  for (const row of rows) {
    // biome-ignore lint/suspicious/noEvolvingTypes: This runtime-untyped boundary requires staged type narrowing.
    // biome-ignore lint/suspicious/noImplicitAnyLet: This runtime value is intentionally narrowed after assignment.
    let data;
    try {
      data = row.record_json ? JSON.parse(row.record_json) : null;
    } catch {
      continue;
    }
    if (!passesGrantRecordConstraints(data, row.record_key, streamGrant, manifestStream)) {
      continue;
    }
    if (!passesRequestFilters(data, compiledFilters)) {
      continue;
    }
    allowed.push(row.record_key);
  }
  return allowed;
}
