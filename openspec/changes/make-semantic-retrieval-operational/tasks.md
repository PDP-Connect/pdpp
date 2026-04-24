## 1. Baseline And Existing Notes

- [ ] 1.1 Record the current semantic design notes reviewed in the implementation report, including why none already covers operational coverage, diagnostics, and multilingual model profiles.
- [x] 1.2 Audit current semantic participation across native and polyfill manifests; write down which manifests declare `semantic_fields` and which advertised deployments would currently index zero fields. (see `design-notes/semantic-field-coverage-2026-04-24.md` — zero polyfill manifests declared `semantic_fields`; the shipped `gmail/github/slack/chatgpt/claude_code/codex/reddit/chase/usaa/ynab` manifests now declare honest coverage.)
- [x] 1.3 Confirm the current public semantic contract still rejects `model`, `model_id`, `embedding`, `vector`, ranking knobs, and debug/score output before changing implementation. (Confirmed via `FORBIDDEN_PARAMS` in `reference-implementation/server/search-semantic.js` and the passing `parseSemanticSearchParams accepts the v1 allowlist` test; no public surface changed.)

## 2. Operational Diagnostics

- [x] 2.1 Add a reference diagnostics helper that reports semantic backend availability, vector index kind/state, model/profile identity, language bias, participating connectors/streams/fields, manifest provenance, DB path, and warnings.
- [x] 2.2 Add a read-only `/dashboard/deployment` page that renders the diagnostics clearly and redacts all secret values.
- [x] 2.3 Show explicit warnings for zero semantic participation, stale index, unavailable embedding backend, missing model cache, disabled download, and vector-index fallback.
- [x] 2.4 Add tests proving deployment diagnostics redacts secrets and reports zero participation separately from backend/index readiness.

## 3. First-Party Semantic Coverage

- [x] 3.1 Audit first-party polyfill manifests for top-level natural-language string fields suitable for semantic retrieval. (see `design-notes/semantic-field-coverage-2026-04-24.md`.)
- [x] 3.2 Add `query.search.semantic_fields` to priority polyfill streams where the field choice is honest and validator-safe. (Added to gmail, github, slack, chatgpt, claude_code, codex, reddit, chase, usaa, ynab; also aligned the semantic validator with `isTopLevelSearchableStringField` so nullable-string fields — the majority of natural-language fields in the first-party set — pass validation, matching the existing lexical validator and the validator's own stated intent.)
- [x] 3.3 Document exclusions for streams with no suitable top-level string semantic fields or fields that are identifier-like, nested, array-shaped, blob-backed, or too sensitive to embed by default. (see `design-notes/semantic-field-coverage-2026-04-24.md` Exclusions section.)
- [x] 3.4 Add regression tests proving at least one real polyfill-style manifest contributes semantic coverage and semantic search can return non-empty results after backfill. (`shipped gmail manifest contributes semantic coverage after reconcile without record re-ingest` in `reference-implementation/test/semantic-retrieval.test.js`.)

## 4. Local Embedding Backend

- [ ] 4.1 Evaluate `@huggingface/transformers` for the operational local embedding backend; verify install/runtime behavior, first-run cache behavior, model loading, dimensions, and Node compatibility.
- [ ] 4.2 Implement an operational local embedding backend with no hosted API key requirement and with explicit model, dimensions, distance metric, availability, and language-bias metadata.
- [ ] 4.3 Preserve the deterministic stub backend for tests and CI; keep tests clear that the stub only promises deterministic exact-match reflexivity.
- [ ] 4.4 Ensure backend unavailability disables or degrades semantic advertisement honestly rather than advertising supported semantic retrieval that cannot embed.

## 5. Multilingual Profile Support

- [ ] 5.1 Add operator configuration for one active semantic embedding profile, including profile ID, model ID or preset, cache directory, download policy, dimensions, distance metric, and language-bias metadata.
- [ ] 5.2 Add and document a multilingual profile suitable for Italian-language data; verify it can build embeddings and return semantic hits in an executable smoke test.
- [ ] 5.3 Decide whether the default operational profile should be multilingual or English-biased, based on measured install size, first-run behavior, latency, and result quality smoke tests.
- [ ] 5.4 Confirm changing the active profile marks existing semantic index coverage stale and rebuilds from stored records.

## 6. Existing Database Reconcile And Backfill

- [x] 6.1 Extend first-party manifest reconciliation so new semantic-field declarations repair existing local polyfill DB manifests without overwriting custom connectors. (Verified — the existing `reconcilePolyfillManifests` canonicalize+diff path already re-runs `registerConnector` on any structural difference, which triggers `semanticIndexBackfillForManifest`. Scope is still limited to shipped first-party `connector_id`s, so custom connectors are untouched. No new reconcile code needed; the new `semantic_fields` entries flow through the existing plumbing.)
- [x] 6.2 Ensure semantic backfill indexes existing stored records after manifest coverage changes, without re-running connectors. (Verified by the new gmail regression test: records ingested against a stripped manifest become semantically searchable after re-registration with the shipped `semantic_fields`, with zero re-ingest.)
- [ ] 6.3 Add restart tests proving semantic coverage survives process restart and profile changes trigger stale-then-built behavior after rebuild. (Restart-across-process-boot coverage already exists in `restart regression: semantic coverage survives process restart without re-ingest` and `backend identity change flips index_state to stale until rebuild restores`; a follow-up test specifically for "real polyfill manifest survives restart" belongs in the profile-configuration slice — 5.x — where the profile switch is part of the reference, not in this coverage-only slice.)

## 7. Dashboard Search Integration

- [x] 7.1 Update dashboard blended search so semantic uplift is attempted only when semantic capability is advertised and diagnostics indicate non-zero participation.
- [x] 7.2 When semantic is unavailable, stale, or zero-participation, degrade silently in search results but make the reason visible on `/dashboard/deployment`.
- [x] 7.3 Add tests for the blended search zero-participation path so an empty semantic index does not look like successful semantic uplift.

## 8. Docs And Validation

- [ ] 8.1 Update reference docs to explain operational semantic setup, model cache behavior, multilingual profile configuration, and the meaning of zero participation.
- [ ] 8.2 Update semantic docs only where needed to clarify server-owned model selection and `language_bias`; do not add public model-selection parameters.
- [ ] 8.3 Run `openspec validate make-semantic-retrieval-operational --strict`.
- [ ] 8.4 Run `openspec validate --all --strict`.
- [ ] 8.5 Run relevant reference and web checks after implementation, including semantic retrieval tests, dashboard diagnostics tests, typecheck, and build.
