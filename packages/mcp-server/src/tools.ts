// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { buildRecordContentLadder as buildSharedRecordContentLadder, summarizeRecordEvidence } from "@pdpp/read-core";
import { z } from "zod";
import type { QueryParams, RsClient, RsErrorResponse, RsResponse } from "./rs-client.ts";

// `@pdpp/read-core` has no published type declarations; its exports are
// implicitly `any`. Every call site below assigns the result through one of
// these narrow return-type annotations so `any` never leaks into this module.
type SharedRecordContentLadder = Record<string, unknown> & {
  id?: string;
  field_windows?: unknown;
};

function callBuildSharedRecordContentLadder(
  record: unknown,
  options: Record<string, unknown>
): SharedRecordContentLadder | null {
  return buildSharedRecordContentLadder(record, options) as SharedRecordContentLadder | null;
}

function callSummarizeRecordEvidence(body: unknown, label: string, options: Record<string, unknown> = {}): string {
  return summarizeRecordEvidence(body, label, options) as string;
}

// A JSON-shaped value read from an RS response body. RS envelopes are
// duck-typed throughout this module (alias fallbacks, optional nesting) rather
// than parsed into a fixed schema, so `unknown` plus the narrowing primitives
// below (`objectValue`, `firstString`, `numberValue`, `stringValue`) is the
// honest type for a body/record/hit — not a shape this module does not
// actually validate.
type Json = unknown;
type JsonObject = Record<string, unknown>;

interface ToolTextContent {
  text: string;
  type: "text";
}
// Kept as a `type` (not `interface`) on purpose — the MCP SDK's
// `CallToolResult` return type carries an index signature (`[x: string]:
// unknown`), which only a structurally-open `type` alias satisfies when
// passed to `registerTool`'s handler callback; an `interface` here would
// need `[key: string]: unknown` as boilerplate to allow the same structural
// match, and the SDK signature isn't ours to widen.
// biome-ignore lint/style/useConsistentTypeDefinitions: see comment above.
type McpToolResult = {
  content: ToolTextContent[];
  isError?: boolean;
  structuredContent?: JsonObject;
};

interface ToolAnnotations {
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
  readOnlyHint: boolean;
}

interface ToolDefinition {
  annotations: ToolAnnotations;
  description: string;
  handler: (args: JsonObject) => Promise<McpToolResult>;
  inputSchema: z.ZodType;
  name: string;
  outputSchema?: z.ZodType;
  title: string;
}

// Kept as a `type` for the same reason as `McpToolResult` above — it flows
// into the MCP SDK's `registerResource` read callback, whose return type
// carries an index signature only a structurally-open `type` alias
// satisfies.
// biome-ignore lint/style/useConsistentTypeDefinitions: see comment above.
type ResourceReadResult = {
  contents: Array<{ uri: string; mimeType: string; text: string }>;
};

interface ResourceTemplateDefinition {
  description: string;
  mimeType: string;
  name: string;
  read: (uri: string, variables: Record<string, string | string[]>) => Promise<ResourceReadResult>;
  title: string;
  uriTemplate: string;
}

// Kept as a `type` (not `interface`) on purpose — `FieldWindowRef` below
// intersects this shape and is passed where a structurally-open `JsonObject`
// (`Record<string, unknown>`) is expected; an `interface` base loses that
// structural match even through a `type` intersection.
// biome-ignore lint/style/useConsistentTypeDefinitions: see comment above.
type RecordRef = {
  connectionId: string | null;
  recordId: string;
  stream: string;
};
type FieldWindowRef = RecordRef & {
  connectionId: string;
  field_path: string;
  cursor?: string;
  offset_chars?: number;
  limit_chars?: number;
  q?: string;
  before_chars?: number;
  after_chars?: number;
};

type ResourceHandlePayload = JsonObject & { v: number; kind: string };

interface MatchWindow {
  complete: boolean;
  field_path: string;
  next_cursor?: string | undefined;
  preview_text: string;
  read?: JsonObject | { tool: string; args: JsonObject } | undefined;
  text: string;
}

interface SearchResult {
  connection_id?: string;
  connector_key?: string;
  display_name?: string;
  evidence_excerpts?: JsonObject[];
  id: string;
  match_windows?: MatchWindow[];
  record_key?: string;
  snippet?: string;
  stream?: string;
  title: string;
  url: string;
}

interface FetchedDocument {
  id: string;
  metadata: JsonObject;
  text: string;
  title: string;
  url: string;
}

const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const PDPP_MCP_TOOL_NAMES = Object.freeze([
  "schema",
  "query_records",
  "aggregate",
  "search",
  "fetch",
  "read_record_field",
]);

function selectNormalTools(tools: ToolDefinition[]): ToolDefinition[] {
  const expectedNames: readonly string[] = PDPP_MCP_TOOL_NAMES;
  const expected = new Set(expectedNames);
  const selected = tools.filter((tool) => expected.has(tool.name));
  const selectedNames = new Set(selected.map((tool) => tool.name));
  const missing = expectedNames.filter((name) => !selectedNames.has(name));
  if (missing.length > 0) {
    throw new Error(`MCP normal surface is missing expected tools: ${missing.join(", ")}`);
  }
  const unexpected = tools.map((tool) => tool.name).filter((name) => !expected.has(name));
  if (unexpected.length > 0) {
    throw new Error(`MCP normal surface has unexpected tools: ${unexpected.join(", ")}`);
  }
  return selected;
}

// MCP-exposed subset of the REST public read query-param vocabulary. These
// keys are forwarded to the RS; the MCP layer never silently drops a member.
// `sort` and `count` are canonical public read primitives advertised by
// `GET /v1/schema` and implemented by the reference runtime where declared.
const SUPPORTED_QUERY_KEYS = new Set([
  "limit",
  "cursor",
  "order",
  "sort",
  "count",
  "filter",
  "fields",
  "view",
  "expand",
  "expand_limit",
  "changes_since",
  // Optional public connection identity. Forwarded verbatim to the RS so
  // the resource server enforces grant scope; the MCP layer never invents
  // or rewrites a connection_id. See:
  //   openspec/changes/expose-connection-identity-on-public-read
  "connection_id",
]);

// Mirror of the REST aggregate query-param vocabulary
// (`/v1/streams/{stream}/aggregate`). Forwarded verbatim to the RS so the
// resource server owns metric/grouping validation; the MCP layer never
// silently drops a member. See:
//   openspec/changes/add-aggregate-time-buckets-and-distinct
const SUPPORTED_AGGREGATE_QUERY_KEYS = new Set([
  "metric",
  "field",
  "group_by",
  "group_by_time",
  "granularity",
  "time_zone",
  "limit",
  "filter",
  "connection_id",
]);

const CONNECTION_ID_DESCRIPTION =
  "Optional. Scope this call to one connection. Omit to fan in across all granted connections. Obtain from `schema` or the `available_connections` field in a typed 409 error — each entry includes `connector_key` and `connection_id`. Persist `connection_id` (not `grant_id`) across reconnects.";

const LIMIT_DESCRIPTION =
  "Records per page. Omit for the default page of 25; the maximum is 100 (the spec-core §8 contract). Values above 100 are rejected here rather than silently clamped, so the page size you request is always the page size you get. Page forward with the returned `cursor` instead of asking for a larger page.";

const SEARCH_LIMIT_DESCRIPTION =
  "Hits per page. Omit for the default page of 25; the maximum is 100 — the bound the published `/v1/search`, `/v1/search/semantic`, and `/v1/search/hybrid` contract declares and every mode honors (mirrored as `capabilities.{lexical,semantic,hybrid}_retrieval.max_limit` in `/.well-known/oauth-protected-resource` and `GET /v1/schema`). Values above 100 are rejected here rather than forwarded to be silently clamped by the RS, so the page size you request is always the page size you get. Page forward with the returned `cursor` (lexical and semantic page; hybrid does not) instead of asking for a larger page.";

const FIELDS_DESCRIPTION =
  "Field allowlist for projection. Field paths must be declared by the stream; advertised by `GET /v1/schema` (`field_capabilities`). Unknown paths are rejected by the RS rather than silently widened.";

const VIEW_DESCRIPTION =
  "Named projection. A stream-declared view id (advertised by `GET /v1/schema` under each stream's `views`) that projects the returned records down to the view's field set. Mutually exclusive with `fields` (passing both is rejected by the RS); an unknown view id is rejected rather than silently ignored. Use `view` for a curated projection and `fields` for an ad-hoc one.";

const FILTER_DESCRIPTION =
  'Typed per-field filter. Pass an OBJECT keyed by field name — never a pre-encoded query string. Exact match: `{ "user_id": "U123" }`. Range: `{ "created_at": { "gte": "2026-01-01T00:00:00Z", "lt": "2026-02-01T00:00:00Z" } }`, where the operator is one of `gte`, `gt`, `lte`, `lt`. Multiple fields AND together. The adapter encodes this into the RS `filter[field]=value` / `filter[field][op]=value` query shape for you. Allowed fields and operators are advertised by `GET /v1/schema` (`field_capabilities`); unsupported fields or operators are rejected by the RS rather than silently ignored.';

const EXPAND_DESCRIPTION =
  "One-hop inline expansion list. Each entry is a manifest-declared parent-to-child relation. Expandable relations and per-relation `expand_limit` caps are advertised by `GET /v1/schema` (`expand_capabilities`); unadvertised relations are rejected by the RS.";

const EXPAND_LIMIT_DESCRIPTION =
  'Typed per-relation cap for has-many expansion, keyed by relation name. Pass an object such as `{ "messages": 3 }`; the adapter encodes it into the RS `expand_limit[relation]=N` query shape. The RS clamps to the per-relation `max_limit` advertised by `GET /v1/schema`.';

const ORDER_DESCRIPTION =
  "Legacy page order for cursor-based pagination: `asc` or `desc`. Prefer canonical `sort` when `/v1/schema` advertises sortable fields; `order` remains accepted for clients that have not migrated.";

const SORT_DESCRIPTION =
  "Canonical sign-prefix sort spec advertised by `GET /v1/schema` (e.g. `sort=-emitted_at`). The reference runtime supports the advertised cursor field; unsupported fields, conflicting directions, or sort/order disagreement are rejected with typed errors rather than treated as no-ops.";

const COUNT_DESCRIPTION =
  'Canonical opt-in count grade (`none`, `estimated`, `exact`). Omit or use `none` for no count. `exact` returns `meta.count.kind="exact"` when supported; `estimated` may be upgraded to an exact count. Counts are page-independent and may be more expensive than the page itself.';

const CHANGES_SINCE_DESCRIPTION =
  "Projection-safe incremental-sync bookmark. Use `beginning` for the initial changes feed, then pass the opaque `next_changes_since` value returned in the prior response. Do not pass an ISO timestamp; malformed bookmarks are rejected as `invalid_cursor`.";

// Supported range operators, mirroring the RS (`record-filters.js`
// SUPPORTED_RANGE_OPERATORS) and the published query contract
// (`apps/site/content/docs/spec-data-query-api.md`).
const SUPPORTED_RANGE_OPERATORS = new Set(["gte", "gt", "lte", "lt"]);

const FIELD_WINDOW_CURSOR_PATTERN = /^\d+$/;
const STREAM_RESOURCE_URI_PATTERN = /^pdpp:\/\/stream\/([^/]+)$/;
const AGGREGATION_KIND_FLAG_PATTERN = /(?:^|,)a=([^,]+)/;
const TRAILING_SLASH_PATTERN = /\/$/;

// A single exact-filter value. The RS coerces by the field's declared JSON
// Schema type, so a scalar is the only meaningful shape; arrays/objects are not
// exact matches.
const FilterScalar = z.union([z.string(), z.number(), z.boolean()]);

// Typed filter input object. Each field maps either to a scalar (exact match)
// or to a range object keyed by `gte`/`gt`/`lte`/`lt`. This mirrors the parsed
// shape the RS receives from `qs.parse(filter[field][op]=value)`, so the
// adapter can encode it back into bracket query params with no semantic
// invention.
const TypedFilterInput = z.record(
  z.string().min(1),
  z.union([
    FilterScalar,
    z
      .object({
        gte: FilterScalar.optional(),
        gt: FilterScalar.optional(),
        lte: FilterScalar.optional(),
        lt: FilterScalar.optional(),
      })
      .strict(),
  ])
);

// Thrown when a typed filter object is structurally ambiguous. Surfaced as a
// typed MCP tool error (`server.js` `toolHandlerError` reads `.code`) so the
// agent gets an actionable instruction instead of a silently-ignored filter.
class MalformedFilterError extends Error {
  code: string;

  constructor(message: string) {
    super(message);
    this.name = "MalformedFilterError";
    this.code = "invalid_filter";
  }
}

class MalformedExpandLimitError extends Error {
  code: string;

  constructor(message: string) {
    super(message);
    this.name = "MalformedExpandLimitError";
    this.code = "invalid_expand";
  }
}

// Thrown when `expand` is requested on a stream whose schema advertises no
// expand_capabilities. The RS would also reject this with invalid_expand, but
// the MCP adapter catches it first so the error message names the stream and
// the canonical fix (consult schema before constructing expand arguments).
class UnadvertisedExpandError extends Error {
  code: string;

  constructor(stream: string, relations: readonly string[]) {
    const relClause = relations.length ? `Relations requested: ${relations.join(", ")}. ` : "";
    super(
      `Stream '${stream}' has no advertised expand_capabilities. ${relClause}` +
        "Consult GET /v1/schema (expand_capabilities) before passing expand; " +
        "unadvertised relations are rejected."
    );
    this.name = "UnadvertisedExpandError";
    this.code = "invalid_expand";
  }
}

// Fetch the compact schema for `stream` and throw UnadvertisedExpandError when
// no expand_capabilities are advertised. Called only when the caller has
// already supplied an `expand` argument, so the extra RS round-trip is bounded
// to expand-using calls. The connection_id is forwarded so multi-source grants
// resolve cleanly.
async function assertExpandCapabilities(
  rs: RsClient,
  stream: string,
  relations: readonly string[],
  connectionId: string | null | undefined
): Promise<void> {
  const schemaQuery: QueryParams = { view: "compact", stream };
  if (connectionId) {
    schemaQuery.connection_id = connectionId;
  }
  const schemaResp = await rs.getJson("/v1/schema", { query: schemaQuery });
  if (!schemaResp.ok) {
    return; // schema unavailable — let RS enforce
  }
  const schemaDoc = unwrapSchemaBody(schemaResp.body);
  const streams = schemaDoc.streams ?? [];
  // Find any stream row that matches (may be multiple for shared stream names).
  const matchingStream = Array.isArray(streams)
    ? streams.find((s) => {
        const row = objectValue(s);
        return row && (row.name === stream || row.stream === stream || row.stream_name === stream);
      })
    : null;
  if (!matchingStream) {
    return; // unknown stream — let RS enforce
  }
  const expandCaps = objectValue(matchingStream)?.expand_capabilities;
  const hasExpandCaps = Array.isArray(expandCaps) ? expandCaps.length > 0 : Boolean(expandCaps);
  if (!hasExpandCaps) {
    throw new UnadvertisedExpandError(stream, relations);
  }
}

// Thrown when a self-contained fetch id embeds one connection while the
// explicit `connection_id` argument names another. Silently preferring either
// handle could read the wrong source, so the disagreement is rejected with a
// typed, actionable error (`server.js` `toolHandlerError` reads `.code`).
class ConflictingConnectionIdError extends Error {
  code: string;

  constructor(embedded: string, explicit: string) {
    super(
      `id embeds connection_id '${embedded}' but the connection_id argument is '${explicit}'; pass the self-contained id alone, or make both handles agree`
    );
    this.name = "ConflictingConnectionIdError";
    this.code = "conflicting_connection_id";
  }
}

class InvalidReadRecordFieldSelectorError extends Error {
  code: string;

  constructor(message: string) {
    super(message);
    this.name = "InvalidReadRecordFieldSelectorError";
    this.code = "invalid_field_window_selector";
  }
}

interface FilterRangeSpec {
  gt?: unknown;
  gte?: unknown;
  lt?: unknown;
  lte?: unknown;
}
type FilterValue = string | number | boolean | FilterRangeSpec;
type FilterInput = Record<string, FilterValue>;
type QueryEntry = [string, string];

// Translate one range-filter spec (`{ gte, gt, lte, lt }`) into
// `filter[field][op]=value` query entries. Split out of
// `filterObjectToBracketEntries` to keep that function's branching budget in
// check.
function rangeFilterBracketEntries(field: string, spec: FilterRangeSpec): QueryEntry[] {
  const opEntries = Object.entries(spec).filter(([, v]) => v !== undefined && v !== null);
  if (opEntries.length === 0) {
    throw new MalformedFilterError(
      `filter range on '${field}' must include at least one of gte/gt/lte/lt; use the typed filter object, e.g. filter: { "${field}": { "gte": <value> } }`
    );
  }
  return opEntries.map(([op, value]) => {
    if (!SUPPORTED_RANGE_OPERATORS.has(op)) {
      throw new MalformedFilterError(
        `unsupported range operator '${op}' on '${field}'; supported operators are gte, gt, lte, lt`
      );
    }
    return [`filter[${field}][${op}]`, String(value)];
  });
}

// Translate a typed filter object into `[bracketKey, value]` query entries the
// RsClient appends verbatim (`filter[field]=value`, `filter[field][op]=value`).
function filterObjectToBracketEntries(filter: FilterInput): QueryEntry[] {
  if (Object.keys(filter).length === 0) {
    throw new MalformedFilterError(
      'filter object must include at least one field; omit filter entirely or pass a typed object such as filter: { "field": "value" }'
    );
  }
  const entries: QueryEntry[] = [];
  for (const [field, spec] of Object.entries(filter)) {
    if (field.includes("[") || field.includes("]")) {
      throw new MalformedFilterError(
        `filter field '${field}' must be an advertised field name, not pre-encoded bracket syntax; pass filter: { "field": "value" }`
      );
    }
    if (spec === undefined || spec === null) {
      continue;
    }
    if (typeof spec === "object" && !Array.isArray(spec)) {
      entries.push(...rangeFilterBracketEntries(field, spec));
      continue;
    }
    // Scalar exact match.
    entries.push([`filter[${field}]`, String(spec)]);
  }
  return entries;
}

// Resolve the tool `filter` argument into the `filter[...]` query entries the
// RS expects. Returns [] when no filter was supplied.
function resolveFilterQueryEntries(filter: FilterInput | null | undefined): QueryEntry[] {
  if (filter === undefined || filter === null) {
    return [];
  }
  if (typeof filter === "object" && !Array.isArray(filter)) {
    return filterObjectToBracketEntries(filter);
  }
  throw new MalformedFilterError(
    'filter must be a typed object, e.g. filter: { "field": "value" } or filter: { "field": { "gte": <value> } }'
  );
}

// Merge resolved filter bracket entries into a query object built by
// `pickQuery` (which deliberately drops the raw `filter` key). Mutates and
// returns `query` for call-site brevity.
function applyFilterToQuery(query: QueryParams, filter: FilterInput | null | undefined): QueryParams {
  for (const [key, value] of resolveFilterQueryEntries(filter)) {
    query[key] = value;
  }
  return query;
}

function applyExpandLimitToQuery(
  query: QueryParams,
  expandLimit: Record<string, number> | null | undefined
): QueryParams {
  if (expandLimit === undefined || expandLimit === null) {
    return query;
  }
  const entries = Object.entries(expandLimit);
  if (entries.length === 0) {
    throw new MalformedExpandLimitError(
      "expand_limit must include at least one relation; omit expand_limit entirely when not setting a cap"
    );
  }
  for (const [relation, limit] of entries) {
    if (relation.includes("[") || relation.includes("]")) {
      throw new MalformedExpandLimitError(
        `expand_limit relation '${relation}' must be a relation name, not pre-encoded bracket syntax; pass expand_limit: { "relation": 3 }`
      );
    }
    query[`expand_limit[${relation}]`] = String(limit);
  }
  return query;
}

const ConnectionIdInputShape = {
  connection_id: z.string().min(1).describe(CONNECTION_ID_DESCRIPTION).optional(),
};

// Canonical envelope summary referenced from tool descriptions. Kept terse to
// stay within MCP token-budget norms; the authoritative schema vocabulary
// lives at `GET /v1/schema` and in the OpenAPI artifacts published by the
// reference-contract package.
const CANONICAL_SCHEMA_HINT =
  "Per-stream filter operators, expandable relations, projection support, search modes, count support, granted `connection_id` values, and canonical `connector_key` metadata are advertised by `GET /v1/schema`. Consult it before constructing filter, sort, expand, fields, count, or source-disambiguation arguments.";

// outputSchema describes the MCP wrapper around the RS response body. We do
// NOT bake the RS body shape into the outputSchema because the canonical
// envelope is the contract source of truth and the RS still ships legacy
// envelopes during the migration window. Validating `data` as a generic
// object keeps the MCP wrapper honest without over-promising RS structure.
const READ_OUTPUT_SCHEMA_SHAPE = {
  data: z
    .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .describe(
      "Canonical RS response body. Follows the public read envelope advertised by `GET /v1/schema` plus operation-specific extensions; source metadata uses canonical `connector_key` and concrete `connection_id` values when present."
    ),
  content_ladder: z.unknown().optional(),
  provider_url: z.string().describe("RS base URL the MCP server was configured with."),
  request_id: z.string().nullable().describe("RS x-request-id when present."),
};

const SEARCH_OUTPUT_SCHEMA_SHAPE = {
  ...READ_OUTPUT_SCHEMA_SHAPE,
  results: z
    .array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          url: z.string(),
        })
        .passthrough()
    )
    .describe(
      "ChatGPT-compatible flattened search results. Each entry carries `id` (a self-contained fetch handle, `connection_id/stream:record_id` when the hit has a connection), `title`, `url`, and available source handles such as `connection_id`. Use `data` for compact envelope metadata."
    ),
};

const FETCH_OUTPUT_SCHEMA_SHAPE = {
  id: z.string(),
  title: z.string(),
  text: z.string(),
  url: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  content_ladder: z.unknown().optional(),
};

const READ_RECORD_FIELD_OUTPUT_SCHEMA_SHAPE = {
  record: z
    .object({
      id: z.string(),
      connection_id: z.string().nullable(),
      stream: z.string(),
      record_id: z.string(),
    })
    .passthrough(),
  field: z
    .object({
      path: z.string(),
      type: z.string().optional(),
      text_like: z.boolean(),
    })
    .passthrough(),
  window: z
    .object({
      text: z.string(),
      start_chars: z.number().int().min(0),
      end_chars: z.number().int().min(0),
      limit_chars: z.number().int().min(1),
      complete: z.boolean(),
    })
    .passthrough(),
  resource: z
    .object({
      uri: z.string(),
      mime_type: z.string(),
    })
    .passthrough()
    .optional(),
  provider_url: z.string(),
  request_id: z.string().nullable(),
};

const DISCOVERY_STREAM_SUMMARY_LIMIT = 50;
const DISCOVERY_FIELD_SUMMARY_LIMIT = 16;
const DISCOVERY_CONNECTION_SUMMARY_LIMIT = 8;
const FIELD_CAPABILITY_FLAG_LEGEND = {
  t: "declared type",
  eq: "exact filter supported",
  r: "range filter operators",
  lex: "lexical search field",
  sem: "semantic search field",
  a: "aggregation capabilities",
  "g=false": "field is not granted",
};

// The `schema` tool's default `structuredContent.data` is a COMPACT projection
// of the RS `/v1/schema` document, not the verbatim body. A real owner's
// grant-scoped schema can exceed 2 MB once every connector advertises
// per-field JSON Schema, so returning it verbatim as the default agent-facing
// payload blows the context budget. The compact projection keeps the discovery
// path `schema -> schema(stream) -> schema(stream, connection_id) -> query_records`
// cheap by dropping the heavy per-field JSON Schema blobs while preserving the
// capability flags, connection identity, and connector metadata an agent needs
// to build a query.
// Exhaustive JSON remains available for one source via
// `schema(stream, connection_id, detail: "full")`. See:
//   openspec/changes/expose-connection-identity-on-public-read/tasks.md (§7
//   MCP discovery/schema token-efficiency target).
const SCHEMA_DETAIL_DESCRIPTION =
  "Response detail grade for `structuredContent.data`. `compact` (default) returns a token-efficient projection: per-stream field names with capability flags, expandable relation names, connection identities, and connector metadata, with the heavy per-field JSON Schema blobs dropped. `full` returns deduped exhaustive schema for one source, preserving raw per-field JSON Schema while removing duplicate top-level stream arrays; it requires `stream`, and `connection_id` when that stream name is shared. The concise `content[]` text summary is identical for both grades.";

const SCHEMA_STREAM_DESCRIPTION =
  "Optional stream name from the compact `schema` stream list. Omit to describe every granted stream. Stream names are not globally unique; pair with `connection_id` when you need one configured source.";

const SCHEMA_CONNECTION_ID_DESCRIPTION =
  "Optional. Scope schema detail to one configured connection when a stream name is shared by multiple connectors or connections. Obtain from schema results or typed ambiguity errors. This is source identity, not a profile selector.";

/**
 * Resolve the `schema` tool `detail` grade defensively. Absent → the compact
 * default; the two valid grades pass through; anything else throws rather than
 * silently coercing to `compact` (defense-in-depth behind the Zod enum).
 */
function resolveSchemaDetail(value: unknown): "compact" | "full" {
  if (value === null || value === undefined) {
    return "compact";
  }
  if (value === "compact" || value === "full") {
    return value;
  }
  throw new Error(`Invalid schema detail: ${JSON.stringify(value)} (expected 'compact' or 'full')`);
}

// Handler body for the `schema` tool, extracted out of the tool-definition
// literal so `buildTools` itself stays under the cognitive-complexity budget.
async function handleSchemaTool(rs: RsClient, providerUrl: string, args: JsonObject): Promise<McpToolResult> {
  const stream = typeof args.stream === "string" && args.stream ? requireSafeName(args.stream, "stream") : null;
  const connectionId =
    typeof args.connection_id === "string" && args.connection_id
      ? requireSafeName(args.connection_id, "connection_id")
      : null;
  // `detail` is normally constrained by the Zod enum to `compact|full`, so a
  // direct MCP call can only land here with `'compact'`, `'full'`, or
  // `undefined` (→ compact default). Resolve it defensively rather than
  // coercing any non-`full` value to `compact`: an unexpected value (a
  // future enum loosening, or a caller that bypassed the Zod parse) fails
  // loudly here instead of silently downgrading the response grade.
  const detail = resolveSchemaDetail(args.detail);
  if (detail === "compact") {
    const compactResponse = await rs.getJson("/v1/schema", {
      query: {
        view: "compact",
        ...(stream ? { stream } : {}),
        ...(connectionId ? { connection_id: connectionId } : {}),
      },
    });
    if (compactResponse.ok) {
      return toSchemaToolResult(compactResponse, providerUrl, {
        detail,
        stream,
        connectionId,
        alreadyCompact: isCompactSchemaBody(compactResponse.body),
      });
    }
    if (!shouldFallbackFromCompactSchemaRequest(compactResponse)) {
      return toSchemaToolResult(compactResponse, providerUrl, { detail, stream, connectionId });
    }
  }
  const response = await rs.getJson("/v1/schema", {
    query: {
      ...(detail === "full" ? { detail: "full" } : {}),
      ...(stream ? { stream } : {}),
      ...(connectionId ? { connection_id: connectionId } : {}),
    },
  });
  return toSchemaToolResult(response, providerUrl, { detail, stream, connectionId });
}

/**
 * Build the static tool definitions. Descriptions are constant — they are never derived
 * from manifest, stream, or record data. RS payloads are returned as data; nothing is
 * interpolated into instructions to the model.
 */
export function buildTools({ rs, providerUrl }: { rs: RsClient; providerUrl: string }): ToolDefinition[] {
  const tools = [
    {
      name: "schema",
      title: "Get PDPP schema",
      description:
        'Return the grant-scoped PDPP schema document from `GET /v1/schema`. This is the canonical capability source: streams, canonical connector-type metadata (`connector_key`), per-field filter operators (`field_capabilities`), expandable relations (`expand_capabilities`), projection support, search modes, pagination support, count support, and granted connection identities (`connection_id`, `display_name`). Defaults to a compact, token-efficient projection (`detail: "compact"`) so the `schema -> schema(stream) -> schema(stream, connection_id) -> query_records` discovery path stays cheap. Stream names are not globally unique; add `connection_id` to narrow a shared stream to one configured source. `detail: "full"` is allowed only with `stream` and returns deduped exhaustive schema for matching stream rows, preserving raw per-field JSON Schema without duplicate stream arrays. Call this before issuing other tools to discover valid filter, sort, expand, fields, count, aggregate, stream, and connection-disambiguation arguments. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          detail: z.enum(["compact", "full"]).optional().describe(SCHEMA_DETAIL_DESCRIPTION),
          stream: z.string().min(1).optional().describe(SCHEMA_STREAM_DESCRIPTION),
          connection_id: z.string().min(1).optional().describe(SCHEMA_CONNECTION_ID_DESCRIPTION),
        })
        .strict(),
      outputSchema: z.object(READ_OUTPUT_SCHEMA_SHAPE),
      handler: (args: JsonObject) => handleSchemaTool(rs, providerUrl, args),
    },
    {
      name: "query_records",
      title: "Query PDPP records",
      description:
        "Query records in a stream via `GET /v1/streams/{stream}/records`. Default returns at most 25 records; `limit` is capped at 100 (enforced at input — a REST client that sends `limit>100` gets `limit_clamped` in `meta.warnings[]`). Page forward with `cursor`; narrow with `fields`. `structuredContent.data` carries the machine envelope; with `fields`, record payloads are narrowed to those fields plus required operational handles. `content[]` previews up to the first 5 records. Forwards all args verbatim. " +
        CANONICAL_SCHEMA_HINT +
        " Read-only.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          stream: z.string().min(1).describe("Stream name advertised by `schema`."),
          limit: z.number().int().positive().max(100).optional().describe(LIMIT_DESCRIPTION),
          cursor: z.string().optional(),
          order: z.string().optional().describe(ORDER_DESCRIPTION),
          sort: z.string().optional().describe(SORT_DESCRIPTION),
          count: z.enum(["none", "estimated", "exact"]).optional().describe(COUNT_DESCRIPTION),
          filter: TypedFilterInput.optional().describe(FILTER_DESCRIPTION),
          fields: z.array(z.string()).optional().describe(FIELDS_DESCRIPTION),
          view: z.string().optional().describe(VIEW_DESCRIPTION),
          expand: z.array(z.string()).optional().describe(EXPAND_DESCRIPTION),
          expand_limit: z.record(z.string(), z.number().int().positive()).optional().describe(EXPAND_LIMIT_DESCRIPTION),
          changes_since: z.string().optional().describe(CHANGES_SINCE_DESCRIPTION),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(READ_OUTPUT_SCHEMA_SHAPE),
      handler: async (args: JsonObject) => {
        const stream = requireSafeName(args.stream, "stream");
        const expand = Array.isArray(args.expand) ? (args.expand as string[]) : undefined;
        const connectionId = typeof args.connection_id === "string" ? args.connection_id : undefined;
        if (expand && expand.length > 0) {
          await assertExpandCapabilities(rs, stream, expand, connectionId);
        }
        const query = applyExpandLimitToQuery(
          applyFilterToQuery(pickQuery(args, SUPPORTED_QUERY_KEYS), args.filter as FilterInput | undefined),
          args.expand_limit as Record<string, number> | undefined
        );
        const response = await rs.getJson(`/v1/streams/${encodeURIComponent(stream)}/records`, {
          query,
        });
        return toToolResult(response, providerUrl, `records from stream "${stream}"`, {
          previewRecords: true,
          contentLadderStream: stream,
          contentLadderConnectionId: connectionId,
        });
      },
    },
    {
      name: "aggregate",
      title: "Aggregate PDPP records",
      description:
        "Compute a single-stream aggregation via `GET /v1/streams/{stream}/aggregate`. Prefer over `query_records` when you only need a count, sum, min/max, distinct count, or grouped/time-bucketed rollup — returns small bucket rows, never record bodies. Metrics: `count`, `sum`, `min`, `max`, `count_distinct` (`field` required for all but `count`). Group with one dimension: `group_by` XOR `group_by_time` (requires `granularity`). Grouped responses include `other_count` (records in groups beyond `limit`) so you can detect top-N truncation without a second call. Groupable fields are advertised by `GET /v1/schema`. Forwards args verbatim. " +
        CANONICAL_SCHEMA_HINT +
        " Read-only.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          stream: z.string().min(1).describe("Stream name advertised by `schema`."),
          metric: z
            .enum(["count", "sum", "min", "max", "count_distinct"])
            .describe("Aggregation metric. `field` is required for sum, min, max, and count_distinct."),
          field: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Target field for sum/min/max/count_distinct. Must be declared for the metric in `GET /v1/schema`."
            ),
          group_by: z
            .string()
            .min(1)
            .optional()
            .describe("Scalar field to group counts by. Mutually exclusive with `group_by_time`."),
          group_by_time: z
            .string()
            .min(1)
            .optional()
            .describe(
              "Declared date/date-time field to bucket counts by. Requires `granularity`. Mutually exclusive with `group_by`."
            ),
          granularity: z
            .enum(["minute", "hour", "day", "week", "month", "quarter", "year"])
            .optional()
            .describe("Calendar bucket unit for `group_by_time`. Required with `group_by_time`, forbidden otherwise."),
          time_zone: z
            .string()
            .min(1)
            .optional()
            .describe(
              "IANA time zone for `group_by_time` bucket boundaries. Defaults to UTC; the response echoes the effective zone."
            ),
          limit: z
            .number()
            .int()
            .positive()
            .max(100)
            .optional()
            .describe("Maximum number of group buckets (1-100). Only valid with `group_by` or `group_by_time`."),
          filter: TypedFilterInput.optional().describe(FILTER_DESCRIPTION),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(READ_OUTPUT_SCHEMA_SHAPE),
      handler: async (args: JsonObject) => {
        const stream = requireSafeName(args.stream, "stream");
        const query = applyFilterToQuery(
          pickQuery(args, SUPPORTED_AGGREGATE_QUERY_KEYS),
          args.filter as FilterInput | undefined
        );
        const response = await rs.getJson(`/v1/streams/${encodeURIComponent(stream)}/aggregate`, {
          query,
        });
        return toAggregateToolResult(response, providerUrl, stream);
      },
    },
    {
      name: "search",
      title: "Search PDPP records",
      description:
        "Search records via `GET /v1/search` (lexical), `/v1/search/semantic`, or `/v1/search/hybrid` per `mode`. Use lexical for exact known terms; semantic is approximate retrieval for conceptual matches. `structuredContent.results` carries the flattened page; `structuredContent.data` carries compact envelope metadata, not a duplicate hit array. Hit ids are self-contained `fetch` handles (the connection is encoded in the id); hits also carry `connection_id` and `connector_key`. Pass `connection_id` to scope, omit to fan in. Page default is 25 hits; `limit` is capped at 100 (enforced at input, and fan-in packages apply it globally). Page forward with `cursor` (lexical/semantic; hybrid does not page). Per-mode capability support is advertised by `GET /v1/schema`. Read-only.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          q: z.string().min(1).describe("Search query string."),
          streams: z.array(z.string()).optional(),
          limit: z.number().int().positive().max(100).optional().describe(SEARCH_LIMIT_DESCRIPTION),
          cursor: z.string().optional(),
          mode: z.enum(["lexical", "semantic", "hybrid"]).optional(),
          filter: TypedFilterInput.optional().describe(FILTER_DESCRIPTION),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(SEARCH_OUTPUT_SCHEMA_SHAPE),
      handler: async (args: JsonObject) => {
        const path = searchPathForMode(args.mode);
        const query = applyFilterToQuery(
          {
            q: args.q as string,
            streams: args.streams as string[] | undefined,
            limit: args.limit as number | undefined,
            cursor: args.cursor as string | undefined,
            connection_id: args.connection_id as string | undefined,
          },
          args.filter as FilterInput | undefined
        );
        const response = await rs.getJson(path, { query });
        return toSearchToolResult(response, providerUrl, {
          limit: typeof args.limit === "number" ? args.limit : undefined,
          q: typeof args.q === "string" ? args.q : undefined,
        });
      },
    },
    {
      name: "fetch",
      title: "Fetch PDPP search result",
      description:
        "Fetch a single OpenAI-compatible document by a result id from `search`. Id formats: self-contained `connection_id/stream:record_id` (pass it unchanged — no other argument is needed) or legacy `stream:record_id` plus an optional `connection_id` argument. Both resolve to `GET /v1/streams/{stream}/records/{record_id}`. Returns document fields only (`id`, `title`, `text`, `url`, `metadata`); use `query_records` for canonical PDPP record envelopes. Use `fields` to project the source record before rendering document text/metadata; if the projection excludes every text-like field (`text`, `content`, `body`, `summary`), `text` contains compact JSON for the projected record rather than the full document body. Operational source handles (`id`, stream, `connection_id`, `connector_key`) remain available in `metadata`. On `ambiguous_connection` (409), pick a `connection_id` from `available_connections` in the error and retry. Read-only.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          id: z
            .string()
            .min(1)
            .describe("ID: `connection_id/stream:record_id`, `stream:record_id`, or `pdpp://record/...` URI."),
          expand: z.array(z.string()).optional().describe(EXPAND_DESCRIPTION),
          expand_limit: z.record(z.string(), z.number().int().positive()).optional().describe(EXPAND_LIMIT_DESCRIPTION),
          fields: z.array(z.string()).optional().describe(FIELDS_DESCRIPTION),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(FETCH_OUTPUT_SCHEMA_SHAPE),
      handler: async (args: JsonObject) => {
        const requestedId = typeof args.id === "string" ? args.id : "";
        const ref = parseRecordResultId(requestedId);
        if (ref.connectionId && typeof args.connection_id === "string" && args.connection_id !== ref.connectionId) {
          throw new ConflictingConnectionIdError(ref.connectionId, args.connection_id);
        }
        const expand = Array.isArray(args.expand) ? (args.expand as string[]) : undefined;
        if (expand && expand.length > 0) {
          const connId = (typeof args.connection_id === "string" ? args.connection_id : null) ?? ref.connectionId;
          await assertExpandCapabilities(rs, ref.stream, expand, connId);
        }
        const query = applyExpandLimitToQuery(
          pickQuery(args, SUPPORTED_QUERY_KEYS),
          args.expand_limit as Record<string, number> | undefined
        );
        // A self-contained id carries its own connection scope; forward it so a
        // multi-source grant resolves without a second model-carried handle.
        if (ref.connectionId && query.connection_id === undefined) {
          query.connection_id = ref.connectionId;
        }
        const response = await rs.getJson(
          `/v1/streams/${encodeURIComponent(ref.stream)}/records/${encodeURIComponent(ref.recordId)}`,
          { query }
        );
        return toFetchToolResult(response, providerUrl, requestedId);
      },
    },
    {
      name: "read_record_field",
      title: "Read PDPP record field window",
      description: "Read bounded field text by record id or `pdpp://record/...` URI; page by offset, cursor, or q.",
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          id: z
            .string()
            .min(1)
            .optional()
            .describe("ID: `connection_id/stream:record_id`, `stream:record_id`, or `pdpp://record/...` URI."),
          connection_id: z.string().min(1).optional(),
          stream: z.string().min(1).optional(),
          record_id: z.string().min(1).optional(),
          field_path: z.string().min(1),
          cursor: z.string().min(1).optional(),
          offset_chars: z.number().int().min(0).optional(),
          limit_chars: z.number().int().min(1).max(16_384).optional(),
          q: z.string().min(1).optional(),
          before_chars: z.number().int().min(0).max(8192).optional(),
          after_chars: z.number().int().min(0).max(8192).optional(),
        })
        .strict(),
      outputSchema: z.object(READ_RECORD_FIELD_OUTPUT_SCHEMA_SHAPE),
      handler: async (args: JsonObject) => {
        const ref = resolveReadRecordFieldRef(args);
        const fieldPath = requireSafeName(args.field_path, "field_path");
        const query = readRecordFieldQuery(args, ref.connectionId, fieldPath);
        const response = await rs.getJson(
          `/v1/streams/${encodeURIComponent(ref.stream)}/records/${encodeURIComponent(ref.recordId)}/field-window`,
          { query }
        );
        return toReadRecordFieldToolResult(response, providerUrl, {
          connectionId: ref.connectionId,
          stream: ref.stream,
          recordId: ref.recordId,
          fieldPath,
        });
      },
    },
  ];

  return selectNormalTools(tools);
}

function searchPathForMode(mode: unknown): string {
  if (mode === "semantic") {
    return "/v1/search/semantic";
  }
  if (mode === "hybrid") {
    return "/v1/search/hybrid";
  }
  return "/v1/search";
}

interface ReadRecordFieldRef {
  connectionId: string;
  recordId: string;
  stream: string;
}

function resolveReadRecordFieldRef(args: JsonObject): ReadRecordFieldRef {
  const hasId = typeof args.id === "string" && args.id.length > 0;
  const hasExplicit = args.connection_id !== undefined || args.stream !== undefined || args.record_id !== undefined;
  if (hasId && hasExplicit) {
    throw new InvalidReadRecordFieldSelectorError(
      "`id` is exclusive with explicit `connection_id`, `stream`, and `record_id`; pass one record identity form"
    );
  }
  if (hasId) {
    const ref = parseRecordResultId(args.id as string);
    if (!ref.connectionId) {
      throw new InvalidReadRecordFieldSelectorError(
        "`id` for read_record_field must include connection_id (`connection_id/stream:record_id`) or use explicit connection_id + stream + record_id"
      );
    }
    return { connectionId: ref.connectionId, stream: ref.stream, recordId: ref.recordId };
  }
  if (!(args.connection_id && args.stream && args.record_id)) {
    throw new InvalidReadRecordFieldSelectorError(
      "read_record_field requires either `id` + `field_path` or `connection_id` + `stream` + `record_id` + `field_path`"
    );
  }
  return {
    connectionId: requireSafeName(args.connection_id, "connection_id"),
    stream: requireSafeName(args.stream, "stream"),
    recordId: requireSafeName(args.record_id, "record_id"),
  };
}

function readRecordFieldQuery(args: JsonObject, connectionId: string, fieldPath: string): QueryParams {
  if (args.cursor !== undefined && args.offset_chars !== undefined) {
    throw new InvalidReadRecordFieldSelectorError("`cursor` is exclusive with `offset_chars`");
  }
  if (args.q !== undefined && (args.cursor !== undefined || args.offset_chars !== undefined)) {
    throw new InvalidReadRecordFieldSelectorError("`q` is exclusive with `cursor` and `offset_chars`");
  }
  if ((args.before_chars !== undefined || args.after_chars !== undefined) && args.q === undefined) {
    throw new InvalidReadRecordFieldSelectorError("`before_chars` and `after_chars` require `q`");
  }
  const query: QueryParams = {
    connection_id: connectionId,
    field: fieldPath,
  };
  if (args.cursor !== undefined) {
    query.offset_chars = parseFieldWindowCursor(args.cursor);
  } else if (typeof args.offset_chars === "number") {
    query.offset_chars = args.offset_chars;
  }
  if (typeof args.limit_chars === "number") {
    query.limit_chars = args.limit_chars;
  }
  if (typeof args.q === "string") {
    query.q = args.q;
  }
  if (typeof args.before_chars === "number") {
    query.before_chars = args.before_chars;
  }
  if (typeof args.after_chars === "number") {
    query.after_chars = args.after_chars;
  }
  return query;
}

function parseFieldWindowCursor(cursor: unknown): number {
  if (typeof cursor !== "string" || !FIELD_WINDOW_CURSOR_PATTERN.test(cursor)) {
    throw new InvalidReadRecordFieldSelectorError(
      "field-window cursor must be a non-negative integer offset returned by read_record_field"
    );
  }
  return Number.parseInt(cursor, 10);
}

export function buildResourceTemplates({
  rs,
  providerUrl,
}: {
  rs: RsClient;
  providerUrl: string;
}): ResourceTemplateDefinition[] {
  return [
    buildStreamResourceTemplate({ rs, providerUrl }),
    buildRecordResourceTemplate({ rs, providerUrl }),
    buildRecordFieldResourceTemplate({ rs, providerUrl }),
  ];
}

function buildRecordResourceTemplate({
  rs,
  providerUrl,
}: {
  rs: RsClient;
  providerUrl: string;
}): ResourceTemplateDefinition {
  return {
    uriTemplate: "pdpp://record/{handle}",
    name: "pdpp-record",
    title: "PDPP record",
    description: "Returns one grant-scoped PDPP record through the resource server. Read-only.",
    mimeType: "application/json",
    read: async (uri, variables) => {
      const ref = resolveRecordResourceRef(uri, variables);
      const query: QueryParams = {};
      if (ref.connectionId) {
        query.connection_id = ref.connectionId;
      }
      const response = await rs.getJson(
        `/v1/streams/${encodeURIComponent(ref.stream)}/records/${encodeURIComponent(ref.recordId)}`,
        { query }
      );
      if (response.ok) {
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(response.body, null, 2),
            },
          ],
        };
      }
      return resourceErrorContents(uri, response, providerUrl);
    },
  };
}

function buildRecordFieldResourceTemplate({
  rs,
  providerUrl,
}: {
  rs: RsClient;
  providerUrl: string;
}): ResourceTemplateDefinition {
  return {
    uriTemplate: "pdpp://field-window/{handle}",
    name: "pdpp-field-window",
    title: "PDPP record field window",
    description: "Returns one bounded text window from an authorized PDPP record field. Read-only.",
    mimeType: "text/plain",
    read: async (uri, variables) => {
      const ref = resolveFieldWindowResourceRef(uri, variables);
      const query = readRecordFieldQuery(ref, ref.connectionId, ref.field_path);
      const response = await rs.getJson(
        `/v1/streams/${encodeURIComponent(ref.stream)}/records/${encodeURIComponent(ref.recordId)}/field-window`,
        { query }
      );
      if (!response.ok) {
        return resourceErrorContents(uri, response, providerUrl);
      }
      const result = toReadRecordFieldToolResult(response, providerUrl, {
        connectionId: ref.connectionId,
        stream: ref.stream,
        recordId: ref.recordId,
        fieldPath: ref.field_path,
      });
      return {
        contents: [
          {
            uri,
            mimeType: "text/plain",
            // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive — under noUncheckedIndexedAccess, array index [0] is `ToolTextContent | undefined`, so the ?. and ?? are load-bearing, not redundant.
            text: result.content[0]?.text ?? "",
          },
        ],
      };
    },
  };
}

export function buildStreamResourceTemplate({
  rs,
  providerUrl,
}: {
  rs: RsClient;
  providerUrl: string;
}): ResourceTemplateDefinition {
  return {
    uriTemplate: "pdpp://stream/{name}",
    name: "pdpp-stream",
    title: "PDPP stream metadata",
    description: "Returns the stream metadata document for a single stream (GET /v1/streams/{name}). Read-only.",
    mimeType: "application/json",
    read: async (uri, variables) => {
      const targetStreamName = resolveStreamName(uri, variables);
      const response = await rs.getJson(`/v1/streams/${encodeURIComponent(targetStreamName)}`);
      if (response.ok) {
        return {
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify(response.body, null, 2),
            },
          ],
        };
      }
      const { error } = response;
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({ error, provider_url: providerUrl, http_status: response.status }, null, 2),
          },
        ],
      };
    },
  };
}

function resourceErrorContents(uri: string, response: RsResponse, providerUrl: string): ResourceReadResult {
  const error = response.ok ? { type: "rs_error", code: "unknown", message: "Unknown RS error" } : response.error;
  return {
    contents: [
      {
        uri,
        mimeType: "application/json",
        text: JSON.stringify({ error, provider_url: providerUrl, http_status: response.status }, null, 2),
      },
    ],
  };
}

function resolveRecordResourceRef(uri: string, variables: Record<string, string | string[]>): RecordRef {
  const handle = resolveResourceHandle(uri, variables, "record");
  let payload: ResourceHandlePayload;
  try {
    payload = decodeResourceHandle(handle, "record");
  } catch {
    const ref = parseRecordResultId(decodeURIComponent(handle));
    return { connectionId: ref.connectionId, stream: ref.stream, recordId: ref.recordId };
  }
  return {
    connectionId: requireSafeName(payload.connection_id, "connection_id"),
    stream: requireSafeName(payload.stream, "stream"),
    recordId: requireSafeName(payload.record_id, "record_id"),
  };
}

function resolveFieldWindowResourceRef(uri: string, variables: Record<string, string | string[]>): FieldWindowRef {
  const payload = decodeResourceHandle(resolveResourceHandle(uri, variables, "field-window"), "field-window");
  const ref: FieldWindowRef = {
    connectionId: requireSafeName(payload.connection_id, "connection_id"),
    stream: requireSafeName(payload.stream, "stream"),
    recordId: requireSafeName(payload.record_id, "record_id"),
    field_path: requireSafeName(payload.field_path, "field_path"),
  };
  if (payload.cursor !== undefined) {
    ref.cursor = String(payload.cursor);
  }
  if (payload.offset_chars !== undefined) {
    ref.offset_chars = payload.offset_chars as number;
  }
  if (payload.limit_chars !== undefined) {
    ref.limit_chars = payload.limit_chars as number;
  }
  if (payload.q !== undefined) {
    ref.q = String(payload.q);
  }
  if (payload.before_chars !== undefined) {
    ref.before_chars = payload.before_chars as number;
  }
  if (payload.after_chars !== undefined) {
    ref.after_chars = payload.after_chars as number;
  }
  return ref;
}

function resolveResourceHandle(uri: string, variables: Record<string, string | string[]>, kind: string): string {
  const rawFromVariables = variables.handle;
  if (typeof rawFromVariables === "string" && rawFromVariables.length > 0) {
    return decodeIfEncoded(rawFromVariables);
  }
  const match = new RegExp(`^pdpp://${kind}/([^/]+)$`).exec(uri);
  // biome-ignore lint/suspicious/noUnnecessaryConditions: false positive — `.exec()` returns `RegExpExecArray | null`, so the `?.` on `match` is load-bearing, not redundant.
  if (!match?.[1]) {
    throw new InvalidResourceUriError(`Resource URI ${uri} does not match pdpp://${kind}/{handle}.`);
  }
  return decodeURIComponent(match[1]);
}

function resolveStreamName(uri: string, variables: Record<string, string | string[]>): string {
  const rawFromVariables = variables.name;
  if (typeof rawFromVariables === "string" && rawFromVariables.length > 0) {
    return requireSafeName(decodeIfEncoded(rawFromVariables), "stream");
  }
  const match = STREAM_RESOURCE_URI_PATTERN.exec(uri);
  if (!match?.[1]) {
    throw new InvalidResourceUriError(`Resource URI ${uri} does not match pdpp://stream/{name}.`);
  }
  return requireSafeName(decodeURIComponent(match[1]), "stream");
}

function decodeIfEncoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodeResourceUri(kind: string, payload: JsonObject): string {
  return `pdpp://${kind}/${encodeResourceHandle({ v: 1, kind, ...payload })}`;
}

function encodeResourceHandle(payload: JsonObject): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeResourceHandle(handle: string, expectedKind: string): ResourceHandlePayload {
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(handle, "base64url").toString("utf8"));
  } catch (error) {
    throw new InvalidResourceUriError(`Resource handle for ${expectedKind} is malformed.`, { cause: error });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new InvalidResourceUriError(`Resource handle for ${expectedKind} is malformed.`);
  }
  const record = payload as ResourceHandlePayload;
  if (record.v !== 1 || record.kind !== expectedKind) {
    throw new InvalidResourceUriError(`Resource handle for ${expectedKind} has the wrong kind or version.`);
  }
  return record;
}

export class InvalidResourceUriError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidResourceUriError";
  }
}

function requireSafeName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  // Reject path-traversal and slash-bearing inputs. The RS validates names too, but a
  // defensive check here keeps the resource template URI surface narrow.
  if (value.includes("/") || value.includes("\\") || value === "." || value === ".." || value.includes("..")) {
    throw new Error(`${label} contains invalid characters`);
  }
  return value;
}

function pickQuery(args: unknown, supportedKeys: ReadonlySet<string>): QueryParams {
  if (!args || typeof args !== "object") {
    return {};
  }
  const out: QueryParams = {};
  const record = args as JsonObject;
  for (const key of Object.keys(record)) {
    if (key === "stream") {
      continue;
    }
    // `filter` is never forwarded as a flat param: the RS expects bracketed
    // `filter[field]=value` query keys, which callers build via
    // `applyFilterToQuery`. Forwarding the raw value here would re-introduce the
    // silent bare-`filter=` no-op this change fixes.
    if (key === "filter") {
      continue;
    }
    // `expand_limit` mirrors the same nested REST query shape:
    // `expand_limit[relation]=N`. Forwarding the raw object would become a JSON
    // string under URLSearchParams instead of the query key the RS parses.
    if (key === "expand_limit") {
      continue;
    }
    if (!supportedKeys.has(key)) {
      continue;
    }
    out[key] = record[key] as QueryParams[string];
  }
  return out;
}

interface ToToolResultOptions {
  contentLadderConnectionId?: string | undefined;
  contentLadderStream?: string | undefined;
  previewRecords?: boolean;
}

// `content[]` is intentionally a concise human summary — the canonical
// `structuredContent` envelope is the contract for programmatic consumers.
// See:
//   openspec/changes/canonicalize-public-read-contract (5.3 prose content[] is
//   a concise summary only and not a second divergent JSON contract).
function toToolResult(
  response: RsResponse,
  providerUrl: string,
  label = "response",
  options: ToToolResultOptions = {}
): McpToolResult {
  if (response.ok) {
    const { body } = response;
    const contentLadder = buildResponseContentLadder(body, options);
    return {
      content: [
        {
          type: "text",
          text: summarizeBody(body, label, options),
        },
      ],
      structuredContent: {
        data: body as Json,
        ...(contentLadder ? { content_ladder: contentLadder } : {}),
        provider_url: providerUrl,
        request_id: response.requestId,
      },
    };
  }
  return errorToolResult(response, providerUrl);
}

interface SchemaToolResultOptions {
  alreadyCompact?: boolean;
  connectionId?: string | null;
  detail?: "compact" | "full";
  stream?: string | null;
}

// Build the `schema` tool result. The text summary is always the compact,
// parseable discovery line. The `structuredContent.data` payload is a compact
// projection by default and the verbatim RS body only when `detail === "full"`.
// When `stream`/`connection_id` are supplied, both the summary and the
// structured payload are scoped so an agent can fetch one source's capabilities
// without pulling the whole document.
function toSchemaToolResult(
  response: RsResponse,
  providerUrl: string,
  { detail = "compact", stream = null, connectionId = null }: SchemaToolResultOptions = {}
): McpToolResult {
  if (!response.ok) {
    return errorToolResult(response, providerUrl);
  }
  const data =
    detail === "full"
      ? dedupeFullSchemaDocument(response.body)
      : compactSchemaDocument(response.body, { includeFieldDetail: Boolean(stream) });
  const schemaDocument = unwrapSchemaBody(data);
  return {
    content: [
      {
        type: "text",
        text: summarizeSchemaDiscovery(schemaDocument, "PDPP schema", {
          includeFieldDetail: Boolean(stream),
          ...(connectionId ? { connectionId } : {}),
        }),
      },
    ],
    structuredContent: { data: schemaDocument as Json, provider_url: providerUrl, request_id: response.requestId },
  };
}

function isCompactSchemaBody(body: Json): boolean {
  return unwrapSchemaBody(body).detail === "compact";
}

function shouldFallbackFromCompactSchemaRequest(response: RsResponse): boolean {
  if (response.ok) {
    return false;
  }
  const error = objectValue(response.error);
  const code = firstString(error?.code, error?.type) ?? "";
  return response.status === 400 && ["bad_request", "invalid_request", "unsupported_query"].includes(code);
}

// Compact projection of the schema document. Drops the heavy per-field JSON
// Schema (`field_capabilities.*.schema`) and any other verbose nested blobs,
// keeping the field name, declared type, grant flag, and usable capability
// flags an agent needs to build filter/sort/expand/fields/count arguments.
// Connection identity (`connection_id`, `display_name`) and canonical connector
// metadata (`connector_key`) are preserved. Deprecated REST aliases are omitted
// from this default MCP projection. The envelope shape (top-level `data` wrapper,
// `connectors[]` grouping) is preserved so the payload is structurally a
// schema document, just lighter.
function compactSchemaDocument(
  body: Json,
  { includeFieldDetail = false }: { includeFieldDetail?: boolean } = {}
): Json {
  const bodyObject = objectValue(body);
  const wrapped = Boolean(bodyObject && objectValue(bodyObject.data));
  const schema = unwrapSchemaBody(body);
  let compactSchema: JsonObject;
  const connectors = extractSchemaConnectors(schema);
  if (connectors.length > 0) {
    compactSchema = {
      ...stripSchemaStreamArrays(schema),
      field_capability_legend: FIELD_CAPABILITY_FLAG_LEGEND,
      connectors: connectors.map((connector) => compactSchemaConnector(connector, { includeFieldDetail })),
    };
  } else if (Array.isArray(schema.streams)) {
    compactSchema = {
      ...schema,
      field_capability_legend: FIELD_CAPABILITY_FLAG_LEGEND,
      streams: schema.streams.map((entry) => compactSchemaStream(entry, { includeFieldDetail })),
    };
  } else {
    compactSchema = schema;
  }
  compactSchema = { ...compactSchema, detail: "compact" };
  return wrapped ? { ...(bodyObject as JsonObject), data: compactSchema } : compactSchema;
}

function dedupeFullSchemaDocument(body: Json): Json {
  const bodyObject = objectValue(body);
  const wrapped = Boolean(bodyObject && objectValue(bodyObject.data));
  const schema = unwrapSchemaBody(body);
  const connectors = extractSchemaConnectors(schema);
  if (connectors.length === 0) {
    return body;
  }
  const deduped = stripSchemaStreamArrays(schema);
  return wrapped ? { ...(bodyObject as JsonObject), data: deduped } : deduped;
}

function stripSchemaStreamArrays(schema: JsonObject): JsonObject {
  const { streams: _streams, ...rest } = schema;
  return rest;
}

function compactSchemaConnector(
  connector: Json,
  { includeFieldDetail = false }: { includeFieldDetail?: boolean } = {}
): Json {
  const connectorObject = objectValue(connector);
  if (!connectorObject) {
    return connector;
  }
  const streams = Array.isArray(connectorObject.streams) ? connectorObject.streams : [];
  const { shared, sharedKey } = pickSharedGrantedConnections(streams);
  const hasShared = shared !== null;
  return {
    ...connectorObject,
    ...(shared ? { granted_connections: shared } : {}),
    streams: streams.map((entry) => compactSchemaStream(entry, { hasShared, sharedKey, includeFieldDetail })),
  };
}

interface CompactSchemaStreamOptions {
  hasShared?: boolean;
  includeFieldDetail?: boolean;
  sharedKey?: string;
}

// Project a single stream-metadata entry to its compact form. Whitelisted
// identity/metadata fields pass through verbatim; `field_capabilities` and
// `expand_capabilities` are compacted; everything else is dropped to keep the
// payload bounded.
function compactSchemaStream(
  entry: Json,
  { hasShared = false, sharedKey = "", includeFieldDetail = false }: CompactSchemaStreamOptions = {}
): Json {
  const entryObject = objectValue(entry);
  if (!entryObject) {
    return entry;
  }
  const out: JsonObject = {};
  const passthrough = [
    "name",
    "stream",
    "stream_name",
    "connector_key",
    "connector_id",
    "connector_display_name",
    "display_name",
    "connection_display_name",
    "connection_id",
    "record_count",
    "granted",
    "primary_key",
    "cursor_field",
    "source",
  ];
  for (const key of passthrough) {
    if (entryObject[key] !== undefined) {
      out[key] = entryObject[key];
    }
  }
  if (entryObject.granted_connections !== undefined) {
    const compactGrantedConnections = compactSchemaGrantedConnections(entryObject.granted_connections);
    const streamKey = Array.isArray(entryObject.granted_connections)
      ? grantedConnectionsKey(entryObject.granted_connections)
      : null;
    if (!hasShared || streamKey === null || streamKey !== sharedKey) {
      out.granted_connections = compactGrantedConnections;
    }
  }
  if (includeFieldDetail && entryObject.field_capabilities !== undefined) {
    out.field_capabilities = compactFieldCapabilities(entryObject.field_capabilities);
  }
  if (includeFieldDetail && entryObject.expand_capabilities !== undefined) {
    out.expand_capabilities = compactExpandCapabilities(entryObject.expand_capabilities);
  }
  return out;
}

// Compact a `field_capabilities` map. Each field collapses to the same terse,
// agent-usable capability flag string the `content[]` summary already
// advertises (e.g. `t=string,eq,r=gte|lt,a=group_by_time`).
// Two size drivers are removed at the compact grade: the per-field JSON Schema
// blob and the five verbose `{declared, usable}` capability sub-objects per
// field. The flag string preserves every usable capability an agent needs to
// build filter / sort / expand / fields / count / aggregate arguments.
// `detail: "full"` remains the path to the raw per-field JSON Schema and the
// structured capability sub-objects. Preserves the map vs array container shape.
function compactFieldCapabilities(fieldCapabilities: Json): Json {
  const entries = fieldCapabilityEntries(fieldCapabilities);
  if (entries.length === 0) {
    return fieldCapabilities;
  }
  const isArray = Array.isArray(fieldCapabilities);
  if (isArray) {
    return entries.map(([name, capabilities]) => ({ name, flags: formatFieldCapabilityFlags(capabilities) }));
  }
  const out: JsonObject = {};
  for (const [name, capabilities] of entries) {
    out[name] = formatFieldCapabilityFlags(capabilities);
  }
  return out;
}

function compactExpandCapabilities(expandCapabilities: Json): Json {
  if (!Array.isArray(expandCapabilities)) {
    return expandCapabilities;
  }
  return expandCapabilities.map((relation: Json) => {
    const relationObject = objectValue(relation);
    if (!relationObject) {
      return relation;
    }
    const out: JsonObject = {};
    for (const key of [
      "name",
      "relation",
      "stream",
      "target_stream",
      "cardinality",
      "granted",
      "usable",
      "foreign_key",
      "max_limit",
      "default_limit",
      "reason",
    ]) {
      if (relationObject[key] !== undefined) {
        out[key] = relationObject[key];
      }
    }
    return Object.keys(out).length > 0 ? out : relation;
  });
}

function grantedConnectionsKey(value: Json): string {
  if (!Array.isArray(value)) {
    return "";
  }
  const entries = value.map((entry: Json) => {
    const entryObject = objectValue(entry);
    if (!entryObject) {
      return JSON.stringify(entry);
    }
    const id = typeof entryObject.connection_id === "string" ? entryObject.connection_id : "";
    const label = typeof entryObject.display_name === "string" ? entryObject.display_name : "";
    return JSON.stringify([id, label]);
  });
  entries.sort();
  return entries.join("\n");
}

function compactSchemaGrantedConnections(value: Json): Json {
  if (!Array.isArray(value)) {
    return value;
  }
  return value.map((entry: Json) => {
    const entryObject = objectValue(entry);
    if (!entryObject) {
      return entry;
    }
    const { connector_instance_id: _deprecatedAlias, ...rest } = entryObject;
    return rest;
  });
}

interface SharedGrantedConnectionsResult {
  shared: Json | null;
  sharedKey: string;
}

function pickSharedGrantedConnections(streams: Json[]): SharedGrantedConnectionsResult {
  const byKey = new Map<string, { value: Json; count: number }>();
  for (const stream of streams) {
    const streamObject = objectValue(stream);
    if (!(streamObject && Array.isArray(streamObject.granted_connections))) {
      continue;
    }
    if (streamObject.granted_connections.length === 0) {
      continue;
    }
    const key = grantedConnectionsKey(streamObject.granted_connections);
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(key, { value: compactSchemaGrantedConnections(streamObject.granted_connections), count: 1 });
    }
  }
  let bestKey = "";
  let best: { value: Json; count: number } | null = null;
  for (const [key, candidate] of byKey) {
    if (!best || candidate.count > best.count) {
      best = candidate;
      bestKey = key;
    }
  }
  return { shared: best ? best.value : null, sharedKey: best ? bestKey : "" };
}

interface ToSearchToolResultOptions {
  limit?: number | undefined;
  q?: string | undefined;
}

function toSearchToolResult(
  response: RsResponse,
  providerUrl: string,
  options: ToSearchToolResultOptions = {}
): McpToolResult {
  if (!response.ok) {
    return errorToolResult(response, providerUrl);
  }
  const allResults = normalizeSearchResults(response.body, { q: options.q, providerUrl });
  const limit = requestedSearchLimit(options.limit);
  const results = allResults.slice(0, limit);
  const bodyObject = objectValue(response.body as Json);
  const summaryBody: Json =
    allResults.length > results.length ? { ...(bodyObject ?? {}), has_more: true } : response.body;
  const data = compactSearchEnvelope(summaryBody, { resultCount: results.length });
  const contentLadder = buildSearchContentLadder(results);
  return {
    content: [
      {
        type: "text",
        text: summarizeSearch(summaryBody, results),
      },
    ],
    structuredContent: {
      data: data as Json,
      results: results as unknown as Json,
      ...(contentLadder ? { content_ladder: contentLadder } : {}),
      provider_url: providerUrl,
      request_id: response.requestId,
    },
  };
}

interface ReadRecordFieldIdentity {
  connectionId: string | null;
  fieldPath: string;
  recordId: string;
  stream: string;
}

function normalizeFieldWindowCursors(rawWindow: JsonObject): JsonObject {
  return {
    ...rawWindow,
    next_cursor:
      rawWindow.next_offset_chars === null || rawWindow.next_offset_chars === undefined
        ? null
        : String(rawWindow.next_offset_chars),
    previous_cursor:
      rawWindow.previous_offset_chars === null || rawWindow.previous_offset_chars === undefined
        ? null
        : String(rawWindow.previous_offset_chars),
  };
}

interface FieldWindowRecordId {
  field_path: string | undefined;
  id: string;
}

// Build the `next`/`previous read_record_field args=...` continuation lines
// for a non-complete field window. Split out of `toReadRecordFieldToolResult`
// to keep that function's branching budget in check.
function fieldWindowContinuationLines(window: JsonObject, record: FieldWindowRecordId): string[] {
  if (window.complete === true) {
    return [];
  }
  const continuationArgs = (offsetChars: number): JsonObject => {
    const args: JsonObject = {
      id: record.id,
      field_path: record.field_path,
      offset_chars: offsetChars,
    };
    const limitChars = numberValue(window.limit_chars);
    if (limitChars !== null) {
      args.limit_chars = limitChars;
    }
    return args;
  };
  const nextOffsetChars = numberValue(window.next_offset_chars);
  const previousOffsetChars = numberValue(window.previous_offset_chars);
  return [
    nextOffsetChars === null ? null : `next_offset_chars=${nextOffsetChars}`,
    nextOffsetChars === null
      ? null
      : `next read_record_field args=${JSON.stringify(continuationArgs(nextOffsetChars))}`,
    previousOffsetChars === null ? null : `previous_offset_chars=${previousOffsetChars}`,
    previousOffsetChars === null
      ? null
      : `previous read_record_field args=${JSON.stringify(continuationArgs(previousOffsetChars))}`,
  ].filter((line): line is string => line !== null);
}

function toReadRecordFieldToolResult(
  response: RsResponse,
  providerUrl: string,
  identity: ReadRecordFieldIdentity
): McpToolResult {
  if (!response.ok) {
    return errorToolResult(response, providerUrl);
  }
  const body = objectValue(response.body) || {};
  const field = objectValue(body.field) || {};
  const rawWindow = objectValue(body.window) || {};
  const stream = firstString(body.stream, identity.stream);
  const recordId = firstString(body.record_id, identity.recordId);
  const connectionId =
    firstString(body.connection_id, body.connector_instance_id, identity.connectionId ?? undefined) || null;
  const record = {
    id: connectionId ? `${connectionId}/${stream}:${recordId}` : `${stream}:${recordId}`,
    connection_id: connectionId,
    stream,
    record_id: recordId,
  };
  const window = normalizeFieldWindowCursors(rawWindow);
  const fieldInfo = {
    path: firstString(field.path, identity.fieldPath),
    type: firstString(field.type, typeof rawWindow.type === "string" ? rawWindow.type : undefined),
    text_like: true,
  };
  const header = [
    `record=${record.id}`,
    `field=${fieldInfo.path}`,
    `chars=${formatScalar(window.start_chars)}..${formatScalar(window.end_chars)}`,
    `total_chars=${formatScalar(window.total_chars)}`,
    `complete=${window.complete === true ? "true" : "false"}`,
    window.next_cursor ? `next_cursor=${window.next_cursor}` : null,
    window.previous_cursor ? `previous_cursor=${window.previous_cursor}` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const continuationLines = fieldWindowContinuationLines(window, { id: record.id, field_path: fieldInfo.path });
  const text = typeof window.text === "string" ? window.text : "";
  return {
    content: [
      {
        type: "text",
        text: [header, ...continuationLines, text].join("\n"),
      },
    ],
    structuredContent: {
      record,
      field: fieldInfo,
      window,
      provider_url: providerUrl,
      request_id: response.requestId ?? null,
    },
  };
}

const CONTENT_LADDER_RECORD_LIMIT = 5;
const CONTENT_LADDER_FIELD_LIMIT = 5;
const CONTENT_LADDER_WINDOW_LIMIT_CHARS = 4096;
const CONTENT_LADDER_BINARY_FIELD_LIMIT = 5;

interface ContentLadderOptions {
  contentLadderConnectionId?: string | undefined;
  contentLadderStream?: string | undefined;
}
type RecordLadder = JsonObject & { id?: string; field_windows?: unknown };

function buildResponseContentLadder(body: Json, options: ContentLadderOptions = {}): JsonObject | null {
  const records = extractRecordRows(body)
    .map((record) =>
      buildRecordContentLadder(record, {
        stream: options.contentLadderStream,
        connectionId: options.contentLadderConnectionId,
      })
    )
    .filter((record): record is RecordLadder => record !== null)
    .slice(0, CONTENT_LADDER_RECORD_LIMIT);
  if (records.length === 0) {
    return null;
  }
  return {
    kind: "record_set",
    read_tool: "read_record_field",
    records,
  };
}

function buildSearchContentLadder(results: SearchResult[]): JsonObject | null {
  const records = results
    .map((result) => {
      const record = buildRecordContentLadder(result as Json, {
        stream: result.stream,
        recordId: result.record_key,
        connectionId: result.connection_id,
      });
      if (!(record && Array.isArray(result.match_windows)) || result.match_windows.length === 0) {
        return record;
      }
      const recordId = firstString(record.id);
      const evidenceExcerpts = searchEvidenceExcerpts(result.match_windows, recordId);
      return {
        ...record,
        ...(evidenceExcerpts.length > 0 ? { evidence_excerpts: evidenceExcerpts } : {}),
        field_windows: mergeSearchMatchWindows(record.field_windows, result.match_windows, recordId),
      };
    })
    .filter((record): record is RecordLadder => record !== null)
    .slice(0, CONTENT_LADDER_RECORD_LIMIT);
  if (records.length === 0) {
    return null;
  }
  return {
    kind: "search_results",
    read_tool: "read_record_field",
    records,
  };
}

function mergeSearchMatchWindows(
  existing: unknown,
  matchWindows: MatchWindow[],
  recordId: string | undefined
): JsonObject[] {
  const rendered = matchWindows.map((window) => {
    const previewText = searchEvidencePreviewText(window);
    const read = searchMatchWindowRead(window, recordId, window.field_path);
    return {
      field_path: window.field_path,
      text_like: true,
      ...(previewText ? { preview_text: previewText } : {}),
      preview_status: window.complete === true ? "complete" : "truncated",
      size_chars: typeof window.text === "string" ? window.text.length : undefined,
      ...(read ? { read } : {}),
    };
  });
  const seen = new Set(rendered.map((window) => window.field_path));
  const existingWindows = Array.isArray(existing) ? (existing as JsonObject[]) : [];
  return [...rendered, ...existingWindows.filter((window) => !seen.has(window.field_path as string))];
}

function searchEvidenceExcerpts(matchWindows: unknown, recordId: string | undefined): JsonObject[] {
  if (!Array.isArray(matchWindows)) {
    return [];
  }
  return (matchWindows as MatchWindow[])
    .map((window): JsonObject | null => {
      const previewText = searchEvidencePreviewText(window);
      if (!previewText) {
        return null;
      }
      const read = searchMatchWindowRead(window, recordId, window.field_path);
      return {
        field_path: window.field_path,
        preview_text: previewText,
        preview_status: window.complete === true ? "complete" : "truncated",
        ...(read ? { read } : {}),
      };
    })
    .filter((entry): entry is JsonObject => entry !== null);
}

function searchEvidencePreviewText(window: MatchWindow): string | null {
  if (typeof window.preview_text === "string") {
    return window.preview_text;
  }
  return typeof window.text === "string" ? truncateText(window.text, SEARCH_TEXT_SNIPPET_CHAR_LIMIT) : null;
}

interface MatchWindowRead {
  args: JsonObject;
  tool: string;
}

function searchMatchWindowRead(
  window: MatchWindow,
  recordId: string | undefined,
  fieldPath: string | undefined
): MatchWindowRead | null {
  const read = objectValue(window.read as Json);
  // RS `evidence_excerpts` carry no `read` hint of their own. Synthesize a
  // bounded `read_record_field` continuation from the hit id + matched field so
  // a visible search excerpt is never a dead end for content-only clients.
  if (!read) {
    if (!(recordId && fieldPath)) {
      return null;
    }
    return {
      tool: "read_record_field",
      args: searchMatchWindowReadArgs({}, recordId, fieldPath),
    };
  }
  const args = searchMatchWindowReadArgs(read.args, recordId, fieldPath);
  if (!firstString(args.id as string | undefined, args.record_uri as string | undefined)) {
    return null;
  }
  return {
    tool: typeof read.tool === "string" ? read.tool : "read_record_field",
    args,
  };
}

function searchMatchWindowReadArgs(
  args: Json,
  recordId: string | undefined,
  fieldPath: string | undefined
): JsonObject {
  const rawArgs = objectValue(args) ?? {};
  if (firstString(rawArgs.id as string | undefined, rawArgs.record_uri as string | undefined)) {
    return rawArgs;
  }
  const connectionId = firstString(
    rawArgs.connection_id as string | undefined,
    rawArgs.connector_instance_id as string | undefined
  );
  const stream = firstString(rawArgs.stream as string | undefined);
  const rawRecordId = firstString(
    rawArgs.record_id as string | undefined,
    rawArgs.recordId as string | undefined,
    rawArgs.record_key as string | undefined,
    rawArgs.recordKey as string | undefined
  );
  const id =
    connectionId && stream && rawRecordId ? selfContainedResultId(`${stream}:${rawRecordId}`, connectionId) : recordId;
  return {
    id,
    field_path:
      firstString(
        rawArgs.field_path as string | undefined,
        rawArgs.fieldPath as string | undefined,
        rawArgs.path as string | undefined
      ) ?? fieldPath,
    ...definedObject({
      q: rawArgs.q,
      cursor: rawArgs.cursor,
      offset_chars: rawArgs.offset_chars,
      limit_chars: rawArgs.limit_chars,
      before_chars: rawArgs.before_chars,
      after_chars: rawArgs.after_chars,
    }),
  };
}

function definedObject(values: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined && value !== null && value !== "")
  );
}

function hideModelVisibleResourceUris(record: RecordLadder | null): RecordLadder | null {
  if (!record) {
    return record;
  }
  const { record_uri: _recordUri, recordUri: _recordUriCamel, ...rest } = record;
  if (!Array.isArray(rest.field_windows)) {
    return rest;
  }
  return {
    ...rest,
    field_windows: (rest.field_windows as JsonObject[]).map(
      ({ resource_uri: _resourceUri, resourceUri: _resourceUriCamel, ...field }) => field
    ),
  };
}

function buildFetchContentLadder(recordBody: Json, document: FetchedDocument): JsonObject | null {
  const record = buildRecordContentLadder(recordBody, {
    id: document.id,
    connectionId: objectValue(document.metadata as Json)?.connection_id as string | undefined,
  });
  if (!record) {
    return null;
  }
  return {
    kind: "record",
    read_tool: "read_record_field",
    ...record,
  };
}

function buildRecordContentLadder(record: Json, fallback: JsonObject = {}): RecordLadder | null {
  const ladder = callBuildSharedRecordContentLadder(record, {
    fallback,
    encodeResourceUri,
    fieldLimit: CONTENT_LADDER_FIELD_LIMIT,
    binaryLimit: CONTENT_LADDER_BINARY_FIELD_LIMIT,
    windowLimitChars: CONTENT_LADDER_WINDOW_LIMIT_CHARS,
  });
  return hideModelVisibleResourceUris(ladder);
}

function toFetchToolResult(response: RsResponse, providerUrl: string, requestedId: string): McpToolResult {
  if (!response.ok) {
    return errorToolResult(response, providerUrl);
  }
  const document = normalizeFetchedDocument(response.body, requestedId, providerUrl);
  const contentLadder = buildFetchContentLadder(response.body, document);
  const text = JSON.stringify(document);
  return {
    content: [
      {
        type: "text",
        text,
      },
    ],
    structuredContent: {
      ...document,
      ...(contentLadder ? { content_ladder: contentLadder } : {}),
    },
  };
}

// Aggregate results must surface the numeric answer in `content[]` text, not
// only in `structuredContent.data`: some hosted agents cannot reliably read
// `structuredContent`. The text stays compact (metric, stream, scalar value or
// a short preview of grouped buckets) — the full envelope remains canonical in
// `structuredContent.data`. See validation criterion 3 in the lane brief.
function toAggregateToolResult(response: RsResponse, providerUrl: string, stream: string): McpToolResult {
  if (!response.ok) {
    return errorToolResult(response, providerUrl);
  }
  return {
    content: [
      {
        type: "text",
        text: summarizeAggregate(response.body, stream),
      },
    ],
    structuredContent: { data: response.body as Json, provider_url: providerUrl, request_id: response.requestId },
  };
}

const AGGREGATE_GROUP_PREVIEW_LIMIT = 5;

function summarizeAggregate(body: Json, stream: string): string {
  const agg = unwrapAggregateBody(body);
  const metric = typeof agg.metric === "string" && agg.metric.length > 0 ? agg.metric : "aggregate";
  const field = typeof agg.field === "string" && agg.field.length > 0 ? ` field=${agg.field}` : "";
  const head = `${metric}(${stream})${field}`;

  const groups = Array.isArray(agg.groups) ? agg.groups : null;
  if (groups) {
    const timeZone = firstString(agg.effective_time_zone, agg.time_zone);
    const timeZoneSuffix = agg.group_by_time && timeZone ? ` time_zone=${formatScalar(timeZone)}` : "";
    const dimension = agg.group_by_time
      ? `group_by_time=${formatScalar(agg.group_by_time)} granularity=${formatScalar(agg.granularity)}${timeZoneSuffix}`
      : `group_by=${formatScalar(agg.group_by)}`;
    if (groups.length === 0) {
      return `${head} ${dimension}: 0 group(s). See structuredContent.data for the canonical envelope.`;
    }
    const shown = groups.slice(0, AGGREGATE_GROUP_PREVIEW_LIMIT).map((g: Json) => {
      const row = objectValue(g);
      const key = row ? row.key : g;
      const count = row ? row.count : undefined;
      return `${formatScalar(key)}=${count === null || count === undefined ? "?" : count}`;
    });
    const more =
      groups.length > AGGREGATE_GROUP_PREVIEW_LIMIT
        ? ` more_groups=${groups.length - AGGREGATE_GROUP_PREVIEW_LIMIT};`
        : "";
    const otherCount = typeof agg.other_count === "number" ? ` other_count=${agg.other_count};` : "";
    return `${head} ${dimension}: ${groups.length} group(s) [${shown.join(", ")}]${more}${otherCount} canonical envelope in structuredContent.data`;
  }

  // Ungrouped: the scalar answer lives in `value`. Fall back to
  // `filtered_record_count` for a count when `value` is absent.
  const value = agg.value === undefined ? agg.filtered_record_count : agg.value;
  return `${head} = ${formatAggregateValue(value)}. canonical envelope in structuredContent.data`;
}

// Render the scalar aggregate answer. Numbers stay unquoted (the common
// count/sum/min/max case) so the text reads as the numeric result; strings are
// quoted for disambiguation.
function formatAggregateValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "null";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return formatScalar(value);
}

function unwrapAggregateBody(body: Json): JsonObject {
  const bodyObject = objectValue(body);
  if (!bodyObject) {
    return {};
  }
  if (bodyObject.object === "aggregation") {
    return bodyObject;
  }
  const data = objectValue(bodyObject.data);
  if (data) {
    return data;
  }
  return bodyObject;
}

type SummarizeBodyOptions = ToToolResultOptions;

function summarizeBody(body: Json, label: string, options: SummarizeBodyOptions = {}): string {
  if (label === "PDPP schema") {
    return summarizeSchemaDiscovery(body, label);
  }
  if (label === "PDPP streams") {
    return summarizeStreamsDiscovery(body, label);
  }
  if (options.previewRecords) {
    return callSummarizeRecordEvidence(body, label);
  }
  if (Array.isArray(body)) {
    return `${label}: ${body.length} item(s). See structuredContent.data for the canonical envelope.`;
  }
  const bodyObject = objectValue(body);
  if (bodyObject) {
    let dataLen: number | null = null;
    if (Array.isArray(bodyObject.data)) {
      dataLen = bodyObject.data.length;
    } else if (Array.isArray(bodyObject.records)) {
      dataLen = bodyObject.records.length;
    } else if (Array.isArray(bodyObject.streams)) {
      dataLen = bodyObject.streams.length;
    }
    const hasMore = bodyObject.has_more === true ? " has_more=true." : "";
    if (dataLen !== null) {
      return `${label}: ${dataLen} item(s).${hasMore} See structuredContent.data for the canonical envelope.`;
    }
    return `${label}: see structuredContent.data for the canonical envelope.`;
  }
  return `${label}: see structuredContent.data for the canonical envelope.`;
}

function extractRecordRows(body: Json): Json[] {
  if (Array.isArray(body)) {
    return body;
  }
  const bodyObject = objectValue(body);
  if (!bodyObject) {
    return [];
  }
  if (Array.isArray(bodyObject.records)) {
    return bodyObject.records;
  }
  if (Array.isArray(bodyObject.data)) {
    return bodyObject.data;
  }
  const data = objectValue(bodyObject.data);
  if (data && Array.isArray(data.records)) {
    return data.records;
  }
  return [];
}

function summarizeStreamsDiscovery(body: Json, label: string): string {
  const streams = extractListRows(body);
  if (streams.length === 0) {
    return `${label}: 0 stream(s)`;
  }

  const lines = streams.slice(0, DISCOVERY_STREAM_SUMMARY_LIMIT).map((stream) => formatStreamListSummary(stream));
  if (streams.length > DISCOVERY_STREAM_SUMMARY_LIMIT) {
    lines.push(`more_streams=${streams.length - DISCOVERY_STREAM_SUMMARY_LIMIT}`);
  }
  return `${label}: ${streams.length} stream(s)\n${lines.join("\n")}`;
}

// When the package-level schema spans many streams, the per-field flag segment
// (`fields=...`) per stream dominates the text summary and pushes it into tens
// of KB — the same token-budget problem the structured compaction solves. Field
// flags are emitted in the text only when the document is scoped to a stream
// (the `schema(stream, connection_id?)` discovery middle step). For multi-stream package
// summaries the text lists streams + connection + connector_key and points the
// agent at `schema(stream, connection_id?)` for per-field capability flags.
// Callers can force inclusion via `includeFieldDetail`.
interface SummarizeSchemaDiscoveryOptions {
  connectionId?: string;
  includeFieldDetail?: boolean;
}
interface StreamRef {
  connector: JsonObject | null;
  stream: Json;
}

function summarizeSchemaDiscovery(
  body: Json,
  label: string,
  { includeFieldDetail, connectionId }: SummarizeSchemaDiscoveryOptions = {}
): string {
  const schema = unwrapSchemaBody(body);
  const streamRefs = extractSchemaStreamRefs(schema);
  const connectorCount = extractSchemaConnectors(schema).length || numberValue(schema.connector_count) || 0;

  if (streamRefs.length === 0) {
    const streamNames = extractSchemaStreamNames(schema);
    if (streamNames.length > 0) {
      return `${label}: connectors=${connectorCount} streams=${streamNames.length}\n${streamNames
        .slice(0, DISCOVERY_STREAM_SUMMARY_LIMIT)
        .map((name) => `stream name=${formatScalar(name)}`)
        .join("\n")}`;
    }
    return `${label}: connectors=${connectorCount} streams=0`;
  }

  const withFields = includeFieldDetail ?? streamRefs.length <= 1;
  const indexLines = streamRefs.length > DISCOVERY_STREAM_SUMMARY_LIMIT ? formatSchemaStreamIndex(streamRefs) : [];
  const legendLines = withFields ? [formatFieldCapabilityLegend()] : [];
  const scopedLines = connectionId ? [`schema_scope connection_id=${formatScalar(connectionId)}`] : [];
  const lines = streamRefs
    .slice(0, DISCOVERY_STREAM_SUMMARY_LIMIT)
    .map(({ stream, connector }) => formatSchemaStreamSummary(stream, connector, { includeFieldDetail: withFields }));
  if (streamRefs.length > DISCOVERY_STREAM_SUMMARY_LIMIT) {
    lines.push(`more_streams=${streamRefs.length - DISCOVERY_STREAM_SUMMARY_LIMIT}`);
  }
  const hint = withFields
    ? ""
    : "\ncall schema(stream, connection_id?) for per-field capability flags (filter/sort/expand/fields/count/aggregate)";
  return `${label}: connectors=${connectorCount} streams=${streamRefs.length}\n${[
    ...legendLines,
    ...scopedLines,
    ...indexLines,
    ...lines,
  ].join("\n")}${hint}`;
}

function formatFieldCapabilityLegend(): string {
  return "field_capability_legend t=declared_type eq=exact_filter r=range_filter_ops lex=lexical_search sem=semantic_search a=aggregation_caps g=false=not_granted";
}

function formatSchemaStreamIndex(streamRefs: StreamRef[]): string[] {
  const byConnector = new Map<string, string[]>();
  for (const { stream, connector } of streamRefs) {
    const connectorKey = connectorKeyFor(stream, connector) || "unknown";
    const name = streamName(stream);
    if (!name) {
      continue;
    }
    if (!byConnector.has(connectorKey)) {
      byConnector.set(connectorKey, []);
    }
    const names = byConnector.get(connectorKey);
    if (names && !names.includes(name)) {
      names.push(name);
    }
  }
  return [...byConnector.entries()].map(
    ([connectorKey, names]) =>
      `stream_index connector_key=${formatScalar(connectorKey)} stream_count=${names.length} streams=${names.map(formatInlineValue).join("|")}`
  );
}

function extractListRows(body: Json): Json[] {
  if (Array.isArray(body)) {
    return body;
  }
  const bodyObject = objectValue(body);
  if (!bodyObject) {
    return [];
  }
  if (Array.isArray(bodyObject.data)) {
    return bodyObject.data;
  }
  if (Array.isArray(bodyObject.streams)) {
    return bodyObject.streams;
  }
  const data = objectValue(bodyObject.data);
  if (data && Array.isArray(data.streams)) {
    return data.streams;
  }
  return [];
}

function unwrapSchemaBody(body: Json): JsonObject {
  const bodyObject = objectValue(body);
  if (!bodyObject) {
    return {};
  }
  const data = objectValue(bodyObject.data);
  if (
    data &&
    (Array.isArray(data.connectors) ||
      Array.isArray(data.streams) ||
      Array.isArray(data.granted_connections) ||
      data.object === "schema")
  ) {
    return data;
  }
  return bodyObject;
}

function extractSchemaConnectors(schema: JsonObject): JsonObject[] {
  return Array.isArray(schema.connectors)
    ? schema.connectors.filter((item: Json): item is JsonObject => Boolean(item && typeof item === "object"))
    : [];
}

function extractSchemaStreamRefs(schema: JsonObject): StreamRef[] {
  const connectors = extractSchemaConnectors(schema);
  if (connectors.length > 0) {
    return connectors.flatMap((connector) => {
      const streams = Array.isArray(connector.streams) ? connector.streams : [];
      return streams.map((stream: Json) => ({ stream, connector }));
    });
  }
  const streams = Array.isArray(schema.streams) ? schema.streams : [];
  return streams
    .filter((stream: Json) => stream && typeof stream === "object")
    .map((stream: Json) => ({ stream, connector: null }));
}

function extractSchemaStreamNames(schema: JsonObject): string[] {
  const streams = Array.isArray(schema.streams) ? schema.streams : [];
  return streams
    .map((stream: Json) => streamName(stream))
    .filter((name: string | undefined): name is string => Boolean(name));
}

function formatStreamListSummary(stream: Json): string {
  const streamObject = objectValue(stream);
  const source = objectValue(streamObject?.source);
  const name = streamName(stream) || "unknown";
  const connectionId = firstString(
    streamObject?.connection_id,
    streamObject?.connector_instance_id,
    source?.connection_id
  );
  const connectorKey = connectorKeyFor(stream, null);
  const displayName = firstString(
    streamObject?.display_name,
    streamObject?.connection_display_name,
    source?.display_name,
    streamObject?.connector_display_name
  );
  const parts = [
    `stream name=${formatScalar(name)}`,
    `connection_id=${formatScalar(connectionId)}`,
    `connector_key=${formatScalar(connectorKey)}`,
    `display_name=${formatScalar(displayName)}`,
  ];
  const recordCount = numberValue(streamObject?.record_count);
  if (recordCount !== null) {
    parts.push(`record_count=${recordCount}`);
  }
  return parts.join(" ");
}

function formatSchemaStreamSummary(
  stream: Json,
  connector: JsonObject | null,
  { includeFieldDetail = true }: { includeFieldDetail?: boolean } = {}
): string {
  const streamObject = objectValue(stream);
  const name = streamName(stream) || "unknown";
  const connectorKey = connectorKeyFor(stream, connector);
  const displayName = displayNameFor(stream, connector);
  const connections = grantedConnectionsFor(stream, connector);
  const parts = [
    `stream name=${formatScalar(name)}`,
    `connector_key=${formatScalar(connectorKey)}`,
    `display_name=${formatScalar(displayName)}`,
    `connections=${formatConnections(connections)}`,
  ];
  if (includeFieldDetail) {
    parts.push(`fields=${formatFieldCapabilities(streamObject?.field_capabilities)}`);
    const aggregations = formatAggregationCapabilities(streamObject?.field_capabilities);
    if (aggregations !== "none") {
      parts.push(`aggregations=${aggregations}`);
    }
  }
  return parts.join(" ");
}

function streamName(stream: Json): string | undefined {
  if (typeof stream === "string" && stream.length > 0) {
    return stream;
  }
  const streamObject = objectValue(stream);
  return firstString(streamObject?.name, streamObject?.stream, streamObject?.stream_name, streamObject?.streamName);
}

function connectorKeyFor(stream: Json, connector: Json): string | undefined {
  const streamObject = objectValue(stream);
  const connectorObject = objectValue(connector);
  const streamSource = objectValue(streamObject?.source);
  const connectorSource = objectValue(connectorObject?.source);
  return firstString(
    streamObject?.connector_key,
    streamObject?.connector_id,
    streamSource?.connector_key,
    streamSource?.connector_id,
    streamSource?.id,
    connectorObject?.connector_key,
    connectorObject?.connector_id,
    connectorSource?.connector_key,
    connectorSource?.connector_id,
    connectorSource?.id
  );
}

function displayNameFor(stream: Json, connector: Json): string | undefined {
  const streamObject = objectValue(stream);
  const connectorObject = objectValue(connector);
  const streamSource = objectValue(streamObject?.source);
  const connectorSource = objectValue(connectorObject?.source);
  return firstString(
    streamObject?.display_name,
    streamObject?.connection_display_name,
    streamSource?.display_name,
    connectorObject?.display_name,
    connectorSource?.display_name,
    connectorObject?.connector_display_name,
    streamObject?.connector_display_name
  );
}

function grantedConnectionsFor(stream: Json, connector: Json): JsonObject[] {
  const streamObject = objectValue(stream);
  const connectorObject = objectValue(connector);
  const explicit = Array.isArray(streamObject?.granted_connections) ? streamObject.granted_connections : [];
  if (explicit.length > 0) {
    return explicit.filter((connection: Json) => connection && typeof connection === "object");
  }
  const shared = Array.isArray(connectorObject?.granted_connections) ? connectorObject.granted_connections : [];
  if (shared.length > 0) {
    return shared.filter((connection: Json) => connection && typeof connection === "object");
  }

  const source = objectValue(streamObject?.source);
  const connectionId = firstString(
    streamObject?.connection_id,
    streamObject?.connector_instance_id,
    source?.connection_id
  );
  if (!connectionId) {
    return [];
  }
  return [
    {
      connection_id: connectionId,
      display_name: firstString(streamObject?.display_name, source?.display_name),
      connector_key: connectorKeyFor(stream, null),
    },
  ];
}

function formatConnections(connections: JsonObject[]): string {
  if (connections.length === 0) {
    return "none";
  }
  const rendered = connections.slice(0, DISCOVERY_CONNECTION_SUMMARY_LIMIT).map((connection) => {
    const id = firstString(connection?.connection_id, connection?.connector_instance_id);
    const displayName = firstString(connection?.display_name, connection?.name);
    const connectorKey = firstString(
      connection?.connector_key,
      connection?.connector_id,
      objectValue(connection?.source)?.connector_key
    );
    const parts = [`connection_id:${formatInlineValue(id)}`];
    if (displayName) {
      parts.push(`display_name:${formatInlineValue(displayName)}`);
    }
    if (connectorKey) {
      parts.push(`connector_key:${formatInlineValue(connectorKey)}`);
    }
    return `{${parts.join(",")}}`;
  });
  if (connections.length > DISCOVERY_CONNECTION_SUMMARY_LIMIT) {
    rendered.push(`more:${connections.length - DISCOVERY_CONNECTION_SUMMARY_LIMIT}`);
  }
  return rendered.join("|");
}

function formatFieldCapabilities(fieldCapabilities: Json): string {
  const entries = fieldCapabilityEntries(fieldCapabilities);
  if (entries.length === 0) {
    return "none";
  }

  const rendered = entries
    .slice(0, DISCOVERY_FIELD_SUMMARY_LIMIT)
    .map(([field, capabilities]) => `${formatFieldName(field)}[${formatFieldCapabilityFlags(capabilities)}]`);
  if (entries.length > DISCOVERY_FIELD_SUMMARY_LIMIT) {
    rendered.push(`more:${entries.length - DISCOVERY_FIELD_SUMMARY_LIMIT}`);
  }
  return rendered.join(";");
}

function fieldCapabilityEntries(fieldCapabilities: Json): [string, Json][] {
  if (!fieldCapabilities || typeof fieldCapabilities !== "object") {
    return [];
  }
  if (Array.isArray(fieldCapabilities)) {
    return fieldCapabilities
      .map((entry: Json): [string, Json] | null => {
        const entryObject = objectValue(entry);
        const name = firstString(entryObject?.name, entryObject?.field, entryObject?.path);
        return name ? [name, entry] : null;
      })
      .filter((entry): entry is [string, Json] => entry !== null);
  }
  return Object.entries(fieldCapabilities);
}

function formatFieldCapabilityFlags(capabilities: Json): string {
  if (typeof capabilities === "string" && capabilities.length > 0) {
    return capabilities;
  }
  const capabilitiesObject = objectValue(capabilities);
  if (!capabilitiesObject) {
    return "declared";
  }
  if (typeof capabilitiesObject.flags === "string" && capabilitiesObject.flags.length > 0) {
    return capabilitiesObject.flags;
  }
  const flags: string[] = [];
  const schema = objectValue(capabilitiesObject.schema);
  const type = firstString(capabilitiesObject.type, schemaType(schema));
  if (type) {
    flags.push(`t=${formatInlineValue(type)}`);
  }
  if (typeof capabilitiesObject.role === "string" && capabilitiesObject.role.length > 0) {
    flags.push(`role=${formatInlineValue(capabilitiesObject.role)}`);
  }
  if (capabilitiesObject.granted === false) {
    flags.push("g=false");
  }
  addCapabilityFlag(flags, "eq", capabilitiesObject.exact_filter);
  addRangeCapabilityFlag(flags, capabilitiesObject.range_filter);
  addCapabilityFlag(flags, "lex", capabilitiesObject.lexical_search);
  addCapabilityFlag(flags, "sem", capabilitiesObject.semantic_search);
  addAggregationCapabilityFlags(flags, capabilitiesObject.aggregation);
  return flags.length > 0 ? flags.join(",") : "declared";
}

function addCapabilityFlag(flags: string[], name: string, capability: Json): void {
  const capabilityObject = objectValue(capability);
  if (!capabilityObject) {
    return;
  }
  if (capabilityObject.usable === true) {
    flags.push(name);
  } else if (capabilityObject.declared === true && capabilityObject.usable === false) {
    flags.push(`${name}=unusable${reasonSuffix(capabilityObject.reason)}`);
  }
}

function addRangeCapabilityFlag(flags: string[], capability: Json): void {
  const capabilityObject = objectValue(capability);
  if (!capabilityObject) {
    return;
  }
  const operators =
    Array.isArray(capabilityObject.operators) && capabilityObject.operators.length > 0
      ? capabilityObject.operators.join("|")
      : null;
  if (capabilityObject.usable === true) {
    flags.push(operators ? `r=${formatInlineValue(operators)}` : "r");
  } else if (capabilityObject.declared === true && capabilityObject.usable === false) {
    flags.push(`r=unusable${reasonSuffix(capabilityObject.reason)}`);
  }
}

function addAggregationCapabilityFlags(flags: string[], aggregation: Json): void {
  const aggregationObject = objectValue(aggregation);
  if (!aggregationObject) {
    return;
  }
  const usable = orderedAggregationKinds(
    Object.entries(aggregationObject)
      .filter(([, capability]) => objectValue(capability)?.usable === true)
      .map(([name]) => name)
  );
  if (usable.length > 0) {
    flags.push(`a=${formatInlineValue(usable.join("|"))}`);
  }
}

const AGGREGATION_SUMMARY_KINDS = ["count_distinct", "group_by", "group_by_time", "sum", "min", "max"];
const AGGREGATION_FIELD_SUMMARY_LIMIT = 12;

function formatAggregationCapabilities(fieldCapabilities: Json): string {
  const entries = fieldCapabilityEntries(fieldCapabilities);
  if (entries.length === 0) {
    return "none";
  }
  const byKind = new Map<string, string[]>(AGGREGATION_SUMMARY_KINDS.map((kind) => [kind, []]));
  for (const [field, capabilities] of entries) {
    for (const kind of aggregationKindsForField(capabilities)) {
      const bucket = byKind.get(kind);
      if (bucket) {
        bucket.push(formatFieldName(field));
      }
    }
  }
  const parts: string[] = [];
  for (const kind of AGGREGATION_SUMMARY_KINDS) {
    const fields = byKind.get(kind) || [];
    if (fields.length === 0) {
      continue;
    }
    const shown = fields.slice(0, AGGREGATION_FIELD_SUMMARY_LIMIT);
    const more =
      fields.length > AGGREGATION_FIELD_SUMMARY_LIMIT ? `|more:${fields.length - AGGREGATION_FIELD_SUMMARY_LIMIT}` : "";
    parts.push(`${kind}=${shown.join("|")}${more}`);
  }
  return parts.length > 0 ? parts.join(";") : "none";
}

function aggregationKindsForField(capabilities: Json): string[] {
  if (typeof capabilities === "string") {
    return aggregationKindsFromFlags(capabilities);
  }
  const capabilitiesObject = objectValue(capabilities);
  if (!capabilitiesObject) {
    return [];
  }
  if (typeof capabilitiesObject.flags === "string") {
    return aggregationKindsFromFlags(capabilitiesObject.flags);
  }
  const aggregation = objectValue(capabilitiesObject.aggregation);
  if (!aggregation) {
    return [];
  }
  return orderedAggregationKinds(
    Object.entries(aggregation)
      .filter(([, capability]) => objectValue(capability)?.usable === true)
      .map(([kind]) => kind)
  );
}

function aggregationKindsFromFlags(flags: string): string[] {
  const match = AGGREGATION_KIND_FLAG_PATTERN.exec(flags);
  if (!match?.[1]) {
    return [];
  }
  return orderedAggregationKinds(
    match[1]
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean)
  );
}

function orderedAggregationKinds(kinds: string[]): string[] {
  const seen = new Set(kinds);
  return [
    ...AGGREGATION_SUMMARY_KINDS.filter((kind) => seen.has(kind)),
    ...kinds.filter((kind) => !AGGREGATION_SUMMARY_KINDS.includes(kind)),
  ];
}

function reasonSuffix(reason: unknown): string {
  return typeof reason === "string" && reason.length > 0 ? `:${reason}` : "";
}

function schemaType(schema: JsonObject | null): string | undefined {
  if (!schema) {
    return;
  }
  if (typeof schema.type === "string") {
    return schema.type;
  }
  return Array.isArray(schema.type)
    ? schema.type.filter((item: Json) => typeof item === "string").join("|") || undefined
    : undefined;
}

function objectValue(value: Json): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatScalar(value: unknown): string {
  return value === undefined || value === null ? "null" : JSON.stringify(String(value));
}

function formatInlineValue(value: unknown): string {
  if (value === undefined || value === null) {
    return "null";
  }
  return String(value)
    .replace(/[;,[\]{}]/g, "_")
    .replace(/\s+/g, "_");
}

function formatFieldName(value: unknown): string {
  return String(value).replace(/[;,[\]{}]/g, "_");
}

function truncateText(value: string, limit: number): string {
  const safeLimit = Math.max(0, limit);
  if (value.length <= safeLimit) {
    return value;
  }
  if (safeLimit <= 1) {
    return "…";
  }
  return `${value.slice(0, safeLimit - 1)}…`;
}

const SEARCH_TEXT_PREVIEW_LIMIT = 3;
const SEARCH_TEXT_SNIPPET_CHAR_LIMIT = 96;
const SEARCH_RESULT_SNIPPET_CHAR_LIMIT = 320;
// A truncated id is a dead fetch handle, so the preview id bound must
// comfortably exceed realistic `{connection_id}/{stream}:{record_id}` handles;
// it exists only to keep pathological record keys from blowing the text budget.
const SEARCH_TEXT_ID_CHAR_LIMIT = 200;

function summarizeSearch(body: Json, results: SearchResult[]): string {
  const hasMore = envelopeField(body, "has_more") === true ? " has_more=true." : "";
  const nextCursor = envelopeStringField(body, "next_cursor");
  const cursorText = nextCursor ? ` next_cursor=${formatScalar(nextCursor)}.` : "";
  const firstFetchText = results[0]?.id ? ` first_fetch_id=${formatInlineValue(results[0].id)}` : "";
  const sourceMixText = formatSearchSourceMix(body);
  const recallText = formatSearchRecallWarning(body);
  const previews = results.slice(0, SEARCH_TEXT_PREVIEW_LIMIT).map(formatSearchPreviewLine);
  const matchPreviews = results
    .slice(0, SEARCH_TEXT_PREVIEW_LIMIT)
    .flatMap((result, index) => formatSearchMatchWindowLines(result, index));
  const matchPreviewText = matchPreviews.length > 0 ? `\nEvidence excerpts:\n${matchPreviews.join("\n")}` : "";
  const previewText = previews.length > 0 ? `\nTop results:\n${previews.join("\n")}` : "";
  const fetchHint =
    previews.length > 0
      ? "\nFetch a hit with `fetch` using the shown id as-is; ids are self-contained. Pass connection_id only when shown separately."
      : "";
  return `search: ${results.length} hit(s).${hasMore}${cursorText}${firstFetchText}${sourceMixText}${recallText}${matchPreviewText}${previewText}${fetchHint} Search envelope metadata: structuredContent.data; flattened results: structuredContent.results.`;
}

function formatSearchMatchWindowLines(result: SearchResult, index: number): string[] {
  const windows = Array.isArray(result.match_windows) ? result.match_windows : [];
  return windows
    .slice(0, 2)
    .filter((window) => typeof window.text === "string" && window.text.length > 0)
    .map((window) => {
      const fieldPath = firstString(window.field_path);
      const read = objectValue(window.read as Json);
      const readArgs = objectValue(read?.args as Json);
      const complete = window.complete === true ? "complete=true" : "complete=false";
      const cursor = firstString(window.next_cursor) ? ` next_cursor=${formatInlineValue(window.next_cursor)}` : "";
      const offset = Number.isInteger(readArgs?.offset_chars) ? ` offset_chars=${readArgs?.offset_chars}` : "";
      const limit = Number.isInteger(readArgs?.limit_chars) ? ` limit_chars=${readArgs?.limit_chars}` : "";
      const readTool = firstString(read?.tool);
      const readHint =
        readTool || readArgs ? ` read=${formatInlineValue(readTool ?? "read_record_field")}${offset}${limit}` : "";
      const visibleId = firstString(readArgs?.id as string | undefined, result.id);
      const previewText =
        typeof window.preview_text === "string"
          ? window.preview_text
          : truncateText(window.text, SEARCH_TEXT_SNIPPET_CHAR_LIMIT);
      return `${index + 1}. result=${index + 1} field_path=${formatFieldName(fieldPath ?? "unknown")} snippet=${formatScalar(
        previewText
      )} id=${formatInlineValue(truncateText(visibleId ?? "", SEARCH_TEXT_ID_CHAR_LIMIT))} ${complete}${cursor}${readHint}`;
    });
}

// Mirror — never reinterpret — the RS recall disclosure. The warning is driven
// strictly by `meta.recall` from `/v1/search`; the adapter does NOT infer
// completeness from `has_more`, page size, or the hit count. A complete
// (`all_matches`) recall emits no extra warning, keeping the common case terse.
// Spec: openspec/changes/disclose-lexical-recall-windows.
function formatSearchRecallWarning(body: Json): string {
  const meta = objectValue(envelopeField(body, "meta"));
  const recall = objectValue(meta?.recall);
  if (!recall) {
    return "";
  }
  if (recall.ranking_scope === "candidate_window" || recall.complete === false) {
    const facts: string[] = [];
    if (typeof recall.ranked_candidate_count === "number") {
      facts.push(`ranked_candidate_count=${recall.ranked_candidate_count}`);
    }
    if (typeof recall.candidate_window_limit === "number") {
      facts.push(`candidate_window_limit=${recall.candidate_window_limit}`);
    }
    if (typeof recall.truncated_source_count === "number") {
      facts.push(`truncated_source_count=${recall.truncated_source_count}`);
    }
    const factsText = facts.length > 0 ? ` (${facts.join(", ")})` : "";
    return ` Recall: results were ranked over a bounded candidate window, not all matches — more matches may exist${factsText}; do not treat this page as exhaustive.`;
  }
  return "";
}

function formatSearchSourceMix(body: Json): string {
  const bodyObject = objectValue(body);
  const meta = objectValue(bodyObject?.meta);
  const pkg = objectValue(meta?.package);
  const sourceMix = pkg?.source_mix;
  if (!Array.isArray(sourceMix) || sourceMix.length === 0) {
    return "";
  }
  const rendered = sourceMix.slice(0, 8).map((entry: Json) => {
    const entryObject = objectValue(entry);
    const parts = [
      `connection_id:${formatInlineValue(entryObject?.connection_id)}`,
      `connector_key:${formatInlineValue(entryObject?.connector_key)}`,
      `count:${formatInlineValue(entryObject?.count)}`,
    ];
    if (entryObject?.display_name) {
      parts.push(`display_name:${formatInlineValue(entryObject.display_name)}`);
    }
    return `{${parts.join(",")}}`;
  });
  if (sourceMix.length > 8) {
    rendered.push(`more:${sourceMix.length - 8}`);
  }
  return ` source_mix=${rendered.join("|")}.`;
}

function formatSearchPreviewLine(result: SearchResult, index: number): string {
  const parts = [`${index + 1}. id=${formatInlineValue(truncateText(result.id, SEARCH_TEXT_ID_CHAR_LIMIT))}`];
  // The connection is normally embedded in the self-contained id; repeat it as
  // a separate handle only when the id could not encode it.
  if (result.connection_id && !String(result.id).startsWith(`${result.connection_id}/`)) {
    parts.push(`connection_id=${formatInlineValue(truncateText(result.connection_id, 80))}`);
  }
  if (result.connector_key) {
    parts.push(`connector_key=${formatInlineValue(truncateText(result.connector_key, 60))}`);
  }
  if (result.stream) {
    parts.push(`stream=${formatInlineValue(truncateText(result.stream, 60))}`);
  }
  if (result.title && result.title !== result.id) {
    parts.push(`title=${formatScalar(truncateText(result.title, 80))}`);
  }
  if (result.display_name) {
    parts.push(`display_name=${formatScalar(truncateText(result.display_name, 60))}`);
  }
  if (result.snippet) {
    parts.push(`snippet=${formatScalar(truncateText(result.snippet, SEARCH_TEXT_SNIPPET_CHAR_LIMIT))}`);
  }
  return parts.join(" ");
}

function envelopeField(body: Json, field: string): Json {
  const bodyObject = objectValue(body);
  if (bodyObject && Object.hasOwn(bodyObject, field)) {
    return bodyObject[field];
  }
  const data = objectValue(bodyObject?.data);
  return data ? data[field] : undefined;
}

function envelopeStringField(body: Json, field: string): string | null {
  const value = envelopeField(body, field);
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface NormalizeSearchResultsOptions {
  providerUrl?: string | undefined;
  q?: string | undefined;
}

function normalizeSearchResults(body: Json, options: NormalizeSearchResultsOptions = {}): SearchResult[] {
  const candidates = searchCandidatesFromBody(body);
  return candidates.map((hit, index) => {
    const hitObject = objectValue(hit);
    const source = objectValue(hitObject?.source) || {};
    const recordUriRef = recordUriRefForHit(hit);
    const stream = firstString(streamForHit(hit), recordUriRef?.stream);
    const recordKey = firstString(recordKeyForHit(hit), recordUriRef?.recordId);
    const connectionId = firstString(
      hitObject?.connection_id,
      hitObject?.connector_instance_id,
      source.connection_id,
      recordUriRef?.connectionId
    );
    // The id is the single opaque handle a model carries into `fetch`; encode
    // the hit's connection so multi-source grants resolve without a second
    // model-carried `connection_id` field.
    const id = selfContainedResultId(resultIdForHit(hit, index, { stream, recordKey }), connectionId);
    const displayName = firstString(hitObject?.display_name, source.display_name);
    const connectorKey = firstString(
      hitObject?.connector_key,
      hitObject?.connector_id,
      source.connector_key,
      source.connector_id
    );
    const snippet = snippetForSearchHit(hit);
    const matchWindows = normalizeSearchMatchWindowReadHints(normalizeSearchMatchWindows(hit, { q: options.q }), id);
    const evidenceExcerpts = searchEvidenceExcerpts(matchWindows, id);
    const normalized: SearchResult = {
      id,
      title: titleForSearchHit(hit, id, { stream, recordKey, connectionId, displayName, connectorKey }),
      url: urlForRecord(hit, id, options.providerUrl),
    };
    if (stream) {
      normalized.stream = stream;
    }
    if (recordKey) {
      normalized.record_key = recordKey;
    }
    if (connectionId) {
      normalized.connection_id = connectionId;
    }
    if (displayName) {
      normalized.display_name = displayName;
    }
    if (connectorKey) {
      normalized.connector_key = connectorKey;
    }
    if (snippet) {
      normalized.snippet = truncateText(snippet, SEARCH_RESULT_SNIPPET_CHAR_LIMIT);
    }
    if (matchWindows.length > 0) {
      normalized.match_windows = matchWindows;
    }
    if (evidenceExcerpts.length > 0) {
      normalized.evidence_excerpts = evidenceExcerpts;
    }
    return normalized;
  });
}

function normalizeSearchMatchWindows(hit: Json, options: { q?: string | undefined } = {}): MatchWindow[] {
  const hitObject = objectValue(hit);
  const data = objectValue(hitObject?.data);
  const candidates = [
    hitObject?.match_windows,
    hitObject?.field_windows,
    hitObject?.matches,
    // The RS lexical search envelope surfaces proven matched text as
    // `evidence_excerpts` ({ field_path, preview_text, truncated }). Treat it as
    // a first-class match-window source so visible search content includes the
    // bounded excerpt without depending on host-side structuredContent reads.
    hitObject?.evidence_excerpts,
    data?.match_windows,
    data?.field_windows,
    data?.evidence_excerpts,
  ].find((value) => Array.isArray(value));
  if (!Array.isArray(candidates)) {
    return [];
  }
  return candidates
    .map((window) => normalizeSearchMatchWindow(window, options))
    .filter((window): window is MatchWindow => window !== null)
    .slice(0, 3);
}

function normalizeSearchMatchWindowReadHints(matchWindows: MatchWindow[], recordId: string | undefined): MatchWindow[] {
  return matchWindows.map((window) => {
    const read = searchMatchWindowRead(window, recordId, window.field_path);
    return read ? { ...window, read } : window;
  });
}

function normalizeSearchMatchWindow(window: Json, options: { q?: string | undefined } = {}): MatchWindow | null {
  const value = objectValue(window);
  if (!value) {
    return null;
  }
  // `preview_text` is the RS `evidence_excerpt` text field; `text`/`preview`/
  // `snippet` cover match-window and legacy hit shapes.
  const nestedWindow = objectValue(value.window);
  const text = firstString(value.text, value.preview_text, value.preview, value.snippet, nestedWindow?.text);
  const fieldValue = objectValue(value.field);
  const fieldPath = firstString(value.field_path, value.fieldPath, value.path, fieldValue?.path);
  if (!(text && fieldPath)) {
    return null;
  }
  const read = objectValue(value.read);
  const normalizedText = centeredSearchText(text, options.q, SEARCH_RESULT_SNIPPET_CHAR_LIMIT);
  const previewText = centeredSearchText(text, options.q, SEARCH_TEXT_SNIPPET_CHAR_LIMIT);
  // An evidence_excerpt that is `truncated: true` is an incomplete window; a
  // match window declares completeness explicitly via `complete: true`.
  const complete = value.complete === true || value.truncated === false;
  const nextCursor = firstString(value.next_cursor, nestedWindow?.next_cursor);
  return {
    field_path: fieldPath,
    text: normalizedText,
    preview_text: previewText,
    complete,
    ...(nextCursor ? { next_cursor: nextCursor } : {}),
    ...(read ? { read } : {}),
  };
}

function centeredSearchText(text: string, query: string | undefined, limit: number): string {
  if (typeof text !== "string" || text.length <= limit) {
    return text;
  }
  const q = typeof query === "string" ? query.trim() : "";
  if (!q) {
    return truncateText(text, limit);
  }
  const index = text.toLowerCase().indexOf(q.toLowerCase());
  if (index < 0) {
    return truncateText(text, limit);
  }

  const available = Math.max(q.length, limit - 6);
  let start = Math.max(0, index - Math.floor((available - q.length) / 2));
  const end = Math.min(text.length, start + available);
  start = Math.max(0, end - available);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end)}${suffix}`;
}

function searchCandidatesFromBody(body: Json): Json[] {
  const bodyObject = objectValue(body);
  if (!bodyObject) {
    return [];
  }
  if (Array.isArray(bodyObject.results)) {
    return bodyObject.results;
  }
  if (Array.isArray(bodyObject.hits)) {
    return bodyObject.hits;
  }
  if (Array.isArray(bodyObject.data)) {
    return bodyObject.data;
  }
  const data = objectValue(bodyObject.data);
  if (data && Array.isArray(data.results)) {
    return data.results;
  }
  if (data && Array.isArray(data.data)) {
    return data.data;
  }
  return [];
}

function requestedSearchLimit(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return Math.min(value, 100);
  }
  return 25;
}

interface CompactEnvelopeOptions {
  resultCount?: number | undefined;
}

function compactSearchEnvelope(body: Json, { resultCount }: CompactEnvelopeOptions = {}): Json {
  if (!body || typeof body !== "object") {
    return body;
  }
  if (Array.isArray(body)) {
    return { object: "list", results_ref: "structuredContent.results", result_count: resultCount ?? body.length };
  }
  const out: JsonObject = { ...(body as JsonObject) };
  if (Array.isArray(out.results)) {
    out.result_count = resultCount ?? out.results.length;
    out.results = undefined;
    out.results_ref = "structuredContent.results";
  }
  if (Array.isArray(out.hits)) {
    out.result_count = resultCount ?? out.hits.length;
    out.hits = undefined;
    out.results_ref = "structuredContent.results";
  }
  if (Array.isArray(out.data)) {
    out.result_count = resultCount ?? out.data.length;
    out.data = undefined;
    out.results_ref = "structuredContent.results";
  } else if (out.data && typeof out.data === "object") {
    out.data = compactSearchEnvelopeDataObject(out.data as JsonObject, { resultCount });
  }
  return out;
}

function compactSearchEnvelopeDataObject(data: JsonObject, { resultCount }: CompactEnvelopeOptions = {}): JsonObject {
  const out: JsonObject = { ...data };
  if (Array.isArray(out.results)) {
    out.result_count = resultCount ?? out.results.length;
    out.results = undefined;
    out.results_ref = "structuredContent.results";
  }
  if (Array.isArray(out.hits)) {
    out.result_count = resultCount ?? out.hits.length;
    out.hits = undefined;
    out.results_ref = "structuredContent.results";
  }
  if (Array.isArray(out.data)) {
    out.result_count = resultCount ?? out.data.length;
    out.data = undefined;
    out.results_ref = "structuredContent.results";
  }
  return out;
}

function resultIdForHit(
  hit: Json,
  index: number,
  fallback: { stream?: string | undefined; recordKey?: string | undefined } = {}
): string {
  const hitObject = objectValue(hit);
  const directId = stringValue(hitObject?.result_id ?? hitObject?.resultId);
  const directRef = parseRecordResultIdOrNull(directId);
  if (directRef) {
    return selfContainedRecordId(directRef);
  }
  if (directId) {
    return directId;
  }

  // REST search envelopes may include a canonical `pdpp://record/...`
  // resource URI. Keep that accepted as input, but do not make it the
  // ordinary model-visible result id: some ChatGPT hosts do not route generic
  // resource reads for templates. A visible id must be directly usable by
  // `fetch` and `read_record_field`, so normalize parseable record URIs into
  // the self-contained tool id grammar.
  const recordUriRef = recordUriRefForHit(hit);
  if (recordUriRef) {
    return selfContainedRecordId(recordUriRef);
  }

  const stream = fallback.stream ?? streamForHit(hit);
  const recordId =
    fallback.recordKey ??
    stringValue(
      hitObject?.id ?? hitObject?.record_id ?? hitObject?.recordId ?? hitObject?.record_key ?? hitObject?.recordKey
    );
  if (stream && recordId) {
    return `${stream}:${recordId}`;
  }

  const fallbackId = stringValue(hitObject?.id ?? hitObject?.url);
  return fallbackId || `result:${index + 1}`;
}

function recordUriRefForHit(hit: Json): RecordRef | null {
  const hitObject = objectValue(hit);
  for (const value of [hitObject?.record_uri, hitObject?.recordUri, hitObject?.id]) {
    const raw = stringValue(value);
    if (!raw?.startsWith("pdpp://record/")) {
      continue;
    }
    const parsed = parseRecordResultIdOrNull(raw);
    if (parsed) {
      return parsed;
    }
  }
  return null;
}

function selfContainedRecordId(ref: RecordRef): string {
  return ref.connectionId ? `${ref.connectionId}/${ref.stream}:${ref.recordId}` : `${ref.stream}:${ref.recordId}`;
}

function streamForHit(hit: Json): string | undefined {
  const hitObject = objectValue(hit);
  return firstString(hitObject?.stream, hitObject?.stream_name, hitObject?.streamName);
}

function recordKeyForHit(hit: Json): string | undefined {
  const hitObject = objectValue(hit);
  return firstString(
    hitObject?.record_key,
    hitObject?.recordKey,
    hitObject?.record_id,
    hitObject?.recordId,
    hitObject?.id
  );
}

function snippetForSearchHit(hit: Json): string | undefined {
  const hitObject = objectValue(hit);
  const snippet = objectValue(hitObject?.snippet);
  return firstString(
    snippet?.text,
    typeof hitObject?.snippet === "string" ? hitObject.snippet : undefined,
    hitObject?.snippet_text,
    hitObject?.summary,
    hitObject?.text
  );
}

// Result-id grammar. Two forms round-trip through `search` -> `fetch`:
//   self-contained: `{connection_id}/{stream}:{record_id}`
//   legacy:         `{stream}:{record_id}`
// `/` is the connection separator because `requireSafeName` guarantees it can
// never appear inside a connection id, stream name, or record id — so a `/`
// unambiguously marks the self-contained form and every legacy id keeps
// parsing exactly as before. See:
//   openspec/changes/make-mcp-result-ids-self-contained
function parseRecordResultId(id: string): RecordRef {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("id is required");
  }
  if (id.startsWith("pdpp://record/")) {
    const handle = decodeURIComponent(id.slice("pdpp://record/".length));
    // The canonical record_uri the model sees in content ladders and resource
    // templates is `pdpp://record/{base64url-JSON}`. Accept that first so a
    // visible handle is never a dead fetch/read_record_field id; fall back to
    // the human-readable `connection_id/stream:record_id` form for legacy/test
    // URIs that embed the self-contained grammar directly.
    try {
      const payload = decodeResourceHandle(handle, "record");
      return {
        connectionId: requireSafeName(payload.connection_id, "connection_id"),
        stream: requireSafeName(payload.stream, "stream"),
        recordId: requireSafeName(payload.record_id, "record_id"),
      };
    } catch (error) {
      if (error instanceof InvalidResourceUriError) {
        return parseRecordResultId(handle);
      }
      throw error;
    }
  }
  const connectionSeparator = id.indexOf("/");
  if (connectionSeparator === -1) {
    return { ...parseStreamRecordId(id), connectionId: null };
  }
  const connectionId = requireSafeName(id.slice(0, connectionSeparator), "connection_id");
  return {
    ...parseStreamRecordId(id.slice(connectionSeparator + 1)),
    connectionId,
  };
}

function parseStreamRecordId(id: string): { stream: string; recordId: string } {
  const value = requireSafeName(id, "id");
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("id must use connection_id/stream:record_id or stream:record_id format");
  }
  return {
    stream: requireSafeName(value.slice(0, separator), "stream"),
    recordId: requireSafeName(value.slice(separator + 1), "record_id"),
  };
}

// Build the self-contained result id for a search hit. Only record-shaped
// base ids (`stream:record_id`) are wrapped — opaque fallbacks (URLs,
// `result:N`) and ids that already carry a connection segment pass through —
// and connection ids that could not survive the grammar (`/` or `:` inside)
// never produce a malformed handle.
function selfContainedResultId<T extends string | undefined>(baseId: T, connectionId: string | null | undefined): T {
  if (typeof baseId !== "string" || baseId.length === 0) {
    return baseId;
  }
  if (typeof connectionId !== "string" || connectionId.length === 0) {
    return baseId;
  }
  if (connectionId.includes("/") || connectionId.includes(":")) {
    return baseId;
  }
  if (baseId.includes("/")) {
    return baseId;
  }
  if (!parseRecordResultIdOrNull(baseId)) {
    return baseId;
  }
  return `${connectionId}/${baseId}` as T;
}

function normalizeFetchedDocument(record: Json, requestedId: string, providerUrl: string): FetchedDocument {
  const recordObject = objectValue(record);
  const payload = objectValue(recordObject?.data);
  const id =
    stringValue(recordObject?.id ?? recordObject?.record_id ?? recordObject?.recordId) ||
    stringValue(payload?.id ?? payload?.record_id ?? payload?.recordId) ||
    requestedId;
  const stream =
    stringValue(recordObject?.stream ?? recordObject?.stream_name ?? recordObject?.streamName) ||
    stringValue(payload?.stream ?? payload?.stream_name ?? payload?.streamName);
  const resultId = stream && id && !requestedId.includes(":") ? `${stream}:${id}` : requestedId;
  const title = titleForFetchedRecord(record, payload, resultId);
  const text = textForFetchedRecord(record, payload);
  const url = urlForFetchedRecord(record, payload, resultId, providerUrl);
  const metadata = metadataForRecord(record, { id: resultId, title, url });
  return { id: resultId, title, text, url, metadata };
}

function titleForFetchedRecord(record: Json, payload: JsonObject | null, fallbackId: string): string {
  const payloadTitle = payload ? titleForRecord(payload, "") : "";
  return payloadTitle || titleForRecord(record, "") || titleFromSourceIdentity(record, payload, fallbackId);
}

function titleForRecord(record: Json, fallbackId: string): string {
  const recordObject = objectValue(record);
  return (
    stringValue(recordObject?.title) ||
    stringValue(recordObject?.name) ||
    stringValue(recordObject?.subject) ||
    stringValue(recordObject?.summary) ||
    fallbackId
  );
}

interface SearchHitSource {
  connectionId?: string | undefined;
  connectorKey?: string | undefined;
  displayName?: string | undefined;
  recordKey?: string | undefined;
  stream?: string | undefined;
}

function titleForSearchHit(record: Json, fallbackId: string, source: SearchHitSource = {}): string {
  const explicit = titleForRecord(record, "");
  if (explicit) {
    return explicit;
  }
  const timestamp = titleTimestampForRecord(record);
  const label = source.displayName || source.connectorKey || source.connectionId;
  const parts = [label, source.stream, timestamp].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" / ") : fallbackId;
}

function titleFromSourceIdentity(record: Json, payload: JsonObject | null, fallbackId: string): string {
  const recordObject = objectValue(record);
  const source = objectValue(recordObject?.source) || objectValue(payload?.source) || {};
  const label = firstString(
    recordObject?.display_name,
    payload?.display_name,
    recordObject?.connector_key,
    payload?.connector_key,
    recordObject?.connector_id,
    payload?.connector_id,
    source.display_name,
    source.connector_key,
    source.connector_id,
    source.connection_id
  );
  const stream = firstString(
    recordObject?.stream,
    recordObject?.stream_name,
    payload?.stream,
    payload?.stream_name,
    source.stream
  );
  const timestamp = titleTimestampForRecord(payload) || titleTimestampForRecord(record);
  const parts = [label, stream, timestamp].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" / ") : fallbackId;
}

function titleTimestampForRecord(record: Json): string | undefined {
  const recordObject = objectValue(record);
  const nested = [
    objectValue(recordObject?.data),
    objectValue(recordObject?.record),
    objectValue(recordObject?.metadata),
    objectValue(recordObject?.source),
  ].filter((value): value is JsonObject => value !== null);
  const authored = firstString(
    recordObject?.sent_at,
    recordObject?.sentAt,
    recordObject?.authored_at,
    recordObject?.authoredAt,
    recordObject?.created_at,
    recordObject?.createdAt,
    recordObject?.source_created_at,
    recordObject?.sourceCreatedAt,
    recordObject?.occurred_at,
    recordObject?.occurredAt,
    recordObject?.updated_at,
    recordObject?.updatedAt,
    ...nested.flatMap((value) => [
      value.sent_at,
      value.sentAt,
      value.authored_at,
      value.authoredAt,
      value.created_at,
      value.createdAt,
      value.source_created_at,
      value.sourceCreatedAt,
      value.occurred_at,
      value.occurredAt,
      value.updated_at,
      value.updatedAt,
    ])
  );
  if (authored) {
    return authored;
  }
  return firstString(
    recordObject?.emitted_at,
    recordObject?.emittedAt,
    ...nested.flatMap((value) => [value.emitted_at, value.emittedAt])
  );
}

function textForFetchedRecord(record: Json, payload: JsonObject | null): string {
  const declared = (payload ? declaredTextForRecord(payload) : undefined) || declaredTextForRecord(record);
  if (declared) {
    return declared;
  }
  return fallbackTextForRecord(payload || record);
}

// Hard ceiling on the JSON-stringify fallback for `fetch`'s `text` field. A
// real declared text-like field (`text`/`content`/`body`/`summary`) is the
// document text ChatGPT consumes and is returned verbatim and unbounded — that
// is the contract. The fallback below only fires when a record declares NONE of
// those fields; without a cap it pretty-prints an arbitrary structured record
// into `text`, turning document fetch into a second record-read path. Bounding
// only the fallback keeps `fetch` document-shaped while pointing agents to the
// structured read tools for canonical records; no declared text is ever
// truncated and no field an agent needs is dropped.
const FETCH_TEXT_FALLBACK_CHAR_LIMIT = 1024;
const FETCH_TEXT_FALLBACK_POINTER =
  "… [record has no text/content/body/summary field; use query_records or fetch(fields) for structured records]";

function declaredTextForRecord(record: Json): string | undefined {
  const recordObject = objectValue(record);
  return (
    stringValue(recordObject?.text) ||
    stringValue(recordObject?.content) ||
    stringValue(recordObject?.body) ||
    stringValue(recordObject?.summary)
  );
}

function fallbackTextForRecord(record: Json): string {
  const serialized = JSON.stringify(record, null, 2);
  if (serialized.length <= FETCH_TEXT_FALLBACK_CHAR_LIMIT) {
    return serialized;
  }
  const head = FETCH_TEXT_FALLBACK_CHAR_LIMIT - FETCH_TEXT_FALLBACK_POINTER.length;
  return `${serialized.slice(0, Math.max(0, head))}${FETCH_TEXT_FALLBACK_POINTER}`;
}

function urlForFetchedRecord(
  record: Json,
  payload: JsonObject | null,
  fallbackId: string,
  providerUrl: string
): string {
  const recordObject = objectValue(record);
  const directUrl = firstString(
    payload?.url,
    payload?.record_url,
    payload?.recordUrl,
    payload?.href,
    payload?.source_url,
    payload?.sourceUrl,
    recordObject?.url,
    recordObject?.record_url,
    recordObject?.recordUrl,
    recordObject?.href,
    recordObject?.source_url,
    recordObject?.sourceUrl
  );
  if (directUrl) {
    return directUrl;
  }
  return urlForRecord(record, fallbackId, providerUrl);
}

function urlForRecord(record: Json, fallbackId: string, providerUrl: string | undefined): string {
  const recordObject = objectValue(record);
  const directUrl = stringValue(
    recordObject?.url ??
      recordObject?.record_url ??
      recordObject?.recordUrl ??
      recordObject?.href ??
      recordObject?.source_url ??
      recordObject?.sourceUrl
  );
  if (directUrl) {
    return directUrl;
  }
  if (providerUrl && fallbackId) {
    const recordRef = parseRecordResultIdOrNull(fallbackId);
    if (recordRef) {
      const base = providerUrl.replace(TRAILING_SLASH_PATTERN, "");
      const recordUrl = `${base}/v1/streams/${encodeURIComponent(recordRef.stream)}/records/${encodeURIComponent(recordRef.recordId)}`;
      return recordRef.connectionId
        ? `${recordUrl}?connection_id=${encodeURIComponent(recordRef.connectionId)}`
        : recordUrl;
    }
  }
  return `pdpp://record/${encodeURIComponent(fallbackId)}`;
}

function parseRecordResultIdOrNull(id: string | undefined): RecordRef | null {
  if (id === undefined) {
    return null;
  }
  try {
    return parseRecordResultId(id);
  } catch {
    return null;
  }
}

interface OmittedDocumentFields {
  id: string;
  title: string;
  url: string;
}

const FETCH_METADATA_PAYLOAD_BACKFILL_KEYS = [
  "stream",
  "stream_name",
  "streamName",
  "connection_id",
  "connector_key",
  "connector_id",
  "display_name",
];

function copyDocumentMetadataValues(metadata: JsonObject, source: JsonObject): void {
  for (const [key, value] of Object.entries(source)) {
    if (isDocumentMetadataValue(value)) {
      metadata[key] = value;
    }
  }
}

function backfillDocumentMetadataFromPayload(metadata: JsonObject, payload: JsonObject): void {
  for (const key of FETCH_METADATA_PAYLOAD_BACKFILL_KEYS) {
    if (metadata[key] === undefined && payload[key] !== undefined) {
      metadata[key] = payload[key];
    }
  }
}

function copyDocumentMetadataFromRecord(
  metadata: JsonObject,
  recordObject: JsonObject,
  omitted: OmittedDocumentFields
): void {
  for (const [key, value] of Object.entries(recordObject)) {
    if (["metadata", "data", "text", "content", "body"].includes(key)) {
      continue;
    }
    if (isOmittedDocumentField(key, value, omitted)) {
      continue;
    }
    if (!FETCH_METADATA_RECORD_KEYS.has(key)) {
      continue;
    }
    if (!isDocumentMetadataValue(value)) {
      continue;
    }
    metadata[key] = value;
  }
}

function metadataForRecord(record: Json, omitted: OmittedDocumentFields): JsonObject {
  const recordObject = objectValue(record);
  if (!recordObject) {
    return {};
  }
  const metadata: JsonObject = {};
  const recordMetadata = objectValue(recordObject.metadata);
  if (recordMetadata) {
    copyDocumentMetadataValues(metadata, recordMetadata);
  }
  const payload = objectValue(recordObject.data);
  if (payload) {
    backfillDocumentMetadataFromPayload(metadata, payload);
  }
  copyDocumentMetadataFromRecord(metadata, recordObject, omitted);
  return metadata;
}

function isOmittedDocumentField(key: string, value: Json, omitted: OmittedDocumentFields): boolean {
  if (["id", "record_id", "recordId"].includes(key)) {
    return value === omitted.id;
  }
  if (key === "title") {
    return value === omitted.title;
  }
  if (["url", "record_url", "recordUrl", "href", "source_url", "sourceUrl"].includes(key)) {
    return value === omitted.url;
  }
  return false;
}

const FETCH_METADATA_RECORD_KEYS = new Set([
  "object",
  "id",
  "record_id",
  "recordId",
  "stream",
  "stream_name",
  "streamName",
  "connection_id",
  "connector_key",
  "connector_id",
  "display_name",
  "emitted_at",
  "emittedAt",
  "sent_at",
  "sentAt",
  "created_at",
  "createdAt",
  "updated_at",
  "updatedAt",
]);

function isDocumentMetadataValue(value: Json): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function stringValue(value: Json): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorToolResult(response: RsErrorResponse, providerUrl: string): McpToolResult {
  const { error } = response;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(error, null, 2),
      },
    ],
    structuredContent: {
      error,
      provider_url: providerUrl,
      http_status: response.status,
      request_id: response.requestId,
    },
  };
}

export const __internal = {
  requireSafeName,
  pickQuery,
  toToolResult,
  toSearchToolResult,
  toFetchToolResult,
  resolveStreamName,
  resolveSchemaDetail,
  assertExpandCapabilities,
  UnadvertisedExpandError,
  parseRecordResultId,
  encodeResourceUri,
};
