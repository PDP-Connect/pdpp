## ADDED Requirements

### Requirement: MCP Surfaces A Complete Evidence Ladder

The MCP adapter SHALL expose an evidence ladder in model-visible output: compact discovery, bounded visible evidence, explicit bounded field/window read, and full fetch or export only when needed.

#### Scenario: Content-only client can inspect proven search evidence

**WHEN** an MCP client receives only `content[]` text from a search response
**AND** the resource server returns a proven matched text window
**THEN** the model-visible text SHALL include a bounded preview of the matched field
**AND** the preview SHALL include enough identity to request the bounded field/window read
**AND** the adapter SHALL NOT rely on hidden `structuredContent` as the only path to the evidence.

#### Scenario: Search evidence includes bounded surrounding context

**WHEN** a search result match occurs inside an ordinary text field with surrounding visible text
**THEN** the evidence preview SHALL include bounded surrounding text around the marked match
**AND** the preview SHALL NOT collapse to only the highlighted query term unless the source field has no additional visible text available.

#### Scenario: Preview without proven body match does not invent evidence

**WHEN** a search result matches only metadata or an unproven field
**THEN** the adapter SHALL NOT render a body/text evidence window
**AND** it SHALL expose an explicit bounded-read or fetch path for further inspection.

### Requirement: Visible Handles Are Not Dead Ends

The MCP adapter SHALL ensure every visible record, field, field-window, cursor, or export handle has a model-callable continuation.

#### Scenario: Record URI appears in visible output

**WHEN** model-visible text or structured content includes a `pdpp://record/...` URI
**THEN** the adapter SHALL either make that URI readable through MCP resource reading
**OR** accept that URI directly in the documented model-callable read tools that operate on the record
**AND** visible instructions SHALL identify the callable path.

#### Scenario: Field-window URI appears in visible output

**WHEN** model-visible text or structured content includes a `pdpp://field-window/...` URI
**THEN** the adapter SHALL either make that URI readable through MCP resource reading
**OR** accept that URI directly in a documented model-callable bounded field/window read
**AND** failure of generic resource reading SHALL NOT be the only available next step.

#### Scenario: Ordinary bounded reads hide unreliable field-window resources

**WHEN** a bounded field read returns ordinary inline text and the reliable continuation path is `read_record_field`
**THEN** the adapter SHALL expose inline text, offsets, truncation state, match metadata when available, and next/previous `read_record_field` arguments
**AND** the adapter SHALL NOT expose a model-visible `pdpp://field-window/...` URI unless that URI is proven readable through the host's generic resource reader.

### Requirement: Ordinary Evidence Stays Inline

The MCP adapter SHALL return ordinary small text evidence inline rather than forcing host file materialization.

#### Scenario: Small granted text field is read

**WHEN** the model calls the bounded field/window read for a granted small text field
**THEN** the adapter SHALL return inline text with total size, served range, completion state, and continuation metadata
**AND** it SHALL NOT return only a resource link or file attachment.

### Requirement: Large Data Escalates Deliberately

The MCP adapter SHALL expose large text, JSON, blob, binary, and multi-record outputs through bounded previews plus explicit read/export escalation.

#### Scenario: Large or binary field is inspected

**WHEN** a granted field is too large or binary for safe inline display
**THEN** the adapter SHALL return metadata, size, media type when known, and a bounded preview when safe
**AND** it SHALL provide an explicit read or export continuation
**AND** it SHALL NOT silently truncate as if complete.

### Requirement: MCP Evidence Semantics Have REST And CLI Parity

Reference implementation REST and CLI surfaces SHALL expose the same evidence ladder concepts as MCP using surface-appropriate names.

#### Scenario: REST search returns a proven match window

**WHEN** REST search returns a result with a proven matched field window
**THEN** the response SHALL include a first-class bounded evidence descriptor with field path, preview, truncation state, and read continuation metadata.

#### Scenario: CLI user inspects a search result

**WHEN** a CLI user searches records and receives a bounded evidence preview
**THEN** the CLI SHALL expose a command or documented invocation to read the corresponding bounded field/window without requiring a full record export.
