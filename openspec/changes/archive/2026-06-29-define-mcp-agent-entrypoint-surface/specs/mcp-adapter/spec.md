## ADDED Requirements

### Requirement: MCP recommended setup SHALL be profile-free

The MCP adapter's recommended setup path SHALL expose one profile-free normal
read entrypoint. The operator SHALL NOT choose or understand `core`, `events`,
`full`, toolsets, or equivalent mechanism labels before connecting an agent.

#### Scenario: Recommended setup is presented to an operator
- **WHEN** the operator views MCP setup for a supported target client
- **THEN** the setup SHALL present one recommended path before advanced variants
- **AND** the recommended path SHALL NOT expose event-subscription management,
  full/developer tools, owner bearers, control-plane bearers, profile names, or
  profile selectors by default

#### Scenario: Local stdio setup is configured
- **WHEN** the local stdio adapter is started from CLI or environment config
- **THEN** supported setup SHALL NOT advertise profile-selection flags or
  environment variables
- **AND** the adapter SHALL start the same profile-free normal read surface used
  by hosted MCP

### Requirement: Normal MCP read surface SHALL contain exact read tools

The normal MCP read surface SHALL contain exactly `schema`, `query_records`,
`aggregate`, `search`, and `fetch`.

The normal MCP read surface SHALL preserve canonical `connection_id` as the
source disambiguation argument for multi-connection grants. It SHALL NOT expose
the deprecated REST alias `connector_instance_id` as an MCP tool input.

#### Scenario: Client lists MCP tools
- **WHEN** a client calls `tools/list` on the recommended MCP endpoint
- **THEN** the response SHALL include exactly `schema`, `query_records`,
  `aggregate`, `search`, and `fetch`
- **AND** it SHALL NOT include `list_streams`, `fetch_blob`, or any
  event-subscription management tool

#### Scenario: Client inspects data-tool selector arguments
- **WHEN** a client calls `tools/list` on the recommended MCP endpoint
- **THEN** `schema`, `query_records`, `aggregate`, `search`, and `fetch` SHALL
  advertise optional `connection_id` where source disambiguation is needed
- **AND** none of those tools SHALL advertise `connector_instance_id`

#### Scenario: Normal read tool is invoked
- **WHEN** a client invokes a normal read tool
- **THEN** the adapter SHALL forward or validate the request against the same
  resource-server read contracts
- **AND** it SHALL NOT broaden the grant or retry through owner credentials

### Requirement: MCP normal surface SHALL preserve owner-token rejection

The MCP adapter SHALL remain grant-scoped and SHALL reject owner bearers,
control-plane bearers, and other owner-level credentials.

#### Scenario: Owner bearer reaches MCP setup
- **WHEN** a request or local process environment carries an owner bearer
- **THEN** the adapter SHALL reject the setup or request
- **AND** it SHALL NOT process the request as a normal MCP operation

### Requirement: MCP normal surface footprint SHALL be measured

The MCP adapter SHALL include regression coverage for the generated `tools/list`
payload. The coverage SHALL assert exact tool membership and byte budget so
future additions do not silently widen the default surface.

#### Scenario: Normal tool list is generated in tests
- **WHEN** the test harness generates the normal `tools/list`
- **THEN** the serialized payload SHALL stay below the configured budget
- **AND** the test SHALL fail if an event-subscription management tool or
  developer-only tool appears

### Requirement: MCP schema discovery SHALL be model-visible and bounded

The MCP `schema` tool SHALL default to compact global discovery. Exhaustive raw
JSON Schema SHALL be available only when the caller scopes the request to one
stream. Normal read tools SHALL include pagination, change-bookmark, and count
handles in `content[]` text when those handles are present in the canonical
resource-server envelope. If compact global discovery bounds detailed stream
rows, it SHALL still include a model-visible index containing every granted
stream name grouped by connector identity.

The global schema result SHALL stay bounded as a complete MCP tool result,
including `structuredContent`. Broad discovery SHALL behave as an index, not as
a repeated field-capability dump. Detailed field, filter, sort, projection, and
aggregation capabilities SHALL be available through scoped schema calls.

#### Scenario: Client requests global schema discovery
- **WHEN** a client calls `schema` without a stream
- **THEN** the adapter SHALL return the compact global projection
- **AND** it SHALL include enough model-visible text for the client to choose a
  stream and call `schema(stream)`
- **AND** every granted stream name SHALL be present in `content[]` text even
  when detailed per-stream rows are capped

#### Scenario: Client requests stream-scoped schema discovery
- **WHEN** a client calls `schema` with a stream name that appears under
  multiple connectors or connections
- **THEN** the adapter SHALL include model-visible field and aggregation
  summaries for each matching stream row
- **AND** clients that cannot inspect `structuredContent` SHALL still be able
  to choose valid filter, sort, aggregate, projection, and connection arguments

#### Scenario: Client narrows a shared stream to one connection
- **WHEN** a client calls `schema` with both `stream` and `connection_id`
- **THEN** the adapter SHALL return capabilities only for the matching granted
  connection and stream
- **AND** the model-visible text SHALL include `connection_id`, `connector_key`,
  stream name, display label when present, field summaries, projection support,
  sort support, count support, expand relations, search modes, and aggregation
  support needed for the next read

#### Scenario: Client uses compact schema flags
- **WHEN** a compact schema response uses abbreviated capability flags or a
  mini-grammar
- **THEN** the response SHALL include a model-visible legend explaining those
  flags
- **AND** a client that reads only `content[]` SHALL be able to construct valid
  filter, sort, projection, and aggregate arguments from the response

#### Scenario: Client requests exhaustive schema
- **WHEN** a client calls `schema` with `detail: "full"` and no stream
- **THEN** the adapter SHALL reject the call before fetching the whole
  grant-wide schema
- **AND** the error SHALL instruct the client to use `schema(stream,
  connection_id, detail: "full")` after compact discovery

#### Scenario: Client requests scoped exhaustive schema
- **WHEN** a client calls `schema` with `detail: "full"` and `stream`
- **THEN** the resource-server and MCP adapter SHALL return only matching
  stream rows, not the grant-wide schema
- **AND** when the stream name resolves to more than one configured source and
  no `connection_id` is supplied, the adapter SHALL return a typed
  disambiguation error with `retry_with: "connection_id"` before returning
  exhaustive schema content
- **AND** when `connection_id` is supplied the response SHALL include only the
  matching configured connection
- **AND** the scoped exhaustive response SHALL stay bounded enough for an
  agent host to accept it as a single tool result
- **AND** the schema document SHALL appear directly under
  `structuredContent.data`, not inside a nested REST-envelope
  `structuredContent.data.data`
- **AND** when connector-grouped streams are present, the response SHALL NOT
  duplicate the same selected stream rows in both top-level `streams` and
  connector-nested `connectors[].streams`

#### Scenario: Client sees paged or incremental results
- **WHEN** a normal read tool returns `next_cursor`, `next_changes_since`, or
  count metadata
- **THEN** the adapter SHALL include those handles in `content[]` text
- **AND** clients that cannot inspect `structuredContent` SHALL still be able to
  page, resume changes, and verify count effects

### Requirement: MCP fan-in search SHALL apply global limits and source identity

When `search` fans in across multiple granted connections, `limit` SHALL mean
the maximum number of merged hits returned to the client, not a per-connection
limit. Every returned hit SHALL carry enough source identity for the agent to
answer which configured connection produced the record without a profile
selector.

#### Scenario: Client searches without a connection scope
- **WHEN** a client calls `search` without `connection_id` and with `limit: N`
- **THEN** the adapter SHALL return no more than N merged hits across all
  granted connections
- **AND** each hit SHALL include `connection_id`, `connector_key`, stream name,
  record id, and a display label when present
- **AND** the model-visible text SHALL include a compact source mix when hits
  come from more than one connection
- **AND** search snippets SHALL use balanced highlight tags or unhighlighted
  prose rather than punctuation sentinels
- **AND** search result `title` SHALL be a human-readable identity distinct
  from the matched snippet when no source title exists
- **AND** title fallback SHALL prefer authored/event timestamps such as
  `sent_at` over ingestion timestamps such as `emitted_at` when both are
  present

#### Scenario: Client searches with a connection scope
- **WHEN** a client calls `search` with `connection_id`
- **THEN** the adapter SHALL restrict search to that granted connection
- **AND** `limit` SHALL apply to that scoped result set

### Requirement: MCP projected reads SHALL narrow payloads and fetch SHALL stay document-shaped

Projection arguments such as `fields` SHALL narrow record payloads returned by
canonical structured read tools. The adapter MAY preserve required operational
envelope keys outside the projected payload when those keys are needed for
source identity, paging, fetching, auditing, or typed retry.

The `fetch` tool SHALL follow the MCP/OpenAI search-fetch document contract. It
SHALL return one document object with `id`, `title`, `text`, `url`, and
`metadata` as `structuredContent`, and SHALL mirror that exact object as
JSON-encoded text in `content[]` for hosts that hide structured output. It
SHALL NOT include the canonical PDPP record envelope or record body under
`structuredContent.data`; canonical structured records remain the job of
`query_records`.

#### Scenario: Client fetches a document from a search result
- **WHEN** a client calls `fetch` with an id returned by `search`
- **THEN** `structuredContent` SHALL contain only the OpenAI-compatible document
  fields `id`, `title`, `text`, `url`, and `metadata`
- **AND** `content[]` SHALL contain a JSON text mirror of the same document
- **AND** the result SHALL NOT include `structuredContent.data`,
  `provider_url`, or `request_id`
- **AND** source identity needed for citation or retry SHALL remain available in
  `metadata`

#### Scenario: Client fetches a projected document
- **WHEN** a client calls `fetch` with `fields`
- **THEN** the adapter SHALL project the source record before rendering the
  document
- **AND** unrequested source-native payload fields SHALL NOT appear in
  `text`, `metadata`, or any other result location
- **AND** source identity needed for follow-up reads and attribution SHALL
  remain available in `metadata`

#### Scenario: Client queries projected records
- **WHEN** a client calls `query_records` with `fields`
- **THEN** each returned record payload SHALL be narrowed to the requested
  fields plus explicitly required identity fields
- **AND** any additional fields that remain SHALL be declared as required
  identity or operational fields in schema or documentation

### Requirement: MCP source ambiguity errors SHALL be bounded and fast
The MCP adapter SHALL return bounded, fast `ambiguous_connection` errors when a
source-required MCP read is invoked against a package containing multiple
configured sources without `connection_id`. It SHALL include enough source
identity for immediate retry on small packages and SHALL cap large-package
candidate lists while pointing the client at `schema` for the full discovery
index.

#### Scenario: Client omits connection identity on a multi-source package
- **WHEN** a client calls a source-required read tool without `connection_id`
  and the package contains more than one configured source
- **THEN** the adapter SHALL return a typed `ambiguous_connection` error with
  `retry_with: "connection_id"`
- **AND** it SHALL NOT fan out child health probes merely to construct the error
- **AND** `available_connections` entries SHALL include `grant_id`,
  `connector_key`, and `connection_id`
- **AND** for large packages the error SHALL include total/truncation metadata
  and a model-visible hint to call `schema` for the full connection index
