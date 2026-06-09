import { z } from 'zod';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

export const PDPP_MCP_TOOL_NAMES = Object.freeze([
  'schema',
  'query_records',
  'aggregate',
  'search',
  'fetch',
]);

function selectNormalTools(tools) {
  const expectedNames = PDPP_MCP_TOOL_NAMES;
  const expected = new Set(expectedNames);
  const selected = tools.filter((tool) => expected.has(tool.name));
  const selectedNames = new Set(selected.map((tool) => tool.name));
  const missing = expectedNames.filter((name) => !selectedNames.has(name));
  if (missing.length > 0) {
    throw new Error(`MCP normal surface is missing expected tools: ${missing.join(', ')}`);
  }
  const unexpected = tools.map((tool) => tool.name).filter((name) => !expected.has(name));
  if (unexpected.length > 0) {
    throw new Error(`MCP normal surface has unexpected tools: ${unexpected.join(', ')}`);
  }
  return selected;
}

// MCP-exposed subset of the REST public read query-param vocabulary. These
// keys are forwarded to the RS; the MCP layer never silently drops a member.
// `sort` and `count` are canonical public read primitives advertised by
// `GET /v1/schema` and implemented by the reference runtime where declared.
const SUPPORTED_QUERY_KEYS = new Set([
  'limit',
  'cursor',
  'order',
  'sort',
  'count',
  'filter',
  'fields',
  'view',
  'expand',
  'expand_limit',
  'changes_since',
  // Optional public connection identity. Forwarded verbatim to the RS so
  // the resource server enforces grant scope; the MCP layer never invents
  // or rewrites a connection_id. See:
  //   openspec/changes/expose-connection-identity-on-public-read
  'connection_id',
]);

// Mirror of the REST aggregate query-param vocabulary
// (`/v1/streams/{stream}/aggregate`). Forwarded verbatim to the RS so the
// resource server owns metric/grouping validation; the MCP layer never
// silently drops a member. See:
//   openspec/changes/add-aggregate-time-buckets-and-distinct
const SUPPORTED_AGGREGATE_QUERY_KEYS = new Set([
  'metric',
  'field',
  'group_by',
  'group_by_time',
  'granularity',
  'time_zone',
  'limit',
  'filter',
  'connection_id',
]);

const CONNECTION_ID_DESCRIPTION =
  'Optional. Scope this call to one connection. Omit to fan in across all granted connections. Obtain from `schema` or the `available_connections` field in a typed 409 error — each entry includes `connector_key` and `connection_id`. Persist `connection_id` (not `grant_id`) across reconnects.';

const LIMIT_DESCRIPTION =
  'Records per page. Omit for the default page of 25; the maximum is 100 (the spec-core §8 contract). Values above 100 are rejected here rather than silently clamped, so the page size you request is always the page size you get. Page forward with the returned `cursor` instead of asking for a larger page.';

const SEARCH_LIMIT_DESCRIPTION =
  'Hits per page. Omit for the default page of 25; the maximum is 100 — the bound the published `/v1/search`, `/v1/search/semantic`, and `/v1/search/hybrid` contract declares and every mode honors (mirrored as `capabilities.{lexical,semantic,hybrid}_retrieval.max_limit` in `/.well-known/oauth-protected-resource` and `GET /v1/schema`). Values above 100 are rejected here rather than forwarded to be silently clamped by the RS, so the page size you request is always the page size you get. Page forward with the returned `cursor` (lexical and semantic page; hybrid does not) instead of asking for a larger page.';

const FIELDS_DESCRIPTION =
  'Field allowlist for projection. Field paths must be declared by the stream; advertised by `GET /v1/schema` (`field_capabilities`). Unknown paths are rejected by the RS rather than silently widened.';

const VIEW_DESCRIPTION =
  'Named projection. A stream-declared view id (advertised by `GET /v1/schema` under each stream\'s `views`) that projects the returned records down to the view\'s field set. Mutually exclusive with `fields` (passing both is rejected by the RS); an unknown view id is rejected rather than silently ignored. Use `view` for a curated projection and `fields` for an ad-hoc one.';

const FILTER_DESCRIPTION =
  'Typed per-field filter. Pass an OBJECT keyed by field name — never a pre-encoded query string. Exact match: `{ "user_id": "U123" }`. Range: `{ "created_at": { "gte": "2026-01-01T00:00:00Z", "lt": "2026-02-01T00:00:00Z" } }`, where the operator is one of `gte`, `gt`, `lte`, `lt`. Multiple fields AND together. The adapter encodes this into the RS `filter[field]=value` / `filter[field][op]=value` query shape for you. Allowed fields and operators are advertised by `GET /v1/schema` (`field_capabilities`); unsupported fields or operators are rejected by the RS rather than silently ignored.';

const EXPAND_DESCRIPTION =
  'One-hop inline expansion list. Each entry is a manifest-declared parent-to-child relation. Expandable relations and per-relation `expand_limit` caps are advertised by `GET /v1/schema` (`expand_capabilities`); unadvertised relations are rejected by the RS.';

const EXPAND_LIMIT_DESCRIPTION =
  'Typed per-relation cap for has-many expansion, keyed by relation name. Pass an object such as `{ "messages": 3 }`; the adapter encodes it into the RS `expand_limit[relation]=N` query shape. The RS clamps to the per-relation `max_limit` advertised by `GET /v1/schema`.';

const ORDER_DESCRIPTION =
  'Legacy page order for cursor-based pagination: `asc` or `desc`. Prefer canonical `sort` when `/v1/schema` advertises sortable fields; `order` remains accepted for clients that have not migrated.';

const SORT_DESCRIPTION =
  'Canonical sign-prefix sort spec advertised by `GET /v1/schema` (e.g. `sort=-emitted_at`). The reference runtime supports the advertised cursor field; unsupported fields, conflicting directions, or sort/order disagreement are rejected with typed errors rather than treated as no-ops.';

const COUNT_DESCRIPTION =
  'Canonical opt-in count grade (`none`, `estimated`, `exact`). Omit or use `none` for no count. `exact` returns `meta.count.kind="exact"` when supported; `estimated` may be upgraded to an exact count. Counts are page-independent and may be more expensive than the page itself.';

const CHANGES_SINCE_DESCRIPTION =
  'Projection-safe incremental-sync bookmark. Use `beginning` for the initial changes feed, then pass the opaque `next_changes_since` value returned in the prior response. Do not pass an ISO timestamp; malformed bookmarks are rejected as `invalid_cursor`.';

// Supported range operators, mirroring the RS (`record-filters.js`
// SUPPORTED_RANGE_OPERATORS) and the published query contract
// (`apps/site/content/docs/spec-data-query-api.md`).
const SUPPORTED_RANGE_OPERATORS = new Set(['gte', 'gt', 'lte', 'lt']);

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
  ]),
);

// Thrown when a typed filter object is structurally ambiguous. Surfaced as a
// typed MCP tool error (`server.js` `toolHandlerError` reads `.code`) so the
// agent gets an actionable instruction instead of a silently-ignored filter.
class MalformedFilterError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MalformedFilterError';
    this.code = 'invalid_filter';
  }
}

class MalformedExpandLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MalformedExpandLimitError';
    this.code = 'invalid_expand';
  }
}

// Translate a typed filter object into `[bracketKey, value]` query entries the
// RsClient appends verbatim (`filter[field]=value`, `filter[field][op]=value`).
function filterObjectToBracketEntries(filter) {
  if (Object.keys(filter).length === 0) {
    throw new MalformedFilterError(
      'filter object must include at least one field; omit filter entirely or pass a typed object such as filter: { "field": "value" }',
    );
  }
  const entries = [];
  for (const [field, spec] of Object.entries(filter)) {
    if (field.includes('[') || field.includes(']')) {
      throw new MalformedFilterError(
        `filter field '${field}' must be an advertised field name, not pre-encoded bracket syntax; pass filter: { "field": "value" }`,
      );
    }
    if (spec === undefined || spec === null) continue;
    if (typeof spec === 'object' && !Array.isArray(spec)) {
      const opEntries = Object.entries(spec).filter(([, v]) => v !== undefined && v !== null);
      if (opEntries.length === 0) {
        throw new MalformedFilterError(
          `filter range on '${field}' must include at least one of gte/gt/lte/lt; use the typed filter object, e.g. filter: { "${field}": { "gte": <value> } }`,
        );
      }
      for (const [op, value] of opEntries) {
        if (!SUPPORTED_RANGE_OPERATORS.has(op)) {
          throw new MalformedFilterError(
            `unsupported range operator '${op}' on '${field}'; supported operators are gte, gt, lte, lt`,
          );
        }
        entries.push([`filter[${field}][${op}]`, String(value)]);
      }
      continue;
    }
    // Scalar exact match.
    entries.push([`filter[${field}]`, String(spec)]);
  }
  return entries;
}

// Resolve the tool `filter` argument into the `filter[...]` query entries the
// RS expects. Returns [] when no filter was supplied.
function resolveFilterQueryEntries(filter) {
  if (filter === undefined || filter === null) return [];
  if (typeof filter === 'object' && !Array.isArray(filter)) {
    return filterObjectToBracketEntries(filter);
  }
  throw new MalformedFilterError(
    'filter must be a typed object, e.g. filter: { "field": "value" } or filter: { "field": { "gte": <value> } }',
  );
}

// Merge resolved filter bracket entries into a query object built by
// `pickQuery` (which deliberately drops the raw `filter` key). Mutates and
// returns `query` for call-site brevity.
function applyFilterToQuery(query, filter) {
  for (const [key, value] of resolveFilterQueryEntries(filter)) {
    query[key] = value;
  }
  return query;
}

function applyExpandLimitToQuery(query, expandLimit) {
  if (expandLimit === undefined || expandLimit === null) return query;
  const entries = Object.entries(expandLimit);
  if (entries.length === 0) {
    throw new MalformedExpandLimitError(
      'expand_limit must include at least one relation; omit expand_limit entirely when not setting a cap',
    );
  }
  for (const [relation, limit] of entries) {
    if (relation.includes('[') || relation.includes(']')) {
      throw new MalformedExpandLimitError(
        `expand_limit relation '${relation}' must be a relation name, not pre-encoded bracket syntax; pass expand_limit: { "relation": 3 }`,
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
  'Per-stream filter operators, expandable relations, projection support, search modes, count support, granted `connection_id` values, and canonical `connector_key` metadata are advertised by `GET /v1/schema`. Consult it before constructing filter, sort, expand, fields, count, or source-disambiguation arguments.';

// outputSchema describes the MCP wrapper around the RS response body. We do
// NOT bake the RS body shape into the outputSchema because the canonical
// envelope is the contract source of truth and the RS still ships legacy
// envelopes during the migration window. Validating `data` as a generic
// object keeps the MCP wrapper honest without over-promising RS structure.
const READ_OUTPUT_SCHEMA_SHAPE = {
  data: z
    .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .describe(
      'Canonical RS response body. Follows the public read envelope advertised by `GET /v1/schema` plus operation-specific extensions; source metadata uses canonical `connector_key` and concrete `connection_id` values when present.',
    ),
  provider_url: z.string().describe('RS base URL the MCP server was configured with.'),
  request_id: z.string().nullable().describe('RS x-request-id when present.'),
};

const SEARCH_OUTPUT_SCHEMA_SHAPE = {
  ...READ_OUTPUT_SCHEMA_SHAPE,
  results: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        url: z.string(),
      }).passthrough(),
    )
    .describe(
      'ChatGPT-compatible flattened search results. Each entry carries `id` (default `stream:record_id`), `title`, `url`, and available source handles such as `connection_id`. Use `data` for compact envelope metadata.',
    ),
};

const FETCH_OUTPUT_SCHEMA_SHAPE = {
  id: z.string(),
  title: z.string(),
  text: z.string(),
  url: z.string(),
  metadata: z.record(z.string(), z.unknown()),
};

const DISCOVERY_STREAM_SUMMARY_LIMIT = 50;
const DISCOVERY_FIELD_SUMMARY_LIMIT = 16;
const DISCOVERY_CONNECTION_SUMMARY_LIMIT = 8;
const FIELD_CAPABILITY_FLAG_LEGEND = {
  t: 'declared type',
  eq: 'exact filter supported',
  r: 'range filter operators',
  lex: 'lexical search field',
  sem: 'semantic search field',
  a: 'aggregation capabilities',
  'g=false': 'field is not granted',
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
  'Response detail grade for `structuredContent.data`. `compact` (default) returns a token-efficient projection: per-stream field names with capability flags, expandable relation names, connection identities, and connector metadata, with the heavy per-field JSON Schema blobs dropped. `full` returns deduped exhaustive schema for one source, preserving raw per-field JSON Schema while removing duplicate top-level stream arrays; it requires `stream`, and `connection_id` when that stream name is shared. The concise `content[]` text summary is identical for both grades.';

const SCHEMA_STREAM_DESCRIPTION =
  'Optional stream name from the compact `schema` stream list. Omit to describe every granted stream. Stream names are not globally unique; pair with `connection_id` when you need one configured source.';

const SCHEMA_CONNECTION_ID_DESCRIPTION =
  'Optional. Scope schema detail to one configured connection when a stream name is shared by multiple connectors or connections. Obtain from schema results or typed ambiguity errors. This is source identity, not a profile selector.';

/**
 * Resolve the `schema` tool `detail` grade defensively. Absent → the compact
 * default; the two valid grades pass through; anything else throws rather than
 * silently coercing to `compact` (defense-in-depth behind the Zod enum).
 */
function resolveSchemaDetail(value) {
  if (value == null) return 'compact';
  if (value === 'compact' || value === 'full') return value;
  throw new Error(`Invalid schema detail: ${JSON.stringify(value)} (expected 'compact' or 'full')`);
}

/**
 * Build the static tool definitions. Descriptions are constant — they are never derived
 * from manifest, stream, or record data. RS payloads are returned as data; nothing is
 * interpolated into instructions to the model.
 */
export function buildTools({ rs, providerUrl }) {
  const tools = [
    {
      name: 'schema',
      title: 'Get PDPP schema',
      description:
        'Return the grant-scoped PDPP schema document from `GET /v1/schema`. This is the canonical capability source: streams, canonical connector-type metadata (`connector_key`), per-field filter operators (`field_capabilities`), expandable relations (`expand_capabilities`), projection support, search modes, pagination support, count support, and granted connection identities (`connection_id`, `display_name`). Defaults to a compact, token-efficient projection (`detail: "compact"`) so the `schema -> schema(stream) -> schema(stream, connection_id) -> query_records` discovery path stays cheap. Stream names are not globally unique; add `connection_id` to narrow a shared stream to one configured source. `detail: "full"` is allowed only with `stream` and returns deduped exhaustive schema for matching stream rows, preserving raw per-field JSON Schema without duplicate stream arrays. Call this before issuing other tools to discover valid filter, sort, expand, fields, count, aggregate, stream, and connection-disambiguation arguments. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          detail: z.enum(['compact', 'full']).optional().describe(SCHEMA_DETAIL_DESCRIPTION),
          stream: z.string().min(1).optional().describe(SCHEMA_STREAM_DESCRIPTION),
          connection_id: z.string().min(1).optional().describe(SCHEMA_CONNECTION_ID_DESCRIPTION),
        })
        .strict(),
      outputSchema: z.object(READ_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const stream = args?.stream ? requireSafeName(args.stream, 'stream') : null;
        const connectionId = args?.connection_id ? requireSafeName(args.connection_id, 'connection_id') : null;
        // `detail` is normally constrained by the Zod enum to `compact|full`,
        // so a direct MCP call can only land here with `'compact'`, `'full'`,
        // or `undefined` (→ compact default). Resolve it defensively rather
        // than coercing any non-`full` value to `compact`: an unexpected value
        // (a future enum loosening, or a caller that bypassed the Zod parse)
        // fails loudly here instead of silently downgrading the response grade.
        const detail = resolveSchemaDetail(args?.detail);
        if (detail === 'compact') {
          const compactResponse = await rs.getJson('/v1/schema', {
            query: { view: 'compact', ...(stream ? { stream } : {}), ...(connectionId ? { connection_id: connectionId } : {}) },
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
        const response = await rs.getJson('/v1/schema', {
          query: {
            ...(detail === 'full' ? { detail: 'full' } : {}),
            ...(stream ? { stream } : {}),
            ...(connectionId ? { connection_id: connectionId } : {}),
          },
        });
        return toSchemaToolResult(response, providerUrl, { detail, stream, connectionId });
      },
    },
    {
      name: 'query_records',
      title: 'Query PDPP records',
      description:
        'Query records in a stream via `GET /v1/streams/{stream}/records`. Default returns at most 25 records; `limit` is capped at 100 (enforced at input — a REST client that sends `limit>100` gets `limit_clamped` in `meta.warnings[]`). Page forward with `cursor`; narrow with `fields`. `structuredContent.data` carries the machine envelope; with `fields`, record payloads are narrowed to those fields plus required operational handles. `content[]` previews up to the first 5 records. Forwards all args verbatim. ' +
        CANONICAL_SCHEMA_HINT +
        ' Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          stream: z.string().min(1).describe('Stream name advertised by `schema`.'),
          limit: z.number().int().positive().max(100).optional().describe(LIMIT_DESCRIPTION),
          cursor: z.string().optional(),
          order: z.string().optional().describe(ORDER_DESCRIPTION),
          sort: z.string().optional().describe(SORT_DESCRIPTION),
          count: z.enum(['none', 'estimated', 'exact']).optional().describe(COUNT_DESCRIPTION),
          filter: TypedFilterInput.optional().describe(FILTER_DESCRIPTION),
          fields: z.array(z.string()).optional().describe(FIELDS_DESCRIPTION),
          view: z.string().optional().describe(VIEW_DESCRIPTION),
          expand: z.array(z.string()).optional().describe(EXPAND_DESCRIPTION),
          expand_limit: z
            .record(z.string(), z.number().int().positive())
            .optional()
            .describe(EXPAND_LIMIT_DESCRIPTION),
          changes_since: z.string().optional().describe(CHANGES_SINCE_DESCRIPTION),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(READ_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const stream = requireSafeName(args?.stream, 'stream');
        const query = applyExpandLimitToQuery(
          applyFilterToQuery(pickQuery(args, SUPPORTED_QUERY_KEYS), args?.filter),
          args?.expand_limit,
        );
        const response = await rs.getJson(`/v1/streams/${encodeURIComponent(stream)}/records`, {
          query,
        });
        return toToolResult(response, providerUrl, `records from stream "${stream}"`, {
          previewRecords: true,
        });
      },
    },
    {
      name: 'aggregate',
      title: 'Aggregate PDPP records',
      description:
        'Compute a single-stream aggregation via `GET /v1/streams/{stream}/aggregate`. Prefer over `query_records` when you only need a count, sum, min/max, distinct count, or grouped/time-bucketed rollup — returns small bucket rows, never record bodies. Metrics: `count`, `sum`, `min`, `max`, `count_distinct` (`field` required for all but `count`). Group with one dimension: `group_by` XOR `group_by_time` (requires `granularity`). Groupable fields are advertised by `GET /v1/schema`. Forwards args verbatim. ' +
        CANONICAL_SCHEMA_HINT +
        ' Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          stream: z.string().min(1).describe('Stream name advertised by `schema`.'),
          metric: z
            .enum(['count', 'sum', 'min', 'max', 'count_distinct'])
            .describe('Aggregation metric. `field` is required for sum, min, max, and count_distinct.'),
          field: z
            .string()
            .min(1)
            .optional()
            .describe('Target field for sum/min/max/count_distinct. Must be declared for the metric in `GET /v1/schema`.'),
          group_by: z
            .string()
            .min(1)
            .optional()
            .describe('Scalar field to group counts by. Mutually exclusive with `group_by_time`.'),
          group_by_time: z
            .string()
            .min(1)
            .optional()
            .describe('Declared date/date-time field to bucket counts by. Requires `granularity`. Mutually exclusive with `group_by`.'),
          granularity: z
            .enum(['minute', 'hour', 'day', 'week', 'month', 'quarter', 'year'])
            .optional()
            .describe('Calendar bucket unit for `group_by_time`. Required with `group_by_time`, forbidden otherwise.'),
          time_zone: z
            .string()
            .min(1)
            .optional()
            .describe('IANA time zone for `group_by_time` bucket boundaries. Defaults to UTC; the response echoes the effective zone.'),
          limit: z
            .number()
            .int()
            .positive()
            .max(100)
            .optional()
            .describe('Maximum number of group buckets (1-100). Only valid with `group_by` or `group_by_time`.'),
          filter: TypedFilterInput.optional().describe(FILTER_DESCRIPTION),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(READ_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const stream = requireSafeName(args?.stream, 'stream');
        const query = applyFilterToQuery(pickQuery(args, SUPPORTED_AGGREGATE_QUERY_KEYS), args?.filter);
        const response = await rs.getJson(`/v1/streams/${encodeURIComponent(stream)}/aggregate`, {
          query,
        });
        return toAggregateToolResult(response, providerUrl, stream);
      },
    },
    {
      name: 'search',
      title: 'Search PDPP records',
      description:
        'Search records via `GET /v1/search` (lexical), `/v1/search/semantic`, or `/v1/search/hybrid` per `mode`. Use lexical for exact known terms; semantic is approximate retrieval for conceptual matches. `structuredContent.results` carries the flattened page; `structuredContent.data` carries compact envelope metadata, not a duplicate hit array. Hits carry `connection_id` and `connector_key`. Pass `connection_id` to scope, omit to fan in. Page default is 25 hits; `limit` is capped at 100 (enforced at input, and fan-in packages apply it globally). Page forward with `cursor` (lexical/semantic; hybrid does not page). Per-mode capability support is advertised by `GET /v1/schema`. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          q: z.string().min(1).describe('Search query string.'),
          streams: z.array(z.string()).optional(),
          limit: z.number().int().positive().max(100).optional().describe(SEARCH_LIMIT_DESCRIPTION),
          cursor: z.string().optional(),
          mode: z.enum(['lexical', 'semantic', 'hybrid']).optional(),
          filter: TypedFilterInput.optional().describe(FILTER_DESCRIPTION),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(SEARCH_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const path = searchPathForMode(args.mode);
        const query = applyFilterToQuery(
          {
            q: args.q,
            streams: args.streams,
            limit: args.limit,
            cursor: args.cursor,
            connection_id: args.connection_id,
          },
          args.filter,
        );
        const response = await rs.getJson(path, { query });
        return toSearchToolResult(response, providerUrl, { limit: args?.limit });
      },
    },
    {
      name: 'fetch',
      title: 'Fetch PDPP search result',
      description:
        'Fetch a single OpenAI-compatible document by a result id from `search`. Id format: `stream:record_id` → `GET /v1/streams/{stream}/records/{record_id}`. Returns document fields only (`id`, `title`, `text`, `url`, `metadata`); use `query_records` for canonical PDPP record envelopes. Use `fields` to project the source record before rendering document text/metadata; operational source handles (`id`, stream, `connection_id`, `connector_key`) remain available in `metadata`. On `ambiguous_connection` (409), pick a `connection_id` from `available_connections` in the error and retry. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          id: z.string().min(1).describe('Search result id, usually `stream:record_id`.'),
          expand: z.array(z.string()).optional().describe(EXPAND_DESCRIPTION),
          expand_limit: z
            .record(z.string(), z.number().int().positive())
            .optional()
            .describe(EXPAND_LIMIT_DESCRIPTION),
          fields: z.array(z.string()).optional().describe(FIELDS_DESCRIPTION),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(FETCH_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const ref = parseRecordResultId(args.id);
        const query = applyExpandLimitToQuery(pickQuery(args, SUPPORTED_QUERY_KEYS), args?.expand_limit);
        const response = await rs.getJson(
          `/v1/streams/${encodeURIComponent(ref.stream)}/records/${encodeURIComponent(ref.recordId)}`,
          { query }
        );
        return toFetchToolResult(response, providerUrl, args.id);
      },
    },
  ];

  return selectNormalTools(tools);
}

function searchPathForMode(mode) {
  if (mode === 'semantic') return '/v1/search/semantic';
  if (mode === 'hybrid') return '/v1/search/hybrid';
  return '/v1/search';
}

export function buildStreamResourceTemplate({ rs, providerUrl }) {
  return {
    uriTemplate: 'pdpp://stream/{name}',
    name: 'pdpp-stream',
    title: 'PDPP stream metadata',
    description:
      'Returns the stream metadata document for a single stream (GET /v1/streams/{name}). Read-only.',
    mimeType: 'application/json',
    read: async (uri, variables) => {
      const streamName = resolveStreamName(uri, variables);
      const response = await rs.getJson(`/v1/streams/${encodeURIComponent(streamName)}`);
      if (response.ok) {
        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(response.body, null, 2),
            },
          ],
        };
      }
      const error = response.error ?? { type: 'rs_error', code: 'unknown', message: 'Unknown RS error' };
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify({ error, provider_url: providerUrl, http_status: response.status }, null, 2),
          },
        ],
      };
    },
  };
}

function resolveStreamName(uri, variables) {
  const rawFromVariables = variables?.name;
  if (typeof rawFromVariables === 'string' && rawFromVariables.length > 0) {
    return requireSafeName(decodeIfEncoded(rawFromVariables), 'stream');
  }
  const match = /^pdpp:\/\/stream\/([^/]+)$/.exec(uri);
  if (!match) {
    throw new InvalidResourceUriError(`Resource URI ${uri} does not match pdpp://stream/{name}.`);
  }
  return requireSafeName(decodeURIComponent(match[1]), 'stream');
}

function decodeIfEncoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class InvalidResourceUriError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvalidResourceUriError';
  }
}

function requireSafeName(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  // Reject path-traversal and slash-bearing inputs. The RS validates names too, but a
  // defensive check here keeps the resource template URI surface narrow.
  if (value.includes('/') || value.includes('\\') || value === '.' || value === '..' || value.includes('..')) {
    throw new Error(`${label} contains invalid characters`);
  }
  return value;
}

function pickQuery(args, supportedKeys) {
  if (!args || typeof args !== 'object') {
    return {};
  }
  const out = {};
  for (const key of Object.keys(args)) {
    if (key === 'stream') continue;
    // `filter` is never forwarded as a flat param: the RS expects bracketed
    // `filter[field]=value` query keys, which callers build via
    // `applyFilterToQuery`. Forwarding the raw value here would re-introduce the
    // silent bare-`filter=` no-op this change fixes.
    if (key === 'filter') continue;
    // `expand_limit` mirrors the same nested REST query shape:
    // `expand_limit[relation]=N`. Forwarding the raw object would become a JSON
    // string under URLSearchParams instead of the query key the RS parses.
    if (key === 'expand_limit') continue;
    if (!supportedKeys.has(key)) continue;
    out[key] = args[key];
  }
  return out;
}

// `content[]` is intentionally a concise human summary — the canonical
// `structuredContent` envelope is the contract for programmatic consumers.
// See:
//   openspec/changes/canonicalize-public-read-contract (5.3 prose content[] is
//   a concise summary only and not a second divergent JSON contract).
function toToolResult(response, providerUrl, label = 'response', options = {}) {
  if (response.ok) {
    const body = response.body;
    return {
      content: [
        {
          type: 'text',
          text: summarizeBody(body, label, options),
        },
      ],
      structuredContent: { data: body, provider_url: providerUrl, request_id: response.requestId },
    };
  }
  return errorToolResult(response, providerUrl);
}

// Build the `schema` tool result. The text summary is always the compact,
// parseable discovery line. The `structuredContent.data` payload is a compact
// projection by default and the verbatim RS body only when `detail === "full"`.
// When `stream`/`connection_id` are supplied, both the summary and the
// structured payload are scoped so an agent can fetch one source's capabilities
// without pulling the whole document.
function toSchemaToolResult(response, providerUrl, { detail = 'compact', stream = null, connectionId = null, alreadyCompact = false } = {}) {
  if (!response.ok) {
    return errorToolResult(response, providerUrl);
  }
  const data = detail === 'full'
    ? dedupeFullSchemaDocument(response.body)
    : compactSchemaDocument(response.body, { includeFieldDetail: Boolean(stream) });
  const schemaDocument = unwrapSchemaBody(data);
  return {
    content: [
      {
        type: 'text',
        text: summarizeSchemaDiscovery(
          schemaDocument,
          'PDPP schema',
          { includeFieldDetail: Boolean(stream), ...(connectionId ? { connectionId } : {}) },
        ),
      },
    ],
    structuredContent: { data: schemaDocument, provider_url: providerUrl, request_id: response.requestId },
  };
}

function isCompactSchemaBody(body) {
  return unwrapSchemaBody(body)?.detail === 'compact';
}

function shouldFallbackFromCompactSchemaRequest(response) {
  if (response.ok) return false;
  const code = response.error?.code ?? response.error?.type ?? '';
  return response.status === 400 && ['bad_request', 'invalid_request', 'unsupported_query'].includes(code);
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
function compactSchemaDocument(body, { includeFieldDetail = false } = {}) {
  const wrapped =
    body && typeof body === 'object' && body.data && typeof body.data === 'object' && !Array.isArray(body.data);
  const schema = unwrapSchemaBody(body);
  if (!schema || typeof schema !== 'object') {
    return body;
  }
  const connectors = extractSchemaConnectors(schema);
  let compactSchema;
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
  compactSchema = { ...compactSchema, detail: 'compact' };
  return wrapped ? { ...body, data: compactSchema } : compactSchema;
}

function dedupeFullSchemaDocument(body) {
  const wrapped =
    body && typeof body === 'object' && body.data && typeof body.data === 'object' && !Array.isArray(body.data);
  const schema = unwrapSchemaBody(body);
  if (!schema || typeof schema !== 'object') return body;
  const connectors = extractSchemaConnectors(schema);
  if (connectors.length === 0) return body;
  const deduped = stripSchemaStreamArrays(schema);
  return wrapped ? { ...body, data: deduped } : deduped;
}

function stripSchemaStreamArrays(schema) {
  const { streams: _streams, ...rest } = schema;
  return rest;
}

function compactSchemaConnector(connector, { includeFieldDetail = false } = {}) {
  if (!connector || typeof connector !== 'object') return connector;
  const streams = Array.isArray(connector.streams) ? connector.streams : [];
  const { shared, sharedKey } = pickSharedGrantedConnections(streams);
  const hasShared = shared !== null;
  return {
    ...connector,
    ...(shared ? { granted_connections: shared } : {}),
    streams: streams.map((entry) => compactSchemaStream(entry, { hasShared, sharedKey, includeFieldDetail })),
  };
}

// Project a single stream-metadata entry to its compact form. Whitelisted
// identity/metadata fields pass through verbatim; `field_capabilities` and
// `expand_capabilities` are compacted; everything else is dropped to keep the
// payload bounded.
function compactSchemaStream(entry, { hasShared = false, sharedKey = '', includeFieldDetail = false } = {}) {
  if (!entry || typeof entry !== 'object') return entry;
  const out = {};
  const passthrough = [
    'name',
    'stream',
    'stream_name',
    'connector_key',
    'connector_id',
    'connector_display_name',
    'display_name',
    'connection_display_name',
    'connection_id',
    'record_count',
    'granted',
    'primary_key',
    'cursor_field',
    'source',
  ];
  for (const key of passthrough) {
    if (entry[key] !== undefined) out[key] = entry[key];
  }
  if (entry.granted_connections !== undefined) {
    const compactGrantedConnections = compactSchemaGrantedConnections(entry.granted_connections);
    const streamKey = Array.isArray(entry.granted_connections)
      ? grantedConnectionsKey(entry.granted_connections)
      : null;
    if (!hasShared || streamKey === null || streamKey !== sharedKey) {
      out.granted_connections = compactGrantedConnections;
    }
  }
  if (includeFieldDetail && entry.field_capabilities !== undefined) {
    out.field_capabilities = compactFieldCapabilities(entry.field_capabilities);
  }
  if (includeFieldDetail && entry.expand_capabilities !== undefined) {
    out.expand_capabilities = compactExpandCapabilities(entry.expand_capabilities);
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
function compactFieldCapabilities(fieldCapabilities) {
  const entries = fieldCapabilityEntries(fieldCapabilities);
  if (entries.length === 0) return fieldCapabilities;
  const isArray = Array.isArray(fieldCapabilities);
  if (isArray) {
    return entries.map(([name, capabilities]) => ({ name, flags: formatFieldCapabilityFlags(capabilities) }));
  }
  const out = {};
  for (const [name, capabilities] of entries) {
    out[name] = formatFieldCapabilityFlags(capabilities);
  }
  return out;
}

function compactExpandCapabilities(expandCapabilities) {
  if (!Array.isArray(expandCapabilities)) return expandCapabilities;
  return expandCapabilities.map((relation) => {
    if (!relation || typeof relation !== 'object') return relation;
    const out = {};
    for (const key of [
      'name',
      'relation',
      'stream',
      'target_stream',
      'cardinality',
      'granted',
      'usable',
      'foreign_key',
      'max_limit',
      'default_limit',
      'reason',
    ]) {
      if (relation[key] !== undefined) out[key] = relation[key];
    }
    return Object.keys(out).length > 0 ? out : relation;
  });
}

function grantedConnectionsKey(value) {
  if (!Array.isArray(value)) return '';
  const entries = value.map((entry) => {
    if (!entry || typeof entry !== 'object') return JSON.stringify(entry);
    const id = typeof entry.connection_id === 'string' ? entry.connection_id : '';
    const label = typeof entry.display_name === 'string' ? entry.display_name : '';
    return JSON.stringify([id, label]);
  });
  entries.sort();
  return entries.join('\n');
}

function compactSchemaGrantedConnections(value) {
  if (!Array.isArray(value)) return value;
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const { connector_instance_id: _deprecatedAlias, ...rest } = entry;
    return rest;
  });
}

function pickSharedGrantedConnections(streams) {
  const byKey = new Map();
  for (const stream of streams) {
    if (!stream || typeof stream !== 'object' || !Array.isArray(stream.granted_connections)) continue;
    if (stream.granted_connections.length === 0) continue;
    const key = grantedConnectionsKey(stream.granted_connections);
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      byKey.set(key, { value: compactSchemaGrantedConnections(stream.granted_connections), count: 1 });
    }
  }
  let bestKey = '';
  let best = null;
  for (const [key, candidate] of byKey) {
    if (!best || candidate.count > best.count) {
      best = candidate;
      bestKey = key;
    }
  }
  return { shared: best ? best.value : null, sharedKey: best ? bestKey : '' };
}

function toSearchToolResult(response, providerUrl, options = {}) {
  if (!response.ok) {
    return errorToolResult(response, providerUrl);
  }
  const allResults = normalizeSearchResults(response.body);
  const limit = requestedSearchLimit(options.limit);
  const results = allResults.slice(0, limit);
  const summaryBody = allResults.length > results.length
    ? { ...response.body, has_more: true }
    : response.body;
  const data = compactSearchEnvelope(summaryBody, { resultCount: results.length });
  return {
    content: [
      {
        type: 'text',
        text: summarizeSearch(summaryBody, results),
      },
    ],
    structuredContent: {
      data,
      results,
      provider_url: providerUrl,
      request_id: response.requestId,
    },
  };
}

function toFetchToolResult(response, providerUrl, requestedId) {
  if (!response.ok) {
    return errorToolResult(response, providerUrl);
  }
  const document = normalizeFetchedDocument(response.body, requestedId, providerUrl);
  const text = JSON.stringify(document);
  return {
    content: [
      {
        type: 'text',
        text,
      },
    ],
    structuredContent: document,
  };
}

// Aggregate results must surface the numeric answer in `content[]` text, not
// only in `structuredContent.data`: some hosted agents cannot reliably read
// `structuredContent`. The text stays compact (metric, stream, scalar value or
// a short preview of grouped buckets) — the full envelope remains canonical in
// `structuredContent.data`. See validation criterion 3 in the lane brief.
function toAggregateToolResult(response, providerUrl, stream) {
  if (!response.ok) {
    return errorToolResult(response, providerUrl);
  }
  return {
    content: [
      {
        type: 'text',
        text: summarizeAggregate(response.body, stream),
      },
    ],
    structuredContent: { data: response.body, provider_url: providerUrl, request_id: response.requestId },
  };
}

const AGGREGATE_GROUP_PREVIEW_LIMIT = 5;

function summarizeAggregate(body, stream) {
  const agg = unwrapAggregateBody(body);
  const metric = typeof agg.metric === 'string' && agg.metric.length > 0 ? agg.metric : 'aggregate';
  const field = typeof agg.field === 'string' && agg.field.length > 0 ? ` field=${agg.field}` : '';
  const head = `${metric}(${stream})${field}`;

  const groups = Array.isArray(agg.groups) ? agg.groups : null;
  if (groups) {
    const timeZone = firstString(agg.effective_time_zone, agg.time_zone);
    const timeZoneSuffix = agg.group_by_time && timeZone ? ` time_zone=${formatScalar(timeZone)}` : '';
    const dimension = agg.group_by_time
      ? `group_by_time=${formatScalar(agg.group_by_time)} granularity=${formatScalar(agg.granularity)}${timeZoneSuffix}`
      : `group_by=${formatScalar(agg.group_by)}`;
    if (groups.length === 0) {
      return `${head} ${dimension}: 0 group(s). See structuredContent.data for the canonical envelope.`;
    }
    const shown = groups.slice(0, AGGREGATE_GROUP_PREVIEW_LIMIT).map((g) => {
      const key = g && typeof g === 'object' ? g.key : g;
      const count = g && typeof g === 'object' ? g.count : undefined;
      return `${formatScalar(key)}=${count == null ? '?' : count}`;
    });
    const more = groups.length > AGGREGATE_GROUP_PREVIEW_LIMIT ? ` more_groups=${groups.length - AGGREGATE_GROUP_PREVIEW_LIMIT};` : '';
    return `${head} ${dimension}: ${groups.length} group(s) [${shown.join(', ')}]${more} canonical envelope in structuredContent.data`;
  }

  // Ungrouped: the scalar answer lives in `value`. Fall back to
  // `filtered_record_count` for a count when `value` is absent.
  const value = agg.value !== undefined ? agg.value : agg.filtered_record_count;
  return `${head} = ${formatAggregateValue(value)}. canonical envelope in structuredContent.data`;
}

// Render the scalar aggregate answer. Numbers stay unquoted (the common
// count/sum/min/max case) so the text reads as the numeric result; strings are
// quoted for disambiguation.
function formatAggregateValue(value) {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return formatScalar(value);
}

function unwrapAggregateBody(body) {
  if (!body || typeof body !== 'object') return {};
  if (body.object === 'aggregation') return body;
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    return body.data;
  }
  return body;
}

function summarizeBody(body, label, options = {}) {
  if (label === 'PDPP schema') {
    return summarizeSchemaDiscovery(body, label);
  }
  if (label === 'PDPP streams') {
    return summarizeStreamsDiscovery(body, label);
  }
  if (options.previewRecords) {
    return summarizeRecordEnvelope(body, label);
  }
  if (Array.isArray(body)) {
    return `${label}: ${body.length} item(s). See structuredContent.data for the canonical envelope.`;
  }
  if (body && typeof body === 'object') {
    const dataLen = Array.isArray(body.data)
      ? body.data.length
      : Array.isArray(body.records)
        ? body.records.length
        : Array.isArray(body.streams)
          ? body.streams.length
          : null;
    const hasMore = body.has_more === true ? ' has_more=true.' : '';
    if (dataLen !== null) {
      return `${label}: ${dataLen} item(s).${hasMore} See structuredContent.data for the canonical envelope.`;
    }
    return `${label}: see structuredContent.data for the canonical envelope.`;
  }
  return `${label}: see structuredContent.data for the canonical envelope.`;
}

const RECORD_PREVIEW_LIMIT = 5;
// Hard ceiling on the whole text preview, including the header and any trailing
// markers. The token-efficiency tests assert the preview stays below 1800
// chars, so this is the load-bearing bound.
const RECORD_PREVIEW_CHAR_LIMIT = 1792;
const RECORD_PREVIEW_FOOTER_RESERVE = 96;
const RECORD_PREVIEW_MIN_RECORD_CHARS = 24;
const RECORD_PREVIEW_TRUNCATED_MARKER =
  'record_preview_truncated=true; machine envelope in structuredContent.data';

function summarizeRecordEnvelope(body, label) {
  const records = extractRecordRows(body);
  const hasMore = envelopeField(body, 'has_more') === true ? ' has_more=true.' : '';
  const handles = formatRecordEnvelopeHandles(body);
  if (records.length === 0) {
    return `${label}: 0 record(s).${handles}`;
  }
  const shown = Math.min(records.length, RECORD_PREVIEW_LIMIT);
  const lines = [`${label}: ${records.length} record(s).${hasMore}${handles} Showing up to ${shown}:`];
  const contentCeiling = RECORD_PREVIEW_CHAR_LIMIT - RECORD_PREVIEW_FOOTER_RESERVE;
  let used = lines[0].length;
  let truncated = false;
  for (const [index, record] of records.slice(0, RECORD_PREVIEW_LIMIT).entries()) {
    const prefix = `record[${index}] `;
    const budget = contentCeiling - used - prefix.length - 1;
    if (budget < RECORD_PREVIEW_MIN_RECORD_CHARS) {
      truncated = true;
      break;
    }
    const rendered = `${prefix}${truncateText(stableInlineJson(record), budget)}`;
    lines.push(rendered);
    used += rendered.length + 1;
  }
  if (truncated) {
    lines.push(RECORD_PREVIEW_TRUNCATED_MARKER);
  } else if (records.length > RECORD_PREVIEW_LIMIT) {
    lines.push(`more_records=${records.length - RECORD_PREVIEW_LIMIT}; machine envelope in structuredContent.data`);
  }
  return lines.join('\n');
}

function formatRecordEnvelopeHandles(body) {
  const parts = [];
  const nextCursor = envelopeStringField(body, 'next_cursor');
  const nextChangesSince = envelopeStringField(body, 'next_changes_since');
  if (nextCursor) parts.push(`next_cursor=${formatScalar(nextCursor)}`);
  if (nextChangesSince) parts.push(`next_changes_since=${formatScalar(nextChangesSince)}`);
  const count = envelopeCount(body);
  if (count) parts.push(`count=${count}`);
  return parts.length > 0 ? ` ${parts.join(' ')}.` : '';
}

function extractRecordRows(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.records)) return body.records;
  if (Array.isArray(body.data)) return body.data;
  if (body.data && typeof body.data === 'object' && Array.isArray(body.data.records)) {
    return body.data.records;
  }
  return [];
}

function summarizeStreamsDiscovery(body, label) {
  const streams = extractListRows(body);
  if (streams.length === 0) {
    return `${label}: 0 stream(s)`;
  }

  const lines = streams
    .slice(0, DISCOVERY_STREAM_SUMMARY_LIMIT)
    .map((stream) => formatStreamListSummary(stream));
  if (streams.length > DISCOVERY_STREAM_SUMMARY_LIMIT) {
    lines.push(`more_streams=${streams.length - DISCOVERY_STREAM_SUMMARY_LIMIT}`);
  }
  return `${label}: ${streams.length} stream(s)\n${lines.join('\n')}`;
}

// When the package-level schema spans many streams, the per-field flag segment
// (`fields=...`) per stream dominates the text summary and pushes it into tens
// of KB — the same token-budget problem the structured compaction solves. Field
// flags are emitted in the text only when the document is scoped to a stream
// (the `schema(stream, connection_id?)` discovery middle step). For multi-stream package
// summaries the text lists streams + connection + connector_key and points the
// agent at `schema(stream, connection_id?)` for per-field capability flags.
// Callers can force inclusion via `includeFieldDetail`.
function summarizeSchemaDiscovery(body, label, { includeFieldDetail, connectionId } = {}) {
  const schema = unwrapSchemaBody(body);
  const streamRefs = extractSchemaStreamRefs(schema);
  const connectorCount = extractSchemaConnectors(schema).length || numberValue(schema?.connector_count) || 0;

  if (streamRefs.length === 0) {
    const streamNames = extractSchemaStreamNames(schema);
    if (streamNames.length > 0) {
      return `${label}: connectors=${connectorCount} streams=${streamNames.length}\n${streamNames
        .slice(0, DISCOVERY_STREAM_SUMMARY_LIMIT)
        .map((name) => `stream name=${formatScalar(name)}`)
        .join('\n')}`;
    }
    return `${label}: connectors=${connectorCount} streams=0`;
  }

  const withFields = includeFieldDetail ?? streamRefs.length <= 1;
  const indexLines = streamRefs.length > DISCOVERY_STREAM_SUMMARY_LIMIT
    ? formatSchemaStreamIndex(streamRefs)
    : [];
  const legendLines = withFields ? [formatFieldCapabilityLegend()] : [];
  const scopedLines = connectionId ? [`schema_scope connection_id=${formatScalar(connectionId)}`] : [];
  const lines = streamRefs
    .slice(0, DISCOVERY_STREAM_SUMMARY_LIMIT)
    .map(({ stream, connector }) => formatSchemaStreamSummary(stream, connector, { includeFieldDetail: withFields }));
  if (streamRefs.length > DISCOVERY_STREAM_SUMMARY_LIMIT) {
    lines.push(`more_streams=${streamRefs.length - DISCOVERY_STREAM_SUMMARY_LIMIT}`);
  }
  const hint = withFields
    ? ''
    : '\ncall schema(stream, connection_id?) for per-field capability flags (filter/sort/expand/fields/count/aggregate)';
  return `${label}: connectors=${connectorCount} streams=${streamRefs.length}\n${[
    ...legendLines,
    ...scopedLines,
    ...indexLines,
    ...lines,
  ].join('\n')}${hint}`;
}

function formatFieldCapabilityLegend() {
  return 'field_capability_legend t=declared_type eq=exact_filter r=range_filter_ops lex=lexical_search sem=semantic_search a=aggregation_caps g=false=not_granted';
}

function formatSchemaStreamIndex(streamRefs) {
  const byConnector = new Map();
  for (const { stream, connector } of streamRefs) {
    const connectorKey = connectorKeyFor(stream, connector) || 'unknown';
    const name = streamName(stream);
    if (!name) continue;
    if (!byConnector.has(connectorKey)) {
      byConnector.set(connectorKey, []);
    }
    const names = byConnector.get(connectorKey);
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return [...byConnector.entries()].map(([connectorKey, names]) =>
    `stream_index connector_key=${formatScalar(connectorKey)} stream_count=${names.length} streams=${names.map(formatInlineValue).join('|')}`,
  );
}

function extractListRows(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.data)) return body.data;
  if (Array.isArray(body.streams)) return body.streams;
  if (body.data && typeof body.data === 'object' && Array.isArray(body.data.streams)) {
    return body.data.streams;
  }
  return [];
}

function unwrapSchemaBody(body) {
  if (!body || typeof body !== 'object') return {};
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    const data = body.data;
    if (
      Array.isArray(data.connectors) ||
      Array.isArray(data.streams) ||
      Array.isArray(data.granted_connections) ||
      data.object === 'schema'
    ) {
      return data;
    }
  }
  return body;
}

function extractSchemaConnectors(schema) {
  return Array.isArray(schema?.connectors) ? schema.connectors.filter((item) => item && typeof item === 'object') : [];
}

function extractSchemaStreamRefs(schema) {
  const connectors = extractSchemaConnectors(schema);
  if (connectors.length > 0) {
    return connectors.flatMap((connector) => {
      const streams = Array.isArray(connector.streams) ? connector.streams : [];
      return streams.map((stream) => ({ stream, connector }));
    });
  }
  const streams = Array.isArray(schema?.streams) ? schema.streams : [];
  return streams
    .filter((stream) => stream && typeof stream === 'object')
    .map((stream) => ({ stream, connector: null }));
}

function extractSchemaStreamNames(schema) {
  const streams = Array.isArray(schema?.streams) ? schema.streams : [];
  return streams
    .map((stream) => streamName(stream))
    .filter(Boolean);
}

function formatStreamListSummary(stream) {
  const source = objectValue(stream?.source);
  const name = streamName(stream) || 'unknown';
  const connectionId = firstString(
    stream?.connection_id,
    stream?.connector_instance_id,
    source?.connection_id,
  );
  const connectorKey = connectorKeyFor(stream, null);
  const displayName = firstString(
    stream?.display_name,
    stream?.connection_display_name,
    source?.display_name,
    stream?.connector_display_name,
  );
  const parts = [
    `stream name=${formatScalar(name)}`,
    `connection_id=${formatScalar(connectionId)}`,
    `connector_key=${formatScalar(connectorKey)}`,
    `display_name=${formatScalar(displayName)}`,
  ];
  const recordCount = numberValue(stream?.record_count);
  if (recordCount !== null) {
    parts.push(`record_count=${recordCount}`);
  }
  return parts.join(' ');
}

function formatSchemaStreamSummary(stream, connector, { includeFieldDetail = true } = {}) {
  const name = streamName(stream) || 'unknown';
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
    parts.push(`fields=${formatFieldCapabilities(stream?.field_capabilities)}`);
    const aggregations = formatAggregationCapabilities(stream?.field_capabilities);
    if (aggregations !== 'none') {
      parts.push(`aggregations=${aggregations}`);
    }
  }
  return parts.join(' ');
}

function streamName(stream) {
  if (typeof stream === 'string' && stream.length > 0) return stream;
  return firstString(stream?.name, stream?.stream, stream?.stream_name, stream?.streamName);
}

function connectorKeyFor(stream, connector) {
  const streamSource = objectValue(stream?.source);
  const connectorSource = objectValue(connector?.source);
  return firstString(
    stream?.connector_key,
    stream?.connector_id,
    streamSource?.connector_key,
    streamSource?.connector_id,
    streamSource?.id,
    connector?.connector_key,
    connector?.connector_id,
    connectorSource?.connector_key,
    connectorSource?.connector_id,
    connectorSource?.id,
  );
}

function displayNameFor(stream, connector) {
  const streamSource = objectValue(stream?.source);
  const connectorSource = objectValue(connector?.source);
  return firstString(
    stream?.display_name,
    stream?.connection_display_name,
    streamSource?.display_name,
    connector?.display_name,
    connectorSource?.display_name,
    connector?.connector_display_name,
    stream?.connector_display_name,
  );
}

function grantedConnectionsFor(stream, connector) {
  const explicit = Array.isArray(stream?.granted_connections) ? stream.granted_connections : [];
  if (explicit.length > 0) {
    return explicit.filter((connection) => connection && typeof connection === 'object');
  }
  const shared = Array.isArray(connector?.granted_connections) ? connector.granted_connections : [];
  if (shared.length > 0) {
    return shared.filter((connection) => connection && typeof connection === 'object');
  }

  const source = objectValue(stream?.source);
  const connectionId = firstString(stream?.connection_id, stream?.connector_instance_id, source?.connection_id);
  if (!connectionId) return [];
  return [
    {
      connection_id: connectionId,
      display_name: firstString(stream?.display_name, source?.display_name),
      connector_key: connectorKeyFor(stream, null),
    },
  ];
}

function formatConnections(connections) {
  if (!connections || connections.length === 0) return 'none';
  const rendered = connections
    .slice(0, DISCOVERY_CONNECTION_SUMMARY_LIMIT)
    .map((connection) => {
      const id = firstString(connection?.connection_id, connection?.connector_instance_id);
      const displayName = firstString(connection?.display_name, connection?.name);
      const connectorKey = firstString(connection?.connector_key, connection?.connector_id, objectValue(connection?.source)?.connector_key);
      const parts = [`connection_id:${formatInlineValue(id)}`];
      if (displayName) parts.push(`display_name:${formatInlineValue(displayName)}`);
      if (connectorKey) parts.push(`connector_key:${formatInlineValue(connectorKey)}`);
      return `{${parts.join(',')}}`;
    });
  if (connections.length > DISCOVERY_CONNECTION_SUMMARY_LIMIT) {
    rendered.push(`more:${connections.length - DISCOVERY_CONNECTION_SUMMARY_LIMIT}`);
  }
  return rendered.join('|');
}

function formatFieldCapabilities(fieldCapabilities) {
  const entries = fieldCapabilityEntries(fieldCapabilities);
  if (entries.length === 0) return 'none';

  const rendered = entries
    .slice(0, DISCOVERY_FIELD_SUMMARY_LIMIT)
    .map(([field, capabilities]) => `${formatFieldName(field)}[${formatFieldCapabilityFlags(capabilities)}]`);
  if (entries.length > DISCOVERY_FIELD_SUMMARY_LIMIT) {
    rendered.push(`more:${entries.length - DISCOVERY_FIELD_SUMMARY_LIMIT}`);
  }
  return rendered.join(';');
}

function fieldCapabilityEntries(fieldCapabilities) {
  if (!fieldCapabilities || typeof fieldCapabilities !== 'object') return [];
  if (Array.isArray(fieldCapabilities)) {
    return fieldCapabilities
      .map((entry) => {
        const name = firstString(entry?.name, entry?.field, entry?.path);
        return name ? [name, entry] : null;
      })
      .filter(Boolean);
  }
  return Object.entries(fieldCapabilities);
}

function formatFieldCapabilityFlags(capabilities) {
  if (typeof capabilities === 'string' && capabilities.length > 0) return capabilities;
  if (!capabilities || typeof capabilities !== 'object') return 'declared';
  if (typeof capabilities.flags === 'string' && capabilities.flags.length > 0) return capabilities.flags;
  const flags = [];
  const schema = objectValue(capabilities.schema);
  const type = firstString(capabilities.type, schemaType(schema));
  if (type) flags.push(`t=${formatInlineValue(type)}`);
  if (capabilities.granted === false) {
    flags.push('g=false');
  }
  addCapabilityFlag(flags, 'eq', capabilities.exact_filter);
  addRangeCapabilityFlag(flags, capabilities.range_filter);
  addCapabilityFlag(flags, 'lex', capabilities.lexical_search);
  addCapabilityFlag(flags, 'sem', capabilities.semantic_search);
  addAggregationCapabilityFlags(flags, capabilities.aggregation);
  return flags.length > 0 ? flags.join(',') : 'declared';
}

function addCapabilityFlag(flags, name, capability) {
  if (!capability || typeof capability !== 'object') return;
  if (capability.usable === true) {
    flags.push(name);
  } else if (capability.declared === true && capability.usable === false) {
    flags.push(`${name}=unusable${reasonSuffix(capability.reason)}`);
  }
}

function addRangeCapabilityFlag(flags, capability) {
  if (!capability || typeof capability !== 'object') return;
  const operators = Array.isArray(capability.operators) && capability.operators.length > 0
    ? capability.operators.join('|')
    : null;
  if (capability.usable === true) {
    flags.push(operators ? `r=${formatInlineValue(operators)}` : 'r');
  } else if (capability.declared === true && capability.usable === false) {
    flags.push(`r=unusable${reasonSuffix(capability.reason)}`);
  }
}

function addAggregationCapabilityFlags(flags, aggregation) {
  if (!aggregation || typeof aggregation !== 'object') return;
  const usable = orderedAggregationKinds(Object.entries(aggregation)
    .filter(([, capability]) => capability && typeof capability === 'object' && capability.usable === true)
    .map(([name]) => name));
  if (usable.length > 0) {
    flags.push(`a=${formatInlineValue(usable.join('|'))}`);
  }
}

const AGGREGATION_SUMMARY_KINDS = ['count_distinct', 'group_by', 'group_by_time', 'sum', 'min', 'max'];
const AGGREGATION_FIELD_SUMMARY_LIMIT = 12;

function formatAggregationCapabilities(fieldCapabilities) {
  const entries = fieldCapabilityEntries(fieldCapabilities);
  if (entries.length === 0) return 'none';
  const byKind = new Map(AGGREGATION_SUMMARY_KINDS.map((kind) => [kind, []]));
  for (const [field, capabilities] of entries) {
    for (const kind of aggregationKindsForField(capabilities)) {
      if (byKind.has(kind)) {
        byKind.get(kind).push(formatFieldName(field));
      }
    }
  }
  const parts = [];
  for (const kind of AGGREGATION_SUMMARY_KINDS) {
    const fields = byKind.get(kind) || [];
    if (fields.length === 0) continue;
    const shown = fields.slice(0, AGGREGATION_FIELD_SUMMARY_LIMIT);
    const more = fields.length > AGGREGATION_FIELD_SUMMARY_LIMIT ? `|more:${fields.length - AGGREGATION_FIELD_SUMMARY_LIMIT}` : '';
    parts.push(`${kind}=${shown.join('|')}${more}`);
  }
  return parts.length > 0 ? parts.join(';') : 'none';
}

function aggregationKindsForField(capabilities) {
  if (typeof capabilities === 'string') return aggregationKindsFromFlags(capabilities);
  if (!capabilities || typeof capabilities !== 'object') return [];
  if (typeof capabilities.flags === 'string') return aggregationKindsFromFlags(capabilities.flags);
  const aggregation = objectValue(capabilities.aggregation);
  if (!aggregation) return [];
  return orderedAggregationKinds(Object.entries(aggregation)
    .filter(([, capability]) => capability && typeof capability === 'object' && capability.usable === true)
    .map(([kind]) => kind));
}

function aggregationKindsFromFlags(flags) {
  const match = /(?:^|,)a=([^,]+)/.exec(flags);
  if (!match) return [];
  return orderedAggregationKinds(match[1].split('|').map((part) => part.trim()).filter(Boolean));
}

function orderedAggregationKinds(kinds) {
  const seen = new Set(kinds);
  return [
    ...AGGREGATION_SUMMARY_KINDS.filter((kind) => seen.has(kind)),
    ...kinds.filter((kind) => !AGGREGATION_SUMMARY_KINDS.includes(kind)),
  ];
}

function reasonSuffix(reason) {
  return typeof reason === 'string' && reason.length > 0 ? `:${reason}` : '';
}

function schemaType(schema) {
  if (!schema || typeof schema !== 'object') return undefined;
  if (typeof schema.type === 'string') return schema.type;
  if (Array.isArray(schema.type)) return schema.type.filter((item) => typeof item === 'string').join('|') || undefined;
  return undefined;
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatScalar(value) {
  return value === undefined || value === null ? 'null' : JSON.stringify(String(value));
}

function formatInlineValue(value) {
  if (value === undefined || value === null) return 'null';
  return String(value).replace(/[;,\[\]{}]/g, '_').replace(/\s+/g, '_');
}

function formatFieldName(value) {
  return String(value).replace(/[;,\[\]{}]/g, '_');
}

function stableInlineJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify(String(value));
  }
}

function truncateText(value, limit) {
  const safeLimit = Math.max(0, limit);
  if (value.length <= safeLimit) return value;
  if (safeLimit <= 1) return '…';
  return `${value.slice(0, safeLimit - 1)}…`;
}

const SEARCH_TEXT_PREVIEW_LIMIT = 3;
const SEARCH_TEXT_SNIPPET_CHAR_LIMIT = 140;
const SEARCH_RESULT_SNIPPET_CHAR_LIMIT = 320;

function summarizeSearch(body, results) {
  const hasMore = envelopeField(body, 'has_more') === true ? ' has_more=true.' : '';
  const nextCursor = envelopeStringField(body, 'next_cursor');
  const cursorText = nextCursor ? ` next_cursor=${formatScalar(nextCursor)}.` : '';
  const sourceMixText = formatSearchSourceMix(body);
  const previews = results.slice(0, SEARCH_TEXT_PREVIEW_LIMIT).map(formatSearchPreviewLine);
  const previewText = previews.length > 0 ? ` Top results:\n${previews.join('\n')}` : '';
  const fetchHint = previews.length > 0
    ? '\nFetch a hit with `fetch` using the shown id; include connection_id when shown.'
    : '';
  return `search: ${results.length} hit(s).${hasMore}${cursorText}${sourceMixText}${previewText}${fetchHint} Search envelope metadata: structuredContent.data; flattened results: structuredContent.results.`;
}

function formatSearchSourceMix(body) {
  const sourceMix = body?.meta?.package?.source_mix;
  if (!Array.isArray(sourceMix) || sourceMix.length === 0) return '';
  const rendered = sourceMix
    .slice(0, 8)
    .map((entry) => {
      const parts = [
        `connection_id:${formatInlineValue(entry?.connection_id)}`,
        `connector_key:${formatInlineValue(entry?.connector_key)}`,
        `count:${formatInlineValue(entry?.count)}`,
      ];
      if (entry?.display_name) parts.push(`display_name:${formatInlineValue(entry.display_name)}`);
      return `{${parts.join(',')}}`;
    });
  if (sourceMix.length > 8) rendered.push(`more:${sourceMix.length - 8}`);
  return ` source_mix=${rendered.join('|')}.`;
}

function formatSearchPreviewLine(result, index) {
  const parts = [`${index + 1}. id=${formatInlineValue(truncateText(result.id, 80))}`];
  if (result.connection_id) parts.push(`connection_id=${formatInlineValue(truncateText(result.connection_id, 80))}`);
  if (result.connector_key) parts.push(`connector_key=${formatInlineValue(truncateText(result.connector_key, 60))}`);
  if (result.stream) parts.push(`stream=${formatInlineValue(truncateText(result.stream, 60))}`);
  if (result.title && result.title !== result.id) parts.push(`title=${formatScalar(truncateText(result.title, 80))}`);
  if (result.display_name) parts.push(`display_name=${formatScalar(truncateText(result.display_name, 60))}`);
  if (result.snippet) parts.push(`snippet=${formatScalar(truncateText(result.snippet, SEARCH_TEXT_SNIPPET_CHAR_LIMIT))}`);
  return parts.join(' ');
}

function envelopeField(body, field) {
  if (!body || typeof body !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(body, field)) return body[field];
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    return body.data[field];
  }
  return undefined;
}

function envelopeStringField(body, field) {
  const value = envelopeField(body, field);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function envelopeCount(body) {
  const meta = objectValue(envelopeField(body, 'meta'));
  const count = objectValue(meta?.count);
  if (!count) return null;
  const kind = firstString(count.kind, count.type);
  const value = count.value ?? count.count ?? count.total;
  if (kind && value !== undefined && value !== null) return `${formatInlineValue(kind)}:${formatInlineValue(value)}`;
  if (kind) return formatInlineValue(kind);
  if (value !== undefined && value !== null) return formatInlineValue(value);
  return null;
}

function normalizeSearchResults(body) {
  const candidates = searchCandidatesFromBody(body);
  return candidates.map((hit, index) => {
    const id = resultIdForHit(hit, index);
    const source = objectValue(hit?.source) || {};
    const stream = streamForHit(hit);
    const recordKey = recordKeyForHit(hit);
    const connectionId = firstString(hit?.connection_id, hit?.connector_instance_id, source.connection_id);
    const displayName = firstString(hit?.display_name, source.display_name);
    const connectorKey = firstString(hit?.connector_key, hit?.connector_id, source.connector_key, source.connector_id);
    const snippet = snippetForSearchHit(hit);
    const normalized = {
      id,
      title: titleForSearchHit(hit, id, { stream, recordKey, connectionId, displayName, connectorKey }),
      url: urlForRecord(hit, id),
    };
    if (stream) normalized.stream = stream;
    if (recordKey) normalized.record_key = recordKey;
    if (connectionId) normalized.connection_id = connectionId;
    if (displayName) normalized.display_name = displayName;
    if (connectorKey) normalized.connector_key = connectorKey;
    if (snippet) normalized.snippet = truncateText(snippet, SEARCH_RESULT_SNIPPET_CHAR_LIMIT);
    return normalized;
  });
}

function searchCandidatesFromBody(body) {
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.results)) return body.results;
  if (Array.isArray(body.hits)) return body.hits;
  if (Array.isArray(body.data)) return body.data;
  if (body.data && typeof body.data === 'object' && Array.isArray(body.data.results)) return body.data.results;
  if (body.data && typeof body.data === 'object' && Array.isArray(body.data.data)) return body.data.data;
  return [];
}

function requestedSearchLimit(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return Math.min(value, 100);
  }
  return 25;
}

function compactSearchEnvelope(body, { resultCount } = {}) {
  if (!body || typeof body !== 'object') return body;
  if (Array.isArray(body)) {
    return { object: 'list', results_ref: 'structuredContent.results', result_count: resultCount ?? body.length };
  }
  const out = { ...body };
  if (Array.isArray(out.results)) {
    out.result_count = resultCount ?? out.results.length;
    delete out.results;
    out.results_ref = 'structuredContent.results';
  }
  if (Array.isArray(out.hits)) {
    out.result_count = resultCount ?? out.hits.length;
    delete out.hits;
    out.results_ref = 'structuredContent.results';
  }
  if (Array.isArray(out.data)) {
    out.result_count = resultCount ?? out.data.length;
    delete out.data;
    out.results_ref = 'structuredContent.results';
  } else if (out.data && typeof out.data === 'object') {
    out.data = compactSearchEnvelopeDataObject(out.data, { resultCount });
  }
  return out;
}

function compactSearchEnvelopeDataObject(data, { resultCount } = {}) {
  const out = { ...data };
  if (Array.isArray(out.results)) {
    out.result_count = resultCount ?? out.results.length;
    delete out.results;
    out.results_ref = 'structuredContent.results';
  }
  if (Array.isArray(out.hits)) {
    out.result_count = resultCount ?? out.hits.length;
    delete out.hits;
    out.results_ref = 'structuredContent.results';
  }
  if (Array.isArray(out.data)) {
    out.result_count = resultCount ?? out.data.length;
    delete out.data;
    out.results_ref = 'structuredContent.results';
  }
  return out;
}

function resultIdForHit(hit, index) {
  const directId = stringValue(hit?.result_id ?? hit?.resultId);
  if (directId) return directId;

  const stream = streamForHit(hit);
  const recordId = stringValue(hit?.id ?? hit?.record_id ?? hit?.recordId ?? hit?.record_key ?? hit?.recordKey);
  if (stream && recordId) {
    return `${stream}:${recordId}`;
  }

  const fallback = stringValue(hit?.id ?? hit?.url);
  return fallback || `result:${index + 1}`;
}

function streamForHit(hit) {
  return firstString(hit?.stream, hit?.stream_name, hit?.streamName);
}

function recordKeyForHit(hit) {
  return firstString(hit?.record_key, hit?.recordKey, hit?.record_id, hit?.recordId, hit?.id);
}

function snippetForSearchHit(hit) {
  const snippet = objectValue(hit?.snippet);
  return firstString(
    snippet?.text,
    typeof hit?.snippet === 'string' ? hit.snippet : undefined,
    hit?.snippet_text,
    hit?.summary,
    hit?.text,
  );
}

function parseRecordResultId(id) {
  const value = requireSafeName(id, 'id');
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error('id must use stream:record_id format');
  }
  return {
    stream: requireSafeName(value.slice(0, separator), 'stream'),
    recordId: requireSafeName(value.slice(separator + 1), 'record_id'),
  };
}

function normalizeFetchedDocument(record, requestedId, providerUrl) {
  const payload = objectValue(record?.data);
  const id =
    stringValue(record?.id ?? record?.record_id ?? record?.recordId) ||
    stringValue(payload?.id ?? payload?.record_id ?? payload?.recordId) ||
    requestedId;
  const stream =
    stringValue(record?.stream ?? record?.stream_name ?? record?.streamName) ||
    stringValue(payload?.stream ?? payload?.stream_name ?? payload?.streamName);
  const resultId = stream && id && !requestedId.includes(':') ? `${stream}:${id}` : requestedId;
  const title = titleForFetchedRecord(record, payload, resultId);
  const text = textForFetchedRecord(record, payload);
  const url = urlForFetchedRecord(record, payload, resultId, providerUrl);
  const metadata = metadataForRecord(record, { id: resultId, title, url });
  return { id: resultId, title, text, url, metadata };
}

function titleForFetchedRecord(record, payload, fallbackId) {
  const payloadTitle = payload ? titleForRecord(payload, '') : '';
  return payloadTitle || titleForRecord(record, '') || titleFromSourceIdentity(record, payload, fallbackId);
}

function titleForRecord(record, fallbackId) {
  return (
    stringValue(record?.title) ||
    stringValue(record?.name) ||
    stringValue(record?.subject) ||
    stringValue(record?.summary) ||
    fallbackId
  );
}

function titleForSearchHit(record, fallbackId, source = {}) {
  const explicit = titleForRecord(record, '');
  if (explicit) return explicit;
  const timestamp = titleTimestampForRecord(record);
  const label = source.displayName || source.connectorKey || source.connectionId;
  const parts = [label, source.stream, timestamp].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : fallbackId;
}

function titleFromSourceIdentity(record, payload, fallbackId) {
  const source = objectValue(record?.source) || objectValue(payload?.source) || {};
  const label = firstString(
    record?.display_name,
    payload?.display_name,
    record?.connector_key,
    payload?.connector_key,
    record?.connector_id,
    payload?.connector_id,
    source.display_name,
    source.connector_key,
    source.connector_id,
    source.connection_id,
  );
  const stream = firstString(record?.stream, record?.stream_name, payload?.stream, payload?.stream_name, source.stream);
  const timestamp = titleTimestampForRecord(payload) || titleTimestampForRecord(record);
  const parts = [label, stream, timestamp].filter(Boolean);
  return parts.length > 0 ? parts.join(' / ') : fallbackId;
}

function titleTimestampForRecord(record) {
  const nested = [
    objectValue(record?.data),
    objectValue(record?.record),
    objectValue(record?.metadata),
    objectValue(record?.source),
  ].filter(Boolean);
  const authored = firstString(
    record?.sent_at,
    record?.sentAt,
    record?.authored_at,
    record?.authoredAt,
    record?.created_at,
    record?.createdAt,
    record?.source_created_at,
    record?.sourceCreatedAt,
    record?.occurred_at,
    record?.occurredAt,
    record?.updated_at,
    record?.updatedAt,
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
    ]),
  );
  if (authored) return authored;
  return firstString(
    record?.emitted_at,
    record?.emittedAt,
    ...nested.flatMap((value) => [
      value.emitted_at,
      value.emittedAt,
    ]),
  );
}

function textForFetchedRecord(record, payload) {
  const declared = (payload ? declaredTextForRecord(payload) : undefined) || declaredTextForRecord(record);
  if (declared) return declared;
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
  '… [record has no text/content/body/summary field; use query_records or fetch(fields) for structured records]';

function textForRecord(record) {
  const declared = declaredTextForRecord(record);
  if (declared) return declared;
  return fallbackTextForRecord(record);
}

function declaredTextForRecord(record) {
  return (
    stringValue(record?.text) ||
    stringValue(record?.content) ||
    stringValue(record?.body) ||
    stringValue(record?.summary)
  );
}

function fallbackTextForRecord(record) {
  const serialized = JSON.stringify(record, null, 2);
  if (serialized.length <= FETCH_TEXT_FALLBACK_CHAR_LIMIT) return serialized;
  const head = FETCH_TEXT_FALLBACK_CHAR_LIMIT - FETCH_TEXT_FALLBACK_POINTER.length;
  return `${serialized.slice(0, Math.max(0, head))}${FETCH_TEXT_FALLBACK_POINTER}`;
}

function urlForFetchedRecord(record, payload, fallbackId, providerUrl) {
  const directUrl = firstString(
    payload?.url,
    payload?.record_url,
    payload?.recordUrl,
    payload?.href,
    payload?.source_url,
    payload?.sourceUrl,
    record?.url,
    record?.record_url,
    record?.recordUrl,
    record?.href,
    record?.source_url,
    record?.sourceUrl,
  );
  if (directUrl) return directUrl;
  return urlForRecord(record, fallbackId, providerUrl);
}

function urlForRecord(record, fallbackId, providerUrl) {
  const directUrl = stringValue(record?.url ?? record?.record_url ?? record?.recordUrl ?? record?.href ?? record?.source_url ?? record?.sourceUrl);
  if (directUrl) return directUrl;
  if (providerUrl && fallbackId) {
    const recordRef = parseRecordResultIdOrNull(fallbackId);
    if (recordRef) {
      const base = providerUrl.replace(/\/$/, '');
      return `${base}/v1/streams/${encodeURIComponent(recordRef.stream)}/records/${encodeURIComponent(recordRef.recordId)}`;
    }
  }
  return `pdpp://record/${encodeURIComponent(fallbackId)}`;
}

function parseRecordResultIdOrNull(id) {
  try {
    return parseRecordResultId(id);
  } catch {
    return null;
  }
}

function metadataForRecord(record, omitted) {
  if (!record || typeof record !== 'object') {
    return {};
  }
  const metadata = {};
  if (record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)) {
    for (const [key, value] of Object.entries(record.metadata)) {
      if (isDocumentMetadataValue(value)) metadata[key] = value;
    }
  }
  const payload = objectValue(record.data);
  if (payload) {
    for (const key of [
      'stream',
      'stream_name',
      'streamName',
      'connection_id',
      'connector_key',
      'connector_id',
      'display_name',
    ]) {
      if (metadata[key] === undefined && payload[key] !== undefined) {
        metadata[key] = payload[key];
      }
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (['metadata', 'data', 'text', 'content', 'body'].includes(key)) continue;
    if (isOmittedDocumentField(key, value, omitted)) continue;
    if (!FETCH_METADATA_RECORD_KEYS.has(key)) continue;
    if (!isDocumentMetadataValue(value)) continue;
    metadata[key] = value;
  }
  return metadata;
}

function isOmittedDocumentField(key, value, omitted) {
  if (['id', 'record_id', 'recordId'].includes(key)) return value === omitted.id;
  if (key === 'title') return value === omitted.title;
  if (['url', 'record_url', 'recordUrl', 'href', 'source_url', 'sourceUrl'].includes(key)) return value === omitted.url;
  return false;
}

const FETCH_METADATA_RECORD_KEYS = new Set([
  'object',
  'id',
  'record_id',
  'recordId',
  'stream',
  'stream_name',
  'streamName',
  'connection_id',
  'connector_key',
  'connector_id',
  'display_name',
  'emitted_at',
  'emittedAt',
  'sent_at',
  'sentAt',
  'created_at',
  'createdAt',
  'updated_at',
  'updatedAt',
]);

function isDocumentMetadataValue(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function errorToolResult(response, providerUrl) {
  const error = response.error ?? {
    type: 'rs_error',
    code: `http_${response.status}`,
    message: `Resource server returned HTTP ${response.status}`,
  };
  return {
    isError: true,
    content: [
      {
        type: 'text',
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
};
