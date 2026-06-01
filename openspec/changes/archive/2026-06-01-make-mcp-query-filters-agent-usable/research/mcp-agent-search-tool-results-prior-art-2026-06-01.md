# MCP Agent Search Tool Results — Prior Art Research

**Status:** research synthesis  
**Date:** 2026-06-01  
**Scope:** `make-mcp-query-filters-agent-usable` — agent-visible text content in search/query tool results  
**Author:** worker lane `ri-mcp-agent-search-prior-art-v1`

---

## 1. Research Question

Does the current RI MCP adapter design satisfy the SLVP (Simplest Live Verifiable Path) for
agent-visible search and query tool results? Specifically:

- Must search hits carry model-visible text in `content[]` or can `structuredContent` alone suffice?
- Is the current dual-channel design (`content[]` text + `structuredContent`) spec-correct?
- What does the spec require for clients that cannot render `structuredContent`?
- Are there design gaps in how the RI surfaces fetch handles, connection identity, or filter results?

---

## 2. Source Inventory

| # | Source | URL | Accessed | Why it matters |
|---|--------|-----|----------|----------------|
| S1 | MCP Schema 2024-11-05 | `https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2024-11-05/schema.ts` | 2026-06-01 | Baseline `CallToolResult` with no `structuredContent` |
| S2 | MCP Schema 2025-03-26 | `https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-03-26/schema.ts` | 2026-06-01 | Adds `AudioContent` but still no `structuredContent` |
| S3 | MCP Schema 2025-06-18 | `https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-06-18/schema.ts` | 2026-06-01 | First version to introduce `structuredContent` |
| S4 | MCP Schema 2025-11-25 | `https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/2025-11-25/schema.ts` | 2026-06-01 | Current latest; identical `CallToolResult` to S3 |
| S5 | MCP Spec Prose 2025-06-18 tools | `https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/docs/specification/2025-06-18/server/tools.mdx` | 2026-06-01 | Authoritative prose on `structuredContent` backward-compat rule and `outputSchema` |
| S6 | MCP Concepts: Tools (modelcontextprotocol.io) | `https://modelcontextprotocol.io/docs/concepts/tools` | 2026-06-01 | High-level consumer docs; consistent with S3–S5 |
| S7 | OpenAI Web Search Tool Docs | `https://platform.openai.com/docs/guides/tools-web-search` | 2026-06-01 | Comparison: how a non-MCP search surface exposes hits to callers |

**Note on schema version naming:** The MCP spec repository does not have a `schema/2025-11-05/` directory. The research confirmed the available versions are `2024-11-05`, `2025-03-26`, `2025-06-18`, and `2025-11-25`. References to "2025-11-05" in other contexts likely intend the 2025-11-25 release.

---

## 3. Findings

### 3.1 `CallToolResult` evolution

**2024-11-05 (S1)** — baseline, no structured output:
```typescript
export interface CallToolResult extends Result {
  content: (TextContent | ImageContent | EmbeddedResource)[];
  isError?: boolean;
}
```

**2025-03-26 (S2)** — adds `AudioContent`, still no `structuredContent`:
```typescript
export interface CallToolResult extends Result {
  content: (TextContent | ImageContent | AudioContent | EmbeddedResource)[];
  isError?: boolean;
}
```

**2025-06-18 and 2025-11-25 (S3, S4)** — introduces `structuredContent` and `outputSchema`:
```typescript
export interface CallToolResult extends Result {
  /** A list of content objects that represent the unstructured result of the tool call. */
  content: ContentBlock[];
  /** An optional JSON object that represents the structured result of the tool call. */
  structuredContent?: { [key: string]: unknown };
  isError?: boolean;
}
```

`Tool` gains an optional `outputSchema` field (JSON Schema 2020-12, `type: "object"` root):
- When `outputSchema` is present, servers **MUST** provide `structuredContent` conforming to it.
- Clients **SHOULD** validate `structuredContent` against `outputSchema`.

### 3.2 Backward-compatibility rule (S5, verbatim)

From the 2025-06-18 spec prose:

> **For backwards compatibility, a tool that returns structured content SHOULD also return the serialized JSON in a TextContent block.**

This is a SHOULD, not a MUST. The intent is clear: because `structuredContent` was not present in any spec version before 2025-06-18, clients built against earlier versions only read `content[]`. A server that puts all its data in `structuredContent` without a text fallback silently breaks those clients.

### 3.3 `content[]` is the model-visible channel

The spec's field comment says `content` contains "the **unstructured** result" and `structuredContent` contains "the **structured** result." In practice:

- MCP hosts (Claude Desktop, Claude.ai, other frontends) render `content[]` into the model's conversation context. This is what the LLM reasons over.
- `structuredContent` is a machine-readable out-of-band channel for programmatic host use (e.g., type-safe SDK consumers, automated pipelines). Its presence in model context is host-discretionary and not guaranteed.

There is no spec requirement that hosts present `structuredContent` to the model. A text-only or model-only client that does not implement `structuredContent` handling remains fully spec-compliant.

### 3.4 What a search hit needs in `content[]`

The MCP spec does not define a standard search-hit shape. From first principles and the backward-compat rule:

A search hit in `content[]` text must be self-contained enough for a model client that only reads `content[].text`. The minimum viable fields are:

| Field | Rationale |
|-------|-----------|
| Hit count + query scope | The model must know how many results matched and what was searched |
| Per-hit: identifier / fetch handle | Needed for follow-up `fetch` calls; must be in text, not only in `structuredContent` |
| Per-hit: title or summary | The model must be able to reason about which hit to follow without calling `fetch` |
| Per-hit: `connection_id` | Required for source disambiguation in multi-connection grants |

If any of these appear only in `structuredContent`, a text-only client cannot build a follow-up fetch call, and the search tool result becomes a dead end.

### 3.5 OpenAI web search comparison (S7)

OpenAI's built-in web search tool does not expose individual hit objects to callers at all. The search is model-internal; the output is a synthesized prose answer with `url_citation` annotations (character range + URL + title) embedded in the assistant message. There are no discrete hit objects, no fetch handles, and no raw snippets in the caller-visible response.

This design is architecturally different from MCP. It is not directly applicable to the PDPP MCP search design, but it confirms that OpenAI does not treat "expose raw search hits" as a general-purpose pattern — their answer is model synthesis + citation attribution. The PDPP design (expose hits with fetch handles + text preview) is the right approach for a data-access protocol where the caller may want to drill into specific records.

---

## 4. SLVP Decision Criteria for the RI Design

The RI MCP adapter's current design is:

1. Every search/query tool result populates `content[]` with a text summary (hit count, per-hit preview including `connection_id`, record preview for `query_records`, numeric answer for `aggregate`).
2. Every result also populates `structuredContent` with the canonical RS response envelope.
3. The `aggregate` tool specifically renders its numeric answer in `content[]` text, not just in `structuredContent`, because some hosted agents cannot reliably read `structuredContent`.
4. The `search` tool's `content[]` text includes the hit count plus a bounded top-hit preview with `id`, available source handles such as `connection_id`, and short title/snippet context. The `structuredContent` carries the full canonical search envelope plus the ChatGPT-compatible `results[]` projection.

The SLVP test for this design is: **can a client that only reads `content[]` text perform a complete search → inspect → follow-up fetch workflow without touching `structuredContent`?**

---

## 5. Confidence Assessment

**Confidence: >95% that the dual-channel design is correct and SLVP.**

Evidence:

1. The spec's backward-compat rule (S5) directly mandates the dual-channel pattern: `content[]` must carry a human-readable representation whenever `structuredContent` is present. The RI design satisfies this.

2. The `structuredContent` field was absent from all spec versions before 2025-06-18. Any client built before that date — or any client that implements the 2024-11-05 or 2025-03-26 spec only — receives zero data from `structuredContent`. The RI's `content[]` text is not optional; it is the only channel guaranteed to reach all clients.

3. The RI `search` tool result includes hit count and per-hit id/source/title/snippet context in `content[]` text via `summarizeSearch`. The `toSearchToolResult` function populates both channels. This satisfies the minimum self-contained requirement identified in §3.4.

4. The RI `aggregate` tool result's `summarizeAggregate` function outputs `metric(stream)[field=...] = value` or grouped bucket previews in `content[]`. This was a specific gap identified in the `make-mcp-query-filters-agent-usable` change: "some hosted agents cannot reliably read `structuredContent`." The change comment is correct: per S3/S4, `structuredContent` is optional and not guaranteed to reach the model.

5. The RI design also populates the `outputSchema` on tools (`outputSchema: z.object(READ_OUTPUT_SCHEMA_SHAPE)`). Per S5, when `outputSchema` is declared, servers MUST provide conforming `structuredContent`. The RI satisfies this: `structuredContent` is always populated on successful responses.

**What would lower confidence below 95%:**

- Evidence that a major MCP host (Claude Desktop, Claude.ai hosted MCP) strips or ignores `content[]` and surfaces only `structuredContent` to the model — this would invert the dependency. No such evidence was found; all observed behavior and spec text confirm `content[]` as the primary model-visible channel.
- Evidence that the `search` tool's text summary omits the fetch handle (`id` field needed for `fetch` calls). Current `summarizeSearch` emits a bounded top-hit preview with `id` and available source handles, and `toSearchToolResult` confirms both channels are populated.

---

## 6. Design Gaps and Residual Risks

### 6.1 `content[]` preview budgets

The `query_records` preview is bounded at 1792 characters and shows at most 5 records. The `search` preview is bounded separately: it shows the top 3 hits, shortens per-hit snippets in text, and keeps the full canonical envelope in `structuredContent.data`. This is intentional token-efficiency. Risk: a model that receives only `content[]` and cannot read `structuredContent` sees only a preview, not the full page. This is acceptable because:

- The model can call `query_records` again with `cursor` to page forward.
- 25-record default pages would exceed any reasonable `content[]` token budget.
- Search and record text summaries preserve follow-up handles, and record pages note `has_more=true` / `more_records=N` when pagination is needed.

These preview limits are not spec-mandated; they are token-budget tradeoffs. Agents that need more records must use `structuredContent` or paginate.

### 6.2 `structuredContent` adoption curve

Client support for `structuredContent` is still emerging (first spec appearance: 2025-06-18). The RI's `outputSchema` declarations on tools declare a conformance commitment: any client that validates against `outputSchema` must receive conforming `structuredContent`. The RI satisfies this today, but changes to RS response shapes must keep `structuredContent` in sync with `outputSchema`. This is a maintenance risk, not a design defect.

### 6.3 Multi-connection package search text summary

The `mergeSearchEnvelopes` function in `package-rs-client.js` merges hits across child grants. The merged hits appear in `structuredContent.data`. The text summary from `summarizeSearch` runs over the normalized merged body. Risk: if package merge or MCP normalization resolves the wrong envelope shape, the text hit count or preview could be inaccurate. The current code handles canonical `data[]`, compatibility `results[]`, `hits[]`, nested `data.data[]`, and nested `data.results[]` shapes. This is a correctness dependency on the merge logic, not a spec gap.

### 6.4 Inferred (not specified) host behavior

The assertion that "MCP hosts render `content[]` into model context" is based on:

- The spec field comment ("unstructured result of the tool call").
- The backward-compat SHOULD in S5.
- Observed behavior in Claude Desktop and Claude.ai (not formally cited because no primary spec reference exists for host rendering behavior).

There is no normative spec section that says "hosts MUST present `content[]` to the LLM." Host rendering behavior is implementation-defined. If a future host chooses to render only `structuredContent`, the text fallback becomes unnecessary overhead. This is a low-probability risk given the strong SHOULD in the backward-compat rule.

---

## 7. Synthesis: Is the RI Design SLVP-Ideal?

**Yes, with one caveat.**

The dual-channel design (`content[]` text + `structuredContent` canonical envelope) is the correct, spec-compliant, SLVP pattern for an MCP tool that targets broad client compatibility. The key invariants are:

1. `content[]` carries the minimum information a model client needs to take a follow-up action (hit count, per-hit title/url/id, connection identity, aggregate numeric answer).
2. `structuredContent` carries the canonical envelope for programmatic consumers and schema-aware hosts.
3. No information critical to agent workflow lives only in `structuredContent`.
4. Filter and query inputs are typed objects (not opaque strings), so the agent never has to hand-encode bracket syntax — the adapter handles encoding.

The caveat: the `content[]` text preview is a heuristic (fixed character budgets and bounded preview counts). This is the right tradeoff for a data-access protocol serving LLMs with limited context budgets, but it should be explicitly labeled as such in code, OpenSpec rationale, or research synthesis rather than silently assumed. The current code and token-efficiency tests make this visible.

---

## Related artifacts

- `openspec/changes/make-mcp-query-filters-agent-usable/design.md` — design rationale for the typed filter + dual-channel aggregate text fix
- `openspec/changes/make-mcp-query-filters-agent-usable/proposal.md` — `structuredContent` gap identified as secondary defect
- `packages/mcp-server/src/tools.js` — implementation: `toToolResult`, `toAggregateToolResult`, `toSearchToolResult`, `summarizeAggregate`, `summarizeSearch`
- `reference-implementation/server/package-rs-client.js` — package fanout and `mergeSearchEnvelopes`
