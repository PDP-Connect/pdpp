import { z } from 'zod';

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

// Mirror of the REST public read query-param vocabulary. Forwarded verbatim
// to the RS; the MCP layer never silently drops a member. `sort` and `count`
// are canonical public read primitives advertised by `GET /v1/schema`; the
// reference RS does not implement them yet and will return a typed
// `unsupported_query` (400) error when they are forwarded. That is the
// honest mirror posture defined by
//   openspec/changes/canonicalize-public-read-contract
// (5.1 MCP input schemas mirror canonical args; 5.4 MCP does not silently
// drop unsupported arguments that REST would reject).
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
  // Deprecated wire alias for `connection_id`. Forwarded unchanged so a
  // pre-migration client can still address a specific connection while
  // downstream consumers adopt the canonical field.
  'connector_instance_id',
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
  'connector_instance_id',
]);

const CONNECTION_ID_DESCRIPTION =
  'Optional connection_id from a prior list_streams response or typed `available_connections` error envelope. Omit to fan in across every connection your grant authorizes for the named stream; pass it to scope the call to one account/device/profile. Required to recover from a typed `ambiguous_connection` (409) error returned by `fetch`, `fetch_blob`, or package-token event-subscription creation — the error envelope lists candidate `available_connections` entries with current-authorization `grant_id`, `connector_key`, `connection_id`, and optional `display_name`, and instructs you to retry with `connection_id`. Persist `connection_id`, not `grant_id`, for source disambiguation across reconnects or reauthorization; `grant_id` identifies the current grant and can change when the owner reconnects. Granted connection identities and canonical connector-type metadata are advertised by `GET /v1/schema`.';

const CONNECTOR_INSTANCE_ID_DESCRIPTION =
  'Deprecated wire alias for `connection_id`. Accepted only for pre-migration compatibility — new clients SHOULD pass `connection_id` instead and ignore this field on the response.';

const LIMIT_DESCRIPTION =
  'Records per page. Omit for the default page of 25; the maximum is 100 (the spec-core §8 contract). Values above 100 are rejected here rather than silently clamped, so the page size you request is always the page size you get. Page forward with the returned `cursor` instead of asking for a larger page.';

const SEARCH_LIMIT_DESCRIPTION =
  'Hits per page. Omit for the default page of 25; the maximum is 100 — the bound the published `/v1/search`, `/v1/search/semantic`, and `/v1/search/hybrid` contract declares and every mode honors (mirrored as `capabilities.{lexical,semantic,hybrid}_retrieval.max_limit` in `/.well-known/oauth-protected-resource` and `GET /v1/schema`). Values above 100 are rejected here rather than forwarded to be silently clamped by the RS, so the page size you request is always the page size you get. Page forward with the returned `cursor` (lexical and semantic page; hybrid does not) instead of asking for a larger page.';

const FIELDS_DESCRIPTION =
  'Field allowlist for projection. Field paths must be declared by the stream; advertised by `GET /v1/schema` (`field_capabilities`). Unknown paths are rejected by the RS rather than silently widened.';

const FILTER_DESCRIPTION =
  'Per-field filter spec, URL-encoded as `filter[field]=value` (exact) or `filter[field][op]=value` (operator). Allowed fields and operators are advertised by `GET /v1/schema` (`field_capabilities`); unsupported fields or operators are rejected by the RS rather than silently ignored. Forwarded verbatim — MCP does not parse the filter shape.';

const EXPAND_DESCRIPTION =
  'One-hop inline expansion list. Each entry is a manifest-declared parent-to-child relation. Expandable relations and per-relation `expand_limit` caps are advertised by `GET /v1/schema` (`expand_capabilities`); unadvertised relations are rejected by the RS.';

const EXPAND_LIMIT_DESCRIPTION =
  'Per-relation cap for has-many expansion, keyed by relation name. The RS clamps to the per-relation `max_limit` advertised by `GET /v1/schema`.';

const ORDER_DESCRIPTION =
  "Page order for the cursor-based pagination primitive: `asc` or `desc`. This is the reference runtime's spelling; the canonical `sort=-field` sign-prefix vocabulary is advertised by `GET /v1/schema` but not yet implemented by the runtime — forwarding `sort` will currently return a typed `unsupported_query` 400.";

const SORT_DESCRIPTION =
  'Canonical sign-prefix sort spec advertised by `GET /v1/schema` (e.g. `sort=-emitted_at,name`). The reference runtime does not yet implement `sort` and will reject it with a typed `unsupported_query` 400; use `order=asc|desc` until `/v1/schema` advertises sortable fields. Forwarded verbatim so MCP does not silently drop a parameter REST would reject.';

const COUNT_DESCRIPTION =
  'Canonical opt-in count grade (`none`, `estimated`, `exact`) advertised by `GET /v1/schema`. The reference runtime does not yet implement counts and will reject with a typed `unsupported_query` 400 if forwarded; consult `/v1/schema` for count support. Forwarded verbatim so MCP does not silently drop a parameter REST would reject.';

const EMPTY_TOOL_INPUT_SCHEMA = z.object({}).strict();

const ConnectionIdInputShape = {
  connection_id: z.string().min(1).describe(CONNECTION_ID_DESCRIPTION).optional(),
  connector_instance_id: z
    .string()
    .min(1)
    .describe(CONNECTOR_INSTANCE_ID_DESCRIPTION)
    .optional(),
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
      'ChatGPT-compatible flattened search results. Each entry carries `id` (default `stream:record_id`), `title`, and `url`. Use `data` for the full canonical envelope.',
    ),
};

const FETCH_OUTPUT_SCHEMA_SHAPE = {
  ...READ_OUTPUT_SCHEMA_SHAPE,
  id: z.string(),
  title: z.string(),
  text: z.string(),
  url: z.string(),
  metadata: z.record(z.string(), z.unknown()),
};

const BLOB_OUTPUT_SCHEMA_SHAPE = {
  provider_url: z.string(),
  request_id: z.string().nullable(),
  bytes_base64: z.string(),
  mime_type: z.string(),
  size: z.number().int().nonnegative(),
};

// Event-subscription envelope is more permissive than READ_OUTPUT_SCHEMA_SHAPE
// because (a) DELETE returns 204 with no body (data: null) and (b) the projected
// subscription row is a plain object, not a list envelope. The MCP wrapper
// validates the wrapper, not the RS body.
const EVENT_SUB_OUTPUT_SCHEMA_SHAPE = {
  data: z.unknown().describe('RS response body. `null` for 204 (delete).'),
  provider_url: z.string(),
  request_id: z.string().nullable(),
  http_status: z.number().int(),
};

// Discovery tool returns the event-subscription capability block from
// `/.well-known/oauth-protected-resource` plus a derived `supported` boolean
// so an MCP client can branch on availability without re-reading the
// advertisement.
const EVENT_SUB_DISCOVERY_OUTPUT_SCHEMA_SHAPE = {
  supported: z
    .boolean()
    .describe('`true` when the protected-resource metadata advertises `capabilities.client_event_subscriptions.supported === true`.'),
  capability: z
    .unknown()
    .describe('The full `capabilities.client_event_subscriptions` block from the RS advertisement, or `null` when unsupported.'),
  data: z.unknown().describe('Full protected-resource metadata body. Source of truth for issuer, supported scopes, and other capabilities.'),
  provider_url: z.string(),
  request_id: z.string().nullable(),
  http_status: z.number().int(),
};

const SUBSCRIPTION_TOOL_FOOTER =
  ' Use event subscriptions when you need low-latency notification of changes from a long-lived receiver; prefer polling via `query_records` with `changes_since` for one-shot reads or short-lived clients. Receivers must be HTTPS endpoints reachable from the configured PDPP instance (http://localhost is permitted only in development). Events are signed per Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`) using the per-subscription secret returned at create. Envelope is CloudEvents 1.0 JSON structured mode (`application/cloudevents+json`); record bodies are never pushed — events carry IDs and a `data.changes_since` cursor that clients pull via `query_records` with `changes_since=<data.changes_since>`. Call `discover_event_subscription_capabilities` for the authoritative supported event types, retry schedule, and signing profile (sourced from `capabilities.client_event_subscriptions` on `/.well-known/oauth-protected-resource`).';

const SUBSCRIPTION_ID_DESCRIPTION =
  'Subscription identifier returned by `create_event_subscription` or `list_event_subscriptions` (prefix `sub_`).';

const CALLBACK_URL_DESCRIPTION =
  'HTTPS receiver URL. `http://localhost` is accepted by the RS for development; everything else must be https. Max 2048 bytes.';

const FILTERS_DESCRIPTION =
  'Optional narrowing of the subscription scope. Streams listed in `filters.streams` must all be inside the bearer\'s grant; the RS rejects unauthorized stream names with a typed `invalid_request` error.';

const SUBSCRIPTION_WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const SUBSCRIPTION_READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const SUBSCRIPTION_DELETE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
};

const DISCOVERY_STREAM_SUMMARY_LIMIT = 50;
const DISCOVERY_FIELD_SUMMARY_LIMIT = 16;
const DISCOVERY_CONNECTION_SUMMARY_LIMIT = 8;

// The `schema` tool's default `structuredContent.data` is a COMPACT projection
// of the RS `/v1/schema` document, not the verbatim body. A real owner's
// grant-scoped schema can exceed 2 MB once every connector advertises
// per-field JSON Schema, so returning it verbatim as the default agent-facing
// payload blows the context budget. The compact projection keeps the discovery
// path `list_streams -> schema(stream) -> query_records` cheap by dropping the
// heavy per-field JSON Schema blobs while preserving the capability flags,
// connection identity, and connector metadata an agent needs to build a query.
// Exhaustive JSON remains available via `detail: "full"`. See:
//   openspec/changes/expose-connection-identity-on-public-read/tasks.md (§7
//   MCP discovery/schema token-efficiency target).
const SCHEMA_DETAIL_DESCRIPTION =
  'Response detail grade for `structuredContent.data`. `compact` (default) returns a token-efficient projection: per-stream field names with capability flags, expandable relation names, connection identities, and connector metadata, with the heavy per-field JSON Schema blobs dropped. `full` returns the exhaustive verbatim `GET /v1/schema` body — opt in only when you need raw JSON Schema for a field. The concise `content[]` text summary is identical for both grades.';

const SCHEMA_STREAM_DESCRIPTION =
  'Optional stream name (as returned by `list_streams`) to scope the schema document to a single stream. Omit to describe every granted stream. Scope to one stream for the cheapest middle step of the `list_streams -> schema(stream) -> query_records` discovery path.';

/**
 * Build the static tool definitions. Descriptions are constant — they are never derived
 * from manifest, stream, or record data. RS payloads are returned as data; nothing is
 * interpolated into instructions to the model.
 */
export function buildTools({ rs, providerUrl }) {
  return [
    {
      name: 'schema',
      title: 'Get PDPP schema',
      description:
        'Return the grant-scoped PDPP schema document from `GET /v1/schema`. This is the canonical capability source: streams, canonical connector-type metadata (`connector_key`), per-field filter operators (`field_capabilities`), expandable relations (`expand_capabilities`), projection support, search modes, pagination support, count support, and granted connection identities (`connection_id`, `display_name`). Defaults to a compact, token-efficient projection (`detail: "compact"`) so the `list_streams -> schema(stream) -> query_records` discovery path stays cheap; pass `detail: "full"` only when you need the exhaustive raw JSON Schema for a field, and pass `stream` to scope to one stream. Call this to discover what filter, sort, expand, fields, count, or connection-disambiguation arguments are valid before issuing other tools. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          detail: z.enum(['compact', 'full']).optional().describe(SCHEMA_DETAIL_DESCRIPTION),
          stream: z.string().min(1).optional().describe(SCHEMA_STREAM_DESCRIPTION),
        })
        .strict(),
      outputSchema: z.object(READ_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const stream = args?.stream ? requireSafeName(args.stream, 'stream') : null;
        const detail = args?.detail === 'full' ? 'full' : 'compact';
        if (detail === 'compact') {
          const compactResponse = await rs.getJson('/v1/schema', {
            query: { view: 'compact', ...(stream ? { stream } : {}) },
          });
          if (compactResponse.ok) {
            return toSchemaToolResult(compactResponse, providerUrl, {
              detail,
              stream,
              alreadyCompact: isCompactSchemaBody(compactResponse.body),
            });
          }
          if (!shouldFallbackFromCompactSchemaRequest(compactResponse)) {
            return toSchemaToolResult(compactResponse, providerUrl, { detail, stream });
          }
        }
        const response = await rs.getJson('/v1/schema');
        return toSchemaToolResult(response, providerUrl, { detail, stream });
      },
    },
    {
      name: 'list_streams',
      title: 'List PDPP streams',
      description:
        'List streams the configured scoped grant can read via `GET /v1/streams`. Multi-connection deployments emit one entry per `(stream, connection_id)`; package-source metadata uses canonical `connector_key` for connector type and each entry carries `connection_id` plus `display_name` when available. Pass `connection_id` to restrict to a single connection. ' +
        CANONICAL_SCHEMA_HINT +
        ' Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z.object(ConnectionIdInputShape).strict(),
      outputSchema: z.object(READ_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const query = pickQuery(args, SUPPORTED_QUERY_KEYS);
        const response = await rs.getJson('/v1/streams', { query });
        return toToolResult(response, providerUrl, 'PDPP streams');
      },
    },
    {
      name: 'query_records',
      title: 'Query PDPP records',
      description:
        'Query records in a stream via `GET /v1/streams/{stream}/records`. Forwards canonical public read args verbatim — MCP does not silently drop a parameter the RS would reject. The page is bounded by default: omitting `limit` returns at most 25 records and `limit` is capped at 100 (the spec-core §8 contract). This tool enforces that cap at input validation, so a `limit` above 100 is rejected here rather than silently clamped; a direct REST client that sends `limit>100` is clamped to 100 and told so via a `limit_clamped` entry in the response `meta.warnings[]`. Either way the page size is never silently surprising. The tool is safe to call before you know a stream is small; page forward with the returned `cursor` and narrow the payload with `fields` (a schema-advertised projection) when records are wide. The `content[]` text summary previews up to the first 5 records within a fixed character budget; the full page stays in `structuredContent.data`. Omitting `connection_id` on a multi-connection grant fans in across granted connections; records carry `connection_id` for attribution and package-source metadata uses canonical `connector_key` for connector type. ' +
        CANONICAL_SCHEMA_HINT +
        ' Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          stream: z.string().min(1).describe('Stream name as returned by `list_streams`.'),
          limit: z.number().int().positive().max(100).optional().describe(LIMIT_DESCRIPTION),
          cursor: z.string().optional(),
          order: z.string().optional().describe(ORDER_DESCRIPTION),
          sort: z.string().optional().describe(SORT_DESCRIPTION),
          count: z.enum(['none', 'estimated', 'exact']).optional().describe(COUNT_DESCRIPTION),
          filter: z.string().optional().describe(FILTER_DESCRIPTION),
          fields: z.array(z.string()).optional().describe(FIELDS_DESCRIPTION),
          view: z.string().optional(),
          expand: z.array(z.string()).optional().describe(EXPAND_DESCRIPTION),
          expand_limit: z
            .record(z.string(), z.number().int().positive())
            .optional()
            .describe(EXPAND_LIMIT_DESCRIPTION),
          changes_since: z.string().optional(),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(READ_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const stream = requireSafeName(args?.stream, 'stream');
        const query = pickQuery(args, SUPPORTED_QUERY_KEYS);
        const response = await rs.getJson(`/v1/streams/${encodeURIComponent(stream)}/records`, {
          query,
        });
        return toToolResult(response, providerUrl, `records from stream "${stream}"`, { previewRecords: true });
      },
    },
    {
      name: 'aggregate',
      title: 'Aggregate PDPP records',
      description:
        'Compute a single-stream grant-safe aggregation via `GET /v1/streams/{stream}/aggregate`. Prefer this over paging `query_records` whenever you only need a count, sum, min/max, distinct count, or a grouped/time-bucketed rollup: it returns small bucket rows, never record bodies, so it answers "how many / how much / grouped by" without pulling pages of records into context. Metrics: `count`, `sum`, `min`, `max`, `count_distinct` (`field` required for all but `count`). Group with exactly one dimension per call — `group_by=<scalar_field>` XOR `group_by_time=<date_field>`; combining them is rejected. `group_by_time` requires `granularity` (`minute|hour|day|week|month|quarter|year`, calendar-aware, weeks start Monday) and accepts an optional IANA `time_zone` (defaults to UTC, echoed in the response). Groupable, time-bucketable, and distinct-able fields are advertised by `GET /v1/schema` (`field_capabilities.*.aggregation`); undeclared or undeclared-for-the-operation fields are rejected by the RS rather than silently ignored. Scalar `group_by` buckets order by count descending then key ascending; `group_by_time` buckets order by bucket start ascending with a single `null` bucket (sorted last) for null/unparseable times. `count_distinct` excludes null and is exact (`approximate: false`). Forwards args verbatim — MCP does not silently drop a parameter the RS would reject. ' +
        CANONICAL_SCHEMA_HINT +
        ' Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          stream: z.string().min(1).describe('Stream name as returned by `list_streams`.'),
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
          filter: z.string().optional().describe(FILTER_DESCRIPTION),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(READ_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const stream = requireSafeName(args?.stream, 'stream');
        const query = pickQuery(args, SUPPORTED_AGGREGATE_QUERY_KEYS);
        const response = await rs.getJson(`/v1/streams/${encodeURIComponent(stream)}/aggregate`, {
          query,
        });
        return toToolResult(response, providerUrl, `aggregation for stream "${stream}"`);
      },
    },
    {
      name: 'search',
      title: 'Search PDPP records',
      description:
        'Search records via `GET /v1/search` (lexical), `/v1/search/semantic`, or `/v1/search/hybrid` per the `mode` argument. Returns the RS search envelope plus ChatGPT-compatible flattened `results`. Hits carry `connection_id` and `display_name`; package-source metadata uses canonical `connector_key` for connector type. Pass `connection_id` to scope, omit to fan in. The page is bounded: omitting `limit` returns at most 25 hits and `limit` is capped at 100 — the bound the published search contract declares and every mode honors (advertised as `capabilities.{lexical,semantic,hybrid}_retrieval.max_limit`). This tool enforces that cap at input validation, so a `limit` above 100 is rejected here rather than forwarded to be silently clamped by the RS. Page forward with the returned `cursor` (lexical and semantic; hybrid does not page) instead of asking for a larger page. Per-mode pagination, filter, and capability support are advertised by `GET /v1/schema` and the protected-resource metadata `capabilities` block. If the deployment does not advertise search, the RS error envelope is preserved in the tool result. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          q: z.string().min(1).describe('Search query string.'),
          streams: z.array(z.string()).optional(),
          limit: z.number().int().positive().max(100).optional().describe(SEARCH_LIMIT_DESCRIPTION),
          cursor: z.string().optional(),
          mode: z.enum(['lexical', 'semantic', 'hybrid']).optional(),
          filter: z.string().optional().describe(FILTER_DESCRIPTION),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(SEARCH_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const path = searchPathForMode(args.mode);
        const query = {
          q: args.q,
          streams: args.streams,
          limit: args.limit,
          cursor: args.cursor,
          filter: args.filter,
          connection_id: args.connection_id,
          connector_instance_id: args.connector_instance_id,
        };
        const response = await rs.getJson(path, { query });
        return toSearchToolResult(response, providerUrl);
      },
    },
    {
      name: 'fetch',
      title: 'Fetch PDPP search result',
      description:
        'Fetch a single ChatGPT-compatible document by a result id returned from `search`. The default id format is `stream:record_id` and is read through `GET /v1/streams/{stream}/records/{record_id}`. When the identifier resolves to more than one connection under your grant and `connection_id` is omitted, the RS returns a typed `ambiguous_connection` (409) error listing `available_connections` entries with current-authorization `grant_id`, canonical `connector_key`, `connection_id`, and optional `display_name`; retry with the chosen `connection_id`. Persist `connection_id`, not `grant_id`, across reconnects. Read-only.',
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
        const query = pickQuery(args, SUPPORTED_QUERY_KEYS);
        const response = await rs.getJson(
          `/v1/streams/${encodeURIComponent(ref.stream)}/records/${encodeURIComponent(ref.recordId)}`,
          { query }
        );
        return toFetchToolResult(response, providerUrl, args.id);
      },
    },
    {
      name: 'discover_event_subscription_capabilities',
      title: 'Discover event subscription capabilities',
      description:
        'Return the reference implementation\'s event-subscription advertisement by fetching `GET /.well-known/oauth-protected-resource` and extracting `capabilities.client_event_subscriptions`. Use this before calling `create_event_subscription` to learn supported event types (e.g. `pdpp.records.changed`, `pdpp.grant.revoked`), signing profile, retry schedule, verification handshake, callback-URL byte limit, and the hint cursor location. This endpoint is unauthenticated by design (RFC 9728). If the deployment does not advertise event subscriptions, the tool surfaces the absence as `supported: false`. Read-only.',
      annotations: SUBSCRIPTION_READ_ANNOTATIONS,
      inputSchema: EMPTY_TOOL_INPUT_SCHEMA,
      outputSchema: z.object(EVENT_SUB_DISCOVERY_OUTPUT_SCHEMA_SHAPE),
      handler: async () => {
        const response = await rs.getJson('/.well-known/oauth-protected-resource');
        return toEventSubDiscoveryResult(response, providerUrl);
      },
    },
    {
      name: 'create_event_subscription',
      title: 'Create event subscription',
      description:
        'Create an outbound event subscription via `POST /v1/event-subscriptions` using the configured scoped client bearer. Persists a `(grant_id, client_id, subject_id)`-bound subscription on the RS and returns the per-subscription `whsec_`-prefixed delivery secret exactly once (rotate via `update_event_subscription`). Under a hosted MCP package token covering multiple sources, pass `connection_id` so the new subscription binds to exactly one child grant; the adapter rejects ambiguous calls with a typed `ambiguous_connection` (409) whose `available_connections` entries include current-authorization `grant_id`, canonical `connector_key`, `connection_id`, and optional `display_name`. Persist the returned `subscription_id` for subscription management and `connection_id` for source disambiguation; do not persist `grant_id` as a reconnect-stable source identifier.' +
        SUBSCRIPTION_TOOL_FOOTER,
      annotations: SUBSCRIPTION_WRITE_ANNOTATIONS,
      inputSchema: z
        .object({
          callback_url: z.string().min(1).describe(CALLBACK_URL_DESCRIPTION),
          connection_id: z.string().min(1).optional().describe(CONNECTION_ID_DESCRIPTION),
          filters: z
            .object({
              streams: z.array(z.string()).optional(),
            })
            .strict()
            .optional()
            .describe(FILTERS_DESCRIPTION),
        })
        .strict(),
      outputSchema: z.object(EVENT_SUB_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const body = { callback_url: args.callback_url };
        if (args.filters) body.filters = args.filters;
        if (args.connection_id) body.connection_id = args.connection_id;
        const response = await rs.postJson('/v1/event-subscriptions', { body });
        return toEventSubToolResult(response, providerUrl, 'create_event_subscription');
      },
    },
    {
      name: 'list_event_subscriptions',
      title: 'List event subscriptions',
      description:
        'List event subscriptions owned by the configured scoped client bearer via `GET /v1/event-subscriptions`. Each entry SHALL include `subscription_id`, `status`, `callback_url`, and the snapshotted grant scope. Returns subscriptions belonging to the bearer\'s `(client_id, grant_id)` only; the RS hides the per-subscription secret. Read-only.' +
        SUBSCRIPTION_TOOL_FOOTER,
      annotations: SUBSCRIPTION_READ_ANNOTATIONS,
      inputSchema: EMPTY_TOOL_INPUT_SCHEMA,
      outputSchema: z.object(EVENT_SUB_OUTPUT_SCHEMA_SHAPE),
      handler: async () => {
        const response = await rs.getJson('/v1/event-subscriptions');
        return toEventSubToolResult(response, providerUrl, 'list_event_subscriptions');
      },
    },
    {
      name: 'get_event_subscription',
      title: 'Get event subscription',
      description:
        'Fetch a single subscription owned by the configured scoped client bearer via `GET /v1/event-subscriptions/:id`. Returns 404 (typed `not_found`) if the subscription belongs to a different client/grant or is deleted. Read-only.' +
        SUBSCRIPTION_TOOL_FOOTER,
      annotations: SUBSCRIPTION_READ_ANNOTATIONS,
      inputSchema: z
        .object({
          subscription_id: z.string().min(1).describe(SUBSCRIPTION_ID_DESCRIPTION),
        })
        .strict(),
      outputSchema: z.object(EVENT_SUB_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const id = requireSafeName(args.subscription_id, 'subscription_id');
        const response = await rs.getJson(`/v1/event-subscriptions/${encodeURIComponent(id)}`);
        return toEventSubToolResult(response, providerUrl, `get_event_subscription:${id}`);
      },
    },
    {
      name: 'update_event_subscription',
      title: 'Update event subscription',
      description:
        'Update a subscription via `PATCH /v1/event-subscriptions/:id`. Pass `enabled: false` to disable (transitions `active`/`pending_verification` → `disabled`), `enabled: true` to re-enable from a `disabled`/`disabled_failure` state, or `rotate_secret: true` to mint a fresh `whsec_`-prefixed signing secret (returned in the response exactly once). A grant-revoked subscription cannot be re-enabled and will return a typed `grant_revoked` (409) error. Each call is a state mutation — calling it twice is NOT a no-op when `rotate_secret: true`.' +
        SUBSCRIPTION_TOOL_FOOTER,
      annotations: SUBSCRIPTION_WRITE_ANNOTATIONS,
      inputSchema: z
        .object({
          subscription_id: z.string().min(1).describe(SUBSCRIPTION_ID_DESCRIPTION),
          enabled: z.boolean().optional(),
          rotate_secret: z.boolean().optional(),
        })
        .strict(),
      outputSchema: z.object(EVENT_SUB_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const id = requireSafeName(args.subscription_id, 'subscription_id');
        const body = {};
        if (typeof args.enabled === 'boolean') body.enabled = args.enabled;
        if (args.rotate_secret === true) body.rotate_secret = true;
        const response = await rs.patchJson(`/v1/event-subscriptions/${encodeURIComponent(id)}`, {
          body,
        });
        return toEventSubToolResult(response, providerUrl, `update_event_subscription:${id}`);
      },
    },
    {
      name: 'delete_event_subscription',
      title: 'Delete event subscription',
      description:
        'Delete a subscription via `DELETE /v1/event-subscriptions/:id`. Marks the subscription `deleted` and drops queued deliveries. Subsequent reads return 404. Destructive: there is no undelete.' +
        SUBSCRIPTION_TOOL_FOOTER,
      annotations: SUBSCRIPTION_DELETE_ANNOTATIONS,
      inputSchema: z
        .object({
          subscription_id: z.string().min(1).describe(SUBSCRIPTION_ID_DESCRIPTION),
        })
        .strict(),
      outputSchema: z.object(EVENT_SUB_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const id = requireSafeName(args.subscription_id, 'subscription_id');
        const response = await rs.deleteJson(`/v1/event-subscriptions/${encodeURIComponent(id)}`);
        return toEventSubToolResult(response, providerUrl, `delete_event_subscription:${id}`);
      },
    },
    {
      name: 'send_test_event',
      title: 'Send subscription test event',
      description:
        'Enqueue a `pdpp.subscription.test` event for the named subscription via `POST /v1/event-subscriptions/:id/test-event`. Returns the freshly minted `event_id`. The RS responds 202 once the event is enqueued — actual delivery happens out-of-band via the delivery worker against the subscription\'s callback URL. The subscription must be `active` or `pending_verification`; other states return a typed `invalid_state` (409). Each call mints a new event id and is NOT a no-op.' +
        SUBSCRIPTION_TOOL_FOOTER,
      annotations: SUBSCRIPTION_WRITE_ANNOTATIONS,
      inputSchema: z
        .object({
          subscription_id: z.string().min(1).describe(SUBSCRIPTION_ID_DESCRIPTION),
        })
        .strict(),
      outputSchema: z.object(EVENT_SUB_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const id = requireSafeName(args.subscription_id, 'subscription_id');
        const response = await rs.postJson(
          `/v1/event-subscriptions/${encodeURIComponent(id)}/test-event`,
          { body: {} }
        );
        return toEventSubToolResult(response, providerUrl, `send_test_event:${id}`);
      },
    },
    {
      name: 'fetch_blob',
      title: 'Fetch PDPP blob',
      description:
        'Fetch a blob referenced by a prior authorized record via `GET /v1/blobs/{blob_id}` using the configured scoped token. Returns base64 bytes and the RS-reported mime type. When the blob identifier resolves to more than one connection under your grant and `connection_id` is omitted, the RS returns a typed `ambiguous_connection` (409) error listing `available_connections` entries with current-authorization `grant_id`, canonical `connector_key`, `connection_id`, and optional `display_name`; retry with the chosen `connection_id`. Persist `connection_id`, not `grant_id`, across reconnects. Read-only.',
      annotations: READ_ONLY_ANNOTATIONS,
      inputSchema: z
        .object({
          blob_id: z
            .string()
            .min(1)
            .describe('Blob identifier returned by a previous `query_records` or `search` call.'),
          range: z
            .string()
            .regex(/^bytes=\d+-\d*$/, { message: 'range must look like bytes=0-1023' })
            .optional(),
          ...ConnectionIdInputShape,
        })
        .strict(),
      outputSchema: z.object(BLOB_OUTPUT_SCHEMA_SHAPE),
      handler: async (args) => {
        const blobId = requireSafeName(args.blob_id, 'blob_id');
        const headers = args.range ? { Range: args.range } : undefined;
        const query = pickQuery(args, SUPPORTED_QUERY_KEYS);
        const response = await rs.getRaw(`/v1/blobs/${encodeURIComponent(blobId)}`, {
          headers,
          query,
        });
        return toBlobToolResult(response, providerUrl);
      },
    },
  ];
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
    return {
      content: [
        {
          type: 'text',
          text: summarizeBody(response.body, label, options),
        },
      ],
      structuredContent: { data: response.body, provider_url: providerUrl, request_id: response.requestId },
    };
  }
  return errorToolResult(response, providerUrl);
}

// Build the `schema` tool result. The text summary is always the compact,
// parseable discovery line. The `structuredContent.data` payload is a compact
// projection by default and the verbatim RS body only when `detail === "full"`.
// When `stream` is supplied, both the summary and the structured payload are
// scoped to that single stream so an agent can fetch one stream's capabilities
// without pulling the whole document.
function toSchemaToolResult(response, providerUrl, { detail = 'compact', stream = null, alreadyCompact = false } = {}) {
  if (!response.ok) {
    return errorToolResult(response, providerUrl);
  }
  const scopedBody = stream && !alreadyCompact ? scopeSchemaBodyToStream(response.body, stream) : response.body;
  const data = detail === 'full' || alreadyCompact ? scopedBody : compactSchemaDocument(scopedBody);
  return {
    content: [
      {
        type: 'text',
        text: summarizeSchemaDiscovery(data, 'PDPP schema'),
      },
    ],
    structuredContent: { data, provider_url: providerUrl, request_id: response.requestId },
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

// Narrow a schema document to a single stream, preserving the envelope shape
// (top-level `data` wrapper and `connectors[]` grouping) so downstream
// compaction and the discovery summary see the same structure they would for
// the full document. Connectors that contribute no matching stream are dropped.
function scopeSchemaBodyToStream(body, streamNameTarget) {
  const wrapped =
    body && typeof body === 'object' && body.data && typeof body.data === 'object' && !Array.isArray(body.data);
  const schema = unwrapSchemaBody(body);
  const connectors = extractSchemaConnectors(schema);
  let scopedSchema;
  if (connectors.length > 0) {
    const scopedConnectors = connectors
      .map((connector) => {
        const streams = Array.isArray(connector.streams) ? connector.streams : [];
        const matching = streams.filter((entry) => streamName(entry) === streamNameTarget);
        if (matching.length === 0) return null;
        return { ...connector, streams: matching, stream_count: matching.length };
      })
      .filter(Boolean);
    scopedSchema = {
      ...schema,
      connectors: scopedConnectors,
      connector_count: scopedConnectors.length,
      stream_count: scopedConnectors.reduce(
        (total, connector) => total + (Array.isArray(connector.streams) ? connector.streams.length : 0),
        0,
      ),
    };
  } else {
    const streams = Array.isArray(schema?.streams) ? schema.streams : [];
    const matching = streams.filter((entry) => streamName(entry) === streamNameTarget);
    scopedSchema = { ...schema, streams: matching, stream_count: matching.length };
  }
  return wrapped ? { ...body, data: scopedSchema } : scopedSchema;
}

// Compact projection of the schema document. Drops the heavy per-field JSON
// Schema (`field_capabilities.*.schema`) and any other verbose nested blobs,
// keeping the field name, declared type, grant flag, and usable capability
// flags an agent needs to build filter/sort/expand/fields/count arguments.
// Connection identity (`connection_id`, `connector_instance_id`,
// `display_name`) and canonical connector metadata (`connector_key`) are
// preserved verbatim. The envelope shape (top-level `data` wrapper,
// `connectors[]` grouping) is preserved so the payload is structurally a
// schema document, just lighter.
function compactSchemaDocument(body) {
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
      connectors: connectors.map((connector) => compactSchemaConnector(connector)),
    };
    // The hosted-MCP package fanout (server/package-rs-client.js
    // `mergeSchemaEnvelopes`) deliberately augments the canonical
    // `connectors[]` envelope with a flattened, source-tagged top-level
    // `streams[]` so MCP consumers get one source-attributed stream list
    // without walking `connectors[]`. The single-source `/v1/schema` shape
    // has no top-level `streams[]`, so stripping it there is correct — but
    // when the fanout provided one, preserve a compacted copy (each entry's
    // `source` tag is already whitelisted by `compactSchemaStream`).
    if (Array.isArray(schema.streams)) {
      compactSchema.streams = schema.streams.map((entry) => compactSchemaStream(entry));
    }
  } else if (Array.isArray(schema.streams)) {
    compactSchema = {
      ...schema,
      streams: schema.streams.map((entry) => compactSchemaStream(entry)),
    };
  } else {
    compactSchema = schema;
  }
  compactSchema = { ...compactSchema, detail: 'compact' };
  return wrapped ? { ...body, data: compactSchema } : compactSchema;
}

function stripSchemaStreamArrays(schema) {
  const { streams: _streams, ...rest } = schema;
  return rest;
}

function compactSchemaConnector(connector) {
  if (!connector || typeof connector !== 'object') return connector;
  const streams = Array.isArray(connector.streams) ? connector.streams : [];
  const { shared, sharedKey } = pickSharedGrantedConnections(streams);
  const hasShared = shared !== null;
  return {
    ...connector,
    ...(shared ? { granted_connections: shared } : {}),
    streams: streams.map((entry) => compactSchemaStream(entry, { hasShared, sharedKey })),
  };
}

// Project a single stream-metadata entry to its compact form. Whitelisted
// identity/metadata fields pass through verbatim; `field_capabilities` and
// `expand_capabilities` are compacted; everything else is dropped to keep the
// payload bounded.
function compactSchemaStream(entry, { hasShared = false, sharedKey = '' } = {}) {
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
    'connector_instance_id',
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
    const streamKey = Array.isArray(entry.granted_connections)
      ? grantedConnectionsKey(entry.granted_connections)
      : null;
    if (!hasShared || streamKey === null || streamKey !== sharedKey) {
      out.granted_connections = entry.granted_connections;
    }
  }
  if (entry.field_capabilities !== undefined) {
    out.field_capabilities = compactFieldCapabilities(entry.field_capabilities);
  }
  if (entry.expand_capabilities !== undefined) {
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
    const alias = typeof entry.connector_instance_id === 'string' ? entry.connector_instance_id : '';
    return JSON.stringify([id, label, alias]);
  });
  entries.sort();
  return entries.join('\n');
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
      byKey.set(key, { value: stream.granted_connections, count: 1 });
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

function toSearchToolResult(response, providerUrl) {
  if (!response.ok) {
    return errorToolResult(response, providerUrl);
  }
  const results = normalizeSearchResults(response.body);
  return {
    content: [
      {
        type: 'text',
        text: summarizeSearch(response.body, results),
      },
    ],
    structuredContent: {
      data: response.body,
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
  return {
    content: [
      {
        type: 'text',
        text: summarizeFetchedDocument(document),
      },
    ],
    structuredContent: {
      ...document,
      data: response.body,
      provider_url: providerUrl,
      request_id: response.requestId,
    },
  };
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
  'record_preview_truncated=true; canonical envelope remains in structuredContent.data';

function summarizeRecordEnvelope(body, label) {
  const records = extractRecordRows(body);
  const hasMore = body && typeof body === 'object' && body.has_more === true ? ' has_more=true.' : '';
  if (records.length === 0) {
    return `${label}: 0 record(s).`;
  }
  const shown = Math.min(records.length, RECORD_PREVIEW_LIMIT);
  const lines = [`${label}: ${records.length} record(s).${hasMore} Showing up to ${shown}:`];
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
    lines.push(`more_records=${records.length - RECORD_PREVIEW_LIMIT}; canonical envelope remains in structuredContent.data`);
  }
  return lines.join('\n');
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
// flags are emitted in the text only when the document is scoped to a single
// stream (the `schema(stream)` discovery middle step). For multi-stream package
// summaries the text lists streams + connection + connector_key and points the
// agent at `schema(stream)` for per-field capability flags. Callers can force
// inclusion via `includeFieldDetail`.
function summarizeSchemaDiscovery(body, label, { includeFieldDetail } = {}) {
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
  const lines = streamRefs
    .slice(0, DISCOVERY_STREAM_SUMMARY_LIMIT)
    .map(({ stream, connector }) => formatSchemaStreamSummary(stream, connector, { includeFieldDetail: withFields }));
  if (streamRefs.length > DISCOVERY_STREAM_SUMMARY_LIMIT) {
    lines.push(`more_streams=${streamRefs.length - DISCOVERY_STREAM_SUMMARY_LIMIT}`);
  }
  const hint = withFields
    ? ''
    : '\ncall schema(stream) for per-field capability flags (filter/sort/expand/fields/count/aggregate)';
  return `${label}: connectors=${connectorCount} streams=${streamRefs.length}\n${lines.join('\n')}${hint}`;
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
  const usable = Object.entries(aggregation)
    .filter(([, capability]) => capability && typeof capability === 'object' && capability.usable === true)
    .map(([name]) => name);
  if (usable.length > 0) {
    flags.push(`a=${formatInlineValue(usable.join('|'))}`);
  }
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

function summarizeSearch(body, results) {
  const hasMore = body && body.has_more === true ? ' has_more=true.' : '';
  return `search: ${results.length} hit(s).${hasMore} See structuredContent.data for the canonical envelope and structuredContent.results for the ChatGPT-compatible projection.`;
}

function summarizeFetchedDocument(document) {
  const title = document.title || document.id;
  return `fetched ${document.id}: ${title}. See structuredContent for the canonical record and ChatGPT-compatible document fields.`;
}

function normalizeSearchResults(body) {
  const candidates = Array.isArray(body?.results)
    ? body.results
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.hits)
        ? body.hits
        : [];
  return candidates.map((hit, index) => {
    const id = resultIdForHit(hit, index);
    return {
      id,
      title: titleForRecord(hit, id),
      url: urlForRecord(hit, id),
    };
  });
}

function resultIdForHit(hit, index) {
  const directId = stringValue(hit?.result_id ?? hit?.resultId);
  if (directId) return directId;

  const stream = stringValue(hit?.stream ?? hit?.stream_name ?? hit?.streamName);
  const recordId = stringValue(hit?.id ?? hit?.record_id ?? hit?.recordId ?? hit?.record_key ?? hit?.recordKey);
  if (stream && recordId) {
    return `${stream}:${recordId}`;
  }

  const fallback = stringValue(hit?.id ?? hit?.url);
  return fallback || `result:${index + 1}`;
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
  const id = stringValue(record?.id ?? record?.record_id ?? record?.recordId) || requestedId;
  const stream = stringValue(record?.stream ?? record?.stream_name ?? record?.streamName);
  const resultId = stream && id && !requestedId.includes(':') ? `${stream}:${id}` : requestedId;
  const title = titleForRecord(record, resultId);
  const text = textForRecord(record);
  const url = urlForRecord(record, resultId, providerUrl);
  const metadata = metadataForRecord(record, { id: resultId, title, url });
  return { id: resultId, title, text, url, metadata };
}

function titleForRecord(record, fallbackId) {
  return (
    stringValue(record?.title) ||
    stringValue(record?.name) ||
    stringValue(record?.subject) ||
    stringValue(record?.snippet?.text) ||
    stringValue(record?.summary) ||
    fallbackId
  );
}

// Hard ceiling on the JSON-stringify fallback for `fetch`'s `text` field.
// A real declared text-like field (`text`/`content`/`body`/`summary`) is the
// document text ChatGPT consumes and is returned verbatim and unbounded — that
// is the contract. The fallback below only fires when a record declares NONE of
// those fields; without a cap it pretty-prints the entire record into `text`,
// duplicating the canonical record already present verbatim in
// `structuredContent.data` (measured at tens of KB and unbounded for fat
// records). Bounding only the fallback keeps `fetch.text` a readable, honest
// excerpt and points the agent at the full record in `structuredContent.data`;
// no declared text is ever truncated and no field an agent needs is dropped.
const FETCH_TEXT_FALLBACK_CHAR_LIMIT = 1024;
const FETCH_TEXT_FALLBACK_POINTER =
  '… [record has no text/content/body/summary field; full record in structuredContent.data]';

function textForRecord(record) {
  const declared =
    stringValue(record?.text) ||
    stringValue(record?.content) ||
    stringValue(record?.body) ||
    stringValue(record?.summary);
  if (declared) return declared;
  const serialized = JSON.stringify(record, null, 2);
  if (serialized.length <= FETCH_TEXT_FALLBACK_CHAR_LIMIT) return serialized;
  const head = FETCH_TEXT_FALLBACK_CHAR_LIMIT - FETCH_TEXT_FALLBACK_POINTER.length;
  return `${serialized.slice(0, Math.max(0, head))}${FETCH_TEXT_FALLBACK_POINTER}`;
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
  const metadata = record.metadata && typeof record.metadata === 'object' ? { ...record.metadata } : {};
  for (const [key, value] of Object.entries(record)) {
    if (['metadata', 'text', 'content', 'body'].includes(key)) continue;
    if (Object.values(omitted).includes(value)) continue;
    metadata[key] = value;
  }
  return metadata;
}

function stringValue(value) {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toEventSubToolResult(response, providerUrl, label) {
  if (!response.ok) {
    return errorToolResult(response, providerUrl);
  }
  return {
    content: [
      {
        type: 'text',
        text: summarizeEventSubBody(response, label),
      },
    ],
    structuredContent: {
      data: response.body,
      provider_url: providerUrl,
      request_id: response.requestId,
      http_status: response.status,
    },
  };
}

function toEventSubDiscoveryResult(response, providerUrl) {
  if (!response.ok) {
    return errorToolResult(response, providerUrl);
  }
  const body = response.body && typeof response.body === 'object' ? response.body : {};
  const capabilities = body.capabilities && typeof body.capabilities === 'object' ? body.capabilities : {};
  const advertised = capabilities.client_event_subscriptions ?? null;
  const supported = !!(advertised && typeof advertised === 'object' && advertised.supported === true);
  const summary = supported
    ? `event subscriptions supported: endpoint=${advertised?.endpoint ?? 'unknown'} stability=${advertised?.stability ?? 'unknown'}. See structuredContent.capability for event types, signing profile, and retry schedule.`
    : 'event subscriptions NOT advertised by this PDPP instance. Call `query_records` with `changes_since` to poll instead. See structuredContent.data for the full protected-resource metadata.';
  return {
    content: [
      {
        type: 'text',
        text: summary,
      },
    ],
    structuredContent: {
      supported,
      capability: advertised,
      data: response.body,
      provider_url: providerUrl,
      request_id: response.requestId,
      http_status: response.status,
    },
  };
}

// The one-time delivery secret can arrive at the top level (create) or, on
// rotate, alongside a nested `subscription` projection (PATCH). Either way the
// RS returns it exactly once and never again on read, so the MCP text MUST
// carry the literal value: chat agents that cannot inspect `structuredContent`
// have no other way to capture it. The structured envelope remains canonical.
function summarizeEventSubBody(response, label) {
  if (response.status === 204) {
    return `${label}: 204 No Content. Subscription removed; subsequent reads will return 404.`;
  }
  const body = response.body;
  if (body && typeof body === 'object') {
    const subscription = body.subscription && typeof body.subscription === 'object' ? body.subscription : null;
    const subscriptionId = firstString(body.subscription_id, subscription?.subscription_id);
    const status = firstString(body.status, subscription?.status);
    const oneTimeSecret = typeof body.secret === 'string' ? body.secret : null;
    if (subscriptionId || oneTimeSecret) {
      const parts = [];
      if (subscriptionId) parts.push(`subscription_id=${subscriptionId}`);
      if (status) parts.push(`status=${status}`);
      const head = parts.length > 0 ? `${label}: ${parts.join(' ')}.` : `${label}:`;
      if (oneTimeSecret) {
        // Compact, unmistakable line an agent can read and relay verbatim. The
        // secret is returned once — the receiver must store it now to verify
        // future signatures.
        return `${head} one_time_secret=${oneTimeSecret} (returned once — store it on the receiver now to verify delivery signatures; not retrievable later). See structuredContent.data for the full body.`;
      }
      return `${head} See structuredContent.data for the full body.`;
    }
    if (typeof body.event_id === 'string') {
      return `${label}: enqueued event_id=${body.event_id}. Delivery occurs out-of-band; check your callback receiver.`;
    }
    if (Array.isArray(body.data)) {
      return `${label}: ${body.data.length} subscription(s). See structuredContent.data for the canonical envelope.`;
    }
  }
  return `${label}: HTTP ${response.status}. See structuredContent.data for the response body.`;
}

function toBlobToolResult(response, providerUrl) {
  if (response.ok) {
    const base64 = Buffer.isBuffer(response.body) ? response.body.toString('base64') : '';
    return {
      content: [
        {
          type: 'text',
          text: `Fetched ${response.body.length} bytes (${response.contentType || 'application/octet-stream'}).`,
        },
      ],
      structuredContent: {
        provider_url: providerUrl,
        request_id: response.requestId,
        bytes_base64: base64,
        mime_type: response.contentType || 'application/octet-stream',
        size: response.body.length,
      },
    };
  }
  return errorToolResult(response, providerUrl);
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
  toBlobToolResult,
  toSearchToolResult,
  toFetchToolResult,
  toEventSubToolResult,
  toEventSubDiscoveryResult,
  resolveStreamName,
};
