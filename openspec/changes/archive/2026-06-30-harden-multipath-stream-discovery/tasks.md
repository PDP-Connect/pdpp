## 1. OpenSpec

- [x] 1.1 Create proposal, design, task list, and spec deltas for multipath stream-definition reuse and MCP first fetch handles.
- [x] 1.2 Validate `harden-multipath-stream-discovery` with `openspec validate --strict`.

## 2. MCP implementation

- [x] 2.1 Add `first_fetch_id=<id>` to search `content[]` text before `source_mix` and top-result previews.
- [x] 2.2 Add regression coverage proving `first_fetch_id` equals `structuredContent.results[0].id` and appears before source metadata.
- [x] 2.3 Preserve zero-hit behavior with no invented fetch handle.

## 3. Validation

- [x] 3.1 Run the focused MCP search/fetch tests.
- [x] 3.2 Run strict OpenSpec validation for the change and all specs if practical.
