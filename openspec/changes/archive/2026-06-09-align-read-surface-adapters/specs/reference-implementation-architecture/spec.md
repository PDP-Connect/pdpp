## ADDED Requirements

### Requirement: Public read semantics SHALL be operation-owned and adapter-shared

The reference implementation SHALL implement public read semantics in canonical
resource-server operations or shared pure read-surface transforms. REST route
handlers, hosted package helpers, MCP tools, and CLI commands SHALL delegate to
that shared substrate for visibility, source resolution, schema projection,
filter validation, projection, sorting, pagination, fan-in limiting, warnings,
and typed error construction. Adapters SHALL own only transport concerns:
authentication lookup, argument parsing/serialization, protocol input-schema
validation, and presentation.

#### Scenario: Adapter handles a read request
- **WHEN** a REST route, MCP tool, hosted package read helper, or CLI command
  performs a public read
- **THEN** visibility, source disambiguation, query validation, projection,
  pagination, warning construction, and error classification SHALL be produced
  by canonical operations or shared read-surface transforms
- **AND** the adapter SHALL NOT reimplement those semantics locally

#### Scenario: Adapter adds presentation
- **WHEN** a transport needs presentation-specific output such as MCP
  `content[]`, CLI table formatting, or REST links
- **THEN** the adapter MAY add that presentation after receiving the canonical
  result
- **AND** it SHALL NOT change the canonical query semantics or source identity

### Requirement: Schema source scoping SHALL be transport-invariant

The canonical schema-discovery primitive SHALL support compact global discovery,
stream-name scoping, and source scoping by canonical `connection_id`. REST,
hosted package reads, MCP, and CLI SHALL expose or consume the same primitive so
common stream names can be narrowed to one configured source without loading a
broad full-schema document.

#### Scenario: Caller scopes schema by stream and connection
- **WHEN** a grant-authorized caller requests schema for a stream and a
  `connection_id`
- **THEN** the canonical schema operation or shared schema transform SHALL return
  only the matching configured source and stream
- **AND** REST, MCP, and CLI SHALL NOT compute different source-scoped schema
  documents for the same grant and request

#### Scenario: Caller requests full detail for an ambiguous stream
- **WHEN** a full-detail schema request names a stream that exists under more
  than one granted source and omits `connection_id`
- **THEN** the read surface SHALL return a typed ambiguity response identifying
  `connection_id` as the retry selector
- **AND** it SHALL NOT return a multi-source full-schema dump as the default
  fallback

### Requirement: Read-surface parity SHALL be verified across REST, MCP, and CLI

The reference implementation SHALL include regression coverage that exercises
REST, MCP, and CLI against the same grant-scoped read matrix. The matrix SHALL
cover schema discovery, source identity, strict projection, fan-in search limits,
pagination/count handles, typed ambiguity, and owner-token exclusion. Transport
specific assertions SHALL remain isolated to the transport they describe.

#### Scenario: Shared read behavior regresses in one adapter
- **WHEN** REST, MCP, or CLI diverges on canonical read behavior for the same
  grant, stream, source, and query shape
- **THEN** the read-surface parity tests SHALL fail
- **AND** the failure SHALL identify the divergent surface

#### Scenario: Transport-specific behavior is tested
- **WHEN** a behavior is protocol-specific, such as MCP `tools/list` membership,
  MCP `content[]` handles, CLI token-cache hygiene, or REST `links.next`
- **THEN** the behavior SHALL be tested as a transport-specific assertion
- **AND** it SHALL NOT be used to justify divergent canonical read semantics

## MODIFIED Requirements

### Requirement: MCP read tools SHALL mirror the canonical public read contract

The in-repo MCP server and hosted MCP gateway SHALL mirror the canonical public
read contract instead of defining a separate read API. MCP tool input schemas
SHALL expose the same public arguments as REST where the normal MCP surface
includes the corresponding operation, including the same documented bounds.
For canonical structured read tools, `structuredContent` SHALL carry the
canonical operation body and prose `content[]` SHALL be a concise summary only.
MCP-only presentation wrappers, including document-shaped `fetch`, SHALL be
generated from canonical public read results and SHALL NOT define a separate
record-detail semantic contract.

#### Scenario: MCP structured tool returns structured content
- **WHEN** an MCP client calls a canonical structured read tool such as
  `query_records`, `search`, `schema`, or `aggregate`
- **THEN** the tool response SHALL include `structuredContent` matching the
  canonical read envelope or operation body
- **AND** any text content SHALL be a human or model-visible summary rather than
  a second divergent contract

#### Scenario: MCP fetch uses document presentation
- **WHEN** an MCP client calls `fetch`
- **THEN** the tool MAY return the MCP/OpenAI document shape required by the
  search-fetch contract
- **AND** the document SHALL be rendered from canonical record/search data
- **AND** canonical structured record retrieval SHALL remain available through
  `query_records` or the REST record-detail contract

#### Scenario: MCP validates arguments through the same contract
- **WHEN** an MCP client supplies filters, fields, sort, expand, count, cursor,
  or `connection_id`
- **THEN** the MCP server SHALL forward or validate them according to the same
  canonical public read contract as REST
- **AND** it SHALL NOT silently drop arguments that the REST surface would
  reject

#### Scenario: MCP enforces the records-list limit cap at input validation
- **WHEN** an MCP client calls `query_records` with a `limit` greater than the
  contract maximum page size (100)
- **THEN** the MCP `query_records` input schema SHALL advertise the maximum as
  an inclusive bound of 100
- **AND** the MCP server SHALL reject the over-max `limit` at input validation
  rather than forwarding it to the RS to be silently clamped
- **AND** a `limit` within the maximum (including exactly the maximum) SHALL be
  accepted and forwarded

#### Scenario: MCP enforces the search limit cap at input validation
- **WHEN** an MCP client calls `search` with a `limit` greater than the
  advertised maximum page size (100)
- **THEN** the MCP `search` input schema SHALL advertise the maximum as an
  inclusive bound of 100
- **AND** the MCP server SHALL reject the over-max `limit` at input validation
  rather than forwarding it to the RS to be silently clamped
- **AND** a `limit` within the maximum (including exactly the maximum) SHALL be
  accepted and forwarded
- **AND** the MCP `search` path SHALL NOT rely on the REST `limit_clamped`
  warning, because it rejects an over-max `limit` before any clamp occurs
