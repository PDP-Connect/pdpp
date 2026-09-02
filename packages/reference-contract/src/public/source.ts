// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { JsonSchema } from "../common/index.ts";

export type SourceKind = "connector" | "provider_native";

export interface SourceObject {
  id: string;
  kind: SourceKind;
}

export interface SourceRequestObject {
  id: string;
  kind?: SourceKind;
}

export interface SourceDeclarationStream {
  consent_time_field?: string;
  cursor_field?: string;
  description?: string;
  display?: { detail?: string; label?: string };
  name: string;
  primary_key: string[];
  query?: SourceQueryCapabilities;
  relationships?: Array<{
    cardinality: "has_many" | "has_one";
    foreign_key: string;
    name: string;
    stream: string;
  }>;
  schema: Record<string, unknown>;
  selection: { fields: boolean; resources: boolean };
  semantics: "append_only" | "mutable_state";
  views?: Array<{ fields: string[]; id: string; label: string }>;
}

export interface SourceQueryCapabilities {
  aggregations?: {
    count?: true;
    count_distinct?: string[];
    group_by?: string[];
    group_by_time?: string[];
    max?: string[];
    min?: string[];
    sum?: string[];
  };
  expand?: Array<{ default_limit?: number; max_limit?: number; name: string }>;
  range_filters?: Record<string, Array<"gte" | "gt" | "lte" | "lt">>;
  search?: { lexical_fields?: string[]; semantic_fields?: string[] };
}

export type SourceSelectionPresetStream = { name: string } & (
  | { fields: string[]; view?: never }
  | { fields?: never; view: string }
  | { fields?: never; view?: never }
);

export interface SourceDeclaration {
  declaration_version: string;
  display: { name: string };
  extensions?: Record<string, unknown>;
  protocol_version: "0.1.0";
  publisher: { id: string };
  selection_presets?: Array<{ id: string; label: string; streams: SourceSelectionPresetStream[] }>;
  source: SourceObject;
  streams: SourceDeclarationStream[];
}

export interface SelectionRequestStream {
  fields?: string[];
  instance_ids?: string[];
  name: string;
  necessity?: "required" | "optional";
  resources?: string[];
  time_range?: { since?: string; until?: string };
  view?: string;
}

interface SelectionRequestBase {
  access_mode: "single_use" | "continuous";
  client_claims?: { commitments?: string[] };
  purpose_code: string;
  purpose_description?: string;
  retention?: { max_duration: string; on_expiry: "anonymize" | "delete" };
  source: SourceRequestObject;
  type: "https://pdpp.dev/data-access";
}

export type SelectionRequest = SelectionRequestBase &
  ({ selection_preset?: never; streams: SelectionRequestStream[] } | { selection_preset: string; streams?: never });

export interface ResolvedGrantStream {
  fields: string[];
  instance_ids: string[];
  name: string;
  resources?: string[];
  time_constraint?: { field: string; since?: string; until?: string };
}

export interface ResolvedGrant {
  access_mode: "single_use" | "continuous";
  client: {
    client_display?: {
      logo_uri?: string;
      name?: string;
      policy_uri?: string;
      tos_uri?: string;
      uri?: string;
    };
    client_id: string;
  };
  /** ISO 8601 grant expiry. Absent means no expiry; `null` is not a valid value. */
  expires_at?: string;
  grant_id: string;
  issued_at: string;
  purpose_code: string;
  purpose_description?: string;
  retention?: { max_duration: string; on_expiry: "anonymize" | "delete" };
  selection_preset?: string;
  source: SourceObject;
  source_declaration: { version: string };
  streams: ResolvedGrantStream[];
  subject: { id: string };
  version: "0.1.0";
}

const NonEmptyStringSchema = { minLength: 1, type: "string" } satisfies JsonSchema;
const NonEmptyUniqueStringsSchema = {
  items: NonEmptyStringSchema,
  minItems: 1,
  type: "array",
  uniqueItems: true,
} satisfies JsonSchema;
const DateTimeSchema = { format: "date-time", type: "string" } satisfies JsonSchema;
const UriSchema = { format: "uri", type: "string" } satisfies JsonSchema;
const FieldNameArraySchema = {
  items: NonEmptyStringSchema,
  minItems: 1,
  type: "array",
  uniqueItems: true,
} satisfies JsonSchema;

const SourceQueryCapabilitiesSchema = {
  additionalProperties: false,
  properties: {
    aggregations: {
      additionalProperties: false,
      properties: {
        count: { const: true },
        count_distinct: FieldNameArraySchema,
        group_by: FieldNameArraySchema,
        group_by_time: FieldNameArraySchema,
        max: FieldNameArraySchema,
        min: FieldNameArraySchema,
        sum: FieldNameArraySchema,
      },
      type: "object",
    },
    expand: {
      items: {
        additionalProperties: false,
        properties: {
          default_limit: { minimum: 1, type: "integer" },
          max_limit: { minimum: 1, type: "integer" },
          name: NonEmptyStringSchema,
        },
        required: ["name"],
        type: "object",
      },
      minItems: 1,
      type: "array",
    },
    range_filters: {
      additionalProperties: {
        items: { enum: ["gte", "gt", "lte", "lt"], type: "string" },
        minItems: 1,
        type: "array",
        uniqueItems: true,
      },
      propertyNames: NonEmptyStringSchema,
      type: "object",
    },
    search: {
      additionalProperties: false,
      properties: {
        lexical_fields: FieldNameArraySchema,
        semantic_fields: FieldNameArraySchema,
      },
      type: "object",
    },
  },
  type: "object",
} satisfies JsonSchema;

export const SourceObjectSchema = {
  additionalProperties: false,
  properties: {
    id: { format: "uri", minLength: 1, type: "string" },
    kind: { enum: ["connector", "provider_native"], type: "string" },
  },
  required: ["kind", "id"],
  type: "object",
} satisfies JsonSchema;

export const SourceRequestObjectSchema = {
  additionalProperties: false,
  properties: {
    id: { format: "uri", minLength: 1, type: "string" },
    kind: { enum: ["connector", "provider_native"], type: "string" },
  },
  required: ["id"],
  type: "object",
} satisfies JsonSchema;

const SourceDeclarationStreamSchema = {
  additionalProperties: false,
  properties: {
    consent_time_field: NonEmptyStringSchema,
    cursor_field: NonEmptyStringSchema,
    description: NonEmptyStringSchema,
    display: {
      additionalProperties: false,
      properties: { detail: NonEmptyStringSchema, label: NonEmptyStringSchema },
      type: "object",
    },
    name: { ...NonEmptyStringSchema, not: { const: "*" } },
    primary_key: NonEmptyUniqueStringsSchema,
    query: SourceQueryCapabilitiesSchema,
    relationships: {
      items: {
        additionalProperties: false,
        properties: {
          cardinality: { enum: ["has_many", "has_one"], type: "string" },
          foreign_key: NonEmptyStringSchema,
          name: NonEmptyStringSchema,
          stream: NonEmptyStringSchema,
        },
        required: ["name", "stream", "foreign_key", "cardinality"],
        type: "object",
      },
      type: "array",
    },
    schema: {
      additionalProperties: true,
      properties: {
        $schema: { const: "https://json-schema.org/draft/2020-12/schema" },
      },
      type: "object",
    },
    selection: {
      additionalProperties: false,
      properties: { fields: { type: "boolean" }, resources: { type: "boolean" } },
      required: ["fields", "resources"],
      type: "object",
    },
    semantics: { enum: ["append_only", "mutable_state"], type: "string" },
    views: {
      items: {
        additionalProperties: false,
        properties: { fields: NonEmptyUniqueStringsSchema, id: NonEmptyStringSchema, label: NonEmptyStringSchema },
        required: ["id", "label", "fields"],
        type: "object",
      },
      type: "array",
    },
  },
  required: ["name", "semantics", "schema", "primary_key", "selection"],
  type: "object",
} satisfies JsonSchema;

export const SourceDeclarationSchema = {
  $id: "https://pdpp.dev/schemas/source-declaration/0.1.0",
  $schema: "https://json-schema.org/draft/2020-12/schema",
  additionalProperties: false,
  properties: {
    declaration_version: NonEmptyStringSchema,
    display: {
      additionalProperties: false,
      properties: { name: NonEmptyStringSchema },
      required: ["name"],
      type: "object",
    },
    extensions: {
      additionalProperties: true,
      propertyNames: { format: "uri" },
      type: "object",
    },
    protocol_version: { const: "0.1.0", type: "string" },
    publisher: {
      additionalProperties: false,
      properties: { id: { format: "uri", type: "string" } },
      required: ["id"],
      type: "object",
    },
    selection_presets: {
      items: {
        additionalProperties: false,
        properties: {
          id: NonEmptyStringSchema,
          label: NonEmptyStringSchema,
          streams: {
            items: {
              additionalProperties: false,
              allOf: [{ not: { required: ["fields", "view"] } }],
              properties: {
                fields: FieldNameArraySchema,
                name: NonEmptyStringSchema,
                view: NonEmptyStringSchema,
              },
              required: ["name"],
              type: "object",
            },
            minItems: 1,
            type: "array",
          },
        },
        required: ["id", "label", "streams"],
        type: "object",
      },
      type: "array",
      uniqueItems: true,
    },
    source: SourceObjectSchema,
    streams: { items: SourceDeclarationStreamSchema, minItems: 1, type: "array", uniqueItems: true },
  },
  required: ["protocol_version", "source", "declaration_version", "publisher", "display", "streams"],
  type: "object",
} satisfies JsonSchema;

export type SourceDeclarationSemanticFailureCode =
  | "source.declaration.duplicate_preset_id"
  | "source.declaration.duplicate_preset_stream_name"
  | "source.declaration.duplicate_expand_name"
  | "source.declaration.duplicate_relationship_name"
  | "source.declaration.duplicate_stream_name"
  | "source.declaration.duplicate_view_id"
  | "source.declaration.invalid_expand_limits"
  | "source.declaration.invalid_query_field_type"
  | "source.declaration.nonlocal_schema_reference"
  | "source.declaration.unknown_relationship"
  | "source.declaration.unknown_schema_field"
  | "source.declaration.unknown_stream"
  | "source.declaration.unknown_view";

export interface SourceDeclarationSemanticFailure {
  code: SourceDeclarationSemanticFailureCode;
  path: string;
  reference: string;
}

export type SourceDeclarationSemanticValidationResult =
  | { ok: true }
  | { failures: SourceDeclarationSemanticFailure[]; ok: false };

function schemaFieldNames(stream: SourceDeclarationStream): Set<string> {
  const { properties } = stream.schema;
  if (!(properties && typeof properties === "object" && !Array.isArray(properties))) {
    return new Set();
  }
  return new Set(Object.keys(properties));
}

function validateEmbeddedSchemaNode(value: unknown, path: string, failures: SourceDeclarationSemanticFailure[]): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      validateEmbeddedSchemaNode(item, `${path}/${index}`, failures);
    }
    return;
  }
  if (!(value && typeof value === "object")) {
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if ((key === "$ref" || key === "$dynamicRef") && (typeof child !== "string" || !child.startsWith("#"))) {
      failures.push({
        code: "source.declaration.nonlocal_schema_reference",
        path: childPath,
        reference: typeof child === "string" ? child : String(child),
      });
    }
    validateEmbeddedSchemaNode(child, childPath, failures);
  }
}

function schemaProperty(stream: SourceDeclarationStream, field: string): unknown {
  const { properties } = stream.schema;
  if (!(properties && typeof properties === "object" && !Array.isArray(properties))) {
    return;
  }
  return (properties as Record<string, unknown>)[field];
}

function nonNullSchemaTypes(schema: unknown): unknown[] {
  const value = schema as Record<string, unknown> | null | undefined;
  const rawType = value?.type;
  if (Array.isArray(rawType)) {
    return rawType.filter((type) => type !== "null");
  }
  if (rawType === undefined || rawType === null) {
    return [];
  }
  const types = [rawType];
  return types.filter((type) => type !== "null");
}

function hasOneNonNullType(schema: unknown, allowed: ReadonlySet<string>): boolean {
  const types = nonNullSchemaTypes(schema);
  return types.length === 1 && allowed.has(types[0] as string);
}

function isSearchableStringSchema(schema: unknown): boolean {
  return hasOneNonNullType(schema, new Set(["string"]));
}

function isRangeSchema(schema: unknown): boolean {
  if (hasOneNonNullType(schema, new Set(["integer", "number"]))) {
    return true;
  }
  const value = schema as Record<string, unknown> | null | undefined;
  return hasOneNonNullType(schema, new Set(["string"])) && (value?.format === "date" || value?.format === "date-time");
}

function isScalarGroupSchema(schema: unknown): boolean {
  return hasOneNonNullType(schema, new Set(["boolean", "integer", "number", "string"]));
}

function isTimeBucketSchema(schema: unknown): boolean {
  const value = schema as Record<string, unknown> | null | undefined;
  return hasOneNonNullType(schema, new Set(["string"])) && (value?.format === "date" || value?.format === "date-time");
}

function pushInvalidQueryFieldType(
  failures: SourceDeclarationSemanticFailure[],
  stream: SourceDeclarationStream,
  fields: Iterable<string>,
  predicate: (schema: unknown) => boolean,
  path: string
): void {
  for (const field of fields) {
    if (schemaFieldNames(stream).has(field) && !predicate(schemaProperty(stream, field))) {
      failures.push({ code: "source.declaration.invalid_query_field_type", path, reference: field });
    }
  }
}

function pushUnknownFields(
  failures: SourceDeclarationSemanticFailure[],
  fields: Iterable<string>,
  knownFields: Set<string>,
  path: string
): void {
  for (const field of fields) {
    if (!knownFields.has(field)) {
      failures.push({ code: "source.declaration.unknown_schema_field", path, reference: field });
    }
  }
}

function validateStreamFieldReferences(
  stream: SourceDeclarationStream,
  streamIndex: number,
  failures: SourceDeclarationSemanticFailure[]
): void {
  const basePath = `/streams/${streamIndex}`;
  const fields = schemaFieldNames(stream);
  pushUnknownFields(failures, stream.primary_key, fields, `${basePath}/primary_key`);
  for (const member of ["cursor_field", "consent_time_field"] as const) {
    const field = stream[member];
    if (field) {
      pushUnknownFields(failures, [field], fields, `${basePath}/${member}`);
    }
  }
  for (const [viewIndex, view] of (stream.views ?? []).entries()) {
    pushUnknownFields(failures, view.fields, fields, `${basePath}/views/${viewIndex}/fields`);
  }
  const { query } = stream;
  pushUnknownFields(failures, Object.keys(query?.range_filters ?? {}), fields, `${basePath}/query/range_filters`);
  pushUnknownFields(failures, query?.search?.lexical_fields ?? [], fields, `${basePath}/query/search/lexical_fields`);
  pushUnknownFields(failures, query?.search?.semantic_fields ?? [], fields, `${basePath}/query/search/semantic_fields`);
  for (const member of ["count_distinct", "group_by", "group_by_time", "max", "min", "sum"] as const) {
    pushUnknownFields(
      failures,
      query?.aggregations?.[member] ?? [],
      fields,
      `${basePath}/query/aggregations/${member}`
    );
  }
  pushInvalidQueryFieldType(
    failures,
    stream,
    query?.search?.lexical_fields ?? [],
    isSearchableStringSchema,
    `${basePath}/query/search/lexical_fields`
  );
  pushInvalidQueryFieldType(
    failures,
    stream,
    query?.search?.semantic_fields ?? [],
    isSearchableStringSchema,
    `${basePath}/query/search/semantic_fields`
  );
  pushInvalidQueryFieldType(
    failures,
    stream,
    Object.keys(query?.range_filters ?? {}),
    isRangeSchema,
    `${basePath}/query/range_filters`
  );
  for (const member of ["count_distinct", "group_by"] as const) {
    pushInvalidQueryFieldType(
      failures,
      stream,
      query?.aggregations?.[member] ?? [],
      isScalarGroupSchema,
      `${basePath}/query/aggregations/${member}`
    );
  }
  pushInvalidQueryFieldType(
    failures,
    stream,
    query?.aggregations?.group_by_time ?? [],
    isTimeBucketSchema,
    `${basePath}/query/aggregations/group_by_time`
  );
  for (const member of ["min", "max"] as const) {
    pushInvalidQueryFieldType(
      failures,
      stream,
      query?.aggregations?.[member] ?? [],
      isRangeSchema,
      `${basePath}/query/aggregations/${member}`
    );
  }
  pushInvalidQueryFieldType(
    failures,
    stream,
    query?.aggregations?.sum ?? [],
    (schema) => hasOneNonNullType(schema, new Set(["integer", "number"])),
    `${basePath}/query/aggregations/sum`
  );
}

function validateUniqueStreamMembers(
  stream: SourceDeclarationStream,
  streamIndex: number,
  failures: SourceDeclarationSemanticFailure[]
): void {
  const viewIds = new Set<string>();
  for (const [viewIndex, view] of (stream.views ?? []).entries()) {
    if (viewIds.has(view.id)) {
      failures.push({
        code: "source.declaration.duplicate_view_id",
        path: `/streams/${streamIndex}/views/${viewIndex}/id`,
        reference: view.id,
      });
    }
    viewIds.add(view.id);
  }
  const relationshipNames = new Set<string>();
  for (const [relationshipIndex, relationship] of (stream.relationships ?? []).entries()) {
    if (relationshipNames.has(relationship.name)) {
      failures.push({
        code: "source.declaration.duplicate_relationship_name",
        path: `/streams/${streamIndex}/relationships/${relationshipIndex}/name`,
        reference: relationship.name,
      });
    }
    relationshipNames.add(relationship.name);
  }
}

function validateRelationships(
  declaration: SourceDeclaration,
  streamsByName: Map<string, SourceDeclarationStream>,
  failures: SourceDeclarationSemanticFailure[]
): void {
  for (const [streamIndex, stream] of declaration.streams.entries()) {
    const relationships = new Map(
      (stream.relationships ?? []).map((relationship) => [relationship.name, relationship])
    );
    for (const [relationshipIndex, relationship] of (stream.relationships ?? []).entries()) {
      const relatedStream = streamsByName.get(relationship.stream);
      const basePath = `/streams/${streamIndex}/relationships/${relationshipIndex}`;
      if (!relatedStream) {
        failures.push({
          code: "source.declaration.unknown_stream",
          path: `${basePath}/stream`,
          reference: relationship.stream,
        });
        continue;
      }
      const foreignKeyStream = relationship.cardinality === "has_many" ? relatedStream : stream;
      pushUnknownFields(
        failures,
        [relationship.foreign_key],
        schemaFieldNames(foreignKeyStream),
        `${basePath}/foreign_key`
      );
    }
    validateExpandCapabilities(stream, streamIndex, relationships, failures);
  }
}

function validateExpandCapabilities(
  stream: SourceDeclarationStream,
  streamIndex: number,
  relationships: Map<string, NonNullable<SourceDeclarationStream["relationships"]>[number]>,
  failures: SourceDeclarationSemanticFailure[]
): void {
  const expands = stream.query?.expand ?? [];
  for (const [expandIndex, expand] of expands.entries()) {
    const path = `/streams/${streamIndex}/query/expand/${expandIndex}`;
    const firstIndex = expands.findIndex((candidate) => candidate.name === expand.name);
    if (firstIndex !== expandIndex) {
      failures.push({
        code: "source.declaration.duplicate_expand_name",
        path: `${path}/name`,
        reference: expand.name,
      });
    }
    const relationship = relationships.get(expand.name);
    if (!relationship) {
      failures.push({ code: "source.declaration.unknown_relationship", path: `${path}/name`, reference: expand.name });
      continue;
    }
    const limitsAreReversed =
      expand.default_limit !== undefined && expand.max_limit !== undefined && expand.default_limit > expand.max_limit;
    const hasOneDeclaresLimits =
      relationship.cardinality === "has_one" && (expand.default_limit !== undefined || expand.max_limit !== undefined);
    if (limitsAreReversed || hasOneDeclaresLimits) {
      failures.push({ code: "source.declaration.invalid_expand_limits", path, reference: expand.name });
    }
  }
}

function validatePresets(
  declaration: SourceDeclaration,
  streamsByName: Map<string, SourceDeclarationStream>,
  failures: SourceDeclarationSemanticFailure[]
): void {
  const presetIds = new Set<string>();
  for (const [presetIndex, preset] of (declaration.selection_presets ?? []).entries()) {
    if (presetIds.has(preset.id)) {
      failures.push({
        code: "source.declaration.duplicate_preset_id",
        path: `/selection_presets/${presetIndex}/id`,
        reference: preset.id,
      });
    }
    presetIds.add(preset.id);
    const presetStreamNames = new Set<string>();
    for (const [selectionIndex, selection] of preset.streams.entries()) {
      const basePath = `/selection_presets/${presetIndex}/streams/${selectionIndex}`;
      if (presetStreamNames.has(selection.name)) {
        failures.push({
          code: "source.declaration.duplicate_preset_stream_name",
          path: `${basePath}/name`,
          reference: selection.name,
        });
      }
      presetStreamNames.add(selection.name);
      const stream = streamsByName.get(selection.name);
      if (!stream) {
        failures.push({
          code: "source.declaration.unknown_stream",
          path: `${basePath}/name`,
          reference: selection.name,
        });
        continue;
      }
      if (selection.view && !(stream.views ?? []).some((view) => view.id === selection.view)) {
        failures.push({ code: "source.declaration.unknown_view", path: `${basePath}/view`, reference: selection.view });
      }
      pushUnknownFields(failures, selection.fields ?? [], schemaFieldNames(stream), `${basePath}/fields`);
    }
  }
}

/** Validates SourceDeclaration invariants that JSON Schema cannot express. */
export function validateSourceDeclarationSemantics(
  declaration: SourceDeclaration
): SourceDeclarationSemanticValidationResult {
  const failures: SourceDeclarationSemanticFailure[] = [];
  const streamsByName = new Map<string, SourceDeclarationStream>();
  for (const [streamIndex, stream] of declaration.streams.entries()) {
    if (streamsByName.has(stream.name)) {
      failures.push({
        code: "source.declaration.duplicate_stream_name",
        path: `/streams/${streamIndex}/name`,
        reference: stream.name,
      });
    } else {
      streamsByName.set(stream.name, stream);
    }
    validateUniqueStreamMembers(stream, streamIndex, failures);
    validateStreamFieldReferences(stream, streamIndex, failures);
    validateEmbeddedSchemaNode(stream.schema, `/streams/${streamIndex}/schema`, failures);
  }
  validateRelationships(declaration, streamsByName, failures);
  validatePresets(declaration, streamsByName, failures);
  return failures.length === 0 ? { ok: true } : { failures, ok: false };
}

export interface SourceAuthorizationSemanticFailure {
  code:
    | "source.grant.duplicate_stream_name"
    | "source.grant.invalid_time_constraint"
    | "source.selection.duplicate_stream_name"
    | "source.selection.invalid_time_range"
    | "source.selection.wildcard_must_be_only_stream";
  path: string;
  reference: string;
}

export type SourceAuthorizationSemanticValidationResult =
  | { ok: true }
  | { failures: SourceAuthorizationSemanticFailure[]; ok: false };

function hasReversedBounds(value: { since?: string; until?: string }): boolean {
  return Boolean(value.since && value.until && Date.parse(value.since) > Date.parse(value.until));
}

/** Validates selection invariants that depend on sibling stream entries. */
export function validateSelectionRequestSemantics(
  request: SelectionRequest
): SourceAuthorizationSemanticValidationResult {
  if (!("streams" in request && request.streams)) {
    return { ok: true };
  }
  const failures: SourceAuthorizationSemanticFailure[] = [];
  const names = new Set<string>();
  for (const [index, stream] of request.streams.entries()) {
    if (names.has(stream.name)) {
      failures.push({
        code: "source.selection.duplicate_stream_name",
        path: `/streams/${index}/name`,
        reference: stream.name,
      });
    }
    names.add(stream.name);
    if (stream.time_range && hasReversedBounds(stream.time_range)) {
      failures.push({
        code: "source.selection.invalid_time_range",
        path: `/streams/${index}/time_range`,
        reference: stream.name,
      });
    }
  }
  if (names.has("*") && request.streams.length !== 1) {
    failures.push({
      code: "source.selection.wildcard_must_be_only_stream",
      path: "/streams",
      reference: "*",
    });
  }
  return failures.length === 0 ? { ok: true } : { failures, ok: false };
}

/** Validates resolved-grant invariants that depend on sibling stream entries. */
export function validateResolvedGrantSemantics(grant: ResolvedGrant): SourceAuthorizationSemanticValidationResult {
  const failures: SourceAuthorizationSemanticFailure[] = [];
  const names = new Set<string>();
  for (const [index, stream] of grant.streams.entries()) {
    if (names.has(stream.name)) {
      failures.push({
        code: "source.grant.duplicate_stream_name",
        path: `/streams/${index}/name`,
        reference: stream.name,
      });
    }
    names.add(stream.name);
    if (stream.time_constraint && hasReversedBounds(stream.time_constraint)) {
      failures.push({
        code: "source.grant.invalid_time_constraint",
        path: `/streams/${index}/time_constraint`,
        reference: stream.name,
      });
    }
  }
  return failures.length === 0 ? { ok: true } : { failures, ok: false };
}

const RetentionSchema = {
  additionalProperties: false,
  properties: {
    max_duration: NonEmptyStringSchema,
    on_expiry: { enum: ["delete", "anonymize"], type: "string" },
  },
  required: ["max_duration", "on_expiry"],
  type: "object",
} satisfies JsonSchema;

const TimeRangeSchema = {
  additionalProperties: false,
  anyOf: [{ required: ["since"] }, { required: ["until"] }],
  properties: { since: DateTimeSchema, until: DateTimeSchema },
  type: "object",
} satisfies JsonSchema;

const SelectionRequestStreamSchema = {
  additionalProperties: false,
  allOf: [{ not: { required: ["fields", "view"] } }],
  properties: {
    fields: NonEmptyUniqueStringsSchema,
    instance_ids: NonEmptyUniqueStringsSchema,
    name: NonEmptyStringSchema,
    necessity: { enum: ["required", "optional"], type: "string" },
    resources: NonEmptyUniqueStringsSchema,
    time_range: TimeRangeSchema,
    view: NonEmptyStringSchema,
  },
  required: ["name"],
  type: "object",
} satisfies JsonSchema;

export const SelectionRequestSchema = {
  additionalProperties: false,
  oneOf: [
    { not: { required: ["selection_preset"] }, required: ["streams"] },
    { not: { required: ["streams"] }, required: ["selection_preset"] },
  ],
  properties: {
    access_mode: { enum: ["single_use", "continuous"], type: "string" },
    client_claims: {
      additionalProperties: false,
      properties: {
        commitments: {
          items: NonEmptyStringSchema,
          minItems: 1,
          type: "array",
          uniqueItems: true,
        },
      },
      type: "object",
    },
    purpose_code: { format: "uri", minLength: 1, type: "string" },
    purpose_description: NonEmptyStringSchema,
    retention: RetentionSchema,
    selection_preset: NonEmptyStringSchema,
    source: SourceRequestObjectSchema,
    streams: { items: SelectionRequestStreamSchema, minItems: 1, type: "array", uniqueItems: true },
    type: { const: "https://pdpp.dev/data-access" },
  },
  required: ["type", "source", "purpose_code", "access_mode"],
  type: "object",
} satisfies JsonSchema;

const TimeConstraintSchema = {
  additionalProperties: false,
  anyOf: [{ required: ["since"] }, { required: ["until"] }],
  properties: { field: NonEmptyStringSchema, since: DateTimeSchema, until: DateTimeSchema },
  required: ["field"],
  type: "object",
} satisfies JsonSchema;

const ResolvedGrantStreamSchema = {
  additionalProperties: false,
  properties: {
    fields: NonEmptyUniqueStringsSchema,
    instance_ids: NonEmptyUniqueStringsSchema,
    name: { minLength: 1, not: { const: "*" }, type: "string" },
    resources: NonEmptyUniqueStringsSchema,
    time_constraint: TimeConstraintSchema,
  },
  required: ["name", "instance_ids", "fields"],
  type: "object",
} satisfies JsonSchema;

export const ResolvedGrantSchema = {
  additionalProperties: false,
  properties: {
    access_mode: { enum: ["single_use", "continuous"], type: "string" },
    client: {
      additionalProperties: false,
      properties: {
        client_display: {
          additionalProperties: false,
          properties: {
            logo_uri: UriSchema,
            name: NonEmptyStringSchema,
            policy_uri: UriSchema,
            tos_uri: UriSchema,
            uri: UriSchema,
          },
          type: "object",
        },
        client_id: NonEmptyStringSchema,
      },
      required: ["client_id"],
      type: "object",
    },
    expires_at: { format: "date-time", type: "string" },
    grant_id: NonEmptyStringSchema,
    issued_at: DateTimeSchema,
    purpose_code: { format: "uri", minLength: 1, type: "string" },
    purpose_description: NonEmptyStringSchema,
    retention: RetentionSchema,
    selection_preset: NonEmptyStringSchema,
    source: SourceObjectSchema,
    source_declaration: {
      additionalProperties: false,
      properties: { version: NonEmptyStringSchema },
      required: ["version"],
      type: "object",
    },
    streams: { items: ResolvedGrantStreamSchema, minItems: 1, type: "array", uniqueItems: true },
    subject: {
      additionalProperties: false,
      properties: { id: NonEmptyStringSchema },
      required: ["id"],
      type: "object",
    },
    version: { const: "0.1.0", type: "string" },
  },
  required: [
    "version",
    "grant_id",
    "issued_at",
    "subject",
    "client",
    "source",
    "source_declaration",
    "purpose_code",
    "access_mode",
    "streams",
  ],
  type: "object",
} satisfies JsonSchema;
