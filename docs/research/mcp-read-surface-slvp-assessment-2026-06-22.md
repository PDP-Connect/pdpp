# MCP Read Surface SLVP Assessment

Status: assessment
Date: 2026-06-22
Owner: Codex

## Question

Assess whether PDPP's MCP surface is the SLVP-ideal read surface for ChatGPT-style and agent-harness clients, and whether MCP should reuse more of the general REST/CLI read surface or expose affordances the other surfaces lack.

This is an assessment/design synthesis, not the raw findings note. The underlying findings are captured separately in `docs/research/mcp-client-read-surface-findings-2026-06-22.md`.

Inputs:

- Live deploy at `83bf1613` after `add-mcp-content-ladder`.
- ChatGPT Hyperlane investigation report supplied by the owner.
- Worker reports from the MCP prior-art, read-surface parity, and client-compat lanes, promoted into the findings note above.
- Official MCP tools/resources specs and OpenAI Apps SDK guidance.

## Prior Art Findings

The MCP spec makes two separations load-bearing:

- Tools are model-controlled. If the model must automatically discover and use a read path, that path must be callable as a tool.
- Resources are application-controlled. Resource URIs are useful for host-side context, but clients decide whether and how to read them.
- Tool results may include `resource_link` blocks. A resource linked from a tool is not guaranteed to appear in `resources/list`.
- `structuredContent` is useful and should have an output schema, but compatibility requires useful visible `content[]` too.

OpenAI's Apps SDK guidance points in the same direction for ChatGPT: server instructions and tool descriptors are part of the model-facing UX; keep instructions concise, define tight tool contracts, keep structured data tight/idempotent, and use app/UI resources only when they materially improve the host experience.

Successful large MCP servers show related patterns:

- GitHub MCP uses toolsets and specific tool allowlists to reduce context footprint and keep the model's choice set scoped.
- Sentry MCP explicitly optimizes for human-in-the-loop coding/debugging workflows rather than exposing every upstream API operation.
- Cloudflare's MCP portal/code-mode work is evidence that endpoint-per-tool expansion does not scale; progressive disclosure and scoped execution reduce tool-list cost.

Implication for PDPP: the MCP surface should stay small and intent-shaped, not mirror every REST endpoint as a separate tool. But every model-visible truncation or opaque pointer must have a deterministic continuation path.

## Current PDPP Surface

Resource-server / REST is the canonical read authority:

- `GET /v1/schema`
- `GET /v1/streams`
- `GET /v1/streams/{stream}/records`
- `GET /v1/streams/{stream}/records/{id}`
- `GET /v1/search`, `/semantic`, `/hybrid`
- `GET /v1/streams/{stream}/aggregate`
- `GET /v1/streams/{stream}/records/{id}/field-window`

CLI currently exposes:

- `schema`
- `streams`
- `query-records`
- `fetch`
- `search`
- `aggregate`

MCP currently exposes:

- `schema`
- `query_records`
- `aggregate`
- `search`
- `fetch`
- `read_record_field`
- `pdpp://record/{handle}` and `pdpp://field-window/{handle}` resources.

## Parity Gaps

REST/CLI capabilities MCP should exploit more:

- MCP forwards many query primitives, but its evidence presentation does not yet use the manifest role vocabulary as deeply as Explore does. Declared display roles should influence compact result cards when available.
- MCP's search cards mostly depend on search hit title/snippet fields. They should prefer server-authored match context, match field, source display, semantic time, and declared primary/secondary roles when the RS can supply them.
- MCP's field windows support `q`, `before_chars`, and `after_chars`, but search results do not yet surface a direct match-window selector for the actual matching field. The model may still have to infer which field to window.
- MCP has adapter-local filter encoding, result normalization, handle encoding, and title fallback logic. These should not drift from CLI, Explore, or REST presentation semantics.

MCP capabilities CLI/REST should expose:

- CLI has no first-class field-window command, even though RS and MCP now support it.
- CLI and raw REST do not expose a compact content ladder or evidence-card projection. They return canonical envelopes, but not the model/agent-friendly path from card to fetch to field window to resource.
- REST has the substrate, but not a single shared evidence-card representation that MCP, CLI, and future SDKs can all render.
- MCP now exposes binary/blob fields as metadata-only with continuation handles; CLI/REST should make that discipline equally obvious in human-facing output modes.

## Candidate SLVP Design Direction

The candidate SLVP design is not "make MCP special." It is a shared read/evidence engine with thin adapters:

1. RS owns authorization, canonical query semantics, pagination, projections, field-window reads, binary discipline, and provenance.
2. A shared read/evidence module produces stable record identities, compact evidence cards, continuation handles, declared-role presentation, and binary metadata from canonical RS envelopes.
3. MCP renders that shared output as concise `content[]` text, validated `structuredContent`, `resource_link` blocks, and `read_record_field` continuation.
4. CLI renders the same shared output as `json`, `jsonl`, and table/card modes, and adds a `field-window` command.
5. REST keeps canonical envelopes by default, with an optional evidence projection if non-MCP clients need the same cards without reimplementing adapter logic.

## Assessment Of The ChatGPT Report

Correct observations:

- A search hit without enough visible context is not enough for substantive classification.
- `structuredContent` and resource URIs cannot be the only path, because some clients hide or gate them.
- Field windows are the right abstraction for token-efficient analysis.
- Full fetch/file materialization is too heavy for repeated small-record inspection.
- Counts and cursors prove reachability, not meaning.

Claims to treat carefully:

- Stable short IDs are useful for visible model ergonomics, but PDPP also needs self-contained fetch handles for multi-source grants. The right design is short visible aliases plus exact handles in structured content where possible, not replacing self-contained ids.
- Search result cards rather than REST envelopes is right for MCP/CLI presentation, but REST should keep canonical envelopes by default.
- Fetched records requiring materialization approval is a ChatGPT-host behavior, not a PDPP protocol fact. The deployed MCP ladder now offers `read_record_field` as the small-field path; this needs fresh ChatGPT smoke after reconnect.

## Required Next Work

P0:

- Add a CLI read command for field windows, backed by the same RS route as MCP.
- Define a shared evidence-card/content-ladder module used by MCP and CLI, with RS-compatible inputs.
- Make MCP search cards surface match field and direct field-window arguments for the matching text when RS provides that data.
- Add client smoke tests or documented manual probes for ChatGPT, Claude app/Desktop, Claude Code, Codex, Gemini CLI, Hermes, opencode, and Cursor. Mark each behavior as proven or inferred.

P1:

- Move MCP-local filter/query encoding helpers into a shared package used by CLI and MCP.
- Add an opt-in REST projection for evidence cards if non-MCP clients need the same token-efficient format.
- Use manifest `x_pdpp_role`/field capabilities in MCP result cards without reintroducing client-authored field guessing.
- Add a regression gate that every omitted, truncated, summarized, or referenced underlying content item in visible MCP text has a fetch, field-window, resource URI, or cursor continuation.

P2:

- Explore ChatGPT app UI affordances for batch evidence review, but do not require a UI widget for model-controlled reading.
- Consider short visible aliases per response page, while preserving self-contained fetch ids as the canonical handles.

## Confidence

Confidence that the deployed MCP ladder is a correct first tranche: 90%.

Confidence that the SLVP target is a shared RS-backed evidence/read-window engine with MCP/CLI/REST adapters: 92%.

Confidence that we have client-by-client behavior proven enough to claim greater than 95%: not yet. The missing evidence is fresh live smoke across the important clients after deploy/reconnect, especially ChatGPT `read_record_field`, `resources/read`, and materialization behavior.

## Sources

- https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- https://modelcontextprotocol.io/specification/2025-06-18/server/resources
- https://developers.openai.com/apps-sdk/build/mcp-server
- https://github.com/github/github-mcp-server
- https://github.com/getsentry/sentry-mcp
- https://blog.cloudflare.com/enterprise-mcp/
