## ADDED Requirements

### Requirement: MCP server instructions SHALL carry shared tool-use guidance

The MCP adapter SHALL publish compact server instructions during MCP initialization. The instructions SHALL carry cross-tool guidance that would otherwise be repeated across tool descriptions, including grant-scoped access posture, schema-first discovery, `connection_id` disambiguation, typed object filters, event-subscription preflight, and pagination/result narrowing.

The first 512 characters of the instructions SHALL be self-contained and sufficient for ChatGPT and Codex clients to understand the core PDPP MCP usage pattern.

#### Scenario: Client initializes the MCP server

- **WHEN** an MCP client sends `initialize`
- **THEN** the server response SHALL include an `instructions` field
- **AND** the first 512 characters SHALL mention schema-first discovery, `connection_id` disambiguation, typed filters, and bounded pagination/result narrowing
- **AND** the instructions SHALL NOT ask the client to use owner or control-plane bearer tokens

### Requirement: MCP tool descriptions SHALL avoid duplicated cross-tool prose

MCP tool descriptions and field descriptions SHALL remain concise and action-specific. Cross-tool recovery and protocol guidance SHALL live in server instructions or in the relevant discovery tool, not repeated verbatim across many tool schemas.

#### Scenario: Client lists tools

- **WHEN** an MCP client calls `tools/list`
- **THEN** the same grant-scoped read and event-subscription tool names SHALL remain available
- **AND** repeated `connection_id` recovery guidance SHALL NOT appear verbatim across every tool that accepts `connection_id`
- **AND** repeated event-subscription signing and delivery guidance SHALL appear only on the event-subscription capability-discovery tool

#### Scenario: Tool descriptions remain routable

- **WHEN** an MCP client inspects an individual tool description
- **THEN** the description SHALL still state the action the tool performs, whether it is read-only or mutating, and the primary RS endpoint or capability it maps to
- **AND** it SHALL point to server instructions or a discovery tool for cross-cutting details instead of embedding full duplicated guidance

### Requirement: MCP discovery footprint SHALL be measured

The MCP adapter SHALL include regression coverage for the default `tools/list` payload footprint. The coverage SHALL fail if the default payload exceeds the documented budget for the current surface or if previously removed duplicated long guidance returns.

#### Scenario: Default tool list is generated in tests

- **WHEN** the test harness generates the default MCP `tools/list` payload
- **THEN** the serialized payload SHALL be below the configured byte budget
- **AND** the test SHALL assert that server instructions are present
- **AND** the test SHALL assert that long cross-tool event-subscription and `connection_id` guidance is not repeated across many tool schemas

### Requirement: MCP result surfaces SHALL not claim hidden structured data

The MCP adapter SHALL treat both `content[]` and `structuredContent` as potentially model-visible. Tool descriptions SHALL NOT claim that full data is hidden from model context merely because it is in `structuredContent`. The adapter SHALL keep `content[]` summaries bounded and SHALL guide clients toward pagination, field projection, stream-scoped schema reads, and aggregate/search tools before wide record reads.

#### Scenario: Read tool descriptions mention structured output

- **WHEN** a client inspects read tool descriptions
- **THEN** the descriptions SHALL describe `structuredContent` as structured output, not as hidden output
- **AND** the descriptions SHALL instruct the model to page, narrow fields, or aggregate/search when it does not need full records

#### Scenario: Full result-budget redesign is needed

- **WHEN** a controlled ChatGPT retest proves that PDPP read results are truncated despite bounded `content[]` summaries and page-size limits
- **THEN** a follow-on OpenSpec change SHALL define explicit compact/full model-visible result-detail controls
- **AND** this footprint change SHALL NOT be treated as having solved that separate result-budget problem

### Requirement: MCP adapter SHALL gate `expand` to streams that advertise it

The MCP adapter SHALL reject `expand` and `expand_limit` arguments at the adapter
layer — before forwarding to the RS — when the target stream's schema does not
advertise any `expand_capabilities`. The rejection SHALL be a typed
`invalid_expand` error with a message that names the stream and points the client
to `GET /v1/schema` (`expand_capabilities`) as the capability source.

The check SHALL use a live schema fetch scoped to the stream (and `connection_id`
when supplied) so the enforcement always reflects the current schema document.
When the schema fetch fails or the stream is unknown, the adapter SHALL defer to
the RS (fail-open on schema unavailability).

#### Scenario: Client requests expand on a stream with advertised expand_capabilities

- **WHEN** a client calls `query_records` with `expand` on a stream whose
  `GET /v1/schema` response includes a non-empty `expand_capabilities` array
- **THEN** the adapter SHALL forward the request to the RS
- **AND** the RS response SHALL reach the client unchanged

#### Scenario: Client requests expand on a stream with no expand_capabilities

- **WHEN** a client calls `query_records` or `fetch` with `expand` on a stream
  whose `GET /v1/schema` response has no `expand_capabilities`
- **THEN** the adapter SHALL return a typed `invalid_expand` error before calling
  the RS records endpoint
- **AND** the error message SHALL name the stream
- **AND** the RS records endpoint SHALL NOT be called

#### Scenario: Schema advertisement matches enforcement

- **WHEN** a stream's `expand_capabilities` is updated in the schema document
- **THEN** the adapter SHALL enforce the updated capability on the next call
  without any server restart or configuration change
