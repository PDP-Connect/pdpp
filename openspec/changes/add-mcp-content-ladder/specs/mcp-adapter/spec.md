## ADDED Requirements

### Requirement: MCP record results SHALL expose a bounded content ladder

The MCP adapter SHALL expose every truncated or non-inline record field through a bounded content ladder consisting of model-visible `content[]` text, canonical `structuredContent` metadata, a tool-callable field-window read path, and an MCP resource path when resources are available.

#### Scenario: Search hit has a truncated text field

- **WHEN** an MCP client calls `search` and a returned hit includes a text-like field whose preview is incomplete
- **THEN** the hit preview in `content[]` SHALL include the self-contained result id, field path, truncation status, and a model-visible next step for reading more of that field
- **AND** `structuredContent.results` SHALL include machine-readable continuation metadata for the same record and field
- **AND** the default search response SHALL NOT inline the full field body unless it fits the configured bounded preview limit

### Requirement: MCP adapter SHALL provide a bounded record-field read tool

The MCP adapter SHALL provide a generic tool named `read_record_field` for reading bounded windows from authorized record fields. The tool SHALL accept record identity, field identity, and one bounded window selector, and SHALL return readable text plus continuation metadata.

#### Scenario: Content-only client follows a field read hint

- **WHEN** an MCP client cannot inspect `structuredContent` or MCP resources but can read tool `content[]`
- **AND** the client follows the visible field read hint from a prior `search`, `query_records`, or `fetch` result
- **THEN** the adapter SHALL return a bounded text window for the requested authorized field
- **AND** the response SHALL include enough visible metadata to continue to the next or previous window when adjacent content exists

#### Scenario: Invalid selector combination

- **WHEN** an MCP client calls `read_record_field` with `cursor` plus `offset_chars` or `q`
- **THEN** the adapter SHALL reject the call before any resource-server read
- **AND** the error SHALL explain that cursor continuation is exclusive with explicit window selection

### Requirement: MCP adapter SHALL use the fixed record-field contract

The `read_record_field` input SHALL use `id` plus `field_path` or `connection_id` plus `stream` plus `record_id` plus `field_path`. The output `structuredContent` SHALL include `record`, `field`, `window`, and optional `resource` objects conforming to the schema in the `add-mcp-content-ladder` design.

#### Scenario: Tool schema is inspected

- **WHEN** an MCP client calls `tools/list`
- **THEN** the `read_record_field` tool SHALL advertise the fixed input schema
- **AND** the tool SHALL advertise an output schema that validates the `structuredContent` result

### Requirement: MCP record and field resources SHALL mirror tool-window reads

The MCP adapter SHALL expose `pdpp://record/{handle}` and `pdpp://field-window/{handle}` MCP resource templates for resource-aware clients. A field resource read SHALL enforce the same authorization and window bounds as `read_record_field` for the same record, field, and window.

#### Scenario: Resource-aware client reads a linked field window

- **WHEN** a tool result includes a `resource_link` for a field window
- **AND** an MCP client calls `resources/read` for that URI with the same scoped client token
- **THEN** the adapter SHALL return the same authorized field window content represented by the tool fallback
- **AND** the resource response SHALL expose a standard continuation URI when adjacent content exists

### Requirement: MCP content ladder handles SHALL remain grant scoped

Content ladder handles, cursors, and resource URIs SHALL identify continuation state only. They SHALL NOT authorize access by themselves, and every read SHALL be enforced through the active scoped PDPP client token and the resource-server grant boundary.

#### Scenario: Handle points outside active grant

- **WHEN** an MCP client presents a syntactically valid content ladder handle for a record or field outside the active grant
- **THEN** the adapter SHALL fail with the same authorization semantics as the underlying resource-server read
- **AND** the adapter SHALL NOT use handle contents to bypass stream, field, time-range, or connection constraints

### Requirement: MCP bounded field reads SHALL be enforced below the adapter

The MCP adapter SHALL NOT satisfy bounded field reads by fetching an entire large field into MCP and slicing it only after grant enforcement. Bounded field windows SHALL be served by an existing or new grant-enforced resource-server path that applies stream, field, time-range, and connection constraints before returning field bytes to the adapter.

#### Scenario: Resource-server field-window path is missing

- **WHEN** existing resource-server APIs cannot return a bounded authorized field window without returning the full field body to MCP
- **THEN** the implementation SHALL add a resource-server field-window path before enabling `read_record_field`

### Requirement: MCP adapter SHALL NOT expose opaque-only content markers

The MCP adapter SHALL NOT make a non-standard opaque marker the only model-visible representation of a record body, field body, or continuation path. Any opaque handle visible to the model SHALL be paired with a standard MCP tool or resource read path.

#### Scenario: Large body would exceed output budget

- **WHEN** a record body is too large for the configured preview budget
- **THEN** the adapter SHALL return a bounded preview and standard continuation metadata
- **AND** the adapter SHALL NOT replace the body with only a custom marker that the MCP client cannot expand through a registered tool or resource

### Requirement: MCP adapter SHALL keep binary bodies out of default tool text

The MCP adapter SHALL represent large binary or blob fields in default tool responses using metadata and resource or export handles rather than base64-inlining the body.

#### Scenario: Record contains a large binary field

- **WHEN** `query_records`, `search`, or `fetch` includes a record with a large binary field
- **THEN** the adapter SHALL expose MIME type, size or size grade when known, digest when available, and a standard resource or export path
- **AND** the adapter SHALL NOT inline the large binary body in default `content[]` text
