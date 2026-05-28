## ADDED Requirements

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
