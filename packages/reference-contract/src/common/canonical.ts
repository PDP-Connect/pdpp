// Canonical public read contract primitives.
//
// These schemas back the canonical envelope, warnings vocabulary, count
// grading, and shared read-input parameters defined in
//   openspec/changes/canonicalize-public-read-contract/
//
// They are additive groundwork: existing public manifests continue to use
// their bespoke envelopes (RecordsListResponseSchema, search hit shapes,
// etc.). Manifest migration onto these helpers happens in a follow-up pass
// once the runtime is ready to emit `links` and structured `meta.warnings`.
//
// The shape of each helper matches `JsonSchema` from ./index.ts so the
// downstream AJV / OpenAPI pipeline accepts them without translation.

// Avoid importing from ./index.ts: that module re-exports everything in this
// file, which creates a value-level cycle (`CursorSchema` is undefined when
// this module's top-level statements run). Pull the JsonSchema type from
// the dedicated type module to keep the dependency one-way, and re-declare
// the cursor primitive locally — it's a single string with a description,
// not worth a cycle.
import type { JsonSchema } from "./json-schema.ts";

const CanonicalCursorSchema: JsonSchema = {
  $id: "pdpp/canonical/Cursor",
  type: "string",
  description: "Opaque server-issued pagination cursor. Encodes the cursor-field/primary-key position.",
};

// ----- Connection identity (shared with public manifests) -----

// The public/operator/LLM-facing connection identity. Mirrored here so the
// canonical envelope and shared read-input helpers can reuse the exact same
// schemas as the existing public manifests without introducing a circular
// import. Keep field semantics in lock-step with public/index.ts.
export const ConnectionIdSchema: JsonSchema = {
  type: "string",
  minLength: 1,
  description:
    "Canonical public identifier for a connection (one owner-configured account/device/profile). Capabilities and granted connection identities are advertised through `GET /v1/schema`.",
};

export const ConnectionDisplayNameSchema: JsonSchema = {
  type: "string",
  minLength: 1,
  description:
    "Owner-meaningful label for the connection. Never the storage-layer placeholder (`legacy`, `default_account`).",
};

export const ConnectorInstanceIdAliasSchema: JsonSchema = {
  type: "string",
  minLength: 1,
  description:
    "Deprecated wire alias for `connection_id`. Emitted alongside `connection_id` during the migration window. New clients SHOULD ignore this field and read `connection_id` instead.",
};

// ----- Envelope: links -----

// `links.self` round-trips the effective request so a client can replay the
// exact call without reconstructing query state. `links.next` is server-
// built and opaque to clients; absent or `null` means no further page.
//
// Both members are optional on non-list responses, but the canonical envelope
// helpers below pull them in by default so the wire shape is uniform.
export const LinksSchema: JsonSchema = {
  $id: "pdpp/canonical/Links",
  type: "object",
  additionalProperties: false,
  properties: {
    self: { type: "string", description: "Effective request URL for this response." },
    next: {
      type: ["string", "null"],
      description: "Opaque server-built next-page URL or `null` when no further page is available.",
    },
  },
};

// ----- Envelope: count meta -----

// Counts are opt-in and cost-graded. The initial vocabulary is `none`,
// `estimated`, and `exact`; servers MAY downgrade a requested grade and
// MUST emit a `count_downgraded` warning if they do.
export const CountKindSchema: JsonSchema = {
  $id: "pdpp/canonical/CountKind",
  type: "string",
  enum: ["none", "estimated", "exact"],
  description: "Cost-graded count grade. `none` means the server returned no count value.",
};

export const CountMetaSchema: JsonSchema = {
  $id: "pdpp/canonical/CountMeta",
  type: "object",
  additionalProperties: false,
  properties: {
    kind: CountKindSchema,
    // `value` is only meaningful when `kind` is `estimated` or `exact`. Servers
    // MAY omit it when `kind` is `none`. We keep the property optional rather
    // than tying it to `kind` via a oneOf so AJV stays cheap; runtime layer
    // is responsible for emitting them consistently.
    value: { type: "integer", minimum: 0 },
  },
  required: ["kind"],
};

// ----- Envelope: bounded window aggregate -----

// Optional bounded aggregate metadata for a record-list read. Additive and
// opt-in via the `window=exact` query parameter; omitted entirely when not
// requested or not cheaply computable (never estimated). `total` is always
// present when `window` is present. `earliest_at` / `latest_at` are the
// logical-time (`consent_time_field`) bounds of the filtered, grant-scoped
// corpus before pagination; they are present together or both omitted (an
// empty corpus, an undeclared `consent_time_field`, or an all-unparseable
// corpus yields `total` with no timestamps).
//
// Spec: openspec/changes/complete-explorer-slvp-ideal/specs/
//       reference-implementation-architecture/spec.md
//       (#"The record-list read MAY expose bounded window aggregate metadata").
export const WindowMetaSchema: JsonSchema = {
  $id: "pdpp/canonical/WindowMeta",
  type: "object",
  additionalProperties: false,
  properties: {
    total: { type: "integer", minimum: 0 },
    earliest_at: { type: "string", format: "date-time" },
    latest_at: { type: "string", format: "date-time" },
  },
  required: ["total"],
};

// ----- Envelope: warnings -----

// The initial structured warning code set. Closed by design: new codes
// require an OpenSpec change so clients can rely on stable signals for
// non-fatal lossiness instead of prose pattern matching.
export const WarningCodeSchema: JsonSchema = {
  $id: "pdpp/canonical/WarningCode",
  type: "string",
  enum: [
    // Server downgraded a requested count grade (e.g. exact -> estimated).
    "count_downgraded",
    // Multi-source read skipped a source because the requested stream or
    // field is not applicable to it.
    "source_skipped_not_applicable",
    // Request supplied a deprecated compatibility alias such as
    // `connector_instance_id`.
    "deprecated_alias_used",
    // Response is partial because the server short-circuited (e.g. timeout
    // budget exceeded) and the remaining sources were not consulted.
    "partial_results",
    // Server applied a default or compatibility fallback (e.g. clamped
    // expand_limit) that the client SHOULD be aware of.
    "compatibility_fallback",
  ],
};

export const WarningSchema: JsonSchema = {
  $id: "pdpp/canonical/Warning",
  type: "object",
  additionalProperties: false,
  properties: {
    code: WarningCodeSchema,
    message: { type: "string", description: "Human-readable explanation. Not a stable client signal." },
    // Optional structured context. Open object because each warning code may
    // attach different fields (e.g. `source`, `requested_kind`, `field`).
    // Runtime is responsible for documenting per-code shapes; the wire
    // contract here just guarantees the envelope.
    detail: { type: "object", additionalProperties: true },
    // When the warning relates to a single field, the owning field path.
    field: { type: "string" },
    // When the warning relates to a particular connection, the
    // `connection_id` it concerns.
    connection_id: { type: "string", minLength: 1 },
  },
  required: ["code", "message"],
};

// ----- Envelope: meta block -----

// Composed meta block used by the canonical envelope helpers. Both members
// are optional on the wire so non-list responses don't have to invent empty
// counts/warnings; helpers below add them in the typical list cases.
export const MetaSchema: JsonSchema = {
  $id: "pdpp/canonical/Meta",
  type: "object",
  additionalProperties: false,
  properties: {
    count: CountMetaSchema,
    window: WindowMetaSchema,
    warnings: { type: "array", items: WarningSchema },
  },
};

// ----- Envelope helpers -----

// Internal helper: builds a property bag with the common envelope members.
// `objectConst` controls the discriminator literal so call sites don't have
// to repeat it.
function envelopeBaseProperties(objectConst: string): Record<string, JsonSchema> {
  return {
    object: { const: objectConst },
    links: LinksSchema,
    meta: MetaSchema,
  };
}

// Canonical list envelope. Items are validated by the caller-supplied
// `itemSchema`. `has_more` is the boolean has-next-page signal; `links.next`
// is the opaque follow-up URL when present.
//
// This is the canonical equivalent of the legacy `ListEnvelopeSchema` in
// ./index.ts. We keep both because public manifests still wire the legacy
// one; new manifests SHOULD switch to this helper once they are ready to
// emit `links` and `meta`.
export const CanonicalListEnvelopeSchema = (itemSchema: JsonSchema): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties: {
    ...envelopeBaseProperties("list"),
    data: { type: "array", items: itemSchema },
    has_more: { type: "boolean" },
  },
  required: ["object", "data", "has_more", "links", "meta"],
});

// Canonical single-object envelope. `data` is the single payload object; the
// envelope keeps the same `object`/`links`/`meta` vocabulary as list
// responses so clients consume one shape.
export const CanonicalSingleEnvelopeSchema = (objectConst: string, dataSchema: JsonSchema): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties: {
    ...envelopeBaseProperties(objectConst),
    data: dataSchema,
  },
  required: ["object", "data", "links", "meta"],
});

// Canonical schema/capability envelope. Identical to the single-object
// envelope but pinned to `object: "schema"` so the discovery surface has a
// stable discriminator.
export const CanonicalSchemaEnvelopeSchema = (dataSchema: JsonSchema): JsonSchema =>
  CanonicalSingleEnvelopeSchema("schema", dataSchema);

// Canonical search envelope. Distinguished from the generic list envelope
// only by the `object: "search"` discriminator; hits remain list-like with
// `has_more` and `links.next`. Server-side search modes that do not support
// cursor pagination MUST advertise that limitation through `/v1/schema`
// (see openspec/changes/canonicalize-public-read-contract).
export const CanonicalSearchEnvelopeSchema = (hitSchema: JsonSchema): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties: {
    ...envelopeBaseProperties("search"),
    data: { type: "array", items: hitSchema },
    has_more: { type: "boolean" },
  },
  required: ["object", "data", "has_more", "links", "meta"],
});

// Canonical aggregate envelope. Aggregations are single-object responses
// (one metric value plus optional groups) but live under the search-like
// `object: "aggregate"` discriminator. Implementations carry the metric
// payload under `data`.
export const CanonicalAggregateEnvelopeSchema = (dataSchema: JsonSchema): JsonSchema =>
  CanonicalSingleEnvelopeSchema("aggregate", dataSchema);

// ----- Shared read-input parameter schemas -----

// `fields` is the projection allowlist. Accepted as either a CSV string or
// an array of field paths so the same primitive serves URL query, JSON body,
// and MCP tool input. Runtime is responsible for splitting/normalizing.
export const FieldsParamSchema: JsonSchema = {
  $id: "pdpp/canonical/FieldsParam",
  description:
    "Field allowlist for projection. CSV string or array of field paths. Dotted paths apply to expanded child records.",
  anyOf: [
    { type: "string", minLength: 1 },
    {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
  ],
};

// `expand[]` is the one-hop inline expansion list. Server validates each
// relation against the stream's advertised expand capabilities; this schema
// only locks the wire shape.
export const ExpandParamSchema: JsonSchema = {
  $id: "pdpp/canonical/ExpandParam",
  description:
    "One-hop inline expansion list. Each entry is a manifest-declared parent-to-child relation name advertised by `GET /v1/schema`.",
  type: "array",
  items: { type: "string", minLength: 1 },
};

// `expand_limit` caps the number of child records returned per has-many
// relation. Open value object — values are per-relation positive integers;
// AJV only validates the outer shape so the runtime can reject unknown
// relation names with a typed error rather than a generic schema failure.
export const ExpandLimitParamSchema: JsonSchema = {
  $id: "pdpp/canonical/ExpandLimitParam",
  description:
    "Per-relation has-many cap, keyed by relation name. Values are positive integers; the server clamps to the per-relation `max_limit` advertised by `/v1/schema`.",
  type: "object",
  additionalProperties: { type: "integer", minimum: 1 },
};

// `filter` is the per-field filter map. Each entry is either an exact value
// (string/number/boolean) or an operator submap (`{ op: value }`). Allowed
// operators per field are advertised through `/v1/schema`; the schema layer
// only locks the wire shape.
export const FilterParamSchema: JsonSchema = {
  $id: "pdpp/canonical/FilterParam",
  description:
    "Per-field filter map. Exact: `filter[field]=value`. Operator: `filter[field][op]=value`. Allowed operators per field come from `/v1/schema` `field_capabilities`.",
  type: "object",
  additionalProperties: {
    anyOf: [
      { type: "string" },
      { type: "number" },
      { type: "integer" },
      { type: "boolean" },
      {
        type: "object",
        additionalProperties: {
          // Operator value. Accepts the same scalar set as exact filters; the
          // server is responsible for type-checking against the field schema.
          anyOf: [{ type: "string" }, { type: "number" }, { type: "integer" }, { type: "boolean" }],
        },
      },
    ],
  },
};

// `sort` is a CSV or array of sign-prefixed field names. Example:
// `sort=-emitted_at,name` sorts by emitted_at descending then name ascending.
// Sortable fields are advertised through `/v1/schema`.
export const SortParamSchema: JsonSchema = {
  $id: "pdpp/canonical/SortParam",
  description:
    "Sign-prefix sort spec. CSV string (`sort=-emitted_at,name`) or array of `[-]field` entries. Sortable fields come from `/v1/schema`.",
  anyOf: [
    { type: "string", minLength: 1, pattern: "^-?[A-Za-z0-9_.]+(,-?[A-Za-z0-9_.]+)*$" },
    {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1, pattern: "^-?[A-Za-z0-9_.]+$" },
    },
  ],
};

// `count` is the requested count grade. Mirrors the HTTP `Prefer: count=...`
// header for generated clients and MCP tools that pass it as an argument.
export const CountParamSchema: JsonSchema = {
  $id: "pdpp/canonical/CountParam",
  description:
    "Requested count grade. Equivalent to the HTTP `Prefer: count=none|estimated|exact` header. The server MAY downgrade and SHALL emit a `count_downgraded` warning.",
  type: "string",
  enum: ["none", "estimated", "exact"],
};

// Limit primitive. The canonical contract caps list/search pages at 500 in
// line with the legacy `PaginationQuerySchema` in ./index.ts. Per-operation
// caps may be lower (e.g. records list keeps its 100 cap); operations can
// override this when wiring the manifest.
export const LimitParamSchema: JsonSchema = {
  $id: "pdpp/canonical/LimitParam",
  type: "integer",
  minimum: 1,
  maximum: 500,
  description: "Maximum number of items per page. Per-operation caps may be lower; see `/v1/schema`.",
};

// Canonical read input bundle. Helper for assembling a manifest `query` or
// MCP tool `inputSchema` from the shared primitives without restating each
// description.
//
// All members are optional; required-ness is controlled at the manifest
// level. Connection identity is included here so multi-connection
// deployments can scope reads without each operation re-declaring the
// primitive.
export const CanonicalReadInputProperties: Record<string, JsonSchema> = {
  fields: FieldsParamSchema,
  expand: ExpandParamSchema,
  expand_limit: ExpandLimitParamSchema,
  filter: FilterParamSchema,
  sort: SortParamSchema,
  count: CountParamSchema,
  limit: LimitParamSchema,
  cursor: CanonicalCursorSchema,
  connection_id: ConnectionIdSchema,
  connector_instance_id: ConnectorInstanceIdAliasSchema,
};

// Convenience helper for new manifests: returns a `query` JSON-Schema with
// the canonical read inputs locked under `additionalProperties: false`. New
// operations SHOULD use this so unknown parameters are rejected at the AJV
// layer in addition to runtime strict-validation.
export const CanonicalReadInputQuerySchema = (extraProperties: Record<string, JsonSchema> = {}): JsonSchema => ({
  type: "object",
  additionalProperties: false,
  properties: {
    ...CanonicalReadInputProperties,
    ...extraProperties,
  },
});
