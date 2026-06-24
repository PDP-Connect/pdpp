# MCP Read Evidence Full-Ideal Plan

Status: captured
Date: 2026-06-23
Related change: `openspec/changes/complete-mcp-read-evidence-ladder/`

## Question

How do we turn the MCP read/evidence design from a useful substrate into the
full SLVP behavior proven by hosted-client failure cases?

## Current Divergence

The deployed `@pdpp/read-evidence` tranche created shared primitives and moved
MCP/CLI toward common evidence semantics. It did not fully satisfy the hosted
ChatGPT workflow because a client can still see handles without useful evidence:

- Search results can expose record handles and `field_windows` without exposing a
  bounded matched text window in visible `content[]`.
- Search result content ladders can be built from search-hit metadata rather than
  actual matched record fields, so visible field windows may be `title`, `url`,
  `record_key`, or `display_name` instead of the matched body field.
- `pdpp://field-window/...` resource links are useful only when the host exposes a
  working resource-read path. ChatGPT can return `ResourceNotReadable`.
- Full `fetch` can materialize a file attachment for small text records, adding
  approval prompts to ordinary evidence inspection.

## Full-Ideal Invariants

1. A search hit that matched a text-like field must expose a bounded, truthful
   visible match preview when the resource server can identify the matched field.
2. A visible incomplete preview must have a model-callable continuation tool path,
   not only a resource URI.
3. MCP resource URIs remain useful bonus affordances, but they are not the only
   recovery route.
4. Small text evidence reads return inline text and continuation cursors; full
   file/export materialization is reserved for genuinely large, bulk, or binary
   content.
5. The resource server owns match-window facts. MCP may render and truncate them,
   but must not infer matched fields from connector names or field names.
6. CLI, MCP, and any future REST evidence projection consume the same shared
   evidence semantics for identity, truncation, continuation, and binary
   metadata.

## TDD Strategy

Build hostile-client tests before implementation. A hostile client sees only
`content[]`, treats `structuredContent` as hidden, treats `resources/read` as
unavailable, and treats small-record file materialization as a failure.

Required failing fixtures:

- Slack-like `messages.text` hit where search returns a proven text match window.
- Search hit with only metadata fields and no proven match window.
- Search hit whose field-window URI is visible but resource read is unavailable.
- Small text fetch/read that must return inline content.
- Large text and binary evidence that must stay bounded and require explicit
  continuation/export.

## Fan-Out Shape

The main agent owns OpenSpec, tests, integration, and final deploy judgment.
Workers may help only after the failing tests define the contract:

- RS evidence lane: surface proven match-window facts from search.
- MCP adapter lane: render visible evidence cards from those facts.
- Continuation lane: keep resource reads and model-callable reads equivalent
  enough that neither path is a dead end.
- Fixture/review lane: attack the hostile-client harness without product-code
  authority.

## Decision

Proceed with `complete-mcp-read-evidence-ladder` as an OpenSpec change. Do not
deploy a new MCP/read-evidence tranche until the hostile-client tests pass.

## 2026-06-23 Hosted-Client Retest Delta

ChatGPT fresh-session retesting showed the practical ladder was usable for Slack evidence classification: `read_record_field` was discoverable, bounded `messages.text` reads returned inline, and projected `fetch` returned inline without file materialization.

The remaining hosted-client gap was narrower: ChatGPT still reported search previews as record/resource metadata (`title`, `url`, `record_key`, `display_name`) rather than matched Slack `text`. Local MCP SDK output already included evidence in visible `content[]`, so the likely divergence is that the hosted client summarizes or previews `structuredContent.content_ladder.records[].field_windows` and `structuredContent.results[]`, where the proven text window had read metadata but no bounded scalar evidence text.

Implementation response: keep the existing `content[]` evidence path, and also require proven search match windows to surface bounded `preview_text` and `evidence_excerpts` scalars in `structuredContent.results[]` and `structuredContent.content_ladder.records[]`. This preserves the no-inference rule: metadata-only hits still do not invent a body/text match.

## 2026-06-23 Field-Window Resource Handle Decision

Follow-up ChatGPT retesting showed the evidence path now passes for ordinary Slack message classification, but `pdpp://field-window/...` URIs remain unreadable through ChatGPT's generic resource reader. Local MCP SDK `resources/read` still succeeds, so the failure is not a resource-server selector bug; it is a host capability mismatch.

Decision: field-window resource URIs are not a model-visible continuation in MCP search or bounded-read responses. Model-visible surfaces SHALL expose the bounded evidence and `read_record_field` continuation args. Field-window resource URIs may remain in hidden tool-result metadata for clients that explicitly support MCP `resources/read`.

This removes the hosted-client dead-end without deleting resource-template support.
