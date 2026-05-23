## ADDED Requirements

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
