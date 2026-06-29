## Why

The hosted MCP surface currently repeats the same cross-cutting guidance across many tool descriptions, producing a ~49.6 KB `tools/list` payload for 14 tools. That cost is paid by every MCP client session and sits in an unpredictable zone for chat-hosted clients whose exact tool-description and tool-result budgets are host-defined.

Official MCP and OpenAI guidance provides a cleaner path: use server `instructions` for cross-tool guidance, keep tool descriptions concise and routing-specific, and keep model-visible tool results bounded by default.

## What Changes

- Add compact MCP server instructions for shared PDPP tool-use rules (`connection_id`, typed filters, schema-first discovery, event-subscription preflight, and pagination).
- Shorten repeated per-tool descriptions and field descriptions without weakening validation or REST forwarding semantics.
- Keep event-subscription delivery/signing details in the capability-discovery tool and replace repeated lifecycle footers on CRUD tools with a short pointer.
- Add regression coverage that measures the default `tools/list` payload and prevents reintroducing duplicated long descriptions.
- Preserve the current tool names and all existing read/event-subscription capabilities in this tranche.
- Defer non-standard lazy/deferred tool loading and advanced result-detail changes until host behavior is proven by controlled tests.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `mcp-adapter`: hosted and stdio MCP surfaces publish compact server instructions and avoid duplicated model-visible tool-definition prose while preserving grant-scoped read behavior.

## Impact

- Affected package: `packages/mcp-server`.
- Affected tests: MCP server/tool schema tests.
- No REST contract changes, storage changes, grant semantics changes, connector changes, or dependency changes.

## Residual Risks

- The original delete/re-add ChatGPT app retest was superseded by later hosted MCP retests after the read-evidence and entrypoint changes. Those retests proved the practical ChatGPT path for `schema`, `search`, `fetch`, and `read_record_field`; no current evidence shows tool-list truncation.
