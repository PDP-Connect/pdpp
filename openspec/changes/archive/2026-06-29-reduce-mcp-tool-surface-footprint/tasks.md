## 1. OpenSpec

- [x] 1.1 Capture research reports under `tmp/workstreams/`.
- [x] 1.2 Create proposal, design, spec delta, and tasks for MCP tool-surface footprint reduction.
- [x] 1.3 Validate with `openspec validate reduce-mcp-tool-surface-footprint --strict`.

## 2. Server Instructions

- [x] 2.1 Add a compact PDPP MCP instructions string in `packages/mcp-server/src/server.js` or a small adjacent module.
- [x] 2.2 Pass the instructions through `createPdppMcpServer()` into `McpServer`.
- [x] 2.3 Add a focused test that proves `initialize` exposes the instructions.

## 3. Tool Description De-Duplication

- [x] 3.1 Replace repeated `connection_id` field prose with a short field description and keep action-specific ambiguity guidance only where needed.
- [x] 3.2 Replace repeated `FILTER_DESCRIPTION` prose with a compact typed-object example and move shared details to server instructions.
- [x] 3.3 Keep the full event-subscription signing/delivery contract on `discover_event_subscription_capabilities` only.
- [x] 3.4 Replace the repeated event-subscription footer on create/list/get/update/delete/test tools with a one-sentence pointer to discovery.
- [x] 3.5 Remove or shorten read-tool text that implies `structuredContent` is hidden from model context.

## 4. Measurement And Regression Tests

- [x] 4.1 Add a test helper that serializes the default tool list in the same shape MCP exposes.
- [x] 4.2 Assert the default tool list stays below 45 KB for the current 14-tool surface.
- [x] 4.3 Assert long event-subscription and `connection_id` guidance is not duplicated across many tool schemas.
- [x] 4.4 Assert `filter` remains object-shaped for `query_records`, `aggregate`, and `search`.

## 5. Verification

- [x] 5.1 Run focused MCP server tests.
- [x] 5.2 Run `pnpm --dir packages/mcp-server test` or the package's equivalent focused test command.
- [x] 5.3 Run `openspec validate reduce-mcp-tool-surface-footprint --strict`.
- [x] 5.4 Record before/after `tools/list` byte and token estimates in a workstream handoff.

## 6. ChatGPT Retest

- [x] 6.1 Deploy after owner review.
- [x] 6.2 Supersede the original delete/re-add ChatGPT app retest with later hosted MCP retests after read-evidence and entrypoint changes.
- [x] 6.3 Record current status: later ChatGPT retests saw the practical read surface and no tool-list truncation; no standalone footprint blocker remains.
