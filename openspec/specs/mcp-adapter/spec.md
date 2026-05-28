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
The MCP adapter SHALL expose only read-only MCP tools/resources that map to existing grant-enforced PDPP resource-server reads. Returned data SHALL be no broader than the resource server returns for the configured token.

#### Scenario: Agent lists streams
- **WHEN** an MCP client calls the stream-listing tool
- **THEN** the adapter SHALL call `GET /v1/streams` with the configured scoped token and return only the streams authorized by that token

#### Scenario: Agent queries records
- **WHEN** an MCP client calls the record-query tool with stream, pagination, field, view, filter, order, expand, or `changes_since` arguments supported by the RS
- **THEN** the adapter SHALL forward those supported arguments to the RS without broadening scope and SHALL reject unsupported MCP arguments rather than inventing query semantics

#### Scenario: Agent fetches a blob
- **WHEN** an MCP client asks to fetch a blob reference returned by a prior authorized record read
- **THEN** the adapter SHALL fetch through the existing RS blob endpoint with the same scoped token and SHALL NOT construct direct source-platform or local-filesystem access

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

