## MODIFIED Requirements

### Requirement: MCP Read Tools SHALL Advertise Typed Filter Objects

MCP read tools that support filtering SHALL advertise `filter` as a typed object record in their tool input schemas. The MCP adapter SHALL preserve runtime compatibility for legacy literal bracket filter strings, but the advertised schema SHALL NOT expose a top-level string branch that causes chat-hosted clients to hide typed filter objects.

#### Scenario: Client lists filtered read tools

- **WHEN** an MCP client calls `tools/list`
- **THEN** `query_records`, `aggregate`, and `search` SHALL advertise `filter` as an object
- **AND** the `filter` schema SHALL describe scalar exact-match values and range operator objects
- **AND** the `filter` schema SHALL NOT expose a top-level string alternative

#### Scenario: Legacy string filter is supplied

- **WHEN** an existing MCP client supplies a literal bracket filter string
- **THEN** the adapter SHALL parse and forward it as bracket query parameters when unambiguous
- **AND** malformed strings SHALL return an actionable MCP error rather than silently widening the query.
