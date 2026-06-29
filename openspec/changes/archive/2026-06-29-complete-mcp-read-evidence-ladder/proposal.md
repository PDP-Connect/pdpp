# Complete MCP Read Evidence Ladder

## Why

The deployed read/evidence substrate improves MCP and CLI structure, but hosted
ChatGPT retesting still found dead ends: search handles without matched text,
field-window resource URIs that the client could not read, and full fetches that
materialized files for small text records.

The adapter needs an end-to-end evidence ladder that remains useful when
`structuredContent` is hidden and resource reads fail.

## What Changes

- Add hostile-client tests for content-only MCP behavior.
- Surface proven search match windows as bounded visible evidence.
- Ensure every visible incomplete preview has a model-callable continuation path.
- Keep `pdpp://field-window/...` resources as a bonus path, not the only path.
- Add a small inline text read path for ordinary evidence inspection.
- Preserve binary and bulk content as explicit resource/export paths.

## Capabilities

Modified:

- `mcp-adapter`
- `reference-implementation-architecture`

## Impact

Affects MCP response shaping, read continuation tools, search evidence
projection, and shared read/evidence tests. Does not broaden grants, invent
connector-specific presentation, or replace canonical REST envelopes.
