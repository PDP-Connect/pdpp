## 1. Operation Contract

- [x] 1.1 Add `SearchLexicalRecallMeta` / `SearchLexicalEnvelopeMeta` types to `reference-implementation/operations/rs-search-lexical`.
- [x] 1.2 Extend `executeSearchLexical` envelopes to include `meta.count`, `meta.count_accuracy`, and `meta.recall`.
- [x] 1.3 Preserve cursor pagination behavior while proving `has_more` does not imply recall completeness. (Recall facts ride on `SearchLexicalSnapshot.recall_meta`, persisted/reloaded, so cursor pages reuse them verbatim — proven by `rs-search-lexical-operation.test.js` and `lexical-retrieval.test.js`.)

## 2. Runtime Metadata Sources

- [x] 2.1 Have SQLite lexical search builders return exact, lower-bound, or not-counted metadata without broadening the search scope. (`runFtsQueryForConnector` reports per-(stream,field) truncation at the `LEXICAL_CANDIDATE_WINDOW_LIMIT` cap; `computeSnapshotRecallMeta` folds it into exact/lower_bound.)
- [x] 2.2 Have Postgres lexical search builders return equivalent metadata, including candidate-window facts when the bounded window is active. (Postgres has a DIFFERENT effective cap than SQLite: `postgresLexicalSearch` clamps its outer LIMIT to <=100, so `postgresEffectiveCandidateWindowLimit()` reports the honest Postgres cap (min(candidate-CTE, 100)) and `candidate_window_limit` reflects the cap that actually bounded each backend. Ranking output is unchanged; proven against a disposable Postgres DB via `PDPP_TEST_POSTGRES_URL=... node --test --import tsx reference-implementation/test/lexical-retrieval.test.js`.)
- [x] 2.3 Ensure owner fan-in metadata counts only caller-visible sources and uses compact aggregate facts, not a per-source dump. (Facts are aggregated over the bindings the grant-safe fan-out already resolved; only `ranked_candidate_count` / `candidate_window_limit` / `sources_searched_count` / `truncated_source_count` are emitted.)

## 3. Adapter Propagation

- [x] 3.1 Preserve `meta` in the native `/v1/search` response envelope and sandbox `/sandbox/v1/search` route. (Native route already forwards `result.envelope.meta`; sandbox spreads `...result.envelope`; both verified by tests.)
- [x] 3.2 Mirror RS recall metadata through the MCP search tool's `structuredContent.data`. (`compactSearchEnvelope` preserves `meta`; `search-recall-mirror.test.js` pins it.)
- [x] 3.3 Add concise MCP text output for `candidate_window` / non-complete recall. (`formatSearchRecallWarning` in `summarizeSearch`.)

## 4. Verification

- [x] 4.1 Add operation tests for exact complete, bounded-window lower-bound, and not-counted responses. (`rs-search-lexical-operation.test.js`.)
- [x] 4.2 Add route tests proving `has_more: false` with `meta.recall.complete: false` remains visibly non-exhaustive. (Operation test "has_more:false with a bounded window..." + native `lexical-retrieval.test.js` bounded-window test + sandbox route recall assertions.)
- [x] 4.3 Add MCP tests proving recall metadata is mirrored and bounded-window searches are summarized honestly. (`search-recall-mirror.test.js`.)
- [x] 4.4 Run `openspec validate disclose-lexical-recall-windows --strict` and relevant lexical/MCP test suites. (Valid; 63 RS lexical tests plus the env-gated 28-test Postgres proof, 141 MCP tests, 33 sandbox route tests, and reference/site typechecks green.)

## 5. Acceptance

- [x] 5.1 Fixture-search a broad/common lexical query and verify the response discloses whether candidate-window truncation occurred. (Native `lexical-retrieval.test.js` ingests 250 matching records -> real SQLite FTS reports `candidate_window` / `lower_bound` / `truncated`.)
- [x] 5.2 Live-search a broad/common query on `pdpp.vivid.fish` after deploy and verify the response discloses whether candidate-window truncation occurred. (After deploying `eddd84b9`, a scoped Slack `messages` grant searched broad terms `error`, `run`, and `chatgpt`; each returned `meta.count_accuracy:"lower_bound"` with `meta.recall.truncated:true`, `ranking_scope:"candidate_window"`, and `candidate_window_limit:100`. A smaller `pdpp` query returned `count_accuracy:"exact"` and `recall.complete:true`, proving both paths live.)
- [x] 5.3 Confirm older clients remain compatible because the change is additive to the list envelope. (All 16 pre-existing operation tests + 27 native lexical-retrieval tests still pass; `meta` is purely additive and the only behavioral change is that `meta` is now always present.)
