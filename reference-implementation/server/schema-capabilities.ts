// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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

interface Schema {
  type?: string | string[];
  [key: string]: unknown;
}
interface ManifestStream {
  fields?: FieldDeclaration[];
  name: string;
  query?: {
    range_filters?: Record<string, string[]>;
    search?: { lexical_fields?: string[]; semantic_fields?: string[] };
    aggregations?: Record<string, boolean | string[]>;
    expand?: ExpandCapability[];
  };
  relationships?: Relationship[];
  schema?: { properties?: Record<string, Schema>; fields?: FieldDeclaration[] };
}
interface FieldDeclaration {
  name: string;
  semantic_class?: string;
  type: string;
}
interface Relationship {
  cardinality: string;
  foreign_key?: string;
  name: string;
  stream: string;
}
interface ExpandCapability {
  default_limit?: unknown;
  max_limit?: unknown;
  name: string;
}
interface StreamGrant {
  fields?: string[];
  grantStreams?: Array<{ name: string }>;
}
interface CapabilityContext {
  aggregations: Record<string, boolean | string[]>;
  fieldDeclarations: Map<string, string>;
  grantedFields: Set<string> | null;
  lexicalFields: Set<string>;
  rangeFilters: Record<string, string[]>;
  semanticFields: Set<string>;
}

function hasObjectEntries(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0);
}

function getNonNullSchemaTypes(schema: Schema | null | undefined): Set<string> {
  const rawType = schema?.type;
  if (!rawType) {
    return new Set();
  }
  const types = Array.isArray(rawType) ? rawType : [rawType];
  return new Set(types.filter((type) => type !== "null"));
}

function isExactFilterableSchema(schema: Schema): boolean {
  const types = getNonNullSchemaTypes(schema);
  if (types.size !== 1) {
    return false;
  }
  // biome-ignore lint/style/useDestructuring: Explicit property or positional access documents this compatibility boundary.
  const type = [...types][0];
  return type !== undefined && ["boolean", "integer", "number", "string"].includes(type);
}

function buildFieldCapabilityFlag({
  declared,
  granted,
  operators = null,
}: {
  declared: boolean;
  granted: boolean;
  operators?: string[] | null | undefined;
}): Record<string, unknown> {
  const flag: Record<string, unknown> = {
    declared,
    usable: declared && granted,
  };
  if (operators) {
    flag.operators = operators;
  }
  if (declared && !granted) {
    flag.reason = "field_not_granted";
  }
  return flag;
}

function buildFieldAggregationCapabilities(
  aggregations: Record<string, boolean | string[]>,
  field: string,
  granted: boolean
): Record<string, unknown> {
  return {
    count_distinct: buildFieldCapabilityFlag({
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      declared: Array.isArray(aggregations?.count_distinct) && aggregations.count_distinct.includes(field),
      granted,
    }),
    group_by: buildFieldCapabilityFlag({
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      declared: Array.isArray(aggregations?.group_by) && aggregations.group_by.includes(field),
      granted,
    }),
    group_by_time: buildFieldCapabilityFlag({
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      declared: Array.isArray(aggregations?.group_by_time) && aggregations.group_by_time.includes(field),
      granted,
    }),
    max: buildFieldCapabilityFlag({
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      declared: Array.isArray(aggregations?.max) && aggregations.max.includes(field),
      granted,
    }),
    min: buildFieldCapabilityFlag({
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      declared: Array.isArray(aggregations?.min) && aggregations.min.includes(field),
      granted,
    }),
    sum: buildFieldCapabilityFlag({
      // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
      declared: Array.isArray(aggregations?.sum) && aggregations.sum.includes(field),
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
function buildFieldCapabilityEntry(
  field: string,
  schema: Schema,
  ctx: CapabilityContext,
  advertiseFilterCapabilities: boolean
): [string, Record<string, unknown>] {
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
    schema &&
    typeof schema === "object" &&
    typeof schema.x_pdpp_type === "string" &&
    schema.x_pdpp_type.trim().length > 0
      ? schema.x_pdpp_type.trim()
      : fieldDeclarations.get(field) || null;
  const declaredRole =
    schema &&
    typeof schema === "object" &&
    typeof schema.x_pdpp_role === "string" &&
    schema.x_pdpp_role.trim().length > 0
      ? schema.x_pdpp_role.trim()
      : null;
  return [
    field,
    {
      ...(declaredType ? { type: declaredType } : {}),
      ...(declaredRole ? { role: declaredRole } : {}),
      aggregation: buildFieldAggregationCapabilities(aggregations, field, granted),
      granted,
      lexical_search: buildFieldCapabilityFlag({
        declared: lexicalFields.has(field),
        granted,
      }),
      schema,
      semantic_search: buildFieldCapabilityFlag({
        declared: semanticFields.has(field),
        granted,
      }),
      ...(advertiseFilterCapabilities
        ? {
            exact_filter: buildFieldCapabilityFlag({
              declared: isExactFilterableSchema(schema),
              granted,
            }),
            range_filter: buildFieldCapabilityFlag({
              declared: Boolean(rangeOperators),
              granted,
              operators: rangeOperators || undefined,
            }),
          }
        : {}),
    },
  ];
}

export function buildFieldCapabilities(
  manifestStream: ManifestStream,
  streamGrant: StreamGrant | null = null
): Record<string, Record<string, unknown>> {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const properties = manifestStream?.schema?.properties || {};
  const fieldDeclarations = new Map();
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  for (const declarations of [manifestStream?.fields, manifestStream?.schema?.fields]) {
    if (!Array.isArray(declarations)) {
      continue;
    }
    for (const declaration of declarations) {
      if (
        declaration &&
        typeof declaration === "object" &&
        typeof declaration.name === "string" &&
        declaration.name.trim().length > 0 &&
        typeof declaration.type === "string" &&
        declaration.type.trim().length > 0
      ) {
        fieldDeclarations.set(declaration.name, declaration.type.trim());
      }
    }
  }
  const grantedFields =
    Array.isArray(streamGrant?.fields) && streamGrant.fields.length > 0 ? new Set(streamGrant.fields) : null;
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const rangeFilters = manifestStream?.query?.range_filters || {};
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const lexicalFields = new Set(manifestStream?.query?.search?.lexical_fields || []);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const semanticFields = new Set(manifestStream?.query?.search?.semantic_fields || []);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  const aggregations = manifestStream?.query?.aggregations || {};

  const fieldCapabilityContext = {
    aggregations,
    fieldDeclarations,
    grantedFields,
    lexicalFields,
    rangeFilters,
    semanticFields,
  };
  const advertiseFilterCapabilities = streamGrant === null;
  return Object.fromEntries(
    Object.entries(properties).map(([field, schema]) =>
      buildFieldCapabilityEntry(field, schema, fieldCapabilityContext, advertiseFilterCapabilities)
    )
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
function resolveExpandRelationReachability(
  targetStream: string,
  grantedStreams: Set<string> | null,
  manifestStreamNames: Set<string> | null
): { known: boolean; granted: boolean; usable: boolean } {
  const known = !manifestStreamNames || manifestStreamNames.has(targetStream);
  const granted = known && (!grantedStreams || grantedStreams.has(targetStream));
  return { granted, known, usable: known && granted };
}

// Build one `expand_capabilities` entry from a declared `query.expand[]`
// capability and its backing relationship. The closure environment that used to
// be captured implicitly (the relationship map + the reachability sets) is now
// passed EXPLICITLY, so this is a pure function of its inputs. Returns null when
// no relationship backs the capability (the caller filters those out).
function buildExpandCapabilityEntry(
  capability: ExpandCapability,
  relationships: Map<string, Relationship>,
  grantedStreams: Set<string> | null,
  manifestStreamNames: Set<string> | null
): Record<string, unknown> | null {
  const relationship = relationships.get(capability.name);
  if (!relationship) {
    return null;
  }
  const targetStream = relationship.stream;
  const { known, granted, usable } = resolveExpandRelationReachability(
    targetStream,
    grantedStreams,
    manifestStreamNames
  );
  const entry: Record<string, unknown> = {
    cardinality: relationship.cardinality,
    granted,
    name: capability.name,
    // `stream` (back-compat) and `target_stream` both name the related child
    // stream; the canonical, self-describing name is `target_stream`.
    stream: targetStream,
    target_stream: targetStream,
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
    entry.reason = known ? "related_stream_not_granted" : "related_stream_unknown";
  }
  return entry;
}

export function buildExpandCapabilities(
  manifestStream: ManifestStream,
  streamGrant: StreamGrant | null = null,
  manifestStreamNames: Set<string> | null = null
): Record<string, unknown>[] {
  const relationships = new Map(
    // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
    (manifestStream?.relationships || []).map((relationship) => [relationship.name, relationship])
  );
  const grantedStreams = Array.isArray(streamGrant?.grantStreams)
    ? new Set(streamGrant.grantStreams.map((stream) => stream.name))
    : null;

  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
  return (manifestStream?.query?.expand || [])
    .map((capability) => buildExpandCapabilityEntry(capability, relationships, grantedStreams, manifestStreamNames))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

function buildDiscoveryUrl(path: string, connectorId: string | null = null): string {
  const connectorQuery = connectorId ? `?connector_id=${encodeURIComponent(connectorId)}` : "";
  return `${path}${connectorQuery}`;
}

export function buildStreamDiscoveryCapabilities({
  connectorId = null,
  stream,
}: {
  connectorId?: string | null;
  stream: ManifestStream;
}): Record<string, unknown> {
  const encodedStream = encodeURIComponent(stream.name);
  const rangeFilters = stream.query?.range_filters;
  const expand = stream.query?.expand;
  const aggregations = stream.query?.aggregations;
  const hasAggregations = hasObjectEntries(aggregations);

  return {
    aggregate: hasAggregations,
    aggregate_url: hasAggregations ? buildDiscoveryUrl(`/v1/streams/${encodedStream}/aggregate`, connectorId) : null,
    changes_since: true,
    exact_filters: true,
    expand: Array.isArray(expand) && expand.length > 0,
    metadata_url: buildDiscoveryUrl(`/v1/streams/${encodedStream}`, connectorId),
    range_filters: hasObjectEntries(rangeFilters),
    records: true,
    records_url: buildDiscoveryUrl(`/v1/streams/${encodedStream}/records`, connectorId),
    stream_metadata: true,
  };
}
