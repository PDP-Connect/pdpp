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

export function invalidQueryError(message, code = 'invalid_request') {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function normalizePrimaryKey(primaryKey) {
  if (Array.isArray(primaryKey)) {
    return primaryKey.filter((field) => typeof field === 'string' && field.length > 0);
  }
  if (typeof primaryKey === 'string' && primaryKey.length > 0) return [primaryKey];
  return [];
}

export function parseIntegerValue(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string' || !/^-?\d+$/.test(value.trim())) return null;
  return Number.parseInt(value.trim(), 10);
}

// JSON-path identifiers that come from the manifest are already validated by
// `validateConnectorManifest`, but we re-validate here with a tight regex so
// backends can only interpolate safely-quoted `$.<field>` paths into SQL.
export const SAFE_JSON_FIELD = /^[A-Za-z_][A-Za-z_0-9]*$/;

export function assertSafeJsonField(field, label) {
  if (typeof field !== 'string' || !SAFE_JSON_FIELD.test(field)) {
    throw new Error(`[records] Unsafe JSON field ${label}: ${JSON.stringify(field)}`);
  }
}

/**
 * Build an effective filter from grant + request params.
 * Returns { fields, timeRange, resources, consentTimeField } for use by
 * either the SQLite or Postgres record paths.
 */
export function buildEffectiveFilter(streamGrant, requestParams, requiredFields = []) {
  const effective = {
    fields: streamGrant.fields || null,
    timeRange: streamGrant.time_range || null,
    resources: streamGrant.resources || null,
    consentTimeField: null,
  };

  if (requestParams.fields && effective.fields) {
    effective.fields = requestParams.fields.filter((f) => effective.fields.includes(f));
  } else if (requestParams.fields && !effective.fields) {
    effective.fields = requestParams.fields;
  }

  if (effective.fields) {
    effective.fields = [...new Set([...requiredFields, ...effective.fields])];
  }

  return effective;
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
export function normalizeExpandRequest(requestParams, stream, grant, manifestStream, order) {
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
