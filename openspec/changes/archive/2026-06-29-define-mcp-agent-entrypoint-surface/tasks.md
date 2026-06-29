## 0. SLVP Owner Gate

- [x] 0.1 Score the serious entrypoint designs in `design.md`: flat trimmed
  list, server profiles/toolsets, split workflow endpoints, client allow-lists,
  host-native deferred loading/tool search, grant-shaped `tools/list`,
  resources/prompts/skills, and one operation-enum tool.
- [x] 0.2 Record current measured profile payloads and whether each candidate
  meets the default setup bar for Claude Code, Codex, ChatGPT/OpenAI Responses,
  and generic MCP clients.
- [x] 0.3 Choose the recommended entrypoint per target host and update setup UX
  tasks to implement that choice instead of mechanically defaulting every host
  to a named profile.
- [x] 0.4 Classify explicit profiles as essential complexity or incidental
  complexity and remove profile vocabulary from the recommended UX.
- [x] 0.5 Decide whether the normal read path should remain the five-tool
  structured read surface or split into a smaller data-only `search`/`fetch`
  path plus an explicit structured read/query path.
- [x] 0.6 Decide whether grant-shaped `tools/list` is part of this change or an
  explicit follow-up, with rationale.
- [x] 0.7 Update proposal/design/spec wording after the decision so the final
  OpenSpec state names the selected SLVP ideal rather than the interim tranche.

## 1. OpenSpec

- [x] 1.1 Create proposal, design, spec delta, and tasks for MCP agent entrypoint
  surface selection.
- [x] 1.2 Validate with `openspec validate define-mcp-agent-entrypoint-surface --strict`.

## 2. Profile-Free MCP Surface

- [x] 2.1 Expose one profile-free normal read surface.
- [x] 2.2 Do not define a hosted MCP profile-selector interface.
- [x] 2.3 Do not advertise local stdio profile selectors.
- [x] 2.4 Remove profile advertisement from protected-resource metadata.

## 3. Tool Membership

- [x] 3.1 Normal surface includes only `schema`, `query_records`, `search`, `fetch`, and `aggregate`.
- [x] 3.2 Event-subscription management tools do not appear in the normal MCP surface.
- [x] 3.3 Full/developer tools do not appear in the normal MCP surface.
- [x] 3.4 Ensure the normal surface preserves grant-scoped authorization and owner-token rejection.
- [x] 3.5 Keep canonical `connection_id` as the only MCP source selector and
  remove the deprecated `connector_instance_id` alias from MCP inputs.

## 4. Setup UX

- [x] 4.1 Update operator setup copy so the default command connects to the
  SLVP-selected normal read entrypoint for the target client.
- [x] 4.2 Remove events and full/developer profile setup from recommended MCP setup.
- [x] 4.3 Ensure setup copy does not ask the operator to paste owner/control-plane bearer tokens.
- [x] 4.4 Keep setup copy short enough that advanced tool-surface choices do not
  appear before the first recommended command.
- [x] 4.5 For Claude Code, Codex, and ChatGPT/OpenAI Responses, document whether
  setup uses server profile selection, host-native filtering/deferral, or both.
- [x] 4.6 If profiles are incidental, ensure recommended setup copy does not show
  `core`, `events`, `full`, or equivalent mechanism labels before the advanced
  section.

## 5. Measurement And Tests

- [x] 5.1 Add tests that generate `tools/list` for the normal surface and assert exact tool membership.
- [x] 5.2 Add byte-budget tests for the normal surface payload.
- [x] 5.3 Add regression coverage proving event tools do not appear in the normal surface.
- [x] 5.4 Add regression coverage proving profile selectors are not advertised.
- [x] 5.5 Add regression coverage proving data-tool schemas expose
  `connection_id` and not `connector_instance_id`.

## 6. Verification

- [x] 6.1 Run focused MCP server tests.
- [x] 6.2 Run hosted MCP smoke for the profile-free normal surface.
- [x] 6.3 Run hosted MCP smoke proving the normal surface remains exact.
- [x] 6.4 Run `openspec validate define-mcp-agent-entrypoint-surface --strict`.
- [x] 6.5 Run `openspec validate --all --strict`.

## 7. Dashboard Setup UX

- [x] 7.1 Add `/dashboard/connect` as the ordinary AI-app setup page.
- [x] 7.2 Show the resolved `/mcp` URL before host-specific commands.
- [x] 7.3 Add copy-paste setup commands for Claude Code and Codex.
- [x] 7.4 Include ChatGPT/Claude.ai remote MCP setup as URL-shaped copy rather
  than a token or profile choice.
- [x] 7.5 Keep CLI-first scoped access and agent-readable discovery secondary.
- [x] 7.6 Link deployment readiness and dashboard navigation to the setup page.
- [x] 7.7 Add invariants that reject owner-token setup copy and profile
  vocabulary on the ordinary setup page.
- [x] 7.8 Run focused dashboard setup UX tests.
- [x] 7.9 Run `openspec validate define-mcp-agent-entrypoint-surface --strict`.
- [x] 7.10 Run `openspec validate --all --strict`.
- [x] 7.11 Reserve `/dashboard/connect` from the legacy bare-connector redirect
  so the setup page is reachable.

## 8. Model-Visible Read Journey Closure

- [x] 8.1 Require `stream` when `schema` is called with `detail: "full"`.
- [x] 8.2 Keep global `schema` compact and model-visible for stream selection.
- [x] 8.3 Include `next_cursor`, `next_changes_since`, and count metadata in
  `query_records` text when present.
- [x] 8.4 Include `next_cursor` in `search` text when present.
- [x] 8.5 Include stream-scoped aggregate-capable field summaries in
  `schema(stream)` text.
- [x] 8.6 Normalize `invalid_sort` HTTP envelopes to request-error class.
- [x] 8.7 Run focused MCP/read-surface tests after the model-visible closure.
- [x] 8.8 Run OpenSpec strict validation after the model-visible closure.
- [x] 8.9 Redeploy the standard reference image and live-smoke the closed
  ChatGPT/Claude-visible paths.

## 9. Post-Battery SLVP Closure

- [x] 9.1 Record the ChatGPT, Claude, Claude Code, and Codex feedback in a
  short RI-owner triage ledger.
- [x] 9.2 Preserve a change-local prior-art/research artifact for MCP host
  tool-result rendering, structured output visibility, discovery patterns, and
  safety hints.
- [x] 9.3 Specify and implement global fan-in `search` limit semantics with
  per-hit source identity and compact source-mix visibility.
- [x] 9.4 Specify and implement `schema(stream, connection_id?)` so shared
  stream names can be narrowed without loading the whole grant package.
- [x] 9.5 Keep global `schema()` small in both `content[]` and
  `structuredContent`; broad discovery SHALL be an index, not a compressed
  field-capability dump.
- [x] 9.6 Specify and implement strict projection for `fetch(fields)` and
  projected `query_records`, preserving only required operational envelope keys
  outside projected canonical record payloads.
- [x] 9.7 Replace or document the compact schema capability mini-grammar with a
  visible legend and tests proving agents can use it.
- [x] 9.8 Verify hosted `tools/list` exposes read-only tool annotations.
- [x] 9.9 Record ChatGPT pre-dispatch safety false positives as a host-behavior
  watch item; later live retests did not reproduce the earlier exact-search
  safety block.
- [x] 9.10 Add focused byte/token regression tests for fan-in search, projected
  fetch, projected `query_records`, global `schema()`, and
  `schema(stream, connection_id?)`.
- [x] 9.11 Run focused MCP/read-surface tests, `openspec validate
  define-mcp-agent-entrypoint-surface --strict`, and `openspec validate --all
  --strict`.
- [x] 9.12 Run a live `/mcp` smoke after deploy/host refresh.
- [x] 9.13 Fix `schema(stream, detail: "full")` so REST full schema scoping and
  MCP package forwarding return only matching stream rows, and add regressions.
- [x] 9.14 Redeploy after the scoped-full fix and run a live `/mcp` smoke that
  proves `schema.connection_id` is host-visible and scoped full schema is
  bounded.
- [x] 9.15 Make exhaustive schema single-source: reject shared-stream
  `detail:"full"` calls without `connection_id`, locally scope schema by
  `connection_id`, remove duplicated compact stream lists, and fix search
  snippet/title presentation.
- [x] 9.16 Redeploy with a unique reference revision and run a live `/mcp`
  smoke proving shared-stream full schema now fails closed while
  `schema(stream, connection_id, detail:"full")` stays bounded.
- [x] 9.17 Make package `ambiguous_connection` errors fast and bounded: do not
  probe every child source to construct the error, cap large
  `available_connections` lists, and include count/truncation metadata plus a
  `schema` discovery hint.
- [x] 9.18 Redeploy after the package ambiguity fix and run a live broad-package
  `/mcp` probe proving `tools/list`, shared-stream full schema, scoped full
  schema, and omit-`connection_id` ambiguity remain bounded.
- [x] 9.19 Pin `fetch` to the MCP/OpenAI document contract: return only
  `id`, `title`, `text`, `url`, and `metadata`, mirror that exact object in
  `content[]`, remove the canonical `structuredContent.data` record copy, and
  update regression tests.
- [x] 9.20 Redeploy after the document-only `fetch` contract and run a live MCP
  probe proving full fetch, projected fetch, and `query_records` canonical reads
  have distinct shapes.
- [x] 9.21 Deduplicate scoped full schema stream arrays and make search/fetch
  fallback titles prefer authored/event timestamps over ingestion timestamps.
- [x] 9.22 Redeploy after full-schema dedupe/title fallback and run live probes
  for scoped full schema size/shape, search titles, and fetch titles.
- [x] 9.23 Collapse the schema MCP double-data envelope and propagate
  authored/event timestamps through search results so search/fetch titles align.
- [x] 9.24 Redeploy after the schema-envelope/search-title fix and run live
  probes for `schema(stream, connection_id, detail:"full")`, lexical search
  titles, and fetch title regression.
