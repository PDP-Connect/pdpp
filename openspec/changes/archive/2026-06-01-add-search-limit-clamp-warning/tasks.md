## 1. Spec Delta

- [x] Modify the `Public read warnings SHALL be structured and closed over known non-fatal outcomes` requirement under `reference-implementation-architecture` to add a search-scoped `limit_clamped` scenario covering clamp, in-range no-op, invalid/absent fallback, hybrid single-warning, and native-host meta passthrough.
- [x] Modify the `MCP read tools SHALL mirror the canonical public read contract` requirement to add a scenario enforcing the search `limit` cap at MCP input validation (inclusive maximum 100, reject over-max, accept ≤ max, no reliance on the REST clamp warning).
- [x] Run `openspec validate add-search-limit-clamp-warning --strict` and `openspec validate --all --strict`.

## 2. Operation Warning Emission (REST/RS, additive)

- [x] In `operations/rs-search-lexical/index.ts`, add a `LIMIT_CLAMPED_WARNING_CODE` export and a `deriveLimitClampedWarning(rawLimit)` helper returning a single `{ code: 'limit_clamped', param: 'limit', detail: { requested_limit, max_limit }, message }` warning when the raw `limit` is a finite integer `> MAX_LIMIT`, and `[]` otherwise; append it to `warnings` in `parseSearchLexicalParams`.
- [x] Mirror the same helper + emission in `operations/rs-search-semantic/index.ts`.
- [x] Mirror the same helper + emission in `operations/rs-search-hybrid/index.ts`; widen the hybrid warning shapes (`NormalizedRequestParams.warnings`, `SearchHybridEnvelopeMeta.warnings`, `pushWarning`, `aggregatedWarnings`) to carry the optional `detail` field.
- [x] Confirm the clamp detection mirrors records: non-positive / unparseable / absent `limit` emits no warning; exactly 100 emits no warning; `> 100` emits one.

## 3. Native REST Shell Meta Passthrough (latent-bug fix)

- [x] In `server/search.js` `runLexicalSearch`, carry `result.envelope.meta` onto the rebuilt REST envelope when present.
- [x] In `server/search-semantic.js` `runSemanticSearch`, same passthrough.
- [x] In `server/search-hybrid.js` `runHybridSearch`, same passthrough.

## 4. MCP Conformance (unchanged, regression-guarded)

- [x] Confirm `packages/mcp-server/src/tools.js` `search` input schema already enforces `max(100)` and rejects over-max at input validation; no behavior change.

## 5. Tests

- [x] `reference-implementation/test/search-limit-clamp.test.js`: per-operation coverage that `executeSearchLexical` / `executeSearchSemantic` / `executeSearchHybrid` append a `limit_clamped` warning (with `detail.requested_limit` / `detail.max_limit`) at `limit=500`; emit none at `limit=100`, `limit=50`, absent, `limit=0`, and non-numeric; hybrid emits a single deduplicated warning.
- [x] `reference-implementation/test/lexical-retrieval.test.js`: native REST shell coverage that `GET /v1/search?limit=500` over the real `startServer` host carries the `limit_clamped` warning through to the response envelope `meta` (guards the meta-drop regression), and that in-range/at-cap limits do not.
- [x] MCP regression guard (in the mcp-server suite): `search` input schema advertises inclusive `maximum: 100` and rejects `limit=500` at input validation.

## 6. Validation

- [x] `node --test reference-implementation/test/search-limit-clamp.test.js`
- [x] Targeted existing search/warning tests: `public-read-deprecated-alias-warning.test.js`, `search-source-skipped-warning.test.js`, `lexical-retrieval.test.js`, `canonical-read-envelope-conformance.test.js`.
- [x] `pnpm --filter @pdpp/mcp-server run test` (MCP cap regression + no drift).
- [x] `pnpm --dir reference-implementation run verify` (typecheck + check) if server/operation files changed.
- [x] `git diff --check`.

## Acceptance Checks

- [x] `openspec validate add-search-limit-clamp-warning --strict`
- [x] `openspec validate --all --strict`
- [x] REST default and in-range `limit` behavior is unchanged (no new 400s); `limit > 100` returns ≤100 hits plus a `limit_clamped` warning instead of a silent clamp, on all three search modes.
- [x] Direct REST search responses now carry the operation's `meta.warnings[]` (limit_clamped, deprecated_alias_used, source_skipped_not_applicable) instead of dropping them.
- [x] MCP `search` rejects `limit > 100` at input validation and advertises `maximum: 100`; the MCP path does not clamp.
