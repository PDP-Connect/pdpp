## 1. Baseline And Boundary

- [x] 1.1 Inventory current native `GET /v1/search/hybrid` behavior, including the `runHybridSearch` flow, allowlist + explicit `cursor` rejection + forbidden-parameter list, sub-request fan-out into `runLexicalSearch` / `runSemanticSearch`, round-robin merge, dedup by `(connector_id, stream, record_key)`, `matched_fields` union, per-source `scores` map forwarding (no flat `score` field), first-non-empty snippet preservation, `retrieval_sources` provenance (lexical-first), `retrieval_mode: "hybrid"`, list-envelope shape (no `next_cursor`), and disclosure data fields.
- [x] 1.2 Confirm the operation module path (`reference-implementation/operations/rs-search-hybrid/index.ts`) and document why it satisfies the no-Fastify/no-Next/no-SQLite/no-`server/search.js`/no-`server/search-semantic.js`/no-`server/search-hybrid.js`/no-process-env boundary.

## 2. Operation Implementation

- [x] 2.1 Implement canonical `rs.search.hybrid` operation with explicit request, response, error, and dependency inputs. The operation owns request normalization (allowlist, explicit `cursor` rejection, explicit forbidden-parameter list, `q` required, `limit` clamp, `streams[]` normalization, `filter[...]` coupling), per-source fan-out via `runLexical` / `runSemantic` capability dependencies, round-robin merge with dedup by `(connector_id, stream, record_key)`, `matched_fields` union (lexical-first), per-source score forwarding under a `scores` map (verbatim, no normalization, no flat `score` field), first-non-empty snippet preservation, `retrieval_sources` provenance (subset of `["lexical", "semantic"]`, lexical-first order), `retrieval_mode: "hybrid"`, list-envelope shape (no `next_cursor` in v1), and `disclosure.served` data block (`query_shape: 'search_hybrid'`, `record_count`, `has_more`, `mode`, `lexical_count`, `semantic_count`).
- [x] 2.2 Update native `runHybridSearch` in `reference-implementation/server/search-hybrid.js` to call `executeSearchHybrid` with native dependencies that preserve the existing sub-request fan-out into `runLexicalSearch` and `runSemanticSearch` (the synthetic sub-request shape, the verbatim forwarding of parsed hybrid params, and the propagation of grant_stream_not_allowed / other underlying-runner errors).
- [x] 2.3 Demote `parseHybridSearchParams` in `reference-implementation/server/search-hybrid.js` to a delegating shim that calls `parseSearchHybridParams` and translates `SearchHybridRequestError` to the previous plain-`Error` shape (`err.code`, optional `err.param`) so any direct importers continue to receive the same error shape.
- [x] 2.4 Add operation-level tests for: allowlist rejection, explicit `cursor` rejection, explicit forbidden-parameter rejection, `q` required, `limit` clamp, `streams[]` normalization (string and array), `filter[...]` coupling, per-source dependency invocation under the caller's grant (with sub-request params forwarded verbatim), error propagation from the underlying runners (e.g. grant_stream_not_allowed), round-robin merge order, dedup by `(connector_id, stream, record_key)`, `matched_fields` union with deduplication, per-source `scores` map (no flat `score` field on hybrid hits, no normalization), first-non-empty snippet preservation, `retrieval_sources` lexical-first provenance, `retrieval_mode: "hybrid"` per hit, limit-after-merge with honest `has_more` and no `next_cursor` in the envelope, and the `disclosure.served` data block (`query_shape: "search_hybrid"`, per-source counts, mode tracking).

## 3. Host Mounts

- [x] 3.1 Confirm the native Fastify `GET /v1/search/hybrid` route still calls `runHybridSearch` exactly as before (no signature change) and that `runHybridSearch` now produces the same envelope and disclosure data through `executeSearchHybrid`.

## 4. Boundary Tests

- [x] 4.1 Extend boundary tests so the new operation module is covered by the shared `operation-boundary.js` gate.
- [x] 4.2 Add a per-operation boundary test proving the operation does not statically import `server/search.js`, `server/search-semantic.js`, or `server/search-hybrid.js` (the hybrid-is-not-a-new-grant-logic-path invariant continues to apply at the operation boundary).

## 5. Validation

- [x] 5.1 Run `node --test --test-force-exit reference-implementation/test/operations-boundary.test.js`.
- [x] 5.2 Run new operation tests for `rs.search.hybrid` (`rs-search-hybrid-operation.test.js`) and the per-operation boundary test (`rs-search-hybrid-boundary.test.js`).
- [x] 5.3 Run `node --test --test-force-exit reference-implementation/test/hybrid-retrieval.test.js` and confirm the existing public-contract scenarios still pass: advertisement only when both lexical and semantic are on; advertisement omission when either surface is off or the extension is explicitly disabled; happy-path owner-token hybrid search across two streams; client-token grant projection (stream + field) applied consistently; dedup of a record matching both sources with merged sources + scores; lexical-only and semantic-only provenance; v1 cursor rejection; cross-surface cursor rejection (lexical and semantic cursors rejected by hybrid); no `next_cursor` in v1; `/v1/search` and `/v1/search/semantic` response shapes unchanged when hybrid is advertised; the explicit forbidden-parameter list; `q`-required.
- [x] 5.4 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 5.5 Run `pnpm --filter pdpp-reference-implementation check`.
- [x] 5.6 Run `openspec validate mount-rs-search-hybrid-operation --strict`.
- [x] 5.7 Run `openspec validate --all --strict`.
- [x] 5.8 Grep for old direct-call patterns: no operation module imports `server/search.js`, `server/search-semantic.js`, `server/search-hybrid.js`, `node:process`, or `process`; the `parseHybridSearchParams` shim still exists and still translates `SearchHybridRequestError` into the previous error shape.

## 6. Acceptance Checks

- `GET /v1/search/hybrid` returns the existing envelope (`object: 'list'`, `url: '/v1/search/hybrid'`, `has_more`, `data: search_result[]` — no `next_cursor` in v1), error codes (including the explicit `cursor` rejection and the explicit forbidden-parameter list), per-hit `retrieval_mode: "hybrid"`, per-hit `retrieval_sources` provenance (subset of `["lexical", "semantic"]`, lexical-first order), per-source `scores` map (each entry is the underlying surface's score object verbatim — no normalization, no flat `score` field), grant filtering through the underlying runners, stream/filter query semantics, and disclosure-spine event shape (`query_shape: 'search_hybrid'`, `record_count`, `has_more`, `mode`, `lexical_count`, `semantic_count`). No public-contract drift in `hybrid-retrieval.test.js`.
- The operation module obeys the shared boundary rule and additionally does not statically import `server/search.js`, `server/search-semantic.js`, or `server/search-hybrid.js`.
- `parseHybridSearchParams` continues to throw the same plain-`Error` shape (`err.code`, optional `err.param`) for direct callers.
- Grant enforcement remains delegated to the underlying lexical and semantic runners. Errors from either runner propagate unchanged through hybrid (e.g. `grant_stream_not_allowed`).
- v1 hybrid pagination remains unsupported. Any `cursor` parameter is rejected with `invalid_request` and `param: 'cursor'`. The envelope SHALL NOT carry `next_cursor`.
- No sandbox hybrid route is added.
