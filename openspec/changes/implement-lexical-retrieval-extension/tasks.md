## 1. Establish the worktree and confirm the approved design is canonical

- [x] 1.1 Create branch `implement-lexical-retrieval-extension` and worktree at `/home/user/code/pdpp-lexical-retrieval` off main commit `7aa10d4` so we don't collide with the in-flight `swap-sqlite-driver` work in `db.js`.
- [x] 1.2 Confirm `add-lexical-retrieval-extension` is approved and untouched. Validate it once with `openspec validate add-lexical-retrieval-extension --strict` to be sure.

## 2. Stream metadata declaration

- [ ] 2.1 Add `query.search.lexical_fields` to `reference-implementation/manifests/reddit.json`:
  - `posts`: `["title", "selftext"]`
  - `comments`: `["body", "post_title"]`
  - `saved`: do not declare (proves the non-participation branch end-to-end)
- [ ] 2.2 Tighten `validateConnectorManifest()` in `reference-implementation/server/auth.js` to enforce, when `query.search.lexical_fields` is present:
  - non-empty array of non-empty strings
  - every entry is a key in `schema.properties`
  - the referenced schema entry is `type: "string"` (rejects array, object, blob ref, integer, etc.)
- [ ] 2.3 No change needed to `GET /v1/streams/:stream` — `mStream.query` is already passed through, so a populated declaration surfaces automatically.

## 3. RS metadata advertisement

- [ ] 3.1 Add an optional `lexicalRetrievalCapability` parameter to `buildProtectedResourceMetadata()` in `reference-implementation/server/metadata.js`. When provided, set `metadata.capabilities.lexical_retrieval = lexicalRetrievalCapability`.
- [ ] 3.2 In the route handler at `index.js` for `GET /.well-known/oauth-protected-resource`, build the capability object with `supported: true`, `endpoint: '/v1/search'`, `cross_stream: true`, `snippets: true`, `default_limit: 25`, `max_limit: 100`. Allow `opts.lexicalRetrievalSupported === false` to publish `supported: false` instead (or `opts.lexicalRetrievalCapability` to override outright for tests).
- [ ] 3.3 Confirm the advertisement is reachable without a bearer token (the route already permits that today; do not regress).

## 4. Internal search helper

- [ ] 4.1 Create `reference-implementation/server/search.js` with:
  - `buildSearchPlan({ manifest, grant, streamsFilter })` returning `[{ streamName, searchableFields }]` with empty intersections dropped
  - `searchRecordsLexical({ storageBinding, manifest, plan, q, limit, cursor })` returning `{ hits, nextCursor, hasMore }`
- [ ] 4.2 Field gating happens in `buildSearchPlan` *before* any FTS5 query. There is no code path that reads from the index for an unauthorized field. (Satisfies "filter-later prohibited" by construction.)
- [ ] 4.3 `searchRecordsLexical` populates a `lexical_search_snapshots` row keyed by `(snapshot_id, q, plan_hash)` so opaque cursor pagination is stable for the session.
- [ ] 4.4 Snippet generation pulls text from the matched field of the record under the caller's grant projection (via the existing record-fetch path / `projectFields`). If snippet hydration fails, omit `snippet`.

## 5. FTS5 backing index

- [ ] 5.1 Add a `CREATE VIRTUAL TABLE IF NOT EXISTS lexical_search_index USING fts5(...)` schema bootstrap in `reference-implementation/server/db.js` — additive, no change to existing tables. Single column with content (`text`); other identifying columns (`stream`, `record_key`, `field`) are `UNINDEXED`.
- [ ] 5.2 Add a `lexical_search_snapshots` table for cursor pagination snapshots (id, query, plan_hash, results JSON, created_at).
- [ ] 5.3 On record insert/update/delete in the existing record-write path, call into `search.js` to upsert/delete the corresponding rows in `lexical_search_index` for declared `lexical_fields` of that stream's manifest. JS-side maintenance, not SQLite triggers, because we need the manifest to know which fields to index.
- [ ] 5.4 On startup, detect drift (record count vs index row count, sampled per stream) and rebuild if mismatched. Log the rebuild via the structured logger.
- [ ] 5.5 Coordinate with `swap-sqlite-driver`: route all FTS5 calls through the existing `db.query(sql\`…\`)` wrapper. If that wrapper changes shape at merge time, retarget but keep the FTS5 schema and maintenance semantics identical.

## 6. `GET /v1/search` route — keep it thin, all logic in `search.js`

- [ ] 6.1 Register `app.get('/v1/search', { contract: 'searchRecordsLexical' }, requireToken, …)` in `reference-implementation/server/index.js` next to the existing `/v1/streams/...` routes. The handler body is at most a few dozen lines: build `queryContext`, call `runLexicalSearch({ req, opts, tokenInfo, queryContext })`, emit `query.received` + `disclosure.served`, send the envelope. No parameter parsing or mode branching inline.
- [ ] 6.2 In `search.js`, parameter allowlist is `q`, `limit`, `cursor`, `streams` / `streams[]`. Any other key → `invalid_request_error` with `param` set to the rejected key. `connector_id` is on the rejection list explicitly (the public surface has no connector-scope param in v1).
- [ ] 6.3 Required `q`: missing → `invalid_request_error`.
- [ ] 6.4 Per-mode resolution inside `search.js`:
  - **Client token**: resolve a single grant + manifest via `resolveGrantManifest`. `streams[]` membership check against the grant: any unauthorized entry → `permission_error` with code `grant_stream_not_allowed`.
  - **Owner token**: enumerate every owner-visible connector (no public `connector_id` param), resolve each connector's manifest + synthetic owner grant, build a per-connector plan. `streams[]` is a soft filter — a stream name not exposed by any owner-visible connector returns zero hits, NOT a hard error (the spec explicitly distinguishes owner vs client `streams[]` semantics).
- [ ] 6.5 (covered by 6.4)
- [ ] 6.6 Helper builds `search_result` objects with required `stream`, `record_key`, `connector_id`, `emitted_at`, `matched_fields`. `record_url` is always emitted on the route; for client tokens it's `/v1/streams/.../records/...`; for owner tokens it's `/v1/streams/.../records/...?connector_id=<canonical>`. `snippet` is optional per result.
- [ ] 6.7 Helper returns a `disclosureData` object the route uses to emit `disclosure.served` with `query_shape: 'search'`, `record_count`, `has_more`, `mode` (`owner` | `client`), `connector_count`. Search disclosures are auditable on the same spine as record reads.
- [ ] 6.8 Response envelope: `{ object: 'list', url: '/v1/search', has_more, next_cursor?, data }`.
- [ ] 6.9 Add a `// Reference-only — not the public lexical retrieval surface (see GET /v1/search).` comment band above `app.get('/_ref/search', …)`.

## 7. Dashboard switchover

- [ ] 7.1 Add `searchRecordsLexical(query, scope)` to the existing `apps/web/src/app/dashboard/lib/rs-client.ts` (the same module that already exposes `listStreams`, `getStreamMetadata`, `queryRecords`, `getRecord` — server-only, owner-token, public RS surface). Do NOT introduce a new generic bridge. Reference-only `_ref` calls keep living in `apps/web/src/app/dashboard/lib/ref-client.ts`.
- [ ] 7.2 In `apps/web/src/app/dashboard/search/page.tsx`, replace `searchRecords(query, scope)` with the new helper. Delete `recordMatches`, `extractSnippet`, and the per-stream fan-out. Keep `refSearch` for the spine deep-link redirect (that's the `/_ref/search` operator-jump UX, which is unchanged).
- [ ] 7.3 The page UI is unchanged: the same `SearchResult` shape is produced; only the data source is now the public extension.

## 8. Docs cleanup

- [ ] 8.1 Edit `apps/web/content/docs/spec-data-query-api.md`: rewrite the trailing "If richer cross-stream search is needed later, add `POST /v1/search` with a query DSL…" sentence to point at the new extension and reserve `POST /v1/search` only as a possible future DSL surface, not-yet-spec'd. Keep all surrounding REST/Stripe-conventions content as is.
- [ ] 8.2 Create `apps/web/content/docs/spec-lexical-retrieval-extension.md` documenting the extension at the same depth as `spec-data-query-api.md`: Overview / Authentication & Versioning / Endpoint / Result shape / Errors / Discovery (RS metadata + per-stream `query.search.lexical_fields`) / Pagination / Non-goals.
- [ ] 8.3 Cross-link the new doc from the docs index. Cross-link `spec-data-query-api.md` ↔ `spec-lexical-retrieval-extension.md`.
- [ ] 8.4 Grep for `POST /v1/search` and `_ref/search` across `apps/web/content/docs` and `reference-implementation/`; correct any other places that overclaim.

## 9. Tests

Create `reference-implementation/test/lexical-retrieval.test.js` covering:

- [ ] 9.1 RS metadata: `capabilities.lexical_retrieval` present with all six required keys when `supported: true`.
- [ ] 9.2 RS metadata: omitted (or `supported: false`) when `opts.lexicalRetrievalSupported === false`.
- [ ] 9.3 `/v1/search?q=...` returns a list envelope with `object: 'list'`, `data: [...]`.
- [ ] 9.4 `/v1/search` rejects missing `q` with `invalid_request`.
- [ ] 9.5 `/v1/search` rejects `filter[…]`, `rank`, `boost`, `embedding`, `vector`, `semantic`, `order`, `connector_id` with `invalid_request` and identifies `param`. The `connector_id` rejection holds for both owner and client tokens — it is not a public param in v1.
- [ ] 9.6 (client token) `/v1/search?streams[]=<not-in-grant>` → `permission_error` / `grant_stream_not_allowed`. (owner token) `/v1/search?streams[]=<nonexistent-anywhere>` → empty result list (NOT an error).
- [ ] 9.7 `/v1/search?q=...` (no `streams[]`) when an opts-level `lexicalRetrievalCapability.cross_stream === false` advertisement is published → `invalid_request`.
- [ ] 9.8 Each result has `object: 'search_result'`, required `stream`/`record_key`/`emitted_at`/`connector_id`, `record_url` resolving to `/v1/streams/{stream}/records/{record_key}` (client) or `/v1/streams/{stream}/records/{record_key}?connector_id=<canonical>` (owner), no `score` field.
- [ ] 9.9 Helper-level test: `runLexicalSearch()` (or a finer-grained internal seam) can produce hits that omit `record_url`, and they're still valid as long as `stream`/`record_key`/`emitted_at`/`connector_id` are present.
- [ ] 9.10 `matched_fields` is a non-empty subset of declared `lexical_fields` ∩ grant projection.
- [ ] 9.11 Grant authorizes only a subset of declared `lexical_fields` → `matched_fields` constrained accordingly; snippet text never quotes the unauthorized field.
- [ ] 9.12 Stream with declared `lexical_fields` whose intersection with the grant is empty contributes zero hits and zero per-stream errors.
- [ ] 9.13 Pagination: `next_cursor` round-trips; passing a `/v1/search` cursor to `/v1/streams/.../records?cursor=...` → `invalid_cursor`.
- [ ] 9.14 `/_ref/search` and `/v1/search` are independent: hitting `/_ref/search?q=trace_id` returns the spine result shape, not a `list` of `search_result`s; hitting `/v1/search?q=...` returns the `list`/`search_result` shape, not the spine shape.
- [ ] 9.15 Manifest validator rejects: empty `lexical_fields`, non-array, nested path (`"posts.title"`), array-type schema field, unknown field, integer-type field.
- [ ] 9.16 Snippet generation is grant-safe: with a grant that omits one of the declared `lexical_fields`, no result snippet contains text from that omitted field.
- [ ] 9.17 Owner-mode cross-connector: with two owner-visible connectors that both expose a stream named `messages` with overlapping `lexical_fields`, hits from BOTH connectors appear in one `/v1/search?q=...` response, each with its own `connector_id`.
- [ ] 9.18 Owner-mode hydration round-trip: take `record_url` from a `/v1/search` hit, GET it under the owner token, confirm the same record envelope comes back. (Proves the `?connector_id=...` encoding is correct.)

## 10. Validation

- [ ] 10.1 `openspec validate add-lexical-retrieval-extension --strict` (sanity, untouched).
- [ ] 10.2 `openspec validate implement-lexical-retrieval-extension --strict`.
- [ ] 10.3 `pnpm --filter pdpp-reference-implementation test` — full suite green; no regressions outside the new file.
- [ ] 10.4 Manual: `apps/web` dashboard search renders Reddit `posts.title` / `posts.selftext` / `comments.body` matches against the public extension.
- [ ] 10.5 Final grep:
  - `grep -rn "POST /v1/search" apps/web reference-implementation` → only the docs sentence reserving the future DSL surface should remain.
  - `grep -rn "_ref/search" apps/web reference-implementation` → only the spine handler + the dashboard's `refSearch` jump caller; no overclaim wording.
  - `grep -rn "lexical_retrieval\|lexical_fields" apps/web reference-implementation openspec` → only intentional references.

## 11. Stop and report instead of widening

If during implementation any of these become necessary, stop and report rather than freelancing:

- [ ] 11.1 The approved spec needs a real change (any contradiction with the locked contract).
- [ ] 11.2 Snippets cannot be made grant-safe under the design.
- [ ] 11.3 Field gating cannot be done pre-query and must be done post-query.
- [ ] 11.4 A new shared dashboard-only search contract is needed.
- [ ] 11.5 A semantic/vector or body-DSL surface seems required.
- [ ] 11.6 The discovery carrier needs to move off RS metadata.
- [ ] 11.7 Connector-specific search semantics seem required.
