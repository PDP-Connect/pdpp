## Context

`design-notes/mcp-tool-surface-token-footprint-2026-06-08.md` measured the live hosted MCP `tools/list` response at ~49.6 KB, about ~12,400 tokens by the chars/4 estimate. The largest avoidable cost is repeated prose:

- `connection_id` recovery guidance is repeated through the shared input shape.
- typed filter guidance is repeated on three read tools.
- event-subscription signing and delivery guidance is repeated across six event tools.
- schema-first discovery guidance is repeated across several tools.

Two low-cost research reports were written under `tmp/workstreams/`:

- `mcp-tool-footprint-local-audit.md`: confirms all 14 tools are registered unconditionally and descriptions are static.
- `mcp-tool-footprint-external-research.md`: confirms no MCP numeric size limit was found, but notes that server `instructions` are a protocol-supported location for shared guidance.

RI owner source verification added two important corrections:

- MCP `tools/list` supports pagination and initialization has an optional `instructions` field in the `initialize` response: https://modelcontextprotocol.io/specification/2025-06-18/server/tools and https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle.
- OpenAI Apps SDK guidance explicitly says to use server instructions for guidance that applies across tools, and says the first 512 characters should be self-contained for ChatGPT and Codex: https://developers.openai.com/apps-sdk/build/mcp-server.
- OpenAI Apps SDK examples put model-usable output in `structuredContent`; `_meta` is the hidden/widget-oriented channel. Therefore PDPP must not assume `structuredContent` is invisible to ChatGPT.

## Goals / Non-Goals

**Goals:**

- Reduce default `tools/list` payload without removing tools.
- Put shared MCP usage rules in one server `instructions` block.
- Keep per-tool descriptions concise, verb-first, and still self-contained enough for routing.
- Preserve current tool names and input/output semantics.
- Add measurement tests so future changes do not regress the discovery footprint.
- Produce a change safe enough to deploy and retest in ChatGPT immediately.

**Non-Goals:**

- Adding a custom lazy-loading protocol or multiple MCP endpoints.
- Removing event-subscription tools from the default surface.
- Moving canonical read envelopes out of `structuredContent`.
- Changing REST query contracts, grant semantics, or `/mcp` authorization posture.

## Decisions

### Use MCP server instructions as the shared guidance layer

Decision: add an `instructions` string to `createPdppMcpServer()` and pass it to `new McpServer(...)`.

The first 512 characters must stand alone for ChatGPT and Codex. It should say, in order:

1. PDPP tools are grant-scoped and read through the configured bearer.
2. Call `list_streams` / `schema` before constructing field, filter, expand, sort, count, or connection-specific reads.
3. Use `connection_id` from schema/list results or `available_connections` errors to disambiguate sources.
4. Use typed object filters, not bracket strings.
5. Use event capability discovery before event-subscription writes.
6. Page and narrow results instead of requesting wide pages.

Rationale: this follows MCP's standard initialization field and OpenAI's own guidance for ChatGPT/Codex. It removes repeated prose without relying on host-specific non-standard features.

### Keep short per-tool routing descriptions

Decision: do not replace tool descriptions with opaque one-liners. Each tool still states what it does, the RS endpoint it maps to, the highest-risk input rule, and whether it is read-only or mutating. Cross-tool recovery paragraphs move to instructions.

Rationale: tool descriptions are still used for selection. The SLVP balance is not the smallest possible string; it is the smallest string that preserves reliable routing.

### Keep full event-subscription semantics in the discovery tool

Decision: `discover_event_subscription_capabilities` remains the authoritative event-subscription preflight. Other event tools keep their action-specific description and replace the repeated footer with a short sentence pointing to discovery.

Rationale: the capability-discovery tool exists specifically to carry event types, signing profile, retry schedule, callback URL rules, and cursor hints. Repeating that contract on every CRUD tool is avoidable.

### Keep all existing tools in this tranche

Decision: do not gate or consolidate event-subscription tools in this change.

Rationale: tool gating or consolidation changes the host-visible API and needs a separate compatibility decision. The evidence does not prove a hard ChatGPT `tools/list` limit, and PDPP's current surface connected successfully in recent live captures. The first SLVP tranche should remove obvious duplication before changing API shape.

### Do not assume `structuredContent` is hidden

Decision: this change only trims discovery-time footprint. It must not claim that large results are hidden from ChatGPT merely because they are in `structuredContent`.

Rationale: OpenAI Apps SDK examples and guidance treat `structuredContent` as model-usable output. PDPP already keeps `content[]` compact and enforces bounded page sizes; if ChatGPT still truncates PDPP read results, a follow-on result-budget change should add explicit compact/full result-detail controls.

## Measurement Target

The default generated `tools/list` payload for the current 14-tool surface should drop by at least 15% versus the measured ~49.6 KB baseline and stay below 45 KB. The test should also assert that:

- the long event-subscription footer appears only on the discovery tool;
- the long `connection_id` paragraph is not repeated in every tool schema;
- server instructions are present and include the required shared guidance.

The byte target is intentionally conservative. It proves real reduction without pretending to know an undocumented ChatGPT hard limit.

## Alternatives

- **Custom lazy loading or deferred tool search.** Deferred because MCP hosts do not expose one portable server-side mechanism today. Anthropic's API has tool-search/deferred-loading features, but those are not the generic MCP server contract.
- **Hide full responses in `_meta`.** Deferred because PDPP MCP tools are also used by generic MCP clients that expect structured results. A result-budget change should be explicit and tested against ChatGPT truncation.
- **Remove event-subscription tools by default.** Deferred because it changes the advertised API. If a later controlled test proves hard host limits, this becomes the largest lever.

## Acceptance Checks

- `initialize` includes server instructions with the shared PDPP MCP guidance.
- `tools/list` still exposes the same 14 tool names.
- `tools/list` is below 45 KB in the default test fixture.
- `filter` remains object-shaped for `query_records`, `aggregate`, and `search`.
- Existing focused MCP server tests pass.
- A ChatGPT retest after deploy can delete/re-add the app and confirm the tool surface remains complete, filter schemas remain typed objects, and basic `schema`, `list_streams`, `query_records`, `search`, and `aggregate` calls work.
