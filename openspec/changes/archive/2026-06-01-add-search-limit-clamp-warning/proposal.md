## Why

The agent-token-efficiency surface audit
(`tmp/workstreams/ri-agent-token-efficiency-surface-audit-v1-report.md`,
residual risk #2) found the last *silent* page-limit clamp on any read surface:
the direct-REST search routes (`/v1/search`, `/v1/search/semantic`,
`/v1/search/hybrid`) clamp an over-cap `limit` to 100 and return the bounded
page with no signal, while the records-list path emits a structured
`limit_clamped` warning for the same situation
(`add-records-limit-clamp-warning`, archived). The published search contract and
`/.well-known/oauth-protected-resource` already advertise
`capabilities.{lexical,semantic,hybrid}_retrieval.max_limit = 100`, but a direct
REST caller that optimistically sends `limit=500` is told nothing — it can keep
asking for a 500-hit page every round and reason against a page that never
existed. This is exactly the token-efficiency surprise the agent-facing read
contract is meant to close.

There is also a latent bug behind the silence: the `rs.search.lexical`,
`rs.search.semantic`, and `rs.search.hybrid` operations already build the
canonical `meta.warnings[]` slot (they emit `deprecated_alias_used` and
`source_skipped_not_applicable` today), but the native Fastify shells
(`runLexicalSearch` / `runSemanticSearch` / `runHybridSearch` in
`server/search*.js`) rebuild the REST envelope and **drop `meta`**. So *no*
search warning — not even the pre-existing alias/skip warnings — reaches a
direct REST caller. The operation-level warning tests pass because they assert
against the operation output, not the native REST envelope. Fixing the silent
limit clamp therefore requires carrying `meta` through the REST shells, which
also makes the already-specced alias/skip warnings honest on REST.

## What Changes

- **REST/RS (additive, non-breaking).** Each search operation keeps clamping an
  over-max `limit` to 100 — a lenient, non-breaking choice — but the reduction is
  no longer silent. When the raw `limit > 100`, the operation appends a
  structured `limit_clamped` entry to the canonical `meta.warnings[]` envelope,
  naming the requested limit and the effective maximum, mirroring the records
  `limit_clamped` wire shape (`code`, `param: 'limit'`,
  `detail.requested_limit` / `detail.max_limit`). A `limit` within the cap
  (including exactly 100) emits no warning. A non-positive/unparseable/absent
  `limit` falls back to the default 25 and is not reported as a clamp (there is
  nothing to honestly report). This reuses the established `meta.warnings[]`
  channel and the already-canonical `limit_clamped` code; no new envelope field
  shape is introduced.
- **REST shell meta passthrough (latent-bug fix).** The native
  `runLexicalSearch` / `runSemanticSearch` / `runHybridSearch` shells now copy
  the operation envelope's `meta` onto the REST response when present, so every
  search warning (`limit_clamped`, `deprecated_alias_used`,
  `source_skipped_not_applicable`) reaches a direct REST caller instead of being
  dropped at the host boundary.
- **MCP (unchanged, regression-guarded).** The MCP `search` tool already rejects
  an over-max `limit` at input validation (`max(100)` in
  `packages/mcp-server/src/tools.js`) rather than forwarding it to be clamped.
  This change does not alter that behavior; it adds a regression test pinning it
  so the REST clamp-warning work cannot be mistaken for a license to clamp on the
  MCP path.
- **Tests.** Enforceable acceptance tests prove: each operation appends a
  `limit_clamped` warning when `limit > 100` and omits it at/below the cap and
  for invalid/absent limits; hybrid emits a single deduplicated `limit_clamped`
  warning; the native REST shells carry the warning through to the response
  envelope; and the MCP `search` tool still rejects `limit > 100` at input
  validation while advertising the inclusive `maximum: 100`.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: the "Public read warnings SHALL be
  structured and closed over known non-fatal outcomes" requirement gains a
  search-scoped `limit_clamped` scenario (the requirement text already admits "a
  clamped page limit" as a known non-fatal outcome); the "MCP read tools SHALL
  mirror the canonical public read contract" requirement gains a scenario
  pinning the search `limit` cap as an argument the MCP surface validates rather
  than forwards-then-clamps.

## Impact

- **Additive on REST.** Existing callers that send `limit ≤ 100` (or omit it)
  see no change. Callers that send `limit > 100` still receive a valid bounded
  page; they additionally receive a `limit_clamped` warning in
  `meta.warnings[]`. No caller starts receiving a 400 it did not receive before.
  Result ordering, search semantics, scoring, cursor behavior, the max value
  (100), and connection-identity behavior are unchanged.
- **Honest pre-existing warnings.** Direct REST search callers now also receive
  the `deprecated_alias_used` and `source_skipped_not_applicable` warnings the
  operations already produced but the shells previously dropped. This is a
  fix toward the already-accepted public-read warning contract, not a new
  contract.
- **MCP unchanged.** The MCP `search` tool's accepted value set (1–100) and its
  reject-over-max behavior are unchanged; only a regression guard is added.
- No change to grant evaluation, disclosure, records/aggregate limits, blob or
  fetch behavior, or `/_ref` timeline pagination.
