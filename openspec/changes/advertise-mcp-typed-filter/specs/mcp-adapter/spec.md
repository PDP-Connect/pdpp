## MODIFIED Requirements

### Requirement: MCP Read Tools SHALL Advertise Typed Filter Objects

MCP read tools that support filtering SHALL advertise `filter` as a typed object record in their tool input schemas. The MCP adapter SHALL NOT accept a top-level string filter argument; REST bracket query syntax is an internal adapter encoding detail, not an MCP tool input contract.

#### Scenario: Client lists filtered read tools

- **WHEN** an MCP client calls `tools/list`
- **THEN** `query_records`, `aggregate`, and `search` SHALL advertise `filter` as an object
- **AND** the `filter` schema SHALL describe scalar exact-match values and range operator objects
- **AND** the `filter` schema SHALL NOT expose a top-level string alternative

#### Scenario: String filter is supplied

- **WHEN** an MCP client supplies `filter` as a string
- **THEN** the MCP input SHALL be rejected before the adapter calls the resource server
- **AND** the string SHALL NOT be forwarded as a bare REST `filter=` query parameter.
