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
  - deterministic hash-based embedding with these explicit promises:
    - **Determinism**: `embedQuery(t)` and `embedDocument(t)` return byte-equal `Float32Array` across invocations
    - **Distinctness**: distinct inputs produce distinct vectors (hash collision on the test corpus is negligible)
    - **Reflexive exact-match hits**: `embedQuery(t) === embedDocument(t)` exactly, so a query whose text is identical to a stored field value ranks that record at distance 0
  - explicit NON-promises (tests MUST NOT assume these):
    - NOT a production semantic embedding
    - NO paraphrase, synonymy, multilingual, or conceptual-similarity recall
    - NO ordering promise beyond "exact-match ranks first"
  - `distanceMetric()` returning `"cosine"`
  - `available()` returning `true`
  - `languageBias()` returning `null`
- [ ] 4.3 Do NOT add a hosted-provider adapter in this tranche. The file `embed-openai.js` (or equivalent) is a follow-up that requires no spec change.
- [ ] 4.4 Do NOT bake any provider API key, endpoint, or secret into reference source. Hosted-provider configuration is operator config, never code-resident.
- [ ] 4.5 At startup, if no embedding backend is configured, the reference SHALL:
  - NOT advertise `capabilities.semantic_retrieval.supported: true`
  - NOT register `GET /v1/search/semantic`
  - leave all existing lexical/record surfaces unchanged

## 5. Vector index interface (pluggable; default persistent `sqlite-vec`; documented BLOB-flat fallback)

- [ ] 5.1 Define `VectorIndex` in `reference-implementation/server/search-semantic.js` with `upsert()`, `delete()`, `delete_by_stream()`, `query()`, `state()`, `clear()`.
- [ ] 5.2 Add `sqlite-vec` as a runtime dependency in `reference-implementation/package.json`. Rely on the published platform binaries (`sqlite-vec-linux-x64`, `sqlite-vec-darwin-arm64`, etc.) distributed as `optionalDependencies` of the main package.
- [ ] 5.3 In `reference-implementation/server/db.js` init path, attempt `sqliteVec.load(db)` after opening the `better-sqlite3` database. On success, record `db.vectorIndexKind = 'sqlite-vec'`. On failure (platform with no binary, locked-down environment, or any other load error), log a warning and record `db.vectorIndexKind = 'blob-flat'`. Do not throw on load failure — the reference gracefully degrades.
- [ ] 5.4 Implement `makeSqliteVecIndex({ db, dimensions, distanceMetric })`:
  - create a `vec0` virtual table `semantic_search_vec` with columns `connector_id TEXT PARTITION KEY`, `stream TEXT`, `record_key TEXT`, `field TEXT`, `embedding FLOAT[${dimensions}]` with the configured `distance_metric`
  - `upsert`, `delete`, `delete_by_stream` via normal prepared statements against the virtual table
  - `query` uses the `MATCH` operator + `ORDER BY distance LIMIT ?` to get KNN; WHERE clause filters to `(connector_id, stream, field) IN (…)` built from the grant-gated plan
  - persistent across restarts (data lives in the `better-sqlite3` database file)
  - `state()` returns `"built"` in steady state; `"building"` during rebuild; `"stale"` on drift
- [ ] 5.5 Implement `makeBlobFlatIndex({ db, dimensions, distanceMetric })` as the documented fallback:
  - schema: `semantic_search_blob(connector_id, stream, record_key, field, embedding BLOB, PRIMARY KEY(...))` + an index on `(connector_id, stream, field)` for plan-scoped scans
  - `query` reads plan-scoped rows, materializes each `BLOB` as a `Float32Array`, computes distance in JS, sorts, paginates
  - persistent across restarts (data lives in the same SQLite database)
  - same interface, same `state()` contract, same persistence semantics — slower throughput at large N
- [ ] 5.6 Selection at semantic-index construction: read `db.vectorIndexKind`; instantiate the matching backend; log a startup line naming the chosen backend so operators see it.
- [ ] 5.7 The `upsert()` path is called ONLY for `(stream, record_key, field, connector_id, vector)` tuples where `field ∈ stream.manifest.query.search.semantic_fields`. The caller enforces this invariant. Both backends honor it by construction.
- [ ] 5.8 `query()` SHALL NOT expose a distance or score value to callers on either backend. Ordering only.
- [ ] 5.9 Grant scoping happens pre-query via the plan's `(connector_id, stream, field)` tuples in the WHERE clause. No embedding is ever computed for, nor read from, an unauthorized or undeclared field.

## 6. Drift metadata, startup backfill, and rebuild

- [ ] 6.1 Add a `semantic_search_meta` table to `reference-implementation/server/db.js` with columns `connector_id`, `stream`, `fields_fingerprint`, `model_id`, `dimensions`, `distance_metric`. Additive; no change to existing tables; no triggers.
- [ ] 6.2 Compute `fields_fingerprint` as a sorted JSON hash of the stream's declared `semantic_fields` at registration time and persist.
- [ ] 6.3 Drift signals that flip `index_state` to `"stale"`:
  - any change to `fields_fingerprint` for any `(connector_id, stream)`
  - any change to the configured backend's `model_id`, `dimensions`, or `distance_metric` vs. what is persisted in `semantic_search_meta`
  - row-count band divergence as a secondary signal
  - (sqlite-vec path) a `dimensions` or `distance_metric` change additionally invalidates the `vec0` virtual table schema; the rebuild recreates the table
- [ ] 6.4 Drift detection runs on startup AND on every connector registration/update. Rebuild is JS-maintained at record write/update/delete call sites (same pattern as lexical). No SQLite triggers.
- [ ] 6.5 Implement `semanticIndexBackfillForManifest(connectorId, stream, declaredFields)` in `search-semantic.js`, parallel to the lexical tranche's `lexicalIndexBackfillForManifest`. Called from `startServer` (native mode) and from `registerConnector` (polyfill mode). Idempotent.
- [ ] 6.6 Backfill reads records from the records table (the source of truth), embeds `declaredFields` using the configured backend, and upserts into the `VectorIndex`. It SHALL NOT call back into any connector — no re-ingest of raw data is required.
- [ ] 6.7 While rebuilding, advertise `index_state: "building"`. On completion, advertise `index_state: "built"`. On detected drift without rebuild complete, advertise `index_state: "stale"`.
- [ ] 6.8 Streams that lose their `semantic_fields` declaration get their stale index rows + meta dropped.
- [ ] 6.9 **Restart survival**: on a clean restart where no drift signals fire, the advertisement SHALL report `index_state: "built"` immediately without running a rebuild, and `GET /v1/search/semantic` SHALL serve the previously-indexed corpus. Tests MUST prove this (see 14.33–14.35).

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
- [ ] 8.6 Regression test (property-style, not paraphrase-assuming): seed a corpus with distinct strings; issue queries that exactly match stored field values; assert the expected record is in `data[]`; for every returned `search_result` with a `snippet`, assert `record[snippet.field].includes(snippet.text)` byte-for-byte. The stub backend guarantees exact-match reflexivity and determinism; it does NOT guarantee paraphrase-shaped hits, so the test does not rely on paraphrase behavior.

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

## 12. Dashboard helper + search UX cleanup (shared across lexical and semantic)

### 12.a `rs-client.ts` — add semantic helper that mirrors the lexical helper's shape

- [ ] 12.1 Add `searchRecordsSemantic(query, opts)` to `apps/web/src/app/dashboard/lib/rs-client.ts` alongside `searchRecordsLexical`. Do NOT introduce a new generic bridge. Reference-only `_ref` calls keep living in `apps/web/src/app/dashboard/lib/ref-client.ts` — untouched.
- [ ] 12.2 Signature: `searchRecordsSemantic(query: string, opts?: { streams?: string[]; limit?: number; cursor?: string }) => Promise<SearchResultPage>`. This mirrors the existing `searchRecordsLexical(query, opts)` shape exactly.
- [ ] 12.3 DO NOT model the helper as `searchRecordsSemantic(query, scope)`. The `scope` argument is removed from the dashboard entirely (see 12.b).
- [ ] 12.4 The helper proxies to `/v1/search/semantic` with the owner-bound bearer token and returns the full page envelope (`{ object: 'list', has_more, next_cursor?, data: [...] }`), NOT just `data[]`.
- [ ] 12.5 Reuse the existing `SearchResultPage` and `SearchResultHit` type aliases where possible. If `SearchResultHit` needs a `retrieval_mode?: 'semantic' | 'hybrid'` optional field to cover semantic hits, add it as an optional property; lexical hits leave it undefined.

### 12.b `search/page.tsx` — remove `messages-like` heuristic, default to all streams, paginate

- [ ] 12.6 Delete `looksLikeMessagesStream()` from `apps/web/src/app/dashboard/search/page.tsx`.
- [ ] 12.7 Delete `discoverMessagesLikeStreamNames()` from the same file.
- [ ] 12.8 Remove the `scope` query parameter, the `scope` form selector in `apps/web/src/app/dashboard/search/search-filters-form.tsx`, and the `scope === 'messages'` branch in `searchRecords()`. The page SHALL NOT offer a `messages` option.
- [ ] 12.9 Default to all owner-visible streams: the dashboard's record-search path calls `searchRecordsLexical(query, { limit, cursor })` and/or `searchRecordsSemantic(query, { limit, cursor })` with no `streams[]` narrowing. The RS's cross-connector fan-out handles stream enumeration honestly per the `lexical_fields` / `semantic_fields` declarations.
- [ ] 12.10 Remove the hard `DEFAULT_MAX_RESULTS` one-page cap. Pass a reasonable `limit` (e.g., 25) to the helper; respect `has_more` and `next_cursor` on the returned envelope rather than truncating.
- [ ] 12.11 Add URL-driven cursor pagination: the page reads `?cursor=<opaque>` from `searchParams` and passes it through. Render a "Next page" link when `has_more` is true; the link sets `?cursor=<next_cursor>` on the current URL.
- [ ] 12.12 Add an optional "Previous" affordance by carrying a thin cursor stack in the URL (`?cursor=<current>&prev=<prev1>,<prev2>,...`). Server-component only — no client-side state. This is acceptable because cursors are opaque and the server cannot reverse them.
- [ ] 12.13 The page stays a server component. Cursor state lives in the URL, not in client state. No new client components are introduced by this work.
- [ ] 12.14 Keep the existing spine deep-link (`refSearch`) jump UX for trace/artifact/id search unchanged — it consumes `/_ref/search` and is reference-only operator UX, not public retrieval. Untouched.

### 12.c Consistency

- [ ] 12.15 Lexical and semantic dashboard helpers SHALL share the same `SearchResultPage` return type and the same `{ streams?, limit?, cursor? }` opts shape. A future reader MUST be able to swap one for the other without changing pagination or envelope handling.
- [ ] 12.16 Tests in `apps/web/tests/dashboard-search.test.ts` (new or extended) SHALL cover: (a) search defaults to all streams when no stream filter is set, (b) `?cursor=` round-trips correctly, (c) "Next" link is rendered only when `has_more: true`, (d) there is no `scope=` parameter on the dashboard page URL. (Tests are scoped to `apps/web`; the reference's `semantic-retrieval.test.js` handles protocol-level conformance.)

### 12.d Boundary

- [ ] 12.17 DO NOT mutate the public `/v1/search` or `/v1/search/semantic` contracts to support dashboard pagination. Cursor semantics come straight from the approved specs. This is dashboard-UX work, not protocol work.
- [ ] 12.18 DO NOT reopen `add-lexical-retrieval-extension` or `implement-lexical-retrieval-extension`. If the lexical tranche's helper already returns `has_more` / `next_cursor` (it does), this tranche just consumes what's already there.

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
- [ ] 14.20 Snippet hydration: for every hit the stub backend produces over the seeded test corpus, assert `snippet.text` appears byte-identically as a contiguous substring of `record[snippet.field]`. (Property test; does not assume paraphrase-shaped hits — the stub is hash-based and does not promise them.)
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
- [ ] 14.33 **Restart regression — `sqlite-vec` path**: start the reference; ingest records for a seed connector with declared `semantic_fields`; issue an exact-match query against `/v1/search/semantic` and capture the hit set; STOP the reference (fully close the DB); START a fresh reference instance pointed at the same `PDPP_DB_PATH`; hit the advertisement — `capabilities.semantic_retrieval.supported: true` with `index_state: "built"` (no rebuild was needed); issue the same query; assert the same hit set returns. Historical records MUST be searchable without re-ingest.
- [ ] 14.34 **Restart regression — BLOB-flat fallback**: same scenario as 14.33, but force the BLOB-flat path by stubbing `sqliteVec.load` to throw at init. Same end-to-end behavior: `index_state: "built"` after restart, same hits, no re-ingest.
- [ ] 14.35 **Restart + drift**: after restart, force a drift signal (e.g., bump the backend's declared `model_id` to a different value by swapping in a second stub backend with `"pdpp-reference-stub-embed-v0-variant"`); hit the advertisement — `index_state: "stale"`; run the backfill; hit again — `index_state: "built"`. The rebuild MUST complete from records alone (the source-of-truth invariant).
- [ ] 14.36 **`sqlite-vec` load failure is graceful**: with `sqliteVec.load` stubbed to throw, startup does NOT crash; a warning is logged; the BLOB-flat backend is used; semantic retrieval still works end-to-end.
- [ ] 14.37 **Backend-agnostic conformance**: run the full test file twice — once with the `sqlite-vec` backend forced, once with the BLOB-flat backend forced. Every test except the backend-selection tests themselves SHALL pass identically under both paths.

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
