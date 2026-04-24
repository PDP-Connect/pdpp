## 1. Baseline And Existing Notes

- [x] 1.1 Record the current semantic design notes reviewed in the implementation report, including why none already covers operational coverage, diagnostics, and multilingual model profiles. (Recorded in `design.md` Context.)
- [x] 1.2 Audit current semantic participation across native and polyfill manifests; write down which manifests declare `semantic_fields` and which advertised deployments would currently index zero fields. (see `design-notes/semantic-field-coverage-2026-04-24.md` — zero polyfill manifests declared `semantic_fields`; the shipped `gmail/github/slack/chatgpt/claude_code/codex/reddit/chase/usaa/ynab` manifests now declare honest coverage.)
- [x] 1.3 Confirm the current public semantic contract still rejects `model`, `model_id`, `embedding`, `vector`, ranking knobs, and debug/score output before changing implementation. (Confirmed via `FORBIDDEN_PARAMS` in `reference-implementation/server/search-semantic.js` and the passing `parseSemanticSearchParams accepts the v1 allowlist` test; no public surface changed.)

## 2. Operational Diagnostics

- [x] 2.1 Add a reference diagnostics helper that reports semantic backend availability, vector index kind/state, model/profile identity, language bias, participating connectors/streams/fields, manifest provenance, DB path, and warnings.
- [x] 2.2 Add a read-only `/dashboard/deployment` page that renders the diagnostics clearly and redacts all secret values.
- [x] 2.3 Show explicit warnings for zero semantic participation, stale index, unavailable embedding backend, missing model cache, disabled download, and vector-index fallback.
- [x] 2.4 Add tests proving deployment diagnostics redacts secrets and reports zero participation separately from backend/index readiness.
- [x] 2.5 Surface active semantic backfill progress in diagnostics and `/dashboard/deployment`, including current connector/stream, stream-check counts, records scanned/total, indexed vectors, and last update time.

## 3. First-Party Semantic Coverage

- [x] 3.1 Audit first-party polyfill manifests for top-level natural-language string fields suitable for semantic retrieval. (see `design-notes/semantic-field-coverage-2026-04-24.md`.)
- [x] 3.2 Add `query.search.semantic_fields` to priority polyfill streams where the field choice is honest and validator-safe. (Added to gmail, github, slack, chatgpt, claude_code, codex, reddit, chase, usaa, ynab; also aligned the semantic validator with `isTopLevelSearchableStringField` so nullable-string fields — the majority of natural-language fields in the first-party set — pass validation, matching the existing lexical validator and the validator's own stated intent.)
- [x] 3.3 Document exclusions for streams with no suitable top-level string semantic fields or fields that are identifier-like, nested, array-shaped, blob-backed, or too sensitive to embed by default. (see `design-notes/semantic-field-coverage-2026-04-24.md` Exclusions section.)
- [x] 3.4 Add regression tests proving at least one real polyfill-style manifest contributes semantic coverage and semantic search can return non-empty results after backfill. (`shipped gmail manifest contributes semantic coverage after reconcile without record re-ingest` in `reference-implementation/test/semantic-retrieval.test.js`.)

## 4. Local Embedding Backend

- [x] 4.1 Evaluate `@huggingface/transformers` for the operational local embedding backend; verify install/runtime behavior, first-run cache behavior, model loading, dimensions, and Node compatibility. (`@huggingface/transformers@4.2.0` installed; smoke loaded `Xenova/all-MiniLM-L6-v2` in Node, produced a 384d vector, and cached to `/tmp/pdpp-transformers-smoke-cache`.)
- [x] 4.2 Implement an operational local embedding backend with no hosted API key requirement and with explicit model, dimensions, distance metric, availability, and language-bias metadata. (`makeLocalTransformerBackend` uses Transformers.js feature extraction with mean pooling + normalization and reports model/profile/dtype/cache metadata.)
- [x] 4.3 Preserve the deterministic stub backend for tests and CI; keep tests clear that the stub only promises deterministic exact-match reflexivity. (`resolveSemanticBackendFromEnv({})` defaults to the stub; dev/server scripts opt into operational defaults explicitly.)
- [x] 4.4 Ensure backend unavailability disables or degrades semantic advertisement honestly rather than advertising supported semantic retrieval that cannot embed. (Unavailable backends omit the capability and route; diagnostics reports `backend_unavailable`.)

## 5. Multilingual Profile Support

- [x] 5.1 Add operator configuration for one active semantic embedding profile, including profile ID, model ID or preset, cache directory, download policy, dimensions, distance metric, and language-bias metadata. (`PDPP_EMBEDDING_PROFILE_ID`, `PDPP_EMBEDDING_MODEL_ID`, `PDPP_EMBEDDING_CACHE_DIR`, `PDPP_EMBEDDING_DOWNLOAD_ALLOWED`, `PDPP_EMBEDDING_DTYPE`, `PDPP_EMBEDDING_DIMENSIONS`, `PDPP_EMBEDDING_DISTANCE_METRIC`.)
- [x] 5.2 Verify the documented `multilingual-minilm` profile can build embeddings and return semantic hits in an executable smoke test. (`multilingual-minilm profile builds embeddings and returns semantic hits` loads the documented Transformers.js profile, builds a 384d embedding, verifies cache/profile metadata, and returns a semantic hit from a small Italian corpus.)
- [x] 5.3 Decide whether the default operational profile should be multilingual or English-biased, based on measured install size, first-run behavior, latency, and result quality smoke tests. (Default is English-biased `minilm` because it is much smaller/faster for low-compute local demos; `multilingual-minilm` is the documented Italian/mixed-language switch.)
- [x] 5.4 Confirm changing the active profile marks existing semantic index coverage stale and rebuilds from stored records. (Semantic storage identity now includes model/profile/dtype/dimensions/metric; the existing restart/backend-identity tests cover stale-then-built rebuild behavior.)

## 6. Existing Database Reconcile And Backfill

- [x] 6.1 Extend first-party manifest reconciliation so new semantic-field declarations repair existing local polyfill DB manifests without overwriting custom connectors. (Verified — the existing `reconcilePolyfillManifests` canonicalize+diff path already re-runs `registerConnector` on any structural difference, which triggers `semanticIndexBackfillForManifest`. Scope is still limited to shipped first-party `connector_id`s, so custom connectors are untouched. No new reconcile code needed; the new `semantic_fields` entries flow through the existing plumbing.)
- [x] 6.2 Ensure semantic backfill indexes existing stored records after manifest coverage changes, without re-running connectors. (Verified by the new gmail regression test: records ingested against a stripped manifest become semantically searchable after re-registration with the shipped `semantic_fields`, with zero re-ingest.)
- [x] 6.3 Add restart tests proving semantic coverage survives process restart and profile changes trigger stale-then-built behavior after rebuild. (Covered by `restart regression: semantic coverage survives process restart without re-ingest`, `backend identity change flips index_state to stale until rebuild restores`, and the profile/dtype-aware storage identity added in the local-backend slice.)
- [x] 6.4 Resume interrupted semantic backfills when the persisted in-progress identity still matches the active field fingerprint and backend storage identity. (`interrupted semantic backfill resumes and embeds only missing record-field pairs` simulates a 501-record rebuild interrupted after the first 500 vectors persist, then verifies restart embeds only the 1 missing vector and clears progress.)

## 7. Dashboard Search Integration

- [x] 7.1 Update dashboard blended search so semantic uplift is attempted only when semantic capability is advertised and diagnostics indicate non-zero participation.
- [x] 7.2 When semantic is unavailable, stale, or zero-participation, degrade silently in search results but make the reason visible on `/dashboard/deployment`.
- [x] 7.3 Add tests for the blended search zero-participation path so an empty semantic index does not look like successful semantic uplift.

## 8. Docs And Validation

- [x] 8.1 Update reference docs to explain operational semantic setup, model cache behavior, multilingual profile configuration, and the meaning of zero participation. (`README.md`, `reference-implementation/README.md`, and `apps/web/content/docs/reference-implementation.md`.)
- [x] 8.2 Update semantic docs only where needed to clarify server-owned model selection and `language_bias`; do not add public model-selection parameters. (`spec-semantic-retrieval-extension.md` keeps model selection server-owned.)
- [x] 8.3 Run `openspec validate make-semantic-retrieval-operational --strict`.
- [x] 8.4 Run `openspec validate --all --strict`.
- [x] 8.5 Run relevant reference and web checks after implementation, including semantic retrieval tests, dashboard diagnostics tests, typecheck, and build.
