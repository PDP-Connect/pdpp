# Add MCP content ladder

## Why

The MCP adapter is token-efficient for list and search responses, but large record bodies can still become a dead end for clients that cannot reliably inspect `structuredContent` or expand custom transcript markers. PDPP needs a standard, grant-scoped path from compact MCP results to the full authorized record or field without dumping large bodies into every tool response.

## What Changes

- Define a content ladder for MCP record results: compact `content[]` preview, canonical `structuredContent`, bounded field-window read, and MCP resource links.
- Add the generic `read_record_field` bounded read tool for record fields so clients without reliable `resources/read` support can still inspect long bodies.
- Add `pdpp://record/{handle}` and `pdpp://field-window/{handle}` resource templates so resource-aware clients can use standard `resource_link` and `resources/read` flows.
- Require truncation metadata, continuation cursors, and model-visible next steps whenever a field preview is incomplete.
- Prohibit opaque-only expansion markers as the sole representation of record content.
- Add compatibility tests for content-only, `structuredContent`-aware, and resource-aware MCP clients.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-adapter`

### Removed Capabilities

None.

## Impact

- Affects `packages/mcp-server` tool schemas, result formatting, resource registration, and tests.
- Requires a hard substrate decision before adapter implementation: if existing resource-server APIs cannot return grant-enforced bounded field windows, add that resource-server path before wiring MCP reads.
- Does not change grant semantics, connector manifests, owner-control routes, or source collection behavior.
- Keeps existing `schema`, `query_records`, `aggregate`, `search`, and `fetch` behavior compatible while adding a standard continuation path for long fields.
