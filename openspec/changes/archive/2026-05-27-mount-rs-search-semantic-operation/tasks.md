## 1. Baseline And Boundary

- [x] 1.1 Inventory current native `GET /v1/search/semantic` behavior, including the `runSemanticSearch` flow, allowlist + forbidden-parameter list, advertisement gate, mode planning, cursor encode/decode (with `sem1.` prefix and stale-cursor backend-identity check), slice math, score gate, envelope, `retrieval_mode`, snippet hydration, and disclosure data fields.
- [x] 1.2 Confirm the operation module path (`reference-implementation/operations/rs-search-semantic/index.ts`) and document why it satisfies the no-Fastify/no-Next/no-SQLite/no-`server/search.js`/no-`server/search-semantic.js`/no-process-env boundary.

## 2. Operation Implementation

- [x] 2.1 Implement canonical `rs.search.semantic` operation with explicit request, response, error, and dependency inputs. The operation owns request normalization (allowlist, explicit forbidden-parameter list, `q` required, `limit` clamp, `streams[]` normalization, `filter[...]` coupling), advertisement gates (cross-stream, score), mode planning, cursor encode/decode with the `sem1.` prefix, snapshot orchestration with backend-identity stale-cursor detection, slice math, `search_result` shaping (including `retrieval_mode: "semantic"`), list-envelope (without host-shaped `url`), and `disclosure.served` data block (`query_shape: "search_semantic"`). It delegates plan compilation, snapshot building, snapshot persistence, manifest/grant resolution, advertisement source, current backend identity, snippet hydration, and record-url formatting to capability dependencies.
- [x] 2.2 Update native `runSemanticSearch` in `reference-implementation/server/search-semantic.js` to call `executeSearchSemantic` with native dependencies that preserve the existing owner fan-out, client grant manifest resolution, embedding-backend selection, vector-index choice (sqlite-vec vs blob-flat), snapshot build/persist/load, backend-identity hashing, snippet hydration, and `record_url` formatting.
- [x] 2.3 Demote `parseSemanticSearchParams` in `reference-implementation/server/search-semantic.js` to a delegating shim that calls `parseSearchSemanticParams` and translates `SearchSemanticRequestError` to the previous plain-`Error` shape (`err.code`, optional `err.param`) so existing direct importers (notably `semantic-retrieval.test.js`) continue to receive the same error shape.
- [x] 2.4 Add operation-level tests for owner-mode flow, client-mode `streams[] ⊆ grant.streams` rejection, allowlist rejection, explicit forbidden-parameter rejection, `q` required, `filter[...]` coupling, cross-stream advertisement gate, score-advertisement gate (including a per-hit shape pin asserting the emitted `score` object carries exactly `kind`, `value`, `order` and no capability-level metadata fields such as `value_semantics`, `comparable_with`, `model`, `dimensions`, `distance_metric`, `profile_id`, `dtype`, or `backend_identity`), cursor round-trip with snapshot persist/load, the `sem1.` prefix in produced cursors, malformed-cursor rejection (no prefix and bad body), expired-cursor rejection, backend-identity stale-cursor rejection, `retrieval_mode: "semantic"` per hit, `disclosure.served` data block (`query_shape: "search_semantic"`), and `formatRecordUrl` / `hydrateResult` invocation.

## 3. Host Mounts

- [x] 3.1 Confirm the native Fastify `GET /v1/search/semantic` route still calls `runSemanticSearch` exactly as before (no signature change) and that `runSemanticSearch` now produces the same envelope and disclosure data through `executeSearchSemantic`.

## 4. Boundary Tests

- [x] 4.1 Extend boundary tests so the new operation module is covered by the shared `operation-boundary.js` gate.
- [x] 4.2 Add a per-operation boundary test proving the operation does not statically import `server/search.js` or `server/search-semantic.js` (the no-silent-fallback invariant continues to apply at the operation boundary).

## 5. Validation

- [x] 5.1 Run `node --test --test-force-exit reference-implementation/test/operations-boundary.test.js`.
- [x] 5.2 Run new operation tests for `rs.search.semantic` (`rs-search-semantic-operation.test.js`) and the per-operation boundary test (`rs-search-semantic-boundary.test.js`).
- [x] 5.3 Run `node --test --test-force-exit reference-implementation/test/semantic-retrieval.test.js` and confirm the existing public-contract scenarios still pass: advertisement shape with backend identity; advertisement omission when extension is disabled or backend is unavailable; happy-path list envelope with `retrieval_mode: "semantic"`; score omitted when not advertised; missing `q` rejected; explicit forbidden-parameter rejection; filtered semantic search range/no-match; filtered semantic search invalid filters; cross-stream advertisement gate; client `streams[]` not in grant returns `grant_stream_not_allowed`; owner unknown stream returns empty list; matched_fields ⊆ granted-and-declared; snippet verbatim-substring property; grant-safe snippet; no-fallback source-level invariant; owner cross-connector fan-out; owner record_url round-trip; owner `connector_id=` rejected; `next_cursor` round-trip with `sem1.` prefix; lexical cursor passed to `/v1/search/semantic` returns `invalid_cursor`; lexical surface unchanged when semantic is enabled; restart persistence; backend-identity drift rebuild.
- [x] 5.4 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 5.5 Run `pnpm --filter pdpp-reference-implementation check`.
- [x] 5.6 Run `openspec validate mount-rs-search-semantic-operation --strict`.
- [x] 5.7 Run `openspec validate --all --strict`.
- [x] 5.8 Grep for old direct-call patterns: no operation module imports `server/search.js`, `server/search-semantic.js`, `node:process`, or `process`; the `parseSemanticSearchParams` shim still exists and still translates `SearchSemanticRequestError` into the previous error shape; the no-fallback source-level test on `server/search-semantic.js` is unchanged.

## 6. Acceptance Checks

- `GET /v1/search/semantic` returns the existing envelope (`object: 'list'`, `url: '/v1/search/semantic'`, `has_more`, optional `next_cursor`, `data: search_result[]`), error codes (including the explicit forbidden-parameter list), cursor format (`sem1.<base64url-json>`), per-hit score shape (exactly `{ kind: "semantic_distance", value, order: "lower_is_better" }`; no `value_semantics`, `comparable_with`, `model`, `dimensions`, `distance_metric`, `profile_id`, `dtype`, or `backend_identity` on individual hits), `retrieval_mode: "semantic"` per hit, grant filtering, stream/filter query semantics, and disclosure-spine event shape (`query_shape: 'search_semantic'`). No public-contract drift in `semantic-retrieval.test.js`.
- `/.well-known/oauth-protected-resource` continues to advertise `capabilities.semantic_retrieval.score` with `value_semantics: "distance"` and `comparable_with` (backend identity, model, dimensions, distance_metric, and where applicable profile_id/dtype). The operation does not synthesize or reshape that advertisement; backend identity is disclosed once at the capability surface, not repeated on every hit.
- The operation module obeys the shared boundary rule and additionally does not statically import `server/search.js` or `server/search-semantic.js`.
- `parseSemanticSearchParams` continues to throw the same plain-`Error` shape (`err.code`, optional `err.param`) for direct callers.
- The no-silent-fallback source-level invariant on `server/search-semantic.js` remains true.
- No sandbox semantic route is added.
