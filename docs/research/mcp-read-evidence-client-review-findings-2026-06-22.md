# MCP Read Evidence Surface — Client/UX Review Findings

Date: 2026-06-22
Scope: `openspec/changes/unify-read-evidence-surface` (proposal, design, tasks, spec deltas)
Lens: client/UX behavior across ChatGPT, Claude (app/Desktop/Code), Codex, Gemini CLI, Hermes, opencode, Cursor/IDEs.
Method: read the change set; cross-checked its claims against the actual deployed adapter
(`packages/mcp-server/src/tools.js`), the RS read routes (`reference-implementation/server/routes/rs-read.ts`,
`rs-hosted-mcp.ts`), and the design's own cited source material
(`docs/research/mcp-client-read-surface-findings-2026-06-22.md`,
`docs/research/mcp-read-surface-slvp-assessment-2026-06-22.md`).
No code was edited.

These are durable facts. The disposition (LAND/HOLD) lives in `tmp/workstreams/read-client-gate-report.md`.

## What is actually deployed today (verified against source)

The MCP adapter registers exactly five tools and a hard guard (`selectNormalTools`,
`packages/mcp-server/src/tools.js`) throws if any tool outside this set appears:

- `schema`, `query_records`, `aggregate`, `search`, `fetch`.

There is **no** `read_record_field` tool, **no** field-window tool, and **no** field-window RS route
anywhere in committed non-dist source. A repo-wide grep for `read_record_field`, `field-window`,
`field_window`, `content_ladder`, `contentLadder` over `*.ts/*.js/*.mjs` (excluding `node_modules`,
`dist/`, `.next/`, and `untracked-artifact-backups`) returns nothing.

`fetch` (tools.js, the `name: 'fetch'` tool) resolves a search-result id to
`GET /v1/streams/{stream}/records/{record_id}` and returns OpenAI-document fields
(`id`, `title`, `text`, `url`, `metadata`). It returns **no** continuation ladder, **no** field-window
arguments, **no** `resource_link`, and **no** explicit truncation→continuation pairing for a large body.

Truncation today (tools.js, `RECORD_PREVIEW_CHAR_LIMIT = 1792`) emits
`record_preview_truncated=true; machine envelope in structuredContent.data` — i.e. the recovery path it
points the model to is `structuredContent.data`. The only model-visible resource template is
`pdpp://stream/{name}` (`buildStreamResourceTemplate`); there is no `pdpp://record/...` or
`pdpp://field-window/...` template in the adapter.

## Empirical client grounding (from the cited corpus)

- **ChatGPT is the only client with observed behavior.** The Hyperlane session is the sole live evidence.
  Everything claimed about Claude (app/Desktop/Code), Codex, Gemini CLI, Hermes, opencode, and Cursor is
  **inferred**, not proven. The SLVP assessment states plainly: confidence that client-by-client behavior
  is proven enough to claim >95% is "not yet," and the missing evidence is "fresh live smoke across the
  important clients after deploy/reconnect."
- **ChatGPT observed states (the three failure modes):**
  1. Search proved matches existed but the visible response was mostly envelope/pagination/resource markers
     — insufficient to classify "depended on vs merely mentioned."
  2. Field-window/record handles existed but the ChatGPT path **could not read** `pdpp://field-window/...`
     resources through its generic resource reader — the affordance existed but was not usable in that client.
  3. Full `fetch` made bodies inspectable, but some bodies were delivered via file/materialization that
     **required user approval** — acceptable for bulk export, too heavy for inspecting several small records.
- **MCP spec facts that bound the design:** a `resource_link` from a tool is not guaranteed to be in
  `resources/list`; resources are host-driven (the host decides if/when to read them); `structuredContent`
  is optional and clients may hide or gate it. Therefore `content[]` + model-callable tools must be
  sufficient on their own.

## Finding 1 — Phantom baseline: "migration" is net-new construction

The design (Slice 3) says "Move MCP search/fetch/query content ladder and visible card rendering onto
shared primitives… Preserve existing tool names and deployed behavior." The Concept Ownership and invariants
treat `read_record_field`, field-window continuation, the four-rung content ladder, and binary metadata-only
discipline as **existing** primitives to be relocated into a shared module.

None of those exist in deployed source (see "What is actually deployed today"). The cited SLVP assessment
compounds this: it asserts "The deployed MCP ladder now offers `read_record_field` as the small-field path"
and frames the remaining work as "fresh ChatGPT smoke after reconnect." That statement is not supported by
the tree.

Consequence: the work is **build**, not **migrate**. The risk profile of net-new tools (new tool-list
entries, new RS route, new approval/resource surfaces, new client-compat unknowns) is materially higher than
a refactor that preserves observed behavior, and the proposal currently hides that risk behind "preserve
deployed behavior" language. This is the single most important correction for the change set.

## Finding 2 — Present dead-end the design names but does not fix in the bounded tranche

Invariant #1 (no dead ends) and #5 (tool fallback because `structuredContent` is not uniformly visible) are
correct and well-grounded. But **today's** truncation recovery path on `query_records`/`fetch` previews is a
pointer to `structuredContent.data`. On a `content[]`-only client (the exact ChatGPT state #1, and the
general class invariant #5 is written to defend against), that pointer is a dead end: the model is told to
look at a surface it cannot see, with no model-callable tool to pull the omitted body field-by-field.

The proposed fix (a model-controlled field-window tool) is exactly right — but it lands in Slice 1–3, while
the dead-end exists in production now. The review should ensure the no-dead-end regression gate is written
against `content[]`-only rendering (structuredContent hidden), not merely "a continuation field exists in
the envelope."

## Finding 3 — Materialization blind spots

The design's Incidental Complexity Ledger lists "ChatGPT may require user approval for file/resource
materialization" and rules it an adapter-boundary fact. Three blind spots remain:

- **Approval count is a first-class UX cost, not just incidental.** The ChatGPT finding shows materialization
  approval made `fetch` "too interaction-heavy as the normal path." Yet approval count only appears in
  Slice 5 measurement; nothing in Slices 1–4 forces the design to keep the *normal* small-record read path
  off the materialization/approval path. A field-window tool helps only if the adapter actually routes
  small reads through it rather than through a resource/file. There is no invariant that says "the normal
  small-record inspection path SHALL NOT require host materialization approval."
- **The `pdpp://field-window/...` resource was observed unreadable in ChatGPT.** Invariant #6 (resource
  fallback) is fine as an *additional* path, but the design must not let any surface treat the field-window
  *resource* as the field-window delivery mechanism. The model-callable tool must carry the bytes; the
  resource is decorative on the ChatGPT path. Spec scenario "Resource read is unavailable" covers this for
  generic content but is not tied specifically to the field-window continuation, which is where the observed
  failure was.
- **Binary/blob discipline is asserted but unbuilt and unmeasured.** Spec requires large binary fields to be
  metadata-only with an "authorized resource/export continuation when available." The export/materialization
  path is precisely the approval-gated path on ChatGPT. "When available" is doing heavy lifting — a binary
  field with no usable export path on a given client is a dead end that the current invariants do not catch
  (invariant #8 says metadata-only "by default with explicit export/resource paths," but does not require the
  export path to be reachable on `content[]`-only clients). Confidence in export/file delivery in the corpus
  is only 92%, the lowest of the behavioral requirements.

## Finding 4 — Missing measurement gates / sequencing inversion

- **Measurement is deferred to Slice 5, after the MCP migration ships in Slice 3.** The design lets shaping
  changes (new cards, new ladder, new tools) land before any token/call/approval/answer-success measurement
  exists. The corpus is explicit that "Demonstrably simplest or most token-efficient design: 60% until
  measured" and "Exact envelope shape, URI grammar, short-id aliasing, and tool decomposition need
  measurement… before being treated as final." The gate should require at least a baseline measurement of
  the current 5-tool surface **before** Slice 3 reshapes it, so regressions are detectable.
- **No numeric acceptance thresholds.** Slice 5 lists the right dimensions (token payload, call count,
  approval count, latency, answer success) but sets no target or no-regression bound. "Measure X" with no
  pass/fail bar is not a gate. A client cannot be marked "proven" without a stated success criterion.
- **The client matrix has no proven/inferred enforcement in the acceptance checks of Slices 1–4.** Only
  Slice 5 says "distinguish proven from inferred." Until then the design may describe seven clients'
  behavior as if known. The acceptance checks should forbid asserting unproven client behavior in spec
  scenarios and require each of the seven clients to be labeled proven/inferred wherever it is named.
- **Cross-surface parity (invariant #10) has no oracle.** "MCP, CLI, and REST evidence projections must
  agree" needs a concrete equality check (same identity/provenance/truncation/continuation/role bytes for
  the same record), or it is unfalsifiable. Slice 1 task 1.3 mentions a cross-surface test but the design
  does not define what "agree" means at field granularity.

## Finding 5 — Overfit risks (ChatGPT-shaped assumptions leaking into core)

- **Self-contained handles vs short aliases.** The corpus warns against replacing self-contained `fetch` ids
  with short aliases (multi-source grants need the connection encoded in the id). The design's
  "self-contained record handles and optional short aliases" wording (Concept Ownership) is consistent, but
  the spec deltas do not state that the canonical handle stays self-contained and the alias is page-scoped
  only. Without that, an implementer optimizing ChatGPT model-visible ergonomics could weaken multi-source
  resolution. Low-likelihood but worth one explicit invariant.
- **512-character self-contained instruction rule** (OpenAI Apps SDK guidance, from the corpus) is a
  ChatGPT/Codex-specific constraint. It is correctly *not* in the spec — good. Flagging it so it does not
  later migrate into a core requirement.
- **"Evidence card" as a shared core concept is largely unvalidated** beyond ChatGPT. The corpus rates the
  four-rung ladder conceptual model at 88% and "separate field/window tool as the best implementation" at
  70%. Promoting evidence cards to shared core semantics (reference-implementation-architecture spec,
  "Shared Read Evidence Semantics") commits CLI/REST/console to a shape proven on one client. The bounded
  default is fine; the *shared-core elevation* should wait for at least a second client's confirmation, or
  be explicitly scoped as MCP+CLI-only until measured (which the design half-does, but the new arch
  requirement reads broader than that).

## What is genuinely strong in the change set

- Invariants #1 (no dead ends), #4 (bounded default), #5 (tool fallback over structuredContent), #7 (honest
  completeness: counts/cursors prove reachability not meaning), and #8 (binary discipline) are the right
  client-derived requirements and match the corpus.
- Keeping RS/REST as canonical authorization and query authority, with adapters rendering only, is the
  correct boundary and directly answers the "don't make MCP special" risk.
- The negative-control requirement (prove field-name guessing is not reintroduced) is the right defense and
  is consistent with prior Explore SLVP work.
- Deferring the ChatGPT batch-review UI widget and not requiring it for model-controlled reading is correct;
  it keeps a host-UI nicety out of the protocol surface.

## Re-review update (2026-06-22, after first patch)

The change set was patched in response to this review. Two durable changes:

- **Finding 1 (phantom baseline) is now addressed in-spec.** The proposal, design, and tasks no longer assume
  `read_record_field` / field-window / content ladder are deployed. The design adds a "Baseline And Dependency"
  section and a Slice 1 "Prerequisite baseline" that lands/imports `add-mcp-content-ladder` before any MCP
  migration; "migrate" wording is now explicitly gated on the prerequisite existing in code. The underlying
  source facts in this document are unchanged and remain accurate: the deployed MCP surface is still exactly
  the 5 tools above, and the content-ladder primitives are still absent from this checkout. The proposal now
  *declares* that gap rather than *contradicting* it.
- **Finding 3 (materialization) partially addressed.** A new mcp-adapter scenario ("Small text inspection
  avoids materialization") requires a model-visible inline read path for bounded small text and forbids
  full file/export materialization as the *ordinary* path. The binary-export-reachability sub-point (export
  path must be reachable on `content[]`-only clients, or declared unreachable) remains open.

Still open (no spec change yet): numeric measurement bounds + baseline-before-reshape sequencing (Finding 4),
proven/inferred enforcement across slices (Finding 4), the no-dead-end gate written against `content[]`-only
rendering at the shared-primitive level (Finding 2), and a falsifiable parity oracle for invariant #10
(Finding 4). Disposition remains HOLD; see `tmp/workstreams/read-client-gate-report.md`.

## Verification notes

- `openspec validate unify-read-evidence-surface --strict` passes. This proves structural validity only; it
  does not detect the phantom-baseline problem in Finding 1, because OpenSpec does not check claims against
  source.
- Tool inventory verified at `packages/mcp-server/src/tools.js` (`buildTools`, lines ~396–636; guard
  `selectNormalTools` ~14–40; truncation `RECORD_PREVIEW_CHAR_LIMIT` ~1146–1182).
- Absence of field-window/`read_record_field`/content-ladder verified by repo-wide grep over non-dist
  source.
