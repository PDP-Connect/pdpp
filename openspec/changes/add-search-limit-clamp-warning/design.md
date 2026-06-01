## Context

`add-records-limit-clamp-warning` (archived `2026-06-01`) closed the silent
records-list clamp by emitting a `limit_clamped` warning on `meta.warnings[]`.
The search routes were explicitly left out of that change's scope and recorded
as residual risk #2 in the token-efficiency surface audit. This change closes
that last silent clamp for the three search modes.

Two facts shaped the design:

1. The three search operations (`operations/rs-search-{lexical,semantic,hybrid}`)
   already own the `limit` clamp (`clampLimit`, default 25 / max 100) and already
   build the canonical `meta.warnings[]` slot for `deprecated_alias_used` and
   `source_skipped_not_applicable`. The natural place for the `limit_clamped`
   warning is the operation's own param parser, beside the existing alias-warning
   derivation.

2. The native Fastify shells (`runLexicalSearch` / `runSemanticSearch` /
   `runHybridSearch`) rebuild the REST response envelope from the operation
   output but **omit `meta`**. So no operation warning currently reaches a direct
   REST caller. This is a latent bug that the operation-level warning tests do
   not catch (they assert against operation output, not the REST envelope).

## Goals

- Emit a `limit_clamped` warning whenever a search request's raw `limit > 100`,
  with the same wire shape as records (`code: 'limit_clamped'`, `param: 'limit'`,
  `detail.requested_limit` / `detail.max_limit`).
- Make every search `meta.warnings[]` entry reach the direct REST response,
  fixing the pre-existing meta-drop bug at the same time.
- Preserve MCP input caps (reject over-max, do not clamp) and guard it with a
  regression test.

## Non-Goals

- No change to result ordering, scoring, snippets, cursor format, search
  semantics, or the max value (100).
- No change to MCP behavior beyond a regression guard.
- No broadening into schema / fetch / blob / aggregate token work.

## Decisions

### Decision 1: Emit the warning in each operation's param parser

Each operation's `parseSearch*Params` already returns a `warnings[]` array
seeded by `deriveSearchConnectionAliasWarnings(query)`. We add a sibling
`deriveLimitClampedWarning(rawLimit)` that returns a single `limit_clamped`
warning when the raw value parses to an integer strictly greater than
`MAX_LIMIT` (100), and nothing otherwise. The existing `clampLimit` continues to
produce the effective numeric `limit`; the new helper only decides whether to
*report* the clamp.

The clamp-detection predicate mirrors records' `clampRecordsPageLimit`: a
non-positive / unparseable / absent `limit` is *not* a clamp (it falls back to
the default 25 and there is nothing to honestly report), so it emits no warning.
Only a finite integer `> 100` is a clamp.

Rationale: keeping the report-decision in the operation (not the host shell)
means the sandbox Next host and the native Fastify host get identical warning
behavior for free, consistent with how `deprecated_alias_used` and
`source_skipped_not_applicable` already work.

### Decision 2: Carry `meta` through the three REST shells

`runLexicalSearch` / `runSemanticSearch` / `runHybridSearch` add a
`...(result.envelope.meta ? { meta: result.envelope.meta } : {})` spread to the
rebuilt REST envelope. This is the minimal, conservative passthrough: `meta` is
emitted only when the operation produced one, so envelopes for warning-free
requests are byte-for-byte unchanged.

This single line is what actually makes `limit_clamped` (and the pre-existing
alias/skip warnings) observable on REST. Without it, Decision 1 would be inert
on the native path.

### Decision 3: Hybrid emits one deduplicated `limit_clamped`

Hybrid clamps its own `limit` and forwards the *already-clamped* value
(`String(params.limit)`, i.e. 100) to its lexical and semantic sub-runners, so
the sub-runners never re-detect a clamp. Hybrid therefore emits exactly one
`limit_clamped` from its own `params.warnings`. The existing hybrid warning
de-duplication (`pushWarning`, keyed by `code::param`) collapses any incidental
duplicates to one entry, satisfying the "at most one" requirement. The hybrid
warning types are widened to carry the optional `detail` field the
`limit_clamped` warning needs (they previously typed only `code/param/message`).

### Decision 4: MCP unchanged

The MCP `search` tool input schema already enforces `max(100)` and rejects
over-max at validation (`SEARCH_LIMIT_DESCRIPTION` already documents this). This
change adds a regression test only; it does not alter MCP behavior. The spec
delta records the MCP search cap as a validated argument so the contract is
explicit and the REST clamp-warning work cannot be mistaken for a license to
clamp on the MCP path.

## Risks / Trade-offs

- **Surfacing previously-dropped warnings on REST is a behavior change for
  direct REST callers.** A caller that sent the deprecated `connector_instance_id`
  alias or hit a skipped source previously saw no `meta`; it now sees one. This
  is the already-accepted public-read warning contract finally being honored on
  the native path, and `meta.warnings[]` is additive and ignorable. Acceptable.
- **No new envelope field shape.** `meta.warnings[]` already exists in the
  operation envelope type and the canonical read contract; only the host
  passthrough and one new per-mode warning row are added.

## Acceptance Checks

- Each operation appends exactly one `limit_clamped` (with
  `detail.requested_limit` / `detail.max_limit`) when `limit > 100`, and none at
  `limit = 100`, `limit < 100`, absent, `limit = 0`, or non-numeric.
- Hybrid emits at most one `limit_clamped`.
- The native REST shells return the warning in the response envelope `meta`.
- The MCP `search` tool rejects `limit = 500` at input validation and advertises
  inclusive `maximum: 100`.
- `openspec validate add-search-limit-clamp-warning --strict` and
  `openspec validate --all --strict` pass.
