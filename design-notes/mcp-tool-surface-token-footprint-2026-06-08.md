# MCP Tool Surface Token Footprint vs. Documented Practice

Status: captured
Owner: project owner (the owner) + RI owner
Created: 2026-06-08
Updated: 2026-06-08
Related: `packages/mcp-server/src/tools.js`, `packages/mcp-server/src/server.js`,
  `openspec/specs/mcp-adapter/spec.md`,
  prior token-efficiency work (compact `schema` projection / `schema_compact` endpoint)

## Question

How does the size and organization of PDPP's hosted MCP tool surface
(`tools/list`) compare to documented MCP/host limits and community-reported
best practices, and where are the gaps? This note records the current state and
the external guidance; it deliberately does not prescribe a redesign.

## Context

### Measured current state (live, 2026-06-08, revision 02406c29/96ff2002)

Captured directly from `POST https://pdpp.vivid.fish/mcp` `tools/list` with a
valid scoped token:

- **14 tools**, total `tools/list` payload **~49.6 KB ≈ ~12,400 tokens**
  (chars/4 estimate).
- Per-tool estimated token cost (total incl. inputSchema | of which description):
  - `query_records` ~1,982 | desc ~373
  - `aggregate` ~1,587 | desc ~426
  - `search` ~1,454 | desc ~282
  - `fetch` ~1,038 | desc ~155
  - `create_event_subscription` ~1,022 | desc ~460
  - `list_streams` ~732 | desc ~169
  - `fetch_blob` ~686 | desc ~150
  - `schema` ~681 | desc ~210
  - `update_event_subscription` ~626 | desc ~378
  - `send_test_event` ~592 | desc ~361
  - `get_event_subscription` ~530 | desc ~300
  - `delete_event_subscription` ~523 | desc ~291
  - `list_event_subscriptions` ~508 | desc ~328
  - `discover_event_subscription_capabilities` ~436 | desc ~152
- **~16 KB of the payload is tool descriptions; the remainder is inputSchemas.**
- The **6 `*_event_subscription` tools** together are **~3,200 tokens (~26%)**
  of the surface.
- Cross-cutting protocol guidance is **repeated inline across tools**. The
  ~150-word `connection_id` disambiguation paragraph and the `available_connections`
  error-recovery paragraph appear, near-verbatim, on ~9 of the 14 tools; the
  typed-`filter` object encoding explanation is repeated on `query_records`,
  `aggregate`, and `search`; the event-subscription signing/delivery contract
  is repeated across all 6 event tools.

### Observed behavior (not a hard block today)

In live connect captures on the current revision, both ChatGPT and Claude
ingested the full 14-tool surface and routed tool calls successfully. So the
current footprint is **not** producing a hard ingestion failure at this size on
these hosts as of this date. The footprint is a recurring per-session and
per-client cost (every client carries the full surface in context for the whole
session), and a potential exposure to the host limits documented below, not a
currently-reproduced outage.

### What the output layer already does

The surface already applies token discipline on the **output** side: the
`schema` tool defaults to a compact projection (`detail: "compact"`) and
documents `detail: "full"` as opt-in; tool results put a short preview in
`content` and the full body in `structuredContent`. The gap described here is on
the **description / discovery** layer, where that discipline is not applied.

## Documented and community-reported guidance

### Officially documented (primary sources)

- **MCP tool result fields and what reaches the model.** Per the MCP tools spec,
  a tool result carries `content`, optional `structuredContent`, and `_meta`.
  Community and OpenAI Apps SDK guidance is that `content` enters the model
  context, `structuredContent` is primarily client/widget-facing, and `_meta` is
  not exposed to the model — i.e. large model-visible output belongs in lean
  `content`, bulk in `structuredContent`/`_meta`
  [MCP-TOOLS-2025-06-18][APPS-SDK-MCP][MCP-DISC-1563].
- **Anthropic guidance / data on tool-definition size.** Anthropic's advanced
  tool-use material reports that large tool-definition footprints materially
  cost context and degrade selection accuracy, and that deferred/just-in-time
  tool loading produced large token reductions and accuracy gains in their
  measurements [ANTHROPIC-ADV-TOOLUSE]. (This is vendor guidance + benchmark,
  not a hard limit.)

### Community-reported (not found in official docs)

- **A ~5,000-token limit on the MCP tool-description / tools/list payload in
  ChatGPT.** Reported independently by multiple developers on the OpenAI
  community forum as an explicit setup-time rejection
  [OPENAI-FORUM-TOKEN-LIMIT][OPENAI-FORUM-TRUNCATION]. **This figure is not
  confirmed in official OpenAI documentation**; the truncation thread's author is
  themselves asking whether a documented limit exists. Treat as widely-repeated
  community lore, not a citable spec. PDPP's current ~12,400-token surface is
  larger than this reported figure, yet connected successfully in our captures —
  so either the figure is approximate, applies differently than stated, or is
  enforced inconsistently.
- **A separate ChatGPT "tool response budget" that truncates large tool
  *results*** "at a line boundary," distinct from the tool-description limit; a
  developer reported a previously-working schema-discovery response starting to
  be silently truncated with the connector error *"Response output was truncated
  at a line boundary to fit the tool response budget"* [OPENAI-FORUM-TRUNCATION].
  Also community-reported, not in official docs; relevant because PDPP read tools
  (`query_records`, `search`) can return large pages.
- **Concise, verb-first tool descriptions reduce mis-routing.** Practitioner
  write-ups report meaningful reductions in misrouted tool calls from tightening
  descriptions, and document real-world MCP servers consuming tens of thousands
  of tokens in tool definitions alone; some hosts also impose hard tool-*count*
  caps (e.g. reported client-side caps) [APIGENE-MCP][SCOTT-SPENCE-MCP]. Quality
  of evidence here is practitioner-blog level, not specification.

### What could not be found

- No official OpenAI documentation of a numeric limit for tool descriptions,
  `tools/list` size, or tool-result size. The 5,000-token figure and the
  "response budget" are community-reported only.
- No statement in the MCP specification of a maximum `tools/list` size; the spec
  is silent on size, leaving it host-defined.

## Stakes

- **Per-session cost across all clients.** The full surface is sent on every
  connection and held in context for the session, on every PDPP MCP client
  (Claude, ChatGPT, Codex, MCPJam), independent of any host limit.
- **Exposure to undocumented host limits.** Because the relevant ChatGPT limits
  are community-reported and apparently enforced inconsistently, the current
  footprint sits in an unpredictable zone: it works today but its margin to any
  real cap is unknown and host-controlled.
- **Routing accuracy.** External guidance associates leaner, less-repetitive
  descriptions with better tool selection; the inverse exposure (duplicated
  multi-paragraph caveats) is unmeasured for PDPP specifically.
- **Silent-truncation risk (results, not schema).** The reported response-budget
  truncation is a correctness risk distinct from footprint: a truncated read
  result is silently partial, which is harder to detect than a hard failure.

## Observations (not recommendations)

This section records what the comparison surfaces, without proposing a solution.

- PDPP's output layer is token-disciplined (compact `schema` default;
  `content`/`structuredContent` split); the description/discovery layer is not,
  and the asymmetry appears to be a deliberate choice favoring standalone-agent
  self-documentation over footprint.
- The largest single structural pattern is **inline duplication** of
  cross-cutting protocol guidance (`connection_id`, typed `filter`,
  `available_connections` recovery, event-subscription contract) across many
  tools, rather than stating it once.
- The MCP protocol provides a server-level `instructions` field and the `schema`
  document as candidate single-source locations for cross-cutting guidance; it is
  an open question whether and how PDPP should use them, and that question is left
  open here.
- The surface is **flat and undifferentiated** by usage frequency: advanced,
  rarely-used tools (the 6 event-subscription tools, ~26% of the footprint) carry
  the same always-present weight as the core read tools. Whether tiering or
  opt-in advanced surfaces is desirable is an open question, not a recommendation.
- The community 5,000-token figure and the response-budget truncation are
  **unverified against official docs**; any decision that leans on them should
  first establish whether they are real, current, and applicable — they are
  recorded here as claims to verify, not as constraints to design against.

## Promotion Trigger

Promote to an OpenSpec change only if the owner decides to act on the tool
surface. A reasonable precondition is resolving the open verification questions
first (does an official ChatGPT tools/list or tool-result limit exist; does the
response-budget truncation affect PDPP read results in practice), so that any
change is motivated by confirmed constraints and/or the standalone
efficiency/accuracy case rather than community lore.

## Decision Log

- 2026-06-08: Captured during a connector-debugging session in which all four
  observed clients (MCPJam, Claude, ChatGPT, Codex path) ultimately connected on
  the current revision. Measured the live `tools/list` at ~12,400 tokens / 14
  tools and recorded the per-tool breakdown and the inline-duplication pattern.
  Recorded external guidance with explicit provenance, separating officially
  documented sources from community-reported figures. Left non-prescriptive per
  owner instruction: describe current state vs. documented/community practice,
  do not propose a redesign.

## References

- [MCP-TOOLS-2025-06-18] MCP Tools specification (2025-06-18).
  https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- [MCP-DISC-1563] MCP discussion — structuredContent vs content in CallToolResult.
  https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1563
- [APPS-SDK-MCP] OpenAI Apps SDK — Build your MCP server.
  https://developers.openai.com/apps-sdk/build/mcp-server
- [ANTHROPIC-ADV-TOOLUSE] Anthropic — Advanced tool use on the Claude Developer
  Platform. https://www.anthropic.com/engineering/advanced-tool-use
- [OPENAI-FORUM-TOKEN-LIMIT] OpenAI community — Token limit when connecting
  ChatGPT with external MCP.
  https://community.openai.com/t/token-limit-when-connecting-chatgpt-with-external-mcp/1371022
- [OPENAI-FORUM-TRUNCATION] OpenAI community — Tool response truncation on MCP
  connector responses that previously worked.
  https://community.openai.com/t/tool-response-truncation-on-mcp-connector-responses-that-previously-worked/1383071
- [APIGENE-MCP] Apigene — MCP Best Practices for Production (2026).
  https://apigene.ai/blog/mcp-best-practices
- [SCOTT-SPENCE-MCP] Scott Spence — Optimising MCP Server Context Usage in Claude
  Code. https://scottspence.com/posts/optimising-mcp-server-context-usage-in-claude-code
- Live measurement: `POST https://pdpp.vivid.fish/mcp` `tools/list`, 2026-06-08.
