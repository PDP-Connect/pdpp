## 1. Probe And Configuration

- [ ] 1.1 Add an explicit Postgres BM25 backend config flag; default it to disabled.
- [ ] 1.2 Add a Postgres `pg_search` availability probe that distinguishes disabled, unavailable, available, enabled, and fallback states.
- [ ] 1.3 Surface the probed backend state in reference deployment diagnostics without exposing connection strings or secrets.
- [ ] 1.4 Add tests proving Postgres startup succeeds without `pg_search` and keeps native FTS active.

## 2. Optional DDL And Index Shape

- [ ] 2.1 Decide and implement the stable BM25 key shape for `lexical_search_index` rows, preserving public `(connector_instance_id, stream, record_key, field)` identity.
- [ ] 2.2 Add opt-in, idempotent BM25 index DDL guarded by config and extension readiness.
- [ ] 2.3 Ensure failed BM25 index creation is observable and falls back to native FTS without corrupting existing lexical index rows.
- [ ] 2.4 Add migration/bootstrap tests for disabled, unavailable, enabled, and re-run idempotency cases.

## 3. Query Backend

- [ ] 3.1 Split native Postgres lexical search and optional BM25 lexical search behind the existing `postgresLexicalSearch(...)` seam.
- [ ] 3.2 Preserve the row shape consumed by `search.js`: connector id, stream, record key, field, emitted timestamp, record JSON, score, and snippet text.
- [ ] 3.3 Keep all grant-derived connector, stream, field, record-key, and deleted-record constraints enforced on both backends.
- [ ] 3.4 Fail closed to native Postgres FTS when the BM25 path is unavailable or fails at query time.

## 4. Recall And Capability Honesty

- [ ] 4.1 Keep `candidate_window` recall disclosure on native Postgres FTS fallback.
- [ ] 4.2 Emit exact/all-matches recall only when the BM25 path proves full scoped top-k retrieval before pagination.
- [ ] 4.3 Update protected-resource metadata or reference diagnostics to identify the active lexical backend without claiming portable score comparability.
- [ ] 4.4 Ensure MCP search output mirrors the same recall/backend facts without inferring completeness from `has_more`.

## 5. Test And Proof Profile

- [ ] 5.1 Add unit tests for backend selection, fallback, and query row-shape parity.
- [ ] 5.2 Add optional Postgres+`pg_search` integration tests gated behind explicit environment configuration.
- [ ] 5.3 Add a fixture where true BM25 top-k differs from a small candidate-window result and prove the BM25 path returns the correct scoped top-k.
- [ ] 5.4 Run existing SQLite lexical retrieval, Postgres fallback, RS operation, MCP mirror, and search fan-in tests.

## 6. Deployment Posture

- [ ] 6.1 Document that default reference images and default Compose profiles do not require `pg_search`.
- [ ] 6.2 If adding a ParadeDB/`pg_search` image profile, document the image source, extension version, licensing posture, and fallback behavior.
- [ ] 6.3 Do not deploy to the live personal-data stack until local tests pass and a live-stack mutex window is declared.
- [ ] 6.4 Live-verify broad lexical queries before/after on the optional BM25 profile and record the timings plus recall envelopes.

## 7. Acceptance Checks

- [ ] 7.1 `openspec validate restore-postgres-bm25-topk-search --strict`.
- [ ] 7.2 `openspec validate --all --strict`.
- [ ] 7.3 Default SQLite and native Postgres lexical tests pass without a `pg_search` extension.
- [ ] 7.4 Optional `pg_search` tests pass in an explicitly configured proof environment.
- [ ] 7.5 Live proof demonstrates no SQLSTATE `53100`, exact/all-matches recall only on the BM25 path, and candidate-window disclosure on fallback.
