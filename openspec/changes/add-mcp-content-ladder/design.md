# MCP content ladder design

## Context

PDPP exposes grant-scoped personal data through MCP to agent clients with uneven support for MCP response features. Current adapter work already made three important decisions:

- `content[]` must remain useful because some clients expose tool text more reliably than `structuredContent`.
- `structuredContent.data` remains the canonical machine envelope for clients that can consume it.
- Search result ids are self-contained fetch handles, so agents do not need to carry separate `connection_id` values.

The remaining gap is large-content navigation. A compact snippet, a `structuredContent` body, or a non-standard transcript marker is not enough when an agent needs to inspect the rest of an email, Slack message, ChatGPT turn, PDF-derived text, or arbitrary connector record field. The research notes in `docs/research/mcp-large-data-surface-patterns-2026-06-22.md` and `docs/research/mcp-content-ladder-slvp-research-2026-06-22.md` converge on the same design: `compact summary -> typed preview with handle -> bounded read window -> resource read/export`.

The design follows the MCP 2025-11-25 split between model-controlled tools, application-driven resources, tool `content[]`, `structuredContent`, `resource_link` content blocks, and `resources/read`. The current MCP spec says tool results may include resource links, resource links returned by tools are not guaranteed to appear in `resources/list`, and structured results with an output schema must conform to that schema. Those facts are why PDPP needs both a model-callable tool fallback and standard resource links. It treats OpenAI Apps SDK resource-backed UI/file patterns as evidence for the model-visible/text vs. resource-backed split, not as PDPP protocol authority.

## Goals

- Preserve token efficiency for default `schema`, `query_records`, `search`, and `fetch` calls.
- Ensure every truncated text-like field has a model-visible continuation path.
- Support clients that only expose tool text, clients that consume `structuredContent`, and clients that support MCP resources.
- Keep full reads grant-scoped and routed through the resource-server authorization boundary.
- Avoid connector-specific rules. The ladder applies to arbitrary manifest-declared streams and fields.

## Non-goals

- Do not add owner-control or connector-running behavior to MCP.
- Do not make resources the only full-read path.
- Do not inline unbounded text or base64 bodies into default tool responses.
- Do not add per-connector MCP tools.
- Do not define a new PDPP Core protocol requirement; this is reference MCP adapter behavior.

## Content ladder

### Tier 0: compact tool text

`query_records`, `search`, and `fetch` continue to return bounded `content[]` text. The text must include enough information for a content-only client to identify the record, distinguish complete vs. truncated previews, and know the next tool call to make.

When a field preview is incomplete, the text includes:

- record handle or result id;
- field path;
- preview range or snippet coordinates when available;
- `read_record_field` hint with required arguments;
- resource URI when available.

### Tier 1: canonical structured metadata

`structuredContent` carries the canonical machine-readable envelope. For records and search hits, it includes a `content_ladder` metadata block for each previewed long field:

- record identity: self-contained id plus discrete `connection_id`, `stream`, and `record_id` when available;
- field identity: path, type, MIME type when known, size grade, and text/binary classification;
- preview status: complete, truncated, snippet-only, binary-only, or unavailable;
- continuation handles: tool cursor and resource URI;
- digest or revision when available so clients can detect stale windows.

### Tier 2: bounded field-window tool

Add one generic tool, `read_record_field`, for text-like record fields. It accepts either a self-contained result id or explicit `connection_id` + `stream` + `record_id`, plus a field path and one bounded window selector.

Window selectors:

- `cursor` for opaque continuation from a previous read. When `cursor` is present, `offset_chars`, `q`, `before_chars`, and `after_chars` are rejected.
- `offset_chars` and `limit_chars` for deterministic character windows when the field is stable text.
- `q` with `before_chars` and `after_chars` for a match-centered window when the agent is trying to inspect a specific term. When `q` is present, `offset_chars` is rejected.

The tool returns readable text in `content[]` and the same window metadata in `structuredContent`. It never returns unbounded full text by default. It includes `next_cursor` and `previous_cursor` when adjacent windows exist.

Default bounds:

- `limit_chars` defaults to 4096.
- `limit_chars` is capped at 16384.
- `before_chars` and `after_chars` default to 2048 each and are capped at 8192 each.
- All cursors are opaque, URL-safe, and bound to record id, field path, field revision or digest when available, and the active grant constraints.

### Tier 3: MCP resources

Register MCP resources for record and field reads. Tool results include standard `resource_link` content blocks for clients that support them.

Resource templates:

- `pdpp://record/{handle}`
- `pdpp://field-window/{handle}`

Use URL-safe opaque handles in resource URIs rather than raw path segments, because stream names, record ids, and field paths can contain characters that are awkward or unsafe in template paths. Handles are identifiers, not authorization grants; every resource read still uses the current MCP access token and resource-server enforcement.

Resource reads are equivalent to field-window tool reads for the same record, field, and window. Large field resources return bounded windows and next/previous resource URIs rather than a surprise full-body dump. A later export resource can provide archive-style access for clients that explicitly want a full record set or binary artifact.

### Tier 4: binary and export handling

Binary or large blob fields are not base64-inlined by default. The adapter returns MIME type, size when known, digest when available, and a resource/export handle. Text extraction may still be exposed as a field-window path when the resource server has text for that blob.

## Client compatibility matrix

The implementation must test three client classes:

- Content-only: ignores `structuredContent` and resource blocks, but can complete a search-to-full-evidence task using visible text and `read_record_field`.
- Structured-content-aware: reads `structuredContent.results` and `content_ladder` metadata and can call `fetch` and `read_record_field` without parsing prose.
- Resource-aware: follows `resource_link` URIs through `resources/read` and can page adjacent windows.

Named client smoke coverage should be opportunistic for Codex, Claude Code/Desktop, Gemini CLI, Hermes, opencode, Cursor, ChatGPT, and Claude app surfaces, but CI should not depend on live hosted clients. CI must simulate the three behavior classes above.

## Fixed tool contract

`read_record_field` input schema:

```json
{
  "type": "object",
  "oneOf": [
    { "required": ["id", "field_path"] },
    { "required": ["connection_id", "stream", "record_id", "field_path"] }
  ],
  "properties": {
    "id": { "type": "string" },
    "connection_id": { "type": "string" },
    "stream": { "type": "string" },
    "record_id": { "type": "string" },
    "field_path": { "type": "string" },
    "cursor": { "type": "string" },
    "offset_chars": { "type": "integer", "minimum": 0 },
    "limit_chars": { "type": "integer", "minimum": 1, "maximum": 16384 },
    "q": { "type": "string" },
    "before_chars": { "type": "integer", "minimum": 0, "maximum": 8192 },
    "after_chars": { "type": "integer", "minimum": 0, "maximum": 8192 }
  },
  "additionalProperties": false
}
```

Selector validation:

- `cursor` is exclusive with `offset_chars`, `q`, `before_chars`, and `after_chars`.
- `q` is exclusive with `offset_chars`.
- `before_chars` and `after_chars` require `q`.
- Missing selector means `offset_chars=0` and `limit_chars=4096`.

`read_record_field` `structuredContent` output schema:

```json
{
  "type": "object",
  "required": ["record", "field", "window"],
  "properties": {
    "record": {
      "type": "object",
      "required": ["id", "connection_id", "stream", "record_id"],
      "properties": {
        "id": { "type": "string" },
        "connection_id": { "type": "string" },
        "stream": { "type": "string" },
        "record_id": { "type": "string" }
      },
      "additionalProperties": false
    },
    "field": {
      "type": "object",
      "required": ["path", "text_like"],
      "properties": {
        "path": { "type": "string" },
        "mime_type": { "type": "string" },
        "text_like": { "type": "boolean" },
        "size_chars": { "type": "integer" },
        "digest": { "type": "string" }
      },
      "additionalProperties": false
    },
    "window": {
      "type": "object",
      "required": ["text", "start_chars", "end_chars", "limit_chars", "complete"],
      "properties": {
        "text": { "type": "string" },
        "start_chars": { "type": "integer" },
        "end_chars": { "type": "integer" },
        "limit_chars": { "type": "integer" },
        "complete": { "type": "boolean" },
        "next_cursor": { "type": ["string", "null"] },
        "previous_cursor": { "type": ["string", "null"] },
        "match": {
          "type": ["object", "null"],
          "properties": {
            "q": { "type": "string" },
            "start_chars": { "type": "integer" },
            "end_chars": { "type": "integer" }
          },
          "additionalProperties": false
        }
      },
      "additionalProperties": false
    },
    "resource": {
      "type": "object",
      "properties": {
        "uri": { "type": "string" },
        "next_uri": { "type": ["string", "null"] },
        "previous_uri": { "type": ["string", "null"] }
      },
      "additionalProperties": false
    }
  },
  "additionalProperties": false
}
```

The tool's `content[]` text must include a compact serialized JSON header with the same record id, field path, range, completeness, and cursor values, followed by the bounded text window. This satisfies MCP backwards-compatibility guidance for structured content without dumping the full record envelope or unbounded field body.

## Authorization and handle rules

- Handles are not bearer tokens and do not grant authority by themselves.
- Every read uses the MCP request's scoped PDPP client token.
- A handle that points outside the active grant fails with the same authorization semantics as the underlying resource-server call.
- The adapter validates handle shape before forwarding to the resource server.
- Unknown, expired, malformed, or stale cursors fail with typed errors that name the field and record when safe.

## P0 substrate gate

Implementation may not start with adapter-side emulation if the current resource-server APIs require fetching an entire large record body into the MCP process before slicing. The first implementation step is a proof that a grant-enforced resource-server path can return bounded field windows, or a resource-server change that adds that path. The proof must cover SQLite and Postgres and must fail if the adapter can read a field that the active grant does not authorize.
