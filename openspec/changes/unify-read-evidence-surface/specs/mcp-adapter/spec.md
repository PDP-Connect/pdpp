## MODIFIED Requirements

### Requirement: Stdio MCP Adapter Uses Scoped PDPP Tokens

The MCP adapter SHALL expose model-controlled read tools over grant-scoped PDPP client tokens. The adapter SHALL NOT issue grants, request new authorization, run connectors, access reference owner-control endpoints, or broaden the grant scope.

#### Scenario: Agent follows omitted content through a model-controlled read

**WHEN** a tool result's visible `content[]` omits, truncates, summarizes, or references underlying record content
**THEN** the result SHALL expose a working model-controlled continuation path, such as a fetch handle, `read_record_field` arguments, or a cursor
**AND** the continuation SHALL remain inside the same grant and source/stream/field scope.

#### Scenario: Host hides structured content

**WHEN** an MCP host exposes only visible `content[]` to the model
**THEN** search/query/fetch results SHALL still include enough bounded evidence and continuation instructions for the model to decide what to inspect next
**AND** SHALL NOT require `structuredContent` as the only path to record identity or continuation.

### Requirement: MCP Adapter Surfaces Resource Links Without Depending On Them

The MCP adapter MAY return MCP `resource_link` blocks and resource templates for host-controlled reads. The adapter SHALL NOT make `resources/read` the only path to additional model-needed content.

#### Scenario: Resource read is unavailable

**WHEN** an MCP host cannot read a returned `pdpp://...` resource URI
**THEN** the same omitted or truncated content SHALL remain reachable through a model-controlled tool path when the active grant authorizes it.

#### Scenario: Small text inspection avoids materialization

**WHEN** an agent inspects a bounded text field or small record excerpt that fits within the configured inline read window
**THEN** the MCP adapter SHALL provide a model-visible inline read path
**AND** SHALL NOT require full file/export materialization as the ordinary path for that inspection.

### Requirement: MCP Adapter Uses Shared Evidence Semantics

The MCP adapter SHALL render evidence cards, truncation descriptors, binary metadata, declared-role presentation, and continuation descriptors using the shared read/evidence semantics rather than MCP-only presentation rules.

#### Scenario: Manifest roles determine presentation

**WHEN** a record field has a manifest-authored display role
**THEN** MCP evidence presentation MAY use that role
**AND** SHALL NOT use connector-specific or field-name guessing to promote undeclared fields.

#### Scenario: Binary field appears in a record

**WHEN** a record contains a large binary, blob, image, attachment, or base64-like field
**THEN** MCP visible output SHALL keep that field metadata-only by default
**AND** SHALL expose an authorized resource/export continuation when available, using the grant-scoped blob read route such as `GET /v1/blobs/:blob_id` for stored blob content
**AND** SHALL NOT inline the large binary body into model-visible text.
