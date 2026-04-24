## Why

The `add-semantic-retrieval-experimental-extension` change is approved as canonical design and spec. The public contract is locked:

- extension status: **experimental / unstable** optional extension
- public surface: `GET /v1/search/semantic` (dedicated; does not mutate `GET /v1/search`)
- query input: text-only (`q`, `limit`, `cursor`, `streams[]`)
- result shape: candidate references with required `stream`, `record_key`, `connector_id`, `emitted_at`, `matched_fields`, `retrieval_mode` ∈ {`"semantic"`, `"hybrid"`}, optional `record_url`, optional grant-safe verbatim `snippet`; no portable numeric score; no debug/trace fields
- per-stream opt-in: `query.search.semantic_fields` (top-level scalar string fields only)
- advertisement: `capabilities.semantic_retrieval` inside the existing RS metadata document, with required `stability: "experimental"`, `query_input: "text"`, `model`, `dimensions`, `distance_metric`, `index_state` ∈ {`"built"`, `"building"`, `"stale"`}, plus the other declared keys
- grant safety: match, rank, and snippet only over (stream-in-grant) ∩ (field-in-grant) ∩ (field-in-`semantic_fields`); "embed everything, filter later" prohibited; snippets are verbatim substrings (never model-generated)
- no silent non-semantic fallback behind the semantic surface

That change deliberately ships no code. This change implements the contract in the reference and keeps the repo truthful.

Grounding facts from the current reference (`reference-implementation/server/`):

- `GET /v1/search` and its helper `server/search.js` are now in place (per `implement-lexical-retrieval-extension`). That gives us a tested enforcement path for grant-safety, manifest validation, and RS-metadata capability advertisement that this change extends pattern-for-pattern.
- The SQLite driver is `better-sqlite3` (the swap from `@databases/sqlite` landed). FTS5 is available in-process. No vector library is currently installed.
- The reference scopes owner reads per connector (the lexical tranche established the cross-connector fan-out pattern with `connector_id` on every result). The semantic surface reuses the same pattern; the design's prohibition on a public `connector_id` query parameter holds identically here.
- No `model`/embedding provider is wired into the reference today. The experimental marker in the advertisement is load-bearing because we are shipping *a server-declared model choice the rest of the ecosystem may not run*.

Truthfulness cleanup this tranche owes the repo:

- `/v1/search/semantic` does not exist; any docs that already mention "semantic search" in passing must be clarified (experimental pointer with the stability marker, or reference-only wording).
- `capabilities.semantic_retrieval` is not published today; `buildProtectedResourceMetadata()` needs the new capability object (parallel to `capabilities.lexical_retrieval`).
- No manifest declares `query.search.semantic_fields`; the validator needs to enforce its shape, and at least one seed manifest should declare it so the contract is exercised end-to-end.
- `/_ref/*` currently has no semantic experiments. If any reference-only semantic surface appears later, it MUST stay out of `/v1/search/semantic`'s advertisement and out of the public contract. This change documents that split in code comments now so it is visible from day one.

## What Changes

- **Extend `validateConnectorManifest()` in `reference-implementation/server/auth.js`** so `query.search.semantic_fields`, when present, is:
  - a non-empty array of non-empty strings
  - every entry references a top-level field declared in the stream's `schema.properties`
  - every referenced schema entry is `type: "string"` (rejects array, object, blob ref, integer, non-string scalar)
  - rejects nested paths, arrays, blob references, unknown fields, empty arrays
  - independent of `lexical_fields`: either, both, or neither MAY be declared
- **Add `query.search.semantic_fields` to a representative subset of seed manifests** so the contract is exercised end-to-end. Target Reddit `posts` (`["title", "selftext"]`) and `comments` (`["body"]`) — same stream surface the lexical tranche exercises, independent declaration. Other manifests stay non-participating (proves the "MAY participate" branch).
- **Add `capabilities.semantic_retrieval` to `buildProtectedResourceMetadata()` in `reference-implementation/server/metadata.js`** with the full required key set when the reference exposes the extension: `supported`, `stability: "experimental"`, `endpoint: "/v1/search/semantic"`, `cross_stream`, `query_input: "text"`, `snippets`, `lexical_blending`, `model`, `dimensions`, `distance_metric`, `default_limit`, `max_limit`, `index_state`. Optional `language_bias` published when the configured model has materially known bias.
- **Implement `GET /v1/search/semantic` in `reference-implementation/server/index.js`**:
  - allow only `q`, `limit`, `cursor`, `streams[]`; reject every other parameter — explicitly including `vector`, `embedding`, `embed`, `model`, `model_id`, `model_family`, `rank`, `boost`, `weights`, `blend`, `connector_id`, `filter[...]`, `fields`, `expand[...]`, `expand_limit[...]`, `order`, and any connector-specific param — with `invalid_request_error` and identify the rejected parameter
  - resolve grant + manifest via the same helpers the record-listing and `/v1/search` handlers use
  - for owner-token callers, fan out across every owner-visible connector; for client-token callers, scope by the grant
  - hard-error with `permission_error` / `grant_stream_not_allowed` on unauthorized `streams[]` entries for client tokens; for owner tokens, `streams[]` is a soft cross-connector filter (zero hits, not an error)
  - match only over `(stream, field)` pairs in (declared `semantic_fields`) ∩ (grant-readable fields); drop streams whose intersection is empty (no per-stream error signal)
  - return `search_result` candidates with required `stream`, `record_key`, `emitted_at`, `connector_id`, `matched_fields`, `retrieval_mode`; include `record_url` (with the owner-mode `connector_id` query parameter when the caller is owner-token); include grant-safe verbatim `snippet` when attributable
  - emit `retrieval_mode: "semantic"` when `lexical_blending: false`; emit `"semantic"` or `"hybrid"` per-result when `lexical_blending: true`
  - opaque cursor pagination distinct from record-list cursors, `changes_since`, AND lexical-search cursors
  - emit a `disclosure.served` spine event with `query_shape: 'search_semantic'` so semantic disclosures are auditable on the same spine as lexical search and record reads
  - when `index_state` is `"building"` or `"stale"` (or the server is otherwise unable to produce honest semantic results), return zero or partial results — NEVER substitute lexical-only matching while still emitting `retrieval_mode: "semantic"` or `"hybrid"`
- **Add `reference-implementation/server/search-semantic.js`** (new) with `searchRecordsSemantic(storageBinding, manifest, plan, q, limit, cursor)`. The route delegates to this helper; dashboard/internal callers reach semantic retrieval over HTTP through the same public route. Grant gating happens in `buildSemanticSearchPlan` *before* any embedding or index lookup — there is no code path that queries the index for an unauthorized or undeclared field.
- **Introduce a pluggable `EmbeddingBackend` interface** in `reference-implementation/server/search-semantic.js`:
  - `model()` → server-declared model identifier (string)
  - `dimensions()` → integer
  - `distanceMetric()` → one of `"cosine"`, `"dot"`, `"l2"`
  - `embedQuery(text)` → `Float32Array`
  - `embedDocument(text)` → `Float32Array`
  - `available()` → boolean (is the backend reachable right now)
  - Default backend is a **deterministic local stub** suitable for tests and for a CI-friendly reference run with no external dependency (treat it as "semantic retrieval is advertised with a small declared model so the contract is exercised; this is not a production-quality model"). A real embedding provider is a configurable drop-in the operator opts into — the provider choice and its keys are operator configuration, not normative protocol behavior.
  - The reference NEVER ships with a hardcoded hosted-provider API key and NEVER advertises a model whose embeddings it cannot actually produce. If no backend is configured, the reference does NOT advertise `capabilities.semantic_retrieval.supported: true`.
- **Build a pluggable `VectorIndex` interface** in `reference-implementation/server/search-semantic.js`:
  - `upsert({ stream, record_key, field, connector_id, vector })`
  - `delete({ stream, record_key })`
  - `delete_by_stream({ stream, connector_id })`
  - `query({ vector, plan, limit, cursor })` → `{ hits, nextCursor, hasMore }`
  - `state()` → one of `"built"`, `"building"`, `"stale"` (honestly computed from the backend's own readiness)
  - **Default backend is `sqlite-vec`** (preferred) using the existing `better-sqlite3` connection. `sqlite-vec` is loaded as a SQLite extension at init via `db.loadExtension()` / `sqliteVec.load(db)` from the `sqlite-vec` npm package (platform binaries are distributed as `optionalDependencies` — `sqlite-vec-linux-x64`, `sqlite-vec-darwin-arm64`, etc., pattern parallel to `esbuild`/`next-swc`). A `vec0` virtual table stores embeddings keyed by `(connector_id, stream, record_key, field)`; distance metric matches `backend.distanceMetric()`. Vectors persist across process restarts in the same `better-sqlite3` database the rest of the reference uses.
  - **Documented fallback backend is `SQLite-BLOB flat`** (also persistent) for environments where the `sqlite-vec` extension cannot be loaded — for example, unusual platforms where no pre-built binary is available, or locked-down CI images that disallow loading SQLite extensions. The fallback stores vectors as `BLOB` rows in a standard SQLite table and computes distance in JS after the grant-gated plan scopes the scan. Same data model, same persistence guarantees, same interface surface — just slower throughput under large corpora.
  - **Backend selection at init** is `try sqlite-vec → catch → fall back to BLOB-flat`, emitted as a startup log line so operators know which path is live. Both paths satisfy the owner's load-bearing requirement: *semantic coverage survives process restart; historical records become searchable again after restart without re-ingest*. Neither path depends on ephemeral in-process state.
  - **Why `sqlite-vec` as the default rather than BLOB-flat**: the algorithmic profile is the same class today (both are flat scans in `sqlite-vec@0.1.x`; HNSW is on the `sqlite-vec` roadmap and will flow through this same interface without a contract change), but `sqlite-vec` runs native SIMD and is 10–100× faster on the same data. Installing it is one npm install plus one `loadExtension` call — operationally very small. The published platform binaries cover the developer and CI targets this repo actually uses. "Package not already installed" is not operational brittleness; deferring adoption would only cost us query throughput at a real owner-scale corpus without buying anything back.
  - The index honors the declared-fields boundary by construction under both paths: embeddings are produced and stored only for `(stream, record_key, field)` tuples where `field ∈ stream.manifest.query.search.semantic_fields`.
- **Startup rebuild / backfill**: on startup and on every connector registration/update, the reference SHALL drift-detect the semantic index per `(connector_id, stream)` (same pattern the lexical tranche established for FTS5), and SHALL backfill from records without requiring re-ingest. Records are the source of truth; the vector index is a derived artifact rebuildable from records at any time. This satisfies the behavioral requirement that historical records become searchable again after restart without re-ingest.
- **Restart persistence**: because vectors are persisted in the same `better-sqlite3` database the rest of the reference uses (whether via a `vec0` virtual table or BLOB rows), `capabilities.semantic_retrieval.supported: true` does NOT depend on ephemeral in-process state. On a clean restart where no drift signals fire, the advertisement reports `index_state: "built"` immediately and `GET /v1/search/semantic` serves the previously-indexed corpus. If drift is detected (fingerprint, `model_id`, `dimensions`, `distance_metric`, or, under the BLOB-flat fallback, row-count band), the advertisement reports `index_state: "stale"` while the rebuild runs in the background from records.
- **Add a `semantic_search_meta` table** in `reference-implementation/server/db.js` mirroring the lexical `lexical_search_meta` pattern: `(connector_id, stream, fields_fingerprint, model_id, dimensions, distance_metric)`. Drift is detected on any change to the declared `semantic_fields` fingerprint, the configured `model`, `dimensions`, or `distance_metric`. Drift reports `index_state: "stale"` in the advertisement until a rebuild restores coverage. The rebuild is JS-maintained at the existing record write/update/delete call sites (same pattern as lexical retrieval — SQLite triggers cannot consult the connector manifest to know which fields to embed).
- **Add `retrieval_mode` wiring**: the handler sets `retrieval_mode: "semantic"` by default (pure vector match). Hybrid mode is gated on the `lexical_blending` capability key and is **off by default** for v1 (value: `false`) — the reference implementation will not blend lexical signals into semantic results in this tranche. `hybrid` is reserved for a later operator-opt-in without a contract change; the advertisement truthfully reports `lexical_blending: false` while that remains the case.
- **Expose a stable JS helper `searchRecordsSemantic(query, scope)` in `apps/web/src/app/dashboard/lib/rs-client.ts`** (the existing module that already wraps the public RS surface for the dashboard — `listStreams`, `getStreamMetadata`, `queryRecords`, `getRecord`, `searchRecordsLexical`). Dashboard UI changes are deliberately out of scope for this tranche — wiring a new dashboard view is a separate product decision. This change only makes the helper available so follow-up UI work doesn't need a second bridge.
- **Add `apps/web/content/docs/spec-semantic-retrieval-extension.md`** documenting the extension at the same depth as `spec-lexical-retrieval-extension.md`: the **EXPERIMENTAL / UNSTABLE** marker surfaced prominently in the first paragraph and at the top of every subsection that describes stability-dependent behavior, the endpoint, params (with rejection list), result shape (including `retrieval_mode`), advertisement shape, per-stream declaration shape, grant-safety invariants, pagination, `index_state` semantics, and non-goals.
- **Update `apps/web/content/docs/spec-data-query-api.md`** — if the lexical tranche's rewrite has landed, add a one-sentence pointer to the semantic extension clearly marked experimental. Do NOT describe `/v1/search` and `/v1/search/semantic` as interchangeable.
- **Add a `// Experimental — public semantic retrieval. Unstable.` comment band** above `app.get('/v1/search/semantic', …)` in `index.js`, mirroring the `// Reference-only.` band the lexical tranche added over `/_ref/search`. The instability of the public surface is visible in code.
- **Tests in `reference-implementation/test/semantic-retrieval.test.js`** covering every scenario in the approved spec delta, the full parameter rejection list, grant-safe snippet behavior, `index_state` truthfulness, the non-substitution rule, and cross-connector owner fan-out.

Explicitly **not in this change**:

- **No mutation of the approved `add-semantic-retrieval-experimental-extension` design** (proposal/design/tasks/spec delta). This change consumes the contract; it does not redesign it.
- **No modification of the lexical retrieval implementation**. `implement-lexical-retrieval-extension` is untouched.
- **No raw vector query surface**. `vector=` and `embedding=` are rejected.
- **No client-supplied embeddings**. There is no backdoor for callers to bring their own vectors.
- **No portable numeric relevance score**. Results are ordered; scores are not exposed.
- **No model-selector parameter on the public surface**. The configured model is server-chosen and advertised.
- **No mutation of `GET /v1/search`**. Lexical retrieval is not modified by this tranche.
- **No overloading of `/_ref/search`**. The reference-only spine surface is not aliased.
- **No `POST /v1/search/semantic`** body-DSL in v1.
- **No connector-specific semantic semantics** on the public surface.
- **No external vector DB or ANN library beyond `sqlite-vec`**. `sqlite-vec` is added as a dependency for the default persistent backend; a documented SQLite-BLOB flat fallback covers environments where `sqlite-vec`'s extension cannot be loaded. Operators with much larger corpora can swap in `faiss`, a hosted vector DB, or a future `sqlite-vec`-HNSW drop-in via the `VectorIndex` interface without changing the public contract.
- **No hosted embedding provider as a default or required dependency**. The deterministic local stub is the default so the reference runs offline with no API key; a hosted provider is operator configuration.
- **No dashboard UI work**. Only the rs-client helper lands so follow-up UI can consume it without introducing a second bridge.
- **No canonical embedding self-export**. Derived-artifact self-export remains governed by the separate open questions and is not pre-empted here.

## Capabilities

### New Capabilities

*(none)*. The public contract capability `semantic-retrieval` is owned by `add-semantic-retrieval-experimental-extension`. This change does not redefine it.

### Modified Capabilities

- `reference-implementation-architecture`: add reference-implementation-scoped requirements describing how the reference realizes the semantic-retrieval experimental extension — manifest validation of `semantic_fields`, RS metadata advertisement with explicit `stability: "experimental"` and truthful `index_state`, pluggable `EmbeddingBackend` / `VectorIndex` seams kept behind a single internal enforcement helper, index-only-declared-fields invariant, cross-connector owner fan-out with the `connector_id` on every result, refusal to substitute a non-semantic fallback while advertising semantic, and explicit code-level separation from any future `/_ref/*` experiments. None of these requirements re-state the public contract; they constrain how the reference itself implements it.

## Impact

- `reference-implementation/server/auth.js` — extend `validateConnectorManifest()` for `query.search.semantic_fields`
- `reference-implementation/server/metadata.js` — add `capabilities.semantic_retrieval` to `buildProtectedResourceMetadata()`
- `reference-implementation/server/index.js` — register `GET /v1/search/semantic`, add the `// Experimental — public semantic retrieval. Unstable.` comment band, wire the capability params alongside `capabilities.lexical_retrieval`
- `reference-implementation/server/search-semantic.js` (new) — `searchRecordsSemantic()` helper, `EmbeddingBackend` interface + default deterministic-stub implementation, `VectorIndex` interface + default `sqlite-vec`-backed implementation + documented SQLite-BLOB flat fallback, grant-gated plan builder, startup backfill/rebuild path
- `reference-implementation/server/db.js` — add `semantic_search_meta` table and load `sqlite-vec` at init (with graceful fallback to BLOB flat); both paths are additive, no change to existing tables, no triggers — maintenance in JS
- `reference-implementation/package.json` — add `sqlite-vec` as a dependency
- `reference-implementation/manifests/reddit.json` — add `query.search.semantic_fields` to `posts` and `comments`
- `reference-implementation/test/semantic-retrieval.test.js` (new) — full scenario coverage
- `apps/web/src/app/dashboard/lib/rs-client.ts` — add `searchRecordsSemantic()` that proxies to `/v1/search/semantic`
- `apps/web/content/docs/spec-semantic-retrieval-extension.md` (new) — extension reference doc with prominent experimental marker
- `apps/web/content/docs/spec-data-query-api.md` — if the lexical rewrite has landed, add a clearly-labeled experimental pointer
- `openspec/specs/reference-implementation-architecture/spec.md` — folded in on archival

## Coordination notes

- This change builds on `implement-lexical-retrieval-extension`. The manifest validator, RS metadata capability plumbing, `search.js` / route-handler conventions, and cross-connector owner fan-out pattern are inherited from that tranche. If that tranche is still mid-flight, this change should rebase onto its merge commit before starting implementation.
- This change does NOT touch `reference-implementation/server/search.js` (lexical) or `capabilities.lexical_retrieval` in `metadata.js`.
- The semantic-retrieval surface is explicitly experimental. Ecosystem-facing announcement material (release notes, docs index entries) MUST surface the stability marker; the protocol-level contract already enforces this via `stability: "experimental"`, but product copy should reinforce it.
