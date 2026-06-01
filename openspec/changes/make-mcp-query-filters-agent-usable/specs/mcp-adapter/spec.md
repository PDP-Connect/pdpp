## ADDED Requirements

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
