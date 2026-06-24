## MODIFIED Requirements

### Requirement: MCP Search Surfaces Bounded Evidence

The MCP adapter SHALL render search results so a client that only exposes
`content[]` can decide whether to inspect a result further without reading
`structuredContent`.

#### Scenario: Search hit has a proven match window

- **WHEN** the resource server returns a search hit with a proven text match
  window
- **THEN** the MCP visible text SHALL include a bounded preview of that matched
  window
- **AND** the visible text SHALL identify the record and matched field enough for
  a model to call the continuation tool
- **AND** `structuredContent.results[]` and `structuredContent.content_ladder.records[]`
  SHALL include a bounded scalar evidence preview for the same proven matched
  window
- **AND** the full machine envelope MAY remain in `structuredContent`

#### Scenario: Search hit lacks a proven match window

- **WHEN** the resource server returns a search hit without a proven text match
  window
- **THEN** the MCP visible text SHALL NOT infer a matched body field from
  connector, stream, or field names
- **AND** the visible text SHALL still expose record identity and an explicit
  fetch or field-read continuation when available

### Requirement: MCP Continuations Are Not Resource-Only

Every visible incomplete text preview in an MCP response SHALL have a
model-callable continuation path in addition to any MCP resource URI.

#### Scenario: Host cannot read MCP resources

- **WHEN** a visible search or fetch preview is incomplete
- **AND** the host does not expose a working MCP resource-read path
- **THEN** the model SHALL still be able to continue through an MCP tool call
  using visible arguments or an opaque handle

#### Scenario: Host can read MCP resources

- **WHEN** a host reads a `pdpp://field-window/...` resource URI exposed by MCP
- **THEN** the returned window SHALL be grant-scoped and semantically equivalent
  to the corresponding MCP field-read tool result for the same selector

### Requirement: Small Text Reads Stay Inline

The MCP adapter SHALL keep ordinary bounded text inspection inline. Full resource
or file materialization is reserved for bulk, large, or binary content.

#### Scenario: Agent inspects one small text field

- **WHEN** the model calls the MCP field-read tool for a granted small text field
- **THEN** the response SHALL include the text window inline in `content[]`
- **AND** the response SHALL expose completeness and continuation state
- **AND** the response SHALL NOT require file materialization

### Requirement: MCP Small Evidence Avoids Incidental Materialization

MCP adapter SHALL keep ordinary small evidence inline and SHALL NOT emit `content[]` resource links for ordinary small text reads or projected small-record fetches. Field-window resource URIs SHALL NOT be exposed in model-visible `content[]` or `structuredContent`; they MAY remain available in hidden tool-result metadata for hosts that explicitly support MCP resource reads.

#### Scenario: Hosted client reads one small field window

- **WHEN** the model calls the MCP field-read tool for a granted small text field
- **THEN** the response SHALL include the text window inline in `content[]`
- **AND** the response SHALL NOT include a `content[]` `resource_link`
- **AND** the response MAY expose a resource URI in hidden tool-result metadata
- **AND** a host that explicitly supports MCP resources SHALL be able to read that URI through `resources/read`

#### Scenario: Hosted client fetches projected small fields

- **WHEN** the model calls `fetch` with a field projection that produces a small document
- **THEN** the response SHALL include the projected document inline in `content[]`
- **AND** the response SHALL NOT include a `content[]` `resource_link`
- **AND** the response SHALL preserve any record resource URI in `structuredContent`

### Requirement: MCP Search Evidence Appears Before Wrappers

MCP adapter SHALL render proven search match-window evidence before generic search wrappers, handle lists, or resource metadata in visible `content[]`.

#### Scenario: Hosted client reads only visible search text

- **WHEN** MCP search has proven match-window evidence for a hit
- **THEN** `content[]` SHALL render a compact evidence excerpt before generic result wrappers
- **AND** the excerpt SHALL include matched field path, bounded snippet, self-contained result id, and model-callable read tool hint
- **AND** the excerpt SHALL NOT rely on a `pdpp://field-window/...` URI as the only visible continuation

#### Scenario: Visible record URI is a bounded-read handle
- **WHEN** a search result exposes a `record_uri` value in visible text or structured content
- **AND** the model calls the MCP field-read tool with that `record_uri` as the record identity
- **THEN** the MCP adapter SHALL resolve the URI to the same grant-scoped record as the self-contained result id
- **AND** the bounded field read SHALL return inline text when the requested field window is ordinary small text
- **AND** failure of a generic MCP `resources/read` call for that URI SHALL NOT by itself make the visible item a dead end
