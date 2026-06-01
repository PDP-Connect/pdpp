## MODIFIED Requirements

### Requirement: Public read warnings SHALL be structured and closed over known non-fatal outcomes
The reference implementation SHALL report non-fatal lossiness, compatibility behavior, approximation, skipped sources, partial results, or a clamped page limit through structured `meta.warnings` entries with stable codes. Warnings SHALL NOT become a prose-only catch-all.

#### Scenario: Source is skipped as not applicable
- **WHEN** a multi-source public read skips a source because the requested stream or field is not applicable
- **THEN** the response MAY still succeed for applicable sources
- **AND** it SHALL include a structured warning identifying the skipped source and reason.

#### Scenario: Deprecated alias is accepted
- **WHEN** a request succeeds because the server accepted a deprecated compatibility alias
- **THEN** the response SHALL include a warning code for deprecated alias usage unless the operation's migration window explicitly suppresses warnings for that alias.

#### Scenario: Records-list limit is clamped to the page maximum
- **WHEN** a records-list read receives a `limit` greater than the contract maximum page size (100)
- **THEN** the response SHALL return at most the maximum page size of records rather than rejecting the request
- **AND** the response SHALL include a structured `meta.warnings` entry with the stable code `limit_clamped` identifying the requested limit and the effective maximum
- **AND** a request whose `limit` is within the maximum (including exactly the maximum) SHALL NOT include a `limit_clamped` warning
- **AND** a request whose `limit` is absent, non-positive, or unparseable SHALL fall back to the default page size and SHALL NOT include a `limit_clamped` warning
- **AND** under multi-connection fan-in the response SHALL include at most one `limit_clamped` warning regardless of how many connections were queried.

### Requirement: MCP read tools SHALL mirror the canonical public read contract
The in-repo MCP server and hosted MCP gateway SHALL mirror the canonical public read contract instead of defining a separate read API. MCP tool input schemas SHALL expose the same public arguments as REST, including the same documented bounds, tool output schemas SHALL describe the canonical envelope, `structuredContent` SHALL carry the canonical body, and prose `content[]` SHALL be a concise summary only.

#### Scenario: MCP tool returns structured content
- **WHEN** an MCP client calls a read tool such as `query_records`, `search`, `fetch`, `list_streams`, `schema`, or `aggregate_records`
- **THEN** the tool response SHALL include `structuredContent` matching the canonical read envelope or operation body
- **AND** any text content SHALL be a human summary rather than a second divergent contract.

#### Scenario: MCP validates arguments through the same contract
- **WHEN** an MCP client supplies filters, fields, sort, expand, count, cursor, or `connection_id`
- **THEN** the MCP server SHALL forward or validate them according to the same canonical public read contract as REST
- **AND** it SHALL NOT silently drop arguments that the REST surface would reject.

#### Scenario: MCP enforces the records-list limit cap at input validation
- **WHEN** an MCP client calls `query_records` with a `limit` greater than the contract maximum page size (100)
- **THEN** the MCP `query_records` input schema SHALL advertise the maximum as an inclusive bound of 100
- **AND** the MCP server SHALL reject the over-max `limit` at input validation rather than forwarding it to the RS to be silently clamped
- **AND** a `limit` within the maximum (including exactly the maximum) SHALL be accepted and forwarded.
