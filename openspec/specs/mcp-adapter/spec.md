# mcp-adapter Specification

## Purpose
TBD - created by archiving change add-mcp-stdio-adapter. Update Purpose after archive.
## Requirements
### Requirement: Stdio MCP Adapter Uses Scoped PDPP Tokens
The MCP adapter SHALL run as a local stdio MCP server that calls the existing PDPP resource-server API using an already-issued scoped client access token from the local PDPP credential cache. The adapter SHALL NOT issue grants, request new authorization, run connectors, or access reference owner-control endpoints.

#### Scenario: Cached grant token is present
- **WHEN** the adapter starts with a configured provider URL and grant identifier whose token is present in the local PDPP credential cache
- **THEN** it SHALL connect over stdio and serve MCP requests by attaching that token to resource-server API calls

#### Scenario: Credential cache is empty
- **WHEN** the adapter starts without a usable scoped client token
- **THEN** it SHALL exit non-zero or return a terminal initialization error with guidance to run `pdpp connect <provider-url>` and SHALL NOT fall back to an owner token

#### Scenario: Owner token is present in the environment
- **WHEN** `PDPP_OWNER_TOKEN` or another owner credential is present but no scoped client token is configured
- **THEN** the adapter SHALL ignore the owner credential by default and fail closed rather than exposing owner-mode self-export through MCP

### Requirement: MCP Surface Is Read-Only and Grant-Scoped

The MCP adapter SHALL expose grant-scoped MCP tools/resources that map to existing PDPP resource-server APIs using the same canonical read and event-subscription contracts. Returned data SHALL be no broader than the resource server returns for the configured token. MCP tool descriptions and structured output SHALL advertise canonical `connector_key` and `connection_id` values, not URL-shaped connector ids or deprecated connector-instance aliases.

#### Scenario: Agent lists streams

- **WHEN** an MCP client calls the stream-listing tool
- **THEN** the adapter SHALL call `GET /v1/streams` with the configured scoped token and return only the streams authorized by that token
- **AND** every source-qualified result SHALL carry canonical connector key and connection identity when available.

#### Scenario: Agent queries records

- **WHEN** an MCP client calls the record-query tool with stream, pagination, field, view, filter, order, `connection_id`, or `changes_since` arguments supported by the RS
- **THEN** the adapter SHALL forward those supported arguments to the RS without broadening scope
- **AND** it SHALL reject unsupported MCP arguments rather than inventing query semantics.

#### Scenario: Agent fetches a blob

- **WHEN** an MCP client asks to fetch a blob reference returned by a prior authorized record read
- **THEN** the adapter SHALL fetch through the existing RS blob endpoint with the same scoped token and SHALL NOT construct direct source-platform or local-filesystem access.

#### Scenario: Tool description names source selectors

- **WHEN** a modern MCP client inspects the tool schema
- **THEN** the schema SHALL describe `connection_id` as the source disambiguator
- **AND** it SHALL NOT advertise URL-shaped connector ids or `connector_instance_id` as the preferred selector.

### Requirement: MCP Errors Preserve PDPP Authorization Semantics
The MCP adapter SHALL preserve resource-server error meaning. Authentication, authorization, invalid cursor, expired cursor, unsupported query, and needs-broader-grant conditions SHALL be surfaced as MCP errors without retrying through broader credentials.

#### Scenario: Resource server returns invalid token
- **WHEN** the RS returns an authentication error such as `invalid_token`
- **THEN** the adapter SHALL return a terminal MCP error and SHALL NOT retry with owner credentials or hidden alternate tokens

#### Scenario: Resource server rejects an unsupported query
- **WHEN** the RS returns a 400 error for an unsupported query shape
- **THEN** the adapter SHALL surface the RS error envelope in the MCP tool result and SHALL NOT silently drop unsupported parameters

### Requirement: MCP Process Keeps Protocol Output Clean
The MCP adapter SHALL write only MCP protocol messages to stdout. Logs, diagnostics, setup guidance, and validation failures SHALL go to stderr or structured MCP errors.

#### Scenario: Adapter logs diagnostic output
- **WHEN** the adapter emits startup, cache, or request diagnostics
- **THEN** it SHALL write diagnostics to stderr and SHALL NOT corrupt the stdio MCP message stream

### Requirement: Hosted MCP Uses Streamable HTTP
The reference implementation SHALL expose a hosted MCP endpoint over Streamable HTTP at `/mcp` for remote MCP clients. The endpoint SHALL use the same read-only PDPP MCP tool implementation as the local stdio adapter.

#### Scenario: MCP client initializes over HTTP
- **WHEN** a remote MCP client sends an MCP initialize request to `/mcp` with a valid scoped PDPP client bearer token
- **THEN** the endpoint SHALL respond using MCP Streamable HTTP without requiring a local stdio process

#### Scenario: Stdio client remains supported
- **WHEN** a local MCP client launches the `@pdpp/mcp-server` stdio command
- **THEN** the stdio adapter SHALL continue to serve the same grant-scoped read-only PDPP MCP surface

### Requirement: Hosted MCP Is Grant-Scoped And Read-Only
The hosted MCP endpoint SHALL require a valid PDPP client token and SHALL route every data-bearing tool/resource read through existing grant-enforced resource-server APIs. It SHALL NOT accept owner tokens, run connectors, mutate source data, mutate reference state, or call reference owner-control routes.

#### Scenario: Request has no bearer
- **WHEN** a request reaches `/mcp` without a bearer token
- **THEN** the endpoint SHALL reject it with an authentication error and protected-resource metadata discovery

#### Scenario: Request has owner bearer
- **WHEN** a request reaches `/mcp` with an active owner token
- **THEN** the endpoint SHALL reject it and SHALL NOT expose owner-mode self-export through MCP

#### Scenario: Tool reads records
- **WHEN** an MCP client calls a record-reading tool
- **THEN** the adapter SHALL call an existing `/v1` resource-server read endpoint with the same client bearer token and SHALL return no broader data than that endpoint returns

### Requirement: MCP `schema` Compact Output Aligns With REST Compact Schema Semantics
The MCP adapter SHALL make the `schema` tool's compact/default output use the same compact projection semantics as `GET /v1/schema?view=compact`. The MCP adapter SHALL keep `detail: "full"` as the exhaustive verbatim escape hatch.

#### Scenario: MCP compact schema uses the REST compact view
- **WHEN** an MCP client calls `schema` without `detail: "full"` against an RS that supports `GET /v1/schema?view=compact`
- **THEN** the adapter SHALL request `GET /v1/schema?view=compact`
- **AND** if the MCP call includes `stream=<name>`, the adapter SHALL pass the same stream as `GET /v1/schema?view=compact&stream=<name>`
- **AND** the MCP `structuredContent.data` SHALL preserve the REST compact body verbatim inside the MCP wrapper

#### Scenario: MCP compact schema falls back without diverging
- **WHEN** an MCP client calls `schema` without `detail: "full"` against an RS that ignores or rejects the compact selector
- **THEN** the adapter MAY fall back to locally projecting the full schema body
- **AND** that fallback projection SHALL preserve the REST compact semantics for field flag aliases, connector-level `granted_connections` de-duplication, stream scoping, and compact byte budgets

#### Scenario: MCP full schema remains explicit
- **WHEN** an MCP client calls `schema` with `detail: "full"`
- **THEN** the adapter SHALL return the exhaustive resource-server schema body in `structuredContent.data`
- **AND** the adapter SHALL NOT substitute the compact projection for the full detail response

### Requirement: Hosted MCP Supports ChatGPT-Compatible Search And Fetch
The MCP adapter SHALL expose `search` and `fetch` tools whose output is compatible with ChatGPT data-only/deep-research expectations while preserving PDPP-native tools for clients that understand them.

#### Scenario: Client searches records
- **WHEN** an MCP client calls `search` with a query
- **THEN** the tool SHALL search grant-scoped PDPP records and return structured search results containing stable result ids, human-readable titles, and citation URLs

#### Scenario: Client fetches a search result
- **WHEN** an MCP client calls `fetch` with a result id returned by `search`
- **THEN** the tool SHALL return a single document object containing id, title, text, URL, and metadata for that grant-scoped result

#### Scenario: Client uses PDPP-native tools
- **WHEN** a full MCP client calls `schema`, `list_streams`, `query_records`, or `fetch_blob`
- **THEN** those tools SHALL remain available and SHALL preserve the existing PDPP resource-server envelope semantics

### Requirement: Hosted MCP Metadata Is Discoverable
The reference implementation SHALL advertise the hosted MCP endpoint from protected-resource metadata using public-origin-safe URLs. The metadata SHALL identify MCP as an adapter over PDPP reads and SHALL NOT replace the PDPP core query base.

#### Scenario: Client reads protected-resource metadata
- **WHEN** a client fetches `/.well-known/oauth-protected-resource`
- **THEN** the response SHALL include a discovery hint for the hosted MCP endpoint and SHALL keep `pdpp_core_query_base` pointed at `/v1`

#### Scenario: Client reads MCP protected-resource metadata
- **WHEN** a client fetches `/.well-known/oauth-protected-resource/mcp`
- **THEN** the response SHALL identify `/mcp` as the protected resource, advertise client bearer tokens only, and include the hosted MCP endpoint URL

#### Scenario: Deployment is behind a trusted proxy
- **WHEN** the reference server builds metadata from a trusted forwarded public origin
- **THEN** the hosted MCP endpoint URL SHALL use that public origin

### Requirement: MCP Query Filters Are Agent-Usable Without Hand-Encoded Bracket Strings

The MCP adapter SHALL expose an agent-usable typed `filter` input on the record
query, aggregate, and search tools. The typed input SHALL accept an object keyed
by field name whose value is either a scalar (exact match) or a range object
keyed by `gte`, `gt`, `lte`, or `lt`. The adapter SHALL encode the typed input
into the resource server's `filter[field]=value` (exact) and
`filter[field][op]=value` (range) query parameters and SHALL NOT require an MCP
client to construct bracket keys inside a string.

A legacy raw query string using literal `filter[field]=value` bracket syntax
SHALL be accepted and parsed into the same bracket parameters. Any other string
shape, an empty string, or an empty typed filter object SHALL be rejected with a
typed, actionable error that directs the agent to the typed filter input. A
`filter` argument SHALL NOT be silently forwarded as a bare `filter=` parameter,
which the resource server ignores. The adapter SHALL NOT change resource-server
filtering semantics; field and operator legality remain owned by the resource
server and advertised by `GET /v1/schema`.

#### Scenario: Agent supplies a typed exact filter

- **WHEN** an MCP client calls the record-query tool with `filter` set to an
  object such as `{ "user_id": "U123" }`
- **THEN** the adapter SHALL forward `filter[user_id]=U123` to the resource
  server
- **AND** the adapter SHALL NOT forward a bare `filter=` parameter

#### Scenario: Agent supplies a typed range filter

- **WHEN** an MCP client calls the record-query tool with `filter` set to a range
  object such as `{ "created_at": { "gte": "2026-01-01T00:00:00Z" } }`
- **THEN** the adapter SHALL forward `filter[created_at][gte]=2026-01-01T00:00:00Z`
  using only the supported operators `gte`, `gt`, `lte`, `lt`

#### Scenario: Legacy bracket string still parses

- **WHEN** an MCP client calls the record-query tool with `filter` set to the
  literal string `filter[user_id]=U123`
- **THEN** the adapter SHALL parse it into `filter[user_id]=U123` bracket
  parameters and forward them to the resource server

#### Scenario: Ambiguous string filter is rejected, never silently dropped

- **WHEN** an MCP client calls the record-query or aggregate tool with a `filter`
  string that is not literal bracket syntax (for example `amount>100`,
  `user_id=U123`, a bare term, an empty string, or JSON encoded as a string)
- **THEN** the adapter SHALL return a typed, actionable error instructing the
  agent to use the typed filter input
- **AND** the adapter SHALL NOT forward the value as a bare `filter=` parameter

#### Scenario: Empty or pre-encoded typed filter objects are rejected

- **WHEN** an MCP client calls the record-query tool with `filter` set to an
  empty object or with an object key that embeds bracket syntax such as
  `filter[user_id]`
- **THEN** the adapter SHALL return a typed, actionable error
- **AND** the adapter SHALL NOT forward any `filter` query parameter to the
  resource server

#### Scenario: Aggregate accepts the same typed filter

- **WHEN** an MCP client calls the aggregate tool with the same typed `filter`
  input accepted by the record-query tool
- **THEN** the adapter SHALL forward the equivalent `filter[field]` /
  `filter[field][op]` parameters
- **AND** a malformed string filter SHALL produce the same class of actionable
  error as the record-query tool

### Requirement: MCP Expand Limits Are Encoded As Resource-Server Bracket Parameters

The MCP adapter SHALL expose `expand_limit` on record-query and fetch tools as a
typed object keyed by relation name. The adapter SHALL encode the typed input
into the resource server's `expand_limit[relation]=N` query parameters and SHALL
NOT forward the object as a bare `expand_limit=` JSON string. An empty
`expand_limit` object or a relation key that embeds bracket syntax SHALL be
rejected with a typed, actionable error before any resource-server call.

#### Scenario: Agent supplies typed expand limits on a record query

- **WHEN** an MCP client calls the record-query tool with `expand` set to a
  relation and `expand_limit` set to an object such as `{ "messages": 3 }`
- **THEN** the adapter SHALL forward `expand=messages` and
  `expand_limit[messages]=3` to the resource server
- **AND** the adapter SHALL NOT forward a bare `expand_limit=` parameter

#### Scenario: Agent supplies typed expand limits on a fetch

- **WHEN** an MCP client calls the fetch tool with `expand_limit` set to an
  object such as `{ "messages": 3 }`
- **THEN** the adapter SHALL forward `expand_limit[messages]=3` to the resource
  server
- **AND** the adapter SHALL NOT forward a bare `expand_limit=` parameter

#### Scenario: Empty or pre-encoded expand-limit objects are rejected

- **WHEN** an MCP client calls the record-query or fetch tool with
  `expand_limit` set to an empty object or with an object key that embeds bracket
  syntax such as `expand_limit[messages]`
- **THEN** the adapter SHALL return a typed, actionable error
- **AND** the adapter SHALL NOT call the resource server

### Requirement: MCP Aggregate Results Are Readable In Tool Text

The MCP adapter SHALL include the aggregation metric, stream, and numeric result
in the aggregate tool result `content[]` text, not only in
`structuredContent.data`. The text SHALL stay compact and SHALL NOT dump the full
JSON envelope. The `structuredContent.data` payload SHALL remain the canonical
envelope and SHALL continue to validate against the tool output schema.

#### Scenario: Scalar aggregate surfaces the number in text

- **WHEN** an MCP client calls the aggregate tool for an ungrouped metric such as
  `count`
- **THEN** the tool result `content[]` text SHALL include the metric, the stream
  name, and the numeric result
- **AND** `structuredContent.data` SHALL still carry the canonical aggregation
  envelope

#### Scenario: Grouped aggregate previews buckets in text

- **WHEN** an MCP client calls the aggregate tool with a grouping dimension
- **THEN** the tool result `content[]` text SHALL preview the grouping dimension
  and a bounded set of bucket keys with their counts
- **AND** the full bucket list SHALL remain in `structuredContent.data`

### Requirement: MCP Search Results Are Usable In Tool Text

The MCP adapter SHALL include a bounded preview of search hits in the search
tool result `content[]` text, not only a hit count or a pointer to
`structuredContent`. Each previewed hit SHALL include the result id and SHALL
include available source handles such as `connection_id`, `connector_key`, and
stream when present. The text SHALL stay compact and SHALL NOT dump the full JSON
envelope. The `structuredContent.data` payload SHALL remain the canonical
envelope, and `structuredContent.results` SHALL remain the flattened search
projection for clients that can inspect structured tool results.

#### Scenario: Search surfaces fetch handles in text

- **WHEN** an MCP client calls the search tool and the resource server returns
  one or more hits
- **THEN** the tool result `content[]` text SHALL include a bounded top-hit
  preview with each previewed hit's id
- **AND** when a previewed hit has `connection_id`, stream, display label,
  connector key, title, or snippet information, the text SHALL include the
  available values within the preview budget
- **AND** the text SHALL tell the agent to fetch a hit by id and include
  `connection_id` when shown

#### Scenario: Search text remains bounded

- **WHEN** the resource server returns many hits or large snippets
- **THEN** the MCP adapter SHALL keep `content[]` text bounded
- **AND** it SHALL preserve the full canonical search envelope in
  `structuredContent.data`

### Requirement: MCP Fetch Results Are Usable In Tool Text

The MCP adapter SHALL include the fetched document id, title, available source
handles, and a bounded text preview in the fetch tool result `content[]` text.
The text SHALL be sufficient for a model that cannot inspect
`structuredContent` to confirm it fetched the intended record and use the
preview to answer or decide a follow-up. The adapter SHALL continue to expose the
full ChatGPT-compatible document in `structuredContent.text` and the canonical
resource-server record in `structuredContent.data`.

#### Scenario: Fetch surfaces the fetched document in text

- **WHEN** an MCP client calls fetch with an id returned by search
- **THEN** the tool result `content[]` text SHALL include the fetched id and
  title
- **AND** when the fetched record has `connection_id`, stream, display label, or
  connector key information, the text SHALL include the available values
- **AND** the text SHALL include a bounded preview of the fetched document text

#### Scenario: Fetch understands canonical record wrappers

- **WHEN** the resource server returns a canonical record wrapper whose
  document fields live under `data`
- **THEN** the adapter SHALL derive the fetch document title, text, url, and
  source handles from the nested record data when present
- **AND** the model-visible `content[]` text SHALL not collapse to a generic
  pointer to `structuredContent`

### Requirement: Hosted MCP Package Search Merges Canonical Child Hits

The hosted MCP adapter SHALL fan out unscoped package-token search calls across
authorized child grants and merge search hits from each successful child
response. The package merge SHALL accept the resource server's canonical
list-envelope `data[]` search result shape and compatibility `data.results[]` or
`data.data[]` shapes. The merge SHALL NOT treat a successful child search
response as empty merely because it uses the canonical `data[]` envelope. When a
package search includes a stream filter, the adapter SHALL intersect the
requested stream names with each child grant before forwarding the child request
and SHALL skip child grants with no requested streams rather than forwarding
stream names that are outside that child grant.

#### Scenario: Unscoped package search merges canonical child list envelopes

- **WHEN** a hosted MCP package search omits `connection_id`
- **AND** child grant searches return successful canonical list envelopes with
  hits in `data[]`
- **THEN** the package adapter SHALL return the merged hit list
- **AND** each merged hit SHALL retain source attribution for the child grant

#### Scenario: Package search stream filter is evaluated per child grant

- **WHEN** a hosted MCP package search omits `connection_id`
- **AND** the request includes `streams[]` values that span multiple child grants
- **THEN** the package adapter SHALL forward only the stream names authorized by
  each child grant to that child
- **AND** it SHALL NOT forward unrelated stream names that would cause the child
  resource server call to fail with `grant_stream_not_allowed`

#### Scenario: Package search skips children outside the stream filter

- **WHEN** a hosted MCP package search omits `connection_id`
- **AND** a child grant authorizes none of the requested stream names
- **THEN** the package adapter SHALL not call that child grant for the search
- **AND** the merged result SHALL include hits from matching child grants

#### Scenario: Scoped package search still selects one child

- **WHEN** a hosted MCP package search includes a valid `connection_id`
- **THEN** the package adapter SHALL route the request to the selected child
  grant
- **AND** it SHALL NOT fan out to unrelated child grants
