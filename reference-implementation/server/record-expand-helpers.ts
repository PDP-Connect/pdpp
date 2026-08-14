// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Storage-agnostic helpers shared by the SQLite and Postgres record paths.
 *
 * Extracted so both backends can validate `expand[]` / `expand_limit[]`
 * requests through the same parser (`normalizeExpandRequest`) and compute
 * the same effective grant projection for child rows during expansion
 * hydration (`buildEffectiveFilter`).
 *
 * Spec: openspec/changes/add-postgres-expand-hydration/specs/
 *       reference-implementation-architecture/spec.md
 *       (the parser and projection requirements that both backends share).
 */

import { requireTimeConstraint, type TimeConstraint } from "./record-filters.ts";

export type JsonObject = Record<string, unknown>;
type RecordKey = unknown;
class QueryError extends Error {
  code: string;
  param?: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}
interface EffectiveFilterGrant {
  fields?: string[] | null;
  instance_ids?: string[] | null;
  resources?: string[] | null;
  time_constraint?: TimeConstraint | null;
}
export interface EffectiveFilter {
  fields: string[] | null;
  resources: string[] | null;
  timeConstraint: TimeConstraint | null;
  timeConstraintField: string | null;
}
interface ExpandGrant {
  streams: Array<{
    name: string;
    fields?: string[] | null;
    instance_ids?: string[] | null;
    time_constraint?: TimeConstraint | null;
    resources?: string[] | null;
  }>;
}
interface RequestParams {
  expand?: string | string[] | JsonObject | null;
  expand_limit?: Record<string, unknown> | string | number | null;
  fields?: string[];
}
export interface ExpandResult {
  childGrant: ExpandGrant["streams"][number];
  limit: number;
  name: string;
  order: unknown;
  relationship: Relationship;
}
interface Relationship {
  cardinality: string;
  name: string;
  stream: string;
  [key: string]: unknown;
}
interface ExpandCapability {
  default_limit?: unknown;
  max_limit?: unknown;
  name: string;
  [key: string]: unknown;
}
interface ManifestStream {
  query?: { expand?: ExpandCapability[] };
  relationships?: Relationship[];
}

export function invalidQueryError(message: string, code = "invalid_request"): QueryError {
  return new QueryError(message, code);
}

export function normalizePrimaryKey(primaryKey: unknown): string[] {
  if (Array.isArray(primaryKey)) {
    return primaryKey.filter((field) => typeof field === "string" && field.length > 0);
  }
  if (typeof primaryKey === "string" && primaryKey.length > 0) {
    return [primaryKey];
  }
  return [];
}

// Shared write-path identity guard used by both the SQLite and Postgres record
// stores so the two backends cannot diverge. `primaryKeyFields` is the
// manifest-declared primary_key (already normalized); `key` is the record's
// key tuple (single string for a one-field key, ordered array for compound).
// Each declared field present in `data` must equal its position in the key
// tuple. Fields omitted from `data` are not checked. When no primary-key fields
// are known, falls back to the legacy `data.id` guard so the common ["id"] case
// is never silently unvalidated. Throws an Error with code
// 'invalid_record_identity' on mismatch.
// Legacy fallback used when no primary-key fields are known: the common
// ["id"] case is never silently unvalidated. A single-field key arrives as a
// scalar; anything else (or a mismatch) is compared against `data.id`.
function assertLegacyIdIdentity(key: RecordKey, data: JsonObject): void {
  // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
  const single = typeof key === "string" ? key : Array.isArray(key) && key.length === 1 ? key[0] : null;
  if (single !== null && data.id !== undefined && data.id !== single) {
    throw new QueryError(`key and data.id disagree: key=${single}, data.id=${data.id}`, "invalid_record_identity");
  }
}

// Compare each declared primary-key field present in `data` against its
// position in the key tuple. A single-field key arrives as a scalar (string or
// number; encodeKey stores either as a string downstream); a compound key
// arrives as an array. Fields omitted from `data`, and key positions the key
// tuple does not provide, are not checked.
function assertPrimaryKeyIdentity(fields: string[], key: RecordKey, data: JsonObject): void {
  // biome-ignore lint/style/noNestedTernary: The existing expression mirrors the protocol’s compact value selection contract.
  const keyParts = typeof key === "string" || typeof key === "number" ? [String(key)] : Array.isArray(key) ? key : [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field === undefined) {
      continue;
    }
    const dataValue = data[field];
    if (dataValue === undefined) {
      continue;
    }
    // The key tuple may be shorter than the declared primary_key (a key part
    // can be absent); only compare positions the key actually provides, so a
    // missing key part is not falsely reported as a mismatch against
    // String(undefined).
    if (keyParts[i] === undefined) {
      continue;
    }
    if (String(dataValue) !== String(keyParts[i])) {
      const err = new QueryError(
        `key and data disagree on primary-key field '${field}': key part=${keyParts[i]}, data.${field}=${dataValue}`,
        "invalid_record_identity"
      );
      throw err;
    }
  }
}

export function assertRecordIdentity(primaryKeyFields: unknown, key: RecordKey, data: unknown): void {
  if (data === null || typeof data !== "object") {
    return;
  }
  const fields = Array.isArray(primaryKeyFields)
    ? primaryKeyFields.filter((field): field is string => typeof field === "string")
    : [];

  if (fields.length === 0) {
    assertLegacyIdIdentity(key, data as JsonObject);
    return;
  }

  assertPrimaryKeyIdentity(fields, key, data as JsonObject);
}

export function parseIntegerValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  // biome-ignore lint/performance/useTopLevelRegex: This parser-local expression intentionally avoids shared regular-expression state.
  if (typeof value !== "string" || !/^-?\d+$/.test(value.trim())) {
    return null;
  }
  return Number.parseInt(value.trim(), 10);
}

// A SourceDeclaration field reference names one literal top-level JSON key.
// It is not an identifier: punctuation and Unicode are valid key characters.
// SQL builders must quote or bind it as JSON data rather than interpolate it
// as SQL syntax.
export function assertNonEmptyJsonField(field: unknown, label: string): asserts field is string {
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`[records] JSON field ${label} must be a non-empty string: ${JSON.stringify(field)}`);
  }
}

/**
 * Build an effective filter from grant + request params.
 * Returns frozen grant fields, resources, and temporal constraint for use by
 * either the SQLite or Postgres record paths.
 */
export function buildEffectiveFilter(
  streamGrant: EffectiveFilterGrant,
  requestParams: RequestParams,
  requiredFields: string[] = []
): EffectiveFilter {
  const timeConstraint = requireTimeConstraint(streamGrant.time_constraint);
  const effective = {
    fields: streamGrant.fields || null,
    resources: streamGrant.resources || null,
    timeConstraint,
    timeConstraintField: timeConstraint ? timeConstraint.field : null,
  };

  if (requestParams.fields && effective.fields !== null) {
    effective.fields = requestParams.fields.filter((f) => effective.fields?.includes(f) === true);
  } else if (requestParams.fields && !effective.fields) {
    effective.fields = requestParams.fields;
  }

  if (effective.fields !== null) {
    // Resolved client grants carry instance_ids and freeze the field set at
    // authorization time. A later manifest declaration must not widen that
    // grant by adding newly-required fields. Owner grants omit instance_ids
    // and retain the current-manifest behavior used by self-reads.
    const manifestRequiredFields = Object.hasOwn(streamGrant, "instance_ids") ? [] : requiredFields;
    effective.fields = [...new Set([...manifestRequiredFields, ...effective.fields])];
  }

  return effective;
}

/**
 * Expansion children are stored in the same source instance as their parent.
 * A resolved client grant therefore authorizes an expansion only when the
 * child stream's closed instance set contains the selected parent instance.
 * Owner grants omit instance_ids and keep their unrestricted self-read path.
 */
export function assertExpansionInstanceAuthorized(childGrant: EffectiveFilterGrant, connectorInstanceId: string): void {
  if (!Object.hasOwn(childGrant, "instance_ids")) {
    return;
  }
  if (!(Array.isArray(childGrant.instance_ids) && childGrant.instance_ids.includes(connectorInstanceId))) {
    const error = invalidQueryError(
      "The expanded stream is not authorized on the selected connection.",
      "connection_not_found"
    );
    error.param = "connection_id";
    throw error;
  }
}

/**
 * Validate the `expand[]` / `expand_limit[]` request shape against the
 * parent stream's manifest-declared `relationships` + `query.expand`
 * allowlist and the caller's grant. Pure: produces a normalized
 * `expansions[]` array describing what hydration the backend should do
 * for this page, without running any SQL.
 *
 * Errors thrown here are `invalid_expand` / `insufficient_scope` and
 * MUST be allowed to propagate so the route handler returns the
 * structured PDPP error envelope.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This protocol transition owns ordered state invariants that must remain local.
export function normalizeExpandRequest(
  requestParams: RequestParams,
  stream: string,
  grant: ExpandGrant,
  manifestStream: ManifestStream,
  order: unknown
): ExpandResult[] {
  if (
    requestParams.expand_limit !== null &&
    requestParams.expand_limit !== undefined &&
    (!requestParams.expand || requestParams.expand === "")
  ) {
    throw invalidQueryError("expand_limit requires a matching expand relation", "invalid_expand");
  }

  if (requestParams.expand === null || requestParams.expand === undefined || requestParams.expand === "") {
    if (requestParams.expand_limit !== null && requestParams.expand_limit !== undefined) {
      throw invalidQueryError("expand_limit requires a matching expand relation", "invalid_expand");
    }
    return [];
  }

  if (requestParams.expand && typeof requestParams.expand === "object" && !Array.isArray(requestParams.expand)) {
    throw invalidQueryError("expand must be a relation name or repeated expand values", "invalid_expand");
  }

  const requestedNames = (Array.isArray(requestParams.expand) ? requestParams.expand : [requestParams.expand])
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  if (!requestedNames.length) {
    throw invalidQueryError("expand must include at least one relation name", "invalid_expand");
  }

  const seenNames = new Set();
  const relationships = new Map(
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    (manifestStream?.relationships || []).map((relationship) => [relationship.name, relationship])
  );
  const capabilities = new Map(
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    (manifestStream?.query?.expand || []).map((capability) => [capability.name, capability])
  );
  let requestedLimits: Record<string, unknown> = {};
  if (requestParams.expand_limit !== null && requestParams.expand_limit !== undefined) {
    if (typeof requestParams.expand_limit !== "object" || Array.isArray(requestParams.expand_limit)) {
      throw invalidQueryError("expand_limit must use expand_limit[relation]=N", "invalid_expand");
    }
    requestedLimits = requestParams.expand_limit;
  }

  const expansions: ExpandResult[] = [];
  for (const relationName of requestedNames) {
    if (seenNames.has(relationName)) {
      continue;
    }
    seenNames.add(relationName);

    if (relationName.includes(".")) {
      throw invalidQueryError(`Nested expansion '${relationName}' is not supported`, "invalid_expand");
    }

    const relationship = relationships.get(relationName);
    const capability = capabilities.get(relationName);
    if (!(relationship && capability)) {
      throw invalidQueryError(`Unsupported expand relation '${relationName}' on '${stream}'`, "invalid_expand");
    }

    const childGrant = grant.streams.find((entry) => entry.name === relationship.stream);
    if (!childGrant) {
      throw invalidQueryError(
        `Expand relation '${relationName}' requires grant access to '${relationship.stream}'`,
        "insufficient_scope"
      );
    }

    const defaultLimit = parseIntegerValue(capability.default_limit) ?? 10;
    const maxLimit = parseIntegerValue(capability.max_limit) ?? 50;
    let appliedLimit = defaultLimit;

    if (requestedLimits && Object.hasOwn(requestedLimits, relationName)) {
      if (relationship.cardinality !== "has_many") {
        throw invalidQueryError(
          `expand_limit is only valid for has_many relations; '${relationName}' is ${relationship.cardinality}`,
          "invalid_expand"
        );
      }
      const parsedLimit = parseIntegerValue(requestedLimits[relationName]);
      if (parsedLimit === null || parsedLimit <= 0) {
        throw invalidQueryError(`expand_limit[${relationName}] must be a positive integer`, "invalid_expand");
      }
      if (parsedLimit > maxLimit) {
        throw invalidQueryError(`expand_limit[${relationName}] exceeds max_limit ${maxLimit}`, "invalid_expand");
      }
      appliedLimit = parsedLimit;
    }

    expansions.push({
      childGrant,
      limit: appliedLimit,
      name: relationName,
      order,
      relationship,
    });
  }

  if (requestedLimits) {
    for (const relationName of Object.keys(requestedLimits)) {
      if (!seenNames.has(relationName)) {
        throw invalidQueryError(`expand_limit[${relationName}] requires a matching expand relation`, "invalid_expand");
      }
    }
  }

  return expansions;
}
