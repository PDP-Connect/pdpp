/**
 * Stream schema capability introspection.
 *
 * Concept: derives field-level filter/search/aggregation capabilities, plus
 * expand and discovery capabilities, from a manifest stream schema.
 *
 * Scope (honest, per §B/R5 which REVISED an earlier overclaim): this module owns
 * the schema/discovery capability PROJECTION for field, expand, and discovery
 * responses — deriving capability METADATA from a manifest stream schema + grant
 * inputs. It does NOT own the complete protocol/runtime implementation of field
 * types or aggregation operators: a genuinely NEW aggregation operator also
 * touches validation (connector-manifest-validation.ts) and execution
 * (record-aggregation.js, records.js). What lands ENTIRELY here is a change to how
 * existing capabilities are PROJECTED into responses.
 *
 * Invariant: pure schema analysis — capability projection is centralised here.
 * No startServer-internal reach-back; no import from index.js.
 */

function hasObjectEntries(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function getNonNullSchemaTypes(schema) {
  const rawType = schema?.type;
  if (!rawType) return new Set();
  const types = Array.isArray(rawType) ? rawType : [rawType];
  return new Set(types.filter((type) => type !== 'null'));
}

function isExactFilterableSchema(schema) {
  const types = getNonNullSchemaTypes(schema);
  if (types.size !== 1) return false;
  const [type] = types;
  return ['boolean', 'integer', 'number', 'string'].includes(type);
}

function buildFieldCapabilityFlag({ declared, granted, operators = null }) {
  const flag = {
    declared,
    usable: declared && granted,
  };
  if (operators) {
    flag.operators = operators;
  }
  if (declared && !granted) {
    flag.reason = 'field_not_granted';
  }
  return flag;
}

function buildFieldAggregationCapabilities(aggregations, field, granted) {
  return {
    sum: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.sum) && aggregations.sum.includes(field),
      granted,
    }),
    min: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.min) && aggregations.min.includes(field),
      granted,
    }),
    max: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.max) && aggregations.max.includes(field),
      granted,
    }),
    group_by: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.group_by) && aggregations.group_by.includes(field),
      granted,
    }),
    group_by_time: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.group_by_time) && aggregations.group_by_time.includes(field),
      granted,
    }),
    count_distinct: buildFieldCapabilityFlag({
      declared: Array.isArray(aggregations?.count_distinct) && aggregations.count_distinct.includes(field),
      granted,
    }),
  };
}

// Build one `[field, capability]` field_capabilities entry. The six per-stream
// lookup structures the enclosing `.map` used to capture from its closure —
// grantedFields, rangeFilters, fieldDeclarations, lexicalFields, semanticFields,
// aggregations — are now an EXPLICIT `ctx` parameter (canon: hidden state →
// explicit), so this is a pure per-field projection: the grant decision, declared
// presentation type/role, and the exact/range/lexical/semantic/aggregation
// capability flags are all derived here byte-for-byte as before. Separated from the
// Object.entries traversal so the per-field shape has a single-entry surface.
function buildFieldCapabilityEntry(field, schema, ctx) {
  const { grantedFields, rangeFilters, fieldDeclarations, lexicalFields, semanticFields, aggregations } = ctx;
  const granted = !grantedFields || grantedFields.has(field);
  const rangeOperators = Array.isArray(rangeFilters[field]) ? rangeFilters[field] : null;
  // Optional declared presentation type, sourced either from the JSON
  // Schema extension (`schema.properties[field].x_pdpp_type`) or from a
  // sandbox-shaped field declaration (`fields[]` or `schema.fields[]`,
  // with `{ name, type, semantic_class }`). Surfaced as an additive `type`
  // on the field_capabilities entry only; it does not influence any filter,
  // search, aggregation, grant, or retrieval decision below.
  const declaredType =
    schema
    && typeof schema === 'object'
    && typeof schema.x_pdpp_type === 'string'
    && schema.x_pdpp_type.trim().length > 0
      ? schema.x_pdpp_type.trim()
      : fieldDeclarations.get(field) || null;
  const declaredRole =
    schema
    && typeof schema === 'object'
    && typeof schema.x_pdpp_role === 'string'
    && schema.x_pdpp_role.trim().length > 0
      ? schema.x_pdpp_role.trim()
      : null;
  return [field, {
    ...(declaredType ? { type: declaredType } : {}),
    ...(declaredRole ? { role: declaredRole } : {}),
    schema,
    granted,
    exact_filter: buildFieldCapabilityFlag({
      declared: isExactFilterableSchema(schema),
      granted,
    }),
    range_filter: buildFieldCapabilityFlag({
      declared: Boolean(rangeOperators),
      granted,
      operators: rangeOperators || undefined,
    }),
    lexical_search: buildFieldCapabilityFlag({
      declared: lexicalFields.has(field),
      granted,
    }),
    semantic_search: buildFieldCapabilityFlag({
      declared: semanticFields.has(field),
      granted,
    }),
    aggregation: buildFieldAggregationCapabilities(aggregations, field, granted),
  }];
}

export function buildFieldCapabilities(manifestStream, streamGrant = null) {
  const properties = manifestStream?.schema?.properties || {};
  const fieldDeclarations = new Map();
  for (const declarations of [manifestStream?.fields, manifestStream?.schema?.fields]) {
    if (!Array.isArray(declarations)) {
      continue;
    }
    for (const declaration of declarations) {
      if (
        declaration
        && typeof declaration === 'object'
        && typeof declaration.name === 'string'
        && declaration.name.trim().length > 0
        && typeof declaration.type === 'string'
        && declaration.type.trim().length > 0
      ) {
        fieldDeclarations.set(declaration.name, declaration.type.trim());
      }
    }
  }
  const grantedFields = Array.isArray(streamGrant?.fields) && streamGrant.fields.length > 0
    ? new Set(streamGrant.fields)
    : null;
  const rangeFilters = manifestStream?.query?.range_filters || {};
  const lexicalFields = new Set(manifestStream?.query?.search?.lexical_fields || []);
  const semanticFields = new Set(manifestStream?.query?.search?.semantic_fields || []);
  const aggregations = manifestStream?.query?.aggregations || {};

  const fieldCapabilityContext = {
    grantedFields, rangeFilters, fieldDeclarations, lexicalFields, semanticFields, aggregations,
  };
  return Object.fromEntries(
    Object.entries(properties).map(([field, schema]) => buildFieldCapabilityEntry(field, schema, fieldCapabilityContext)),
  );
}

// Emit one `expand_capabilities` entry per enabled parent-stream relation (a
// `query.expand[]` capability backed by a `relationships[]` declaration),
// including relations whose target stream is unreadable under the current
// request. Declared-but-unreadable relations stay visible with `usable: false`
// and a `reason` enum value so a console can tell "no relation declared" apart
// from "relation declared but not readable here".
//
// `manifestStreamNames`, when provided, is the set of streams the loaded
// manifest declares; a relation pointing at a stream outside that set is
// surfaced as `related_stream_unknown` rather than silently dropped.
// Reachability of one declared relation under the current request: `known` (its
// target stream is inside the loaded manifest) and `granted` (readable under the
// grant). Kept as an explicit, named fact so the entry-builder below reads as
// shape-assembly, not interleaved policy. `grantedStreams === null` means "no
// grant scoping in effect" (owner/unfiltered), so everything known is granted.
function resolveExpandRelationReachability(targetStream, grantedStreams, manifestStreamNames) {
  const known = !manifestStreamNames || manifestStreamNames.has(targetStream);
  const granted = known && (!grantedStreams || grantedStreams.has(targetStream));
  return { known, granted, usable: known && granted };
}

// Build one `expand_capabilities` entry from a declared `query.expand[]`
// capability and its backing relationship. The closure environment that used to
// be captured implicitly (the relationship map + the reachability sets) is now
// passed EXPLICITLY, so this is a pure function of its inputs. Returns null when
// no relationship backs the capability (the caller filters those out).
function buildExpandCapabilityEntry(capability, relationships, grantedStreams, manifestStreamNames) {
  const relationship = relationships.get(capability.name);
  if (!relationship) return null;
  const targetStream = relationship.stream;
  const { known, granted, usable } = resolveExpandRelationReachability(targetStream, grantedStreams, manifestStreamNames);
  const entry = {
    name: capability.name,
    // `stream` (back-compat) and `target_stream` both name the related child
    // stream; the canonical, self-describing name is `target_stream`.
    stream: targetStream,
    target_stream: targetStream,
    cardinality: relationship.cardinality,
    granted,
    usable,
  };
  if (relationship.foreign_key) {
    // The field on the child carrying the parent's key. `child_parent_key_field`
    // is the canonical name; `foreign_key` stays as a back-compat alias with
    // the identical value.
    entry.child_parent_key_field = relationship.foreign_key;
    entry.foreign_key = relationship.foreign_key;
  }
  if (capability.default_limit !== undefined) {
    entry.default_limit = capability.default_limit;
  }
  if (capability.max_limit !== undefined) {
    entry.max_limit = capability.max_limit;
  }
  if (!usable) {
    entry.reason = known ? 'related_stream_not_granted' : 'related_stream_unknown';
  }
  return entry;
}

export function buildExpandCapabilities(manifestStream, streamGrant = null, manifestStreamNames = null) {
  const relationships = new Map((manifestStream?.relationships || []).map((relationship) => [relationship.name, relationship]));
  const grantedStreams = Array.isArray(streamGrant?.grantStreams)
    ? new Set(streamGrant.grantStreams.map((stream) => stream.name))
    : null;

  return (manifestStream?.query?.expand || [])
    .map((capability) => buildExpandCapabilityEntry(capability, relationships, grantedStreams, manifestStreamNames))
    .filter(Boolean);
}

function buildDiscoveryUrl(path, connectorId = null) {
  const connectorQuery = connectorId ? `?connector_id=${encodeURIComponent(connectorId)}` : '';
  return `${path}${connectorQuery}`;
}

export function buildStreamDiscoveryCapabilities({ connectorId = null, stream }) {
  const encodedStream = encodeURIComponent(stream.name);
  const rangeFilters = stream.query?.range_filters;
  const expand = stream.query?.expand;
  const aggregations = stream.query?.aggregations;
  const hasAggregations = hasObjectEntries(aggregations);

  return {
    stream_metadata: true,
    metadata_url: buildDiscoveryUrl(`/v1/streams/${encodedStream}`, connectorId),
    records: true,
    records_url: buildDiscoveryUrl(`/v1/streams/${encodedStream}/records`, connectorId),
    aggregate: hasAggregations,
    aggregate_url: hasAggregations
      ? buildDiscoveryUrl(`/v1/streams/${encodedStream}/aggregate`, connectorId)
      : null,
    exact_filters: true,
    range_filters: hasObjectEntries(rangeFilters),
    expand: Array.isArray(expand) && expand.length > 0,
    changes_since: true,
  };
}
