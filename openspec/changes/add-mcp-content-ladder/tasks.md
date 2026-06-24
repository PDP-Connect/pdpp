## 1. Contract and response shape

- [x] 1.1 Implement the fixed `read_record_field` input schema from `design.md`, including selector exclusivity and bound checks.
- [x] 1.2 Implement the fixed `read_record_field` output schema from `design.md`, and configure MCP output-schema validation for `structuredContent`.
- [x] 1.3 Add `content_ladder` metadata to `search`, `query_records`, and `fetch` for resource-backed fields.
- [x] 1.4 Implement URL-safe record and field resource handles for `pdpp://record/{handle}` and `pdpp://field-window/{handle}`.
- [x] 1.5 Update MCP server instructions without repeating long connector or recovery prose.

## 2. Adapter implementation

- [x] 2.1 Add the bounded field-window read tool and route reads through existing grant-enforced resource-server APIs.
- [x] 2.2 Add record and field MCP resource templates and `resources/read` handlers.
- [x] 2.3 Add `resource_link` blocks to tool results where the MCP SDK supports them.
- [x] 2.4 Update `search`, `query_records`, and `fetch` formatting to expose the content ladder without requiring prose parsing.
- [x] 2.5 Keep binary/blob fields metadata-only by default, with resource/export handles rather than large base64 text.

## 3. Resource-server substrate

- [x] 3.1 Prove resource-server APIs can return bounded text windows.
- [x] 3.2 Add the resource-server field-window endpoint when existing APIs cannot satisfy the bounded-read contract.
- [x] 3.3 Preserve grant enforcement for stream, field, time-range, resource, and connection constraints on window/resource reads.
- [x] 3.4 Add SQLite and Postgres conformance tests for the field-window substrate.

## 4. Compatibility and regression coverage

- [x] 4.3 Add structured-content-aware client assertions that follow `content_ladder` metadata without parsing prose.
- [x] 4.4 Add resource-aware client simulation that follows `resource_link` URIs through `resources/read`.
- [x] 4.5 Add full tests for invalid selector combinations, default bounds, max bounds, out-of-grant reads, malformed handles, stale cursors, and binary fields.
- [x] 4.6 Add regression coverage that no adapter-owned opaque-only marker is emitted as the sole path to long content.
- [x] 4.7 Extend existing token-budget tests so the new ladder does not regress default `tools/list`, search, query, or fetch budgets.
- [x] 4.8 Add a `resources/list` independence test: a `resource_link` returned by a tool is readable even when it is not listed by `resources/list`.

## 5. Documentation and closeout

- [x] 5.1 Update MCP package documentation with content-ladder examples and client compatibility notes.
- [x] 5.2 Add a concise compatibility matrix for Codex, Claude Code/Desktop, Gemini CLI, Hermes, opencode, Cursor, ChatGPT, and Claude app surfaces where evidence exists.
- [x] 5.3 Run `openspec validate add-mcp-content-ladder --strict`.
- [x] 5.4 Run the MCP server test suite and targeted compatibility simulations.
- [x] 5.5 Record MCP spec version details for tool-result, resource-link, output-schema, and resource-read semantics.
- [x] 5.6 Record live-client smoke gaps as residual risks rather than claiming unsupported client behavior.
