## 1. Establish the worktree and confirm the approved design is canonical

- [ ] 1.1 Create branch `implement-semantic-retrieval-experimental-extension` and a worktree off the tip that includes `implement-lexical-retrieval-extension` (rebase if that tranche is still mid-flight).
- [ ] 1.2 Confirm `add-semantic-retrieval-experimental-extension` is approved and untouched. Run `openspec validate add-semantic-retrieval-experimental-extension --strict` for sanity.
- [ ] 1.3 Confirm no accidental drift in `add-lexical-retrieval-extension` or `implement-lexical-retrieval-extension` from this worktree.

## 2. Stream metadata declaration (validator + seed manifest)

- [ ] 2.1 Extend `validateConnectorManifest()` in `reference-implementation/server/auth.js` to enforce, when `query.search.semantic_fields` is present:
  - non-empty array of non-empty strings
  - every entry is a key in `schema.properties`
  - the referenced schema entry is `type: "string"` (rejects array, object, blob ref, integer, non-string scalar)
- [ ] 2.2 The `semantic_fields` validator runs independently of the `lexical_fields` validator; either, both, or neither MAY be declared on a stream.
- [ ] 2.3 Add `query.search.semantic_fields` to `reference-implementation/manifests/reddit.json`:
  - `posts`: `["title", "selftext"]`
  - `comments`: `["body"]` (deliberately omits `post_title` to exercise the "one field MAY be lexical-only" branch end-to-end)
  - `saved`: do not declare (proves the non-participating branch end-to-end)
- [ ] 2.4 No change needed to `GET /v1/streams/:stream` — `mStream.query` is already passed through; the declaration surfaces automatically.

## 3. RS metadata advertisement

- [ ] 3.1 Add a `semanticRetrievalCapability` parameter to `buildProtectedResourceMetadata()` in `reference-implementation/server/metadata.js`. When provided, set `metadata.capabilities.semantic_retrieval = semanticRetrievalCapability`. Leave the lexical capability path unchanged.
- [ ] 3.2 In the route handler at `index.js` for `GET /.well-known/oauth-protected-resource`, assemble the capability object from the configured embedding backend and vector index. Required keys when `supported: true`: `supported`, `stability: "experimental"` (hardcoded), `endpoint: "/v1/search/semantic"`, `cross_stream: true`, `query_input: "text"` (hardcoded), `snippets: true`, `lexical_blending: false` (hardcoded for v1), `model` (from backend), `dimensions` (from backend), `distance_metric` (from backend), `default_limit: 25`, `max_limit: 100`, `index_state` (from vector index).
- [ ] 3.3 Publish `supported: true` ONLY when both an embedding backend and a vector index are configured. When no backend is configured, omit the object (or publish `supported: false` when `opts.semanticRetrievalSupported === false` is explicitly set).
- [ ] 3.4 Optional `language_bias` is published only when the configured backend declares one (via `backend.languageBias()`); otherwise omitted.
- [ ] 3.5 Confirm the advertisement is reachable without a bearer token (the route already permits that; do not regress).
- [ ] 3.6 Confirm the advertisement is independent of `capabilities.lexical_retrieval`: toggling one does NOT toggle the other.

## 4. Embedding backend interface (pluggable; default deterministic stub)

- [ ] 4.1 Define `EmbeddingBackend` in `reference-implementation/server/search-semantic.js` with `model()`, `dimensions()`, `distanceMetric()`, `embedQuery(text)`, `embedDocument(text)`, `available()`, `languageBias?()`.
- [ ] 4.2 Implement the default backend `makeStubBackend({ dimensions = 64 } = {})` with:
  - `model()` returning a self-identifying string (e.g., `"pdpp-reference-stub-embed-v0"`) — the string must NOT impersonate a real provider model name
  - deterministic hash-based embedding (same input → same vector; different inputs → different vectors)
  - `distanceMetric()` returning `"cosine"`
  - `available()` returning `true`
  - `languageBias()` returning `null`
- [ ] 4.3 Do NOT add a hosted-provider adapter in this tranche. The file `embed-openai.js` (or equivalent) is a follow-up that requires no spec change.
- [ ] 4.4 Do NOT bake any provider API key, endpoint, or secret into reference source. Hosted-provider configuration is operator config, never code-resident.
- [ ] 4.5 At startup, if no embedding backend is configured, the reference SHALL:
  - NOT advertise `capabilities.semantic_retrieval.supported: true`
  - NOT register `GET /v1/search/semantic`
  - leave all existing lexical/record surfaces unchanged

## 5. Vector index interface (pluggable; default in-memory flat)

- [ ] 5.1 Define `VectorIndex` in `reference-implementation/server/search-semantic.js` with `upsert()`, `delete()`, `delete_by_stream()`, `query()`, `state()`, `clear()`.
- [ ] 5.2 Implement `makeInMemoryFlatIndex({ distanceMetric = "cosine" } = {})` with:
  - in-process `Map` keyed by `(connector_id, stream, record_key, field)`
  - flat-scan `query()` that respects the plan's allowed `(connector_id, stream, field)` tuples
  - `state()` returning `"built"` in steady state; transitions to `"building"` during rebuild and `"stale"` on drift detection
- [ ] 5.3 The `upsert()` path is called ONLY for `(stream, record_key, field, connector_id, vector)` tuples where `field ∈ stream.manifest.query.search.semantic_fields`. The caller enforces this invariant.
- [ ] 5.4 Do NOT add `sqlite-vec` or an external vector DB as a dependency in this tranche. A persistent backend is a drop-in for the same interface and a separate change.
- [ ] 5.5 `query()` SHALL NOT expose a distance or score value to callers. Ordering only.

## 6. Drift metadata and rebuild

- [ ] 6.1 Add a `semantic_search_meta` table to `reference-implementation/server/db.js` with columns `connector_id`, `stream`, `fields_fingerprint`, `model_id`, `dimensions`, `distance_metric`. Additive; no change to existing tables; no triggers.
- [ ] 6.2 Compute `fields_fingerprint` as a sorted JSON hash of the stream's declared `semantic_fields` at registration time and persist.
- [ ] 6.3 Drift signals that flip `index_state` to `"stale"`:
  - any change to `fields_fingerprint` for any `(connector_id, stream)`
  - any change to the configured backend's `model_id`, `dimensions`, or `distance_metric` vs. what is persisted in `semantic_search_meta`
  - row-count band divergence as a secondary signal
- [ ] 6.4 Drift detection runs on startup and on every connector registration/update. Rebuild is JS-maintained at record write/update/delete call sites (same pattern as lexical). No SQLite triggers.
- [ ] 6.5 While rebuilding, advertise `index_state: "building"`. On completion, advertise `index_state: "built"`. On failure or detected drift, advertise `index_state: "stale"`.
- [ ] 6.6 Streams that lose their `semantic_fields` declaration get their stale index rows + meta dropped.

## 7. `GET /v1/search/semantic` route — thin handler, all logic in `search-semantic.js`

- [ ] 7.1 Register `app.get('/v1/search/semantic', { contract: 'searchRecordsSemantic' }, requireToken, …)` in `reference-implementation/server/index.js` next to `/v1/search`.
- [ ] 7.2 Add a comment band above the handler: `// Experimental — public semantic retrieval. Unstable. See capabilities.semantic_retrieval.stability and spec-semantic-retrieval-extension.md.`
- [ ] 7.3 The handler body is a few dozen lines: build `queryContext`, call `runSemanticSearch({ req, opts, tokenInfo, queryContext })`, emit `query.received` + `disclosure.served`, send the envelope. No parameter parsing or mode branching inline.
- [ ] 7.4 In `search-semantic.js`, parameter allowlist is exactly `q`, `limit`, `cursor`, `streams` / `streams[]`. Every other key → `invalid_request_error` with `param` set.
- [ ] 7.5 Explicit rejection list in tests (every one of these returns `invalid_request_error` with `param`): `vector`, `embedding`, `embed`, `model`, `model_id`, `model_family`, `rank`, `boost`, `weights`, `blend`, `connector_id`, `filter[...]`, `fields`, `expand`, `expand[...]`, `expand_limit`, `expand_limit[...]`, `order`, `sort`, `mode`.
- [ ] 7.6 Required `q`: missing → `invalid_request_error`.
- [ ] 7.7 Per-mode resolution inside `search-semantic.js`:
  - **Client token**: resolve a single grant + manifest via `resolveGrantManifest`. `streams[]` membership check against the grant: any unauthorized entry → `permission_error` / `grant_stream_not_allowed`.
  - **Owner token**: enumerate every owner-visible connector; resolve each manifest + synthetic owner grant; build a per-connector plan. `streams[]` is a soft filter — a stream not exposed by any owner-visible connector returns zero hits, NOT a hard error.
- [ ] 7.8 Plan construction (`buildSemanticSearchPlan`) filters to `(declared semantic_fields) ∩ (grant-readable fields)` BEFORE any embedding or index call. Streams with empty intersection are silently dropped.
- [ ] 7.9 The embedding backend is called once per request (`embedQuery(q)`). The vector index is queried once with the plan + query vector. No per-field embedding loop on the query path.
- [ ] 7.10 Result hydration: for each hit, emit a `search_result` with required `object: "search_result"`, `stream`, `record_key`, `connector_id`, `emitted_at`, `matched_fields`, `retrieval_mode`. Include `record_url` (with owner-mode `connector_id` query parameter for owner tokens). Include `snippet` when verbatim hydration succeeds.
- [ ] 7.11 `retrieval_mode = "semantic"` on every result in v1. The advertisement reports `lexical_blending: false`; tests assert the two agree.
- [ ] 7.12 No portable numeric relevance score in the result shape. No `score`, `cosine`, `bm25`, `blend`, `_debug`, `_explain`, or `_vector_distance`.
- [ ] 7.13 Spine emit: `disclosure.served` with `query_shape: "search_semantic"` (distinct from lexical's `"search"` and records' `"read"`).
- [ ] 7.14 Response envelope: `{ object: "list", url: "/v1/search/semantic", has_more, next_cursor?, data }`.

## 8. Grant-safe verbatim snippets

- [ ] 8.1 Snippet hydration reads the matched field from the record under the caller's grant projection (same path the record-listing handler uses).
- [ ] 8.2 Snippet text MUST be a verbatim contiguous substring of the matched field's stored text.
- [ ] 8.3 Snippet generation MUST NOT paraphrase, summarize, translate, or synthesize text.
- [ ] 8.4 Snippet is omitted when the matched field cannot yield a useful verbatim excerpt. Do NOT fabricate.
- [ ] 8.5 Snippet's `field` MUST be a member of `matched_fields`; both MUST be members of (declared `semantic_fields`) ∩ (grant projection).
- [ ] 8.6 Regression test: stored content `"hello world"` with a paraphrase-shaped query returns the hit (because the stub embed treats them as nearby) but the snippet text appears verbatim in `"hello world"`.

## 9. No silent non-semantic fallback

- [ ] 9.1 `search-semantic.js` MUST NOT import `reference-implementation/server/search.js` (lexical). The modules are independent.
- [ ] 9.2 When `vectorIndex.state() === "stale"` or `"building"`, the handler returns an empty or partial result set — it does NOT call into lexical search.
- [ ] 9.3 While the index is not `"built"`, results emitted still carry `retrieval_mode: "semantic"` (they are honestly-produced semantic results; there are just fewer of them). The handler MUST NOT substitute lexical results with that mode label.
- [ ] 9.4 Test: with `vectorIndex.state()` forced to `"stale"`, a query that would match lexically returns zero results, and the advertisement reports `stale`.
- [ ] 9.5 Test: mock `search.js` to throw if invoked; assert `GET /v1/search/semantic` never invokes it.

## 10. Owner-token cross-connector fan-out

- [ ] 10.1 Enumerate owner-visible connectors (reuse the lexical tranche's helper).
- [ ] 10.2 Build a per-connector plan; embed the query once; query each connector's plan against the vector index scoped by `connector_id`.
- [ ] 10.3 Merge results by relevance order; emit `connector_id` on every hit.
- [ ] 10.4 `record_url` for owner-token callers includes the canonical owner-mode `connector_id` query parameter; for client-token callers it does not.
- [ ] 10.5 Request shape is identical for owner and client tokens. `connector_id` is rejected as a query parameter in both modes.
- [ ] 10.6 Test: owner round-trip — take `record_url` from a `/v1/search/semantic` hit, GET it under the same owner token, confirm the record envelope.

## 11. Pagination

- [ ] 11.1 Opaque cursor encodes at least: query text hash, plan hash, backend `model_id`, index generation, paging offset.
- [ ] 11.2 Stale cursor detection: plan change, `model_id` change, `fields_fingerprint` change, index rebuild → `invalid_cursor`.
- [ ] 11.3 Cursors from `/v1/search/semantic` SHALL be rejected by `/v1/search`, `/v1/streams/.../records`, and `changes_since`.
- [ ] 11.4 Cursors from those surfaces SHALL be rejected by `/v1/search/semantic`.
- [ ] 11.5 Tests cover both directions.

## 12. Dashboard helper (no UI change)

- [ ] 12.1 Add `searchRecordsSemantic(query, scope)` to `apps/web/src/app/dashboard/lib/rs-client.ts` alongside `searchRecordsLexical`. Do NOT introduce a new generic bridge.
- [ ] 12.2 The helper proxies to `/v1/search/semantic` with the owner-bound bearer token.
- [ ] 12.3 No UI changes to `apps/web/src/app/dashboard/search/page.tsx` in this tranche.
- [ ] 12.4 Reference-only `_ref` calls keep living in `apps/web/src/app/dashboard/lib/ref-client.ts` — untouched.

## 13. Docs

- [ ] 13.1 Create `apps/web/content/docs/spec-semantic-retrieval-extension.md` documenting the extension at the same depth as `spec-lexical-retrieval-extension.md`: Overview / Stability / Authentication & Versioning / Endpoint / Result shape / Errors / Discovery (RS metadata + per-stream `query.search.semantic_fields`) / `index_state` semantics / Pagination / Non-goals / FAQ.
- [ ] 13.2 Surface the **EXPERIMENTAL / UNSTABLE** marker prominently in the first paragraph, in a dedicated `## Stability` subsection, and at the top of every stability-dependent subsection.
- [ ] 13.3 If the lexical tranche's rewrite of `spec-data-query-api.md` has landed, add a clearly-labeled experimental pointer to the semantic extension there. Do NOT describe `/v1/search` and `/v1/search/semantic` as interchangeable.
- [ ] 13.4 Cross-link the new doc from the docs index. Cross-link `spec-lexical-retrieval-extension.md` ↔ `spec-semantic-retrieval-extension.md` so readers understand the two are siblings, not replacements.
- [ ] 13.5 Grep for "semantic search" across `apps/web/content/docs` and `reference-implementation/`; correct any ambient mentions that predate the experimental extension.

## 14. Tests

Create `reference-implementation/test/semantic-retrieval.test.js` covering:

- [ ] 14.1 RS metadata: `capabilities.semantic_retrieval` present with all required keys when `supported: true`.
- [ ] 14.2 RS metadata: `stability === "experimental"`, `query_input === "text"`, `lexical_blending === false` in v1.
- [ ] 14.3 RS metadata: omitted (or `supported: false`) when no backend is configured.
- [ ] 14.4 RS metadata: reachable without a bearer token.
- [ ] 14.5 RS metadata: independent of `capabilities.lexical_retrieval` (toggle each separately).
- [ ] 14.6 `/v1/search/semantic?q=...` returns a list envelope with `object: "list"`, `data: [...]`.
- [ ] 14.7 Each result has `object: "search_result"`, required `stream`/`record_key`/`connector_id`/`emitted_at`/`matched_fields`/`retrieval_mode`; no `score`, `cosine`, `bm25`, `blend`, `_debug`, `_explain`, `_vector_distance`.
- [ ] 14.8 `retrieval_mode === "semantic"` on every result in v1 (`lexical_blending: false`).
- [ ] 14.9 Missing `q` → `invalid_request_error`.
- [ ] 14.10 Each rejected parameter returns `invalid_request_error` with `param` set: `vector`, `embedding`, `embed`, `model`, `model_id`, `model_family`, `rank`, `boost`, `weights`, `blend`, `connector_id`, `filter[...]`, `fields`, `expand`, `expand[...]`, `expand_limit`, `expand_limit[...]`, `order`, `sort`, `mode`.
- [ ] 14.11 Cross-stream advertised `false` + no `streams[]` → `invalid_request_error`.
- [ ] 14.12 Client token with `streams[]=<not-in-grant>` → `permission_error` + `grant_stream_not_allowed`.
- [ ] 14.13 Owner token with `streams[]=<nonexistent>` → empty list, not an error.
- [ ] 14.14 Stream in grant with no `semantic_fields` ∩ grant intersection → zero hits, no per-stream error.
- [ ] 14.15 `matched_fields` is a subset of (declared `semantic_fields`) ∩ grant projection; never includes fields outside the intersection.
- [ ] 14.16 Manifest validator rejects: empty `semantic_fields`, non-array, nested path, array-type schema field, blob-type field, integer-type field, unknown field.
- [ ] 14.17 Manifest validator accepts: `semantic_fields` only, `lexical_fields` only, both with different contents, both with overlapping contents.
- [ ] 14.18 Snippet hydration: snippet text is a verbatim contiguous substring of the matched field's stored value.
- [ ] 14.19 Snippet hydration: grant-safe — no snippet text drawn from fields outside the grant projection or outside `semantic_fields`.
- [ ] 14.20 Snippet hydration: paraphrase-shaped query still returns verbatim snippet text drawn from stored content.
- [ ] 14.21 No-fallback: with `vectorIndex.state()` forced to `"stale"`, a query that would match lexically returns zero results, and `index_state` reports `stale`.
- [ ] 14.22 No-fallback: mock `search.js` (lexical) to throw if invoked; assert `GET /v1/search/semantic` never invokes it.
- [ ] 14.23 `index_state` transitions: on backend `model_id` change → `stale` until rebuild; on `fields_fingerprint` change → `stale` until rebuild; on successful rebuild → `built`.
- [ ] 14.24 Owner cross-connector: two connectors both exposing `messages` with `semantic_fields: ["text"]` and both matching → hits from both connectors appear with their own `connector_id`.
- [ ] 14.25 Owner round-trip: take `record_url` from a hit, GET it under the same owner token, confirm the record envelope returns.
- [ ] 14.26 Owner request with `connector_id=` → `invalid_request_error`.
- [ ] 14.27 Pagination: `next_cursor` round-trips within a session; stale cursor after simulated rebuild → `invalid_cursor`.
- [ ] 14.28 Pagination: cursor from `/v1/search/semantic` passed to `/v1/search` → `invalid_cursor`.
- [ ] 14.29 Pagination: cursor from `/v1/search/semantic` passed to `/v1/streams/.../records` → `invalid_cursor`.
- [ ] 14.30 Pagination: cursor from `/v1/search` passed to `/v1/search/semantic` → `invalid_cursor`.
- [ ] 14.31 Independence from lexical: `capabilities.lexical_retrieval`, `GET /v1/search`, `/_ref/search` all behave identically to the implement-lexical-retrieval-extension baseline.
- [ ] 14.32 `semantic_search_meta` contents match the currently configured backend; on backend change without rebuild, `index_state === "stale"`.

## 15. Validation

- [ ] 15.1 `openspec validate add-semantic-retrieval-experimental-extension --strict` (sanity, untouched).
- [ ] 15.2 `openspec validate implement-semantic-retrieval-experimental-extension --strict`.
- [ ] 15.3 `pnpm --filter pdpp-reference-implementation test` — full suite green; no regressions in existing lexical/record tests.
- [ ] 15.4 Manual smoke: start the reference with the default stub backend; hit `/.well-known/oauth-protected-resource` and confirm `capabilities.semantic_retrieval` with `stability: "experimental"`; hit `/v1/search/semantic?q=...` with an owner token and confirm `search_result` envelope shape.
- [ ] 15.5 Manual smoke: restart the reference with no backend configured; confirm `capabilities.semantic_retrieval` is absent (or `supported: false`) and `/v1/search/semantic` returns 404.
- [ ] 15.6 Final grep:
  - `grep -rn "/v1/search/semantic" apps/web reference-implementation openspec` → only intentional references.
  - `grep -rn "semantic_retrieval" apps/web reference-implementation openspec` → only intentional references.
  - `grep -rn "semantic_fields" apps/web reference-implementation openspec` → only intentional references.
  - `grep -rn "stability.*experimental" apps/web reference-implementation openspec` → appears in doc, code comment band, metadata builder, and spec delta.
  - `grep -rn "from.*search\.js" reference-implementation/server/search-semantic.js` → zero matches (the no-fallback invariant is visible in code).

## 16. Stop-and-report conditions for any future worker on this change

If during implementation any of these become necessary, stop and report rather than mutating the approved design or spec:

- [ ] 16.1 The approved spec (`add-semantic-retrieval-experimental-extension`) needs a real change (any contradiction with the locked contract).
- [ ] 16.2 Grant gating cannot be done pre-embedding and must happen post-query.
- [ ] 16.3 Verbatim snippets cannot be produced at acceptable quality — a paraphrase is the only option.
- [ ] 16.4 The advertisement's required keys cannot be populated honestly (e.g., `dimensions` is unknown from the configured backend).
- [ ] 16.5 `index_state` cannot be honestly computed from the backing store.
- [ ] 16.6 A silent non-semantic fallback seems required to produce useful results.
- [ ] 16.7 A public `connector_id`, `model`, or similar parameter seems required.
- [ ] 16.8 `retrieval_mode` values other than `"semantic"` or `"hybrid"` seem needed in v1.
- [ ] 16.9 Raw vector queries or client-supplied embeddings seem required.
- [ ] 16.10 A dashboard-only semantic contract seems required beside the public extension.
- [ ] 16.11 `sqlite-vec` or an external vector DB seems required as a hard dependency (rather than a pluggable drop-in) in this tranche.
- [ ] 16.12 A hosted embedding provider seems required as a default (rather than as operator configuration) in this tranche.
