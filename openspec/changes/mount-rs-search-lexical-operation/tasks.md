## 1. Baseline And Boundary

- [x] 1.1 Inventory current native `GET /v1/search` behavior, including the `runLexicalSearch` flow, allowlist, advertisement gate, mode planning, cursor encode/decode, slice math, score gate, envelope, and disclosure data fields.
- [x] 1.2 Inventory current sandbox `GET /sandbox/v1/search` behavior, including the `buildLiveSearchResponse` matcher, empty-`q` behavior, score-shape parity, and `paginateLive` envelope shape.
- [x] 1.3 Confirm the operation module path (`reference-implementation/operations/rs-search-lexical/index.ts`) and document why it satisfies the no-Fastify/no-Next/no-SQLite/no-`server/search.js`/no-process-env boundary.

## 2. Operation Implementation

- [x] 2.1 Implement canonical `rs.search.lexical` operation with explicit request, response, error, and dependency inputs. The operation owns request normalization (allowlist, `q` required, `limit` clamp, `streams[]` normalization, `filter[...]` coupling), advertisement gates (cross-stream, score), mode planning, cursor encode/decode, snapshot orchestration, slice math, `search_result` shaping, list-envelope (without host-shaped `url`), and `disclosure.served` data block. It delegates plan compilation, snapshot building, snapshot persistence, manifest/grant resolution, advertisement source, and record-url formatting to capability dependencies.
- [x] 2.2 Update native `runLexicalSearch` in `reference-implementation/server/search.js` to call `executeSearchLexical` with native dependencies that preserve the existing owner fan-out, client grant manifest resolution, FTS5 snapshot build/persist/load, and `record_url` formatting. Keep `parseSearchParams`, `encodeSearchCursor`, and `decodeSearchCursor` callers wired through the operation; their bodies may live in either module as long as the operation owns the public-contract behavior.
- [x] 2.3 Add sandbox fixture dependencies in `apps/web/src/app/sandbox/_demo/operations-fixtures.ts` (`createSandboxSearchLexicalDependencies`) backed by deterministic substring matching over `DEMO_RECORDS` and an in-memory snapshot cache. The factory MAY consume the previous `buildLiveSearchResponse` matcher demoted to a fixture-only helper.
- [x] 2.4 Switch `/sandbox/v1/search/route.ts` to call `executeSearchLexical` directly with the fixture dependencies. The route SHALL NOT statically import `buildLiveSearchResponse`. The route SHALL NOT short-circuit empty `q`; the operation's canonical `invalid_request` rejection applies to the sandbox API the same way it applies to native (per owner guidance — see design §6). Map the operation's typed errors (`invalid_request`, `invalid_cursor`, `grant_stream_not_allowed`) to a sandbox JSON error envelope consistent with the existing sandbox `notFound` shape.
- [x] 2.5 Demote `buildLiveSearchResponse` so it is no longer exported from `_demo/builders.ts` to public route code. Either delete the public export and inline the matcher into the fixture factory, or keep it as a fixture-only helper imported only from `_demo/operations-fixtures.ts`.
- [x] 2.6 Add operation-level tests for owner-mode flow, client-mode `streams[] ⊆ grant.streams` rejection, allowlist rejection, `q` required, `filter[...]` coupling, cross-stream advertisement gate, score-advertisement gate, cursor round-trip with snapshot persist/load, expired-cursor rejection, and `disclosure.served` data block.

## 3. Host Mounts

- [x] 3.1 Confirm the native Fastify `GET /v1/search` route still calls `runLexicalSearch` exactly as before (no signature change) and that `runLexicalSearch` now produces the same envelope and disclosure data through `executeSearchLexical`.
- [x] 3.2 Switch the Next sandbox `GET /sandbox/v1/search` route to mount `executeSearchLexical` with the fixture dependencies; preserve the sandbox demo headers and the `url: '/sandbox/v1/search'` envelope field. Update the existing `routes.test.ts` empty-`q` case to assert the canonical `invalid_request` envelope.

## 4. Boundary Tests

- [x] 4.1 Extend boundary tests so the new operation module is covered by the shared `operation-boundary.js` gate.
- [x] 4.2 Add a per-operation boundary test proving the sandbox `/sandbox/v1/search/route.ts` does not statically import `buildLiveSearchResponse` and that `_demo/builders.ts` no longer exports it (or no longer exports it for non-fixture consumers — see task 2.5 for the chosen mechanism).

## 5. Validation

- [x] 5.1 Run `node --test --test-force-exit reference-implementation/test/operations-boundary.test.js`.
- [x] 5.2 Run new operation tests for `rs.search.lexical` (`rs-search-lexical-operation.test.js`).
- [x] 5.3 Run `node --test --test-force-exit reference-implementation/test/lexical-retrieval.test.js` and confirm the existing public-contract scenarios still pass: happy-path list envelope with bm25 score; score omitted when not advertised; missing `q` rejected; disallowed v1 params rejected; filtered search range/exact/no-match; filtered search invalid filter shapes; client `streams[]` not in grant returns `grant_stream_not_allowed`; owner unknown stream returns empty list; `cross_stream: false` advertisement requires `streams[]`; pagination round-trip; and the spine-vs-list independence assertion.
- [x] 5.4 Run `node --test --test-force-exit --import tsx apps/web/src/app/sandbox/_demo/routes.test.ts` and confirm the existing `/sandbox/v1/search` cases still pass.
- [x] 5.5 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 5.6 Run `pnpm --filter pdpp-reference-implementation check`.
- [x] 5.7 Run `pnpm --dir apps/web run types:check`.
- [x] 5.8 Run `pnpm --dir apps/web run check`.
- [x] 5.9 Run `openspec validate mount-rs-search-lexical-operation --strict`.
- [x] 5.10 Run `openspec validate --all --strict`.
- [x] 5.11 Grep for old direct-route/builder import patterns: no public route imports `buildLiveSearchResponse`; no operation module imports `server/search.js`, `node:process`, or `process`.

## 6. Acceptance Checks

- `/v1/search` returns the existing envelope, error codes, cursor format, scoring metadata, grant filtering, stream/filter query semantics, and disclosure-spine event shape. No public-contract drift in `lexical-retrieval.test.js`.
- `/sandbox/v1/search` returns the existing `LiveSearchResponse` envelope (`object: 'list'`, `url: '/sandbox/v1/search'`, `has_more`, `data: search_result[]`) for valid populated queries, and emits the same bm25-shaped score field when scoring is advertised. Empty/missing `q` returns the canonical `invalid_request` envelope (a deliberate, owner-approved drift from the prior `routes.test.ts` empty-`q` assertion).
- The operation module obeys the shared boundary rule and the sandbox route does not statically import `buildLiveSearchResponse`.
