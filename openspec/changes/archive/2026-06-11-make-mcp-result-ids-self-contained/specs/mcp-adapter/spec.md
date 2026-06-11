## ADDED Requirements

### Requirement: MCP Search Result Ids Are Self-Contained Fetch Handles

Search result ids SHALL be single opaque handles sufficient to fetch the
result with no additional argument. When a hit carries a source connection,
the adapter SHALL encode it into the id using the grammar
`{connection_id}/{stream}:{record_id}`. `/` is reserved as the connection
separator because the adapter rejects `/` inside connection ids, stream names,
and record ids, so a `/` unambiguously marks the self-contained form and every
legacy `stream:record_id` id keeps parsing unchanged. The complete id SHALL
appear in model-visible `content[]` text as well as `structuredContent.results`;
an id SHALL NOT be truncated in text below usability as a fetch handle.

The `fetch` tool SHALL accept both grammars. For a self-contained id the
adapter SHALL forward the embedded connection to the resource server as the
canonical `connection_id` query parameter; the adapter SHALL NOT invent or
rewrite connection ids and the resource server SHALL remain the authority on
grant scope. For a legacy id the existing semantics — optional `connection_id`
argument, typed `ambiguous_connection` 409 on unscoped multi-source reads —
SHALL be preserved. Every id segment SHALL be validated against path traversal
before any resource-server call. The adapter SHALL NOT wrap base ids that are
not record handles (such as URL fallbacks) and SHALL NOT wrap when the
connection id cannot survive the grammar.

#### Scenario: Multi-source search returns self-contained ids

- **WHEN** an MCP client calls `search` and the resource server returns hits
  from more than one connection
- **THEN** each result id SHALL embed that hit's connection as
  `{connection_id}/{stream}:{record_id}`
- **AND** the complete id SHALL appear in both `content[]` text and
  `structuredContent.results`
- **AND** `structuredContent.results` entries SHALL still carry the discrete
  `connection_id` source handle

#### Scenario: Single-handle search-to-fetch journey on a multi-source grant

- **WHEN** a model consumes only the search result `content[]` text, extracts
  a previewed id, and calls `fetch` with that id and no other argument against
  a grant where the unscoped record read would be ambiguous
- **THEN** the adapter SHALL forward the embedded connection as the canonical
  `connection_id` query parameter
- **AND** the fetch SHALL succeed without an `ambiguous_connection` error
- **AND** the returned document id SHALL echo the self-contained handle

#### Scenario: Legacy id semantics are preserved

- **WHEN** an MCP client calls `fetch` with a legacy `stream:record_id` id
- **THEN** the call SHALL behave exactly as before this change: an optional
  `connection_id` argument scopes the read, and an unscoped read of an
  ambiguous record SHALL surface the resource server's typed
  `ambiguous_connection` envelope

#### Scenario: Conflicting connection handles are rejected

- **WHEN** an MCP client calls `fetch` with a self-contained id embedding one
  connection and a `connection_id` argument naming a different connection
- **THEN** the adapter SHALL return a typed, actionable error rather than
  silently preferring either handle
- **AND** the adapter SHALL NOT call the resource server

#### Scenario: Malformed self-contained ids are rejected before the RS

- **WHEN** an MCP client calls `fetch` with an id whose connection, stream, or
  record segment is empty, contains additional separators, or embeds path
  traversal
- **THEN** the adapter SHALL reject the id with a typed error
- **AND** the adapter SHALL NOT call the resource server

## MODIFIED Requirements

### Requirement: MCP Search Results Are Usable In Tool Text

The MCP adapter SHALL include a bounded preview of search hits in the search
tool result `content[]` text, not only a hit count or a pointer to
`structuredContent`. Each previewed hit SHALL include the complete result id —
a self-contained fetch handle — and SHALL include available source labels such
as `connector_key`, display label, and stream when present. The preview SHALL
NOT repeat `connection_id` as a separate field when it is already embedded in
the id; it SHALL show `connection_id` separately only for a hit whose id could
not embed it. The text SHALL stay compact and SHALL NOT dump the full JSON
envelope. The `structuredContent.data` payload SHALL remain the canonical
envelope, and `structuredContent.results` SHALL remain the flattened search
projection for clients that can inspect structured tool results.

#### Scenario: Search surfaces fetch handles in text

- **WHEN** an MCP client calls the search tool and the resource server returns
  one or more hits
- **THEN** the tool result `content[]` text SHALL include a bounded top-hit
  preview with each previewed hit's complete self-contained id
- **AND** when a previewed hit has stream, display label, connector key,
  title, or snippet information, the text SHALL include the available values
  within the preview budget
- **AND** the text SHALL tell the agent to fetch a hit by passing the shown id
  as-is, and to pass `connection_id` only when it is shown separately

#### Scenario: Search text remains bounded

- **WHEN** the resource server returns many hits or large snippets
- **THEN** the MCP adapter SHALL keep `content[]` text bounded
- **AND** it SHALL preserve the full canonical search envelope in
  `structuredContent.data`
