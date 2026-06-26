# MCP Large-Data Surface Patterns

**Date:** 2026-06-22
**Status:** captured
**Question:** How should PDPP expose large, navigable personal-data records through MCP without flooding agent context or leaving clients unable to inspect full evidence?

## Trigger

The immediate failure mode came from asking PDPP data whether `hyperlane` appears and whether anything depends on it. Search worked: the MCP search surface returned stable result IDs, exact counts for scoped lexical searches, source mix, snippets, and `structuredContent.results`. The inspection path was weaker: fetching full Slack/Gmail bodies surfaced opaque markers such as `<<ccr:...>>` in the agent-visible output. That means the data was reachable to the backend, but not reliably navigable through the client/model surface.

This note records research findings and the current product/architecture leaning. It is not an implementation spec.

## Sources Checked

- MCP tool result model: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP resource model: https://modelcontextprotocol.io/specification/2025-06-18/server/resources
- MCP structured-content client divergence discussion: https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1624
- Claude Code custom tools result shape: https://code.claude.com/docs/en/agent-sdk/custom-tools
- GitHub MCP Server: https://github.com/github/github-mcp-server
- GitHub MCP Server install guides for Codex, Claude, Cursor, Gemini CLI, OpenCode, Windsurf, and other clients: https://github.com/github/github-mcp-server/blob/main/README.md
- Microsoft Playwright MCP: https://github.com/microsoft/playwright-mcp
- Context7 MCP and CLI: https://github.com/upstash/context7
- Firecrawl MCP: https://raw.githubusercontent.com/mendableai/firecrawl-mcp-server/main/README.md
- Filesystem MCP server and resource-support issue: https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/README.md and https://github.com/modelcontextprotocol/servers/issues/399

## Field Lessons

### 1. `content[]` is still the compatibility floor

MCP supports `structuredContent`, but important clients do not treat it uniformly. The MCP issue above records client divergence: Cursor leaning toward `content`, VS Code preferring `structuredContent`, and other clients ignoring `structuredContent` for model context. Claude Code tool docs also make `content` the required result block and `structuredContent` optional machine-readable data.

PDPP implication: every important read path must include enough model-visible `content[]` text for an agent to know what happened and what to call next. `structuredContent` can be canonical for machines, but it cannot be the only usable surface.

### 2. Opaque compression handles are not a universal read surface

Custom markers such as `<<ccr:...>>` are fine as internal transcript/storage optimizations only if the agent has a standard next step to expand them. If a client or harness cannot dereference the marker, the record is not navigable even though the backend has the bytes.

PDPP implication: `ccr`-style markers must never be the sole agent-visible representation of record bodies, snippets, or full-text inspection handles.

### 3. Successful servers return focused context, not raw dumps

Context7 succeeds by resolving a library and returning task-relevant documentation directly into the agent context. Firecrawl recommends structured JSON extraction for most scraping and markdown/full content only when genuinely needed. Playwright MCP uses accessibility snapshots instead of screenshots to keep browser state text-structured and agent-usable. GitHub MCP keeps work split across API-shaped list/get/search tools with install guidance for many clients.

PDPP implication: token efficiency should come from focused operations, projections, windows, cursors, and capability metadata, not from hiding the next readable content behind non-standard handles.

### 4. Resources are necessary, but not sufficient

MCP `resource_link` plus `resources/read` is the right full-body escape hatch, but client support varies and many agent tasks need a small local window, not the entire email/thread/file. The filesystem server history is a caution: claiming or implying resource support is not enough if the runtime path is not implemented and visible to the client.

PDPP implication: resource links should exist for full-body provenance/read-through, but the normal agent path should be a bounded text-window tool that works in tool-only clients.

### 5. CLI plus skills may be better for high-throughput local agent workflows

Playwright explicitly distinguishes MCP from CLI+Skills: MCP is useful for persistent state and interactive introspection, while CLI+Skills can be more token-efficient for coding agents. Context7 also supports both MCP and CLI+Skills.

PDPP implication: MCP should own grant-scoped, remote, protocol-mediated data access. The PDPP CLI should remain the preferred path for local diagnostics, run timelines, exports, and artifact-producing workflows where the agent can inspect files incrementally.

## Option Matrix

| Option | Token Efficiency | Navigability | Client Compatibility | Verdict |
| --- | --- | --- | --- | --- |
| Inline full bodies in search results | Poor | High | Mixed, context overflow likely | Reject as default |
| Snippets only | High | Poor for evidence inspection | Good but dead-ends | Reject as complete solution |
| Opaque custom handles only | High | Poor outside custom renderer | Poor | Reject |
| `structuredContent.results` only | High | Medium where supported | Inconsistent | Insufficient |
| `resource_link` + `resources/read` | Good | High in capable clients | Uneven | Necessary escape hatch |
| Bounded text-window tool | High | High for agent reasoning | Strong, tool-only compatible | Primary follow-up path |
| Chunked full-read/export | Medium | High for exhaustive review | Good if explicit and paged | Secondary/owner path |
| CLI artifact workflow | High for coding agents | High locally | Depends on CLI availability | Complementary path |

## Current Leaning

The SLVP shape is a progressive content ladder:

1. `search` and record-list tools return compact, model-visible hit cards in `content[]`: result ID, source identity, stream, timestamp, matched fields, and bounded match windows.
2. `structuredContent.results[]` remains the canonical machine-readable hit list for clients that support it.
3. `fetch(id)` returns canonical record metadata, small fields inline, and explicit long-body references when body text is incomplete.
4. A first-class bounded text-window tool provides `id`, `field`, `query` or `offset`, `before`, `after`, and returns readable text with previous/next cursors.
5. Long fields and blobs are also exposed as real MCP resources with `resource_link` URIs and working `resources/read` for clients that support resources.
6. Chunked full-read/export paths exist for exhaustive owner/audit workflows, with explicit byte/character ranges, MIME type, checksum, size, truncation, and provenance.
7. Schema/capability metadata advertises which fields are searchable, previewable, complete inline, blob-backed, or window-readable.

The invariant: every compact result must have an obvious, standard, model-usable next read path. Token efficiency is allowed to defer content, but never to dead-end content.

## Compatibility Acceptance Matrix

Before calling this solved, run a live matrix against the clients we care about:

- Codex
- Claude Code
- Claude Desktop / Claude app MCP surfaces
- ChatGPT MCP / Apps surfaces
- Cursor
- Gemini CLI
- Hermes
- OpenCode
- VS Code / Copilot-style MCP hosts
- Windsurf or another high-usage IDE host if available

Minimum prompt:

> Use my PDPP data to find whether `hyperlane` is used and whether anything depends on it. Inspect the relevant full context before answering.

Pass criteria:

- The client can see search result IDs and source identity without custom PDPP knowledge.
- The client can read a bounded text window around the match.
- The client can continue to adjacent context or full body when needed.
- The client can distinguish snippet completeness from body completeness.
- No path requires interpreting an opaque `ccr` marker.
- The final answer can cite which record/window supported it.

## Tests To Add When Promoted

- Search fixture with long Slack/Gmail-style body returns readable match windows in `content[]`.
- Fetch fixture with long body returns `body_complete=false` plus body reference metadata and next tool/resource hints.
- Text-window tool returns text around a query, stable offsets, and previous/next cursors.
- Resource link can be read through MCP resource APIs where supported.
- Tool-only client path can complete the same task without `resources/read`.
- Structured-content-only and content-only compatibility tests prove no semantic divergence.
- Oversized field never becomes an opaque marker without a standard expansion path.

## Promotion Trigger

Promote into OpenSpec before changing MCP tools, response schemas, RS body/blob endpoints, schema capability metadata, or the official agent guidance. This affects durable protocol/reference behavior and client interoperability; it should not ship as an incidental adapter patch.
