## Context

`design-notes/mcp-tool-surface-token-footprint-2026-06-08.md` measured the live
hosted MCP `tools/list` response at about 49.6 KB for 14 tools. The prose
cleanup tranche reduced the complete surface to about 38.5 KB, but kept a flat
tool topology. That is useful hygiene, not the SLVP ideal.

The prior-art pass in
`design-notes/mcp-tool-surface-prior-art-2026-06-08.md` found multiple real
mechanisms: MCP authorization-shaped tool availability, OpenAI
`allowed_tools`/deferred loading, Codex `enabled_tools`/`disabled_tools`, Claude
Code tool search, GitHub toolsets, Stripe permission scoping, and workflow
specialization from Sentry.

## SLVP Decision

The SLVP ideal is one profile-free normal MCP read entrypoint.

Profiles do not remain in the ideal. They are not a user intent, and this repo
has no existing-user constraint that justifies preserving a profile taxonomy.
No hosted or local profile selector interface is defined. The implementation
does not advertise profile selectors or branch on profile vocabulary. The
recommended setup path is one command pointing at `/mcp`.

The normal MCP surface contains exactly:

- `schema`
- `query_records`
- `aggregate`
- `search`
- `fetch`

This is the smallest defensible normal PDPP read surface. `search`/`fetch` alone
matches data-only MCP prior art but loses structured PDPP reads and aggregate
queries. The five-tool surface keeps the normal agent loop intact:
schema discovery, structured record reads, aggregate answers, document-style
search, and fetch-by-result.

`connection_id` remains in the read tools. It is not a profile selector; it is
the canonical source identity needed when one grant can address multiple active
connections under the same connector. The deprecated REST alias
`connector_instance_id` is not part of the SLVP MCP input surface and is omitted
from the compact `schema` projection. REST can continue accepting the alias
under its own compatibility contract.

## Out Of Scope

Event-subscription management is not part of recommended MCP setup. Operators
can manage event subscriptions through operator surfaces or future explicit
workflow tooling; it does not belong in the normal agent read surface.

`list_streams` and `fetch_blob` are not part of recommended MCP setup.
`schema` covers stream discovery, and `fetch` covers the normal search-result
retrieval loop. Blob retrieval can return in a later change only if a concrete
agent workflow proves it belongs in the normal read entrypoint.

Grant-shaped `tools/list` is not part of this change. The normal MCP surface is
already read-only and grant-scoped; stream/field/time constraints are discovered
through `schema` and enforced by the resource server. If a future change
reintroduces non-read MCP workflows, grant-shaped tool availability should be
re-evaluated before adding tools.

## Host Setup

The primary setup for each target host is profile-free:

| Target | Recommended setup |
|---|---|
| Claude Code | One PDPP MCP command/URL pointing at `/mcp`; rely on Claude Code tool search where available. |
| Codex | One `codex mcp add` command pointing at `/mcp`; do not require `enabled_tools` in the primary command. |
| ChatGPT/OpenAI Responses | One normal MCP endpoint for ChatGPT-style setup; API integrations may still use OpenAI `allowed_tools` or `defer_loading` when composing broader app flows. |
| Generic MCP client | One `/mcp` endpoint whose server response is already least-surface. |

## Setup Page Placement

The SLVP operator flow is a top-level dashboard page, `/dashboard/connect`,
labeled "Connect an AI app." Deployment readiness should point to it, but it
should not live under owner-token issuance. Tokens remain a secondary
trusted-local-owner-agent/debug path.

The page should have one primary payload: the resolved MCP URL for the running
deployment. Claude Code and Codex get exact copy-paste command templates because
their CLI prior art is command-shaped. ChatGPT, Claude.ai, and generic remote
MCP clients get the same URL because their setup flows are UI-shaped. CLI-first
agents and agent-readable discovery remain visible as secondary entrypoints:
`pdpp connect <origin>` and `<origin>/llms.txt`.

The page intentionally avoids dense docs, nested component choreography, and
profile vocabulary. It should make the ordinary path hard to confuse with owner
bearer setup.

## Model-Visible Handles

ChatGPT and Claude-style hosted MCP clients may hide or partially render
`structuredContent`. The normal surface therefore cannot rely on hidden
structured output for the next step of a read journey. `content[]` remains
bounded prose, but it must carry the operational handles a model needs:
`next_cursor`, `next_changes_since`, exact count metadata, search/fetch ids,
`connection_id`, and stream-scoped field/aggregation summaries.

The global `schema(detail: "full")` escape hatch is not part of the SLVP ideal.
It preserves an accidental way to load hundreds of KB or megabytes into a
client whose safety/runtime may reject the call. The ideal keeps global schema
compact and requires `stream` for `detail: "full"` so exhaustive raw JSON Schema
is reachable only after the model has selected one stream.

Compact global schema may bound detailed per-stream rows, but it must not hide
stream names from clients that cannot inspect `structuredContent`. When detailed
rows are capped, `content[]` carries a connector-level stream index so the model
can still discover every stream name and then call `schema(stream)`.

## Post-Battery Closure Decisions

The ChatGPT, Claude, Claude Code, and Codex batteries exposed construction gaps
in the selected five-tool surface, not a reason to reintroduce profiles. The
surface remains profile-free, but the read journey must be tightened so broad
grant packages are navigable without hidden state, accidental payload bloat, or
ambiguous source identity.

Global `schema()` is an index. It must fit as a whole tool result, not merely as
visible prose, because hosts may count or reject `structuredContent` even when
their transcript preview hides it. Field-capability detail belongs behind scoped
calls. `schema(stream)` is not enough when common stream names such as
`messages` appear under multiple connectors or connections, so the SLVP detail
call accepts `connection_id` as an optional source scope. The stable
disambiguation tuple is `connection_id`, `connector_key`, `stream`, and record
`id`; `display_name` is human-facing context, not a stable selector.

Fan-in `search` uses a global `limit` after merge/rank, not N per connection.
Each hit carries source identity, and fan-in responses include a compact source
mix when multiple connections contributed. This answers "which connection did
this record come from?" from the result itself rather than through profiles or a
separate selector taxonomy.

Projection narrows canonical record payloads. Required operational envelope keys
may remain outside the projected payload so the agent can page, fetch, audit
source identity, and retry ambiguous reads. Extra source-native fields that are
not required identity fields must not leak through projected payloads; if they
are required, the schema and docs must say so.

`fetch` is the exception because it follows the MCP/OpenAI search-fetch document
contract, not the PDPP record-envelope contract. It returns one document object
(`id`, `title`, `text`, `url`, `metadata`) as `structuredContent` and mirrors
that exact JSON object in `content[]` for host compatibility. It does not also
return the canonical PDPP record under `structuredContent.data`; agents that
need canonical structured records use `query_records`.

The compact field-capability mini-grammar is not accepted as self-evident. It is
either replaced with clearer compact fields or accompanied by a visible legend
and tests proving that a model can construct valid filters, sorts, projections,
and aggregations from the displayed schema alone.

## Acceptance Checks

- Hosted `/mcp` `tools/list` returns exactly the five normal read tools.
- Data-tool input schemas expose `connection_id` and do not expose
  `connector_instance_id`.
- No hosted or local MCP setup copy, metadata, or command advertises profile
  selectors.
- Protected-resource metadata advertises one MCP endpoint and no profiles.
- Setup copy shows one recommended path and no profile taxonomy.
- `/dashboard/connect` shows concrete MCP setup copy for Claude Code, Codex,
  ChatGPT/Claude.ai-style remote MCP clients, CLI-first scoped access, and the
  agent-readable entrypoint without asking for owner bearer material.
- `schema(detail: "full")` without `stream` is rejected; `schema(stream,
  detail: "full")` is available only when the stream resolves to one source,
  otherwise the client must retry with `connection_id`.
- Global `schema()` keeps all granted stream names visible in `content[]` even
  when detailed stream rows are capped.
- `schema(stream)` exposes field and aggregation summaries in `content[]` for
  every matching stream row, including common stream names shared by multiple
  connectors.
- `query_records` and `search` expose `next_cursor` in `content[]` when present,
  and `query_records` exposes `next_changes_since` and count metadata in
  `content[]` when present.
- Global `schema()` stays bounded as a complete tool result and does not carry
  repeated full field-capability detail for broad grant packages.
- `schema(stream, connection_id?)` lets an agent narrow common stream names to
  one configured connection before requesting detailed capabilities.
- Compact schema does not duplicate the same stream list in both top-level and
  connector-nested locations when `connectors[]` is present.
- Scoped `detail: "full"` preserves raw per-field JSON Schema but does not
  duplicate the selected stream list in both top-level and connector-nested
  locations when `connectors[]` is present.
- Schema MCP results place the schema document directly under
  `structuredContent.data`, not under a nested REST-style
  `structuredContent.data.data` envelope.
- Fan-in `search(limit: N)` returns at most N merged hits across all granted
  connections, with per-hit source identity and a compact source mix.
- Search snippets use balanced highlight tags, search titles do not fall back
  to snippets, and fallback titles prefer authored/event timestamps over ingest
  timestamps.
- `fetch` returns a document-only `structuredContent` object, mirrors that
  object exactly in `content[]`, and never includes `structuredContent.data`.
- `fetch(fields)` projects the source record before document rendering, while
  projected `query_records` reads narrow canonical record payloads and preserve
  only required operational envelope keys.
- Missing-`connection_id` ambiguity errors are typed, bounded, and generated
  from package membership without fan-out health probes; large packages include
  total/truncation metadata plus a `schema` discovery hint.
- Any compact schema grammar includes a model-visible legend or is replaced by
  explicit compact fields.
- Owner/control-plane bearer tokens remain rejected.
- Package tests and OpenSpec strict validation pass.
