## MODIFIED Requirements

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
