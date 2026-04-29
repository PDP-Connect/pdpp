## Why

The `define-reference-operation-environments` proof sequence has landed `rs.streams.list`, `rs.streams.detail`, `rs.schema.get`, `rs.records.list`, and `rs.records.get` as canonical reference operations mounted from both the native Fastify host and the Next sandbox host. The remaining public AS/RS surface in the sandbox that still resolves through a website-local builder is `/sandbox/v1/search` (`buildLiveSearchResponse` in `apps/web/src/app/sandbox/_demo/builders.ts`). The native `GET /v1/search` route still embeds public-contract semantics — strict v1 query-param allowlist, cross-stream advertisement gate, client `streams[] ⊆ grant.streams` rejection, `filter[...]` coupling to a single `streams[]`, score-advertisement gate, cursor encoding, and envelope shape — that should belong to a single canonical operation rather than the native route or the sandbox builder.

Lexical search is a high-risk surface: scoring semantics, grant filtering, cursor opacity, and disclosure shape are public PDPP concerns. This change extracts only the host-independent slice into an operation capsule and keeps storage/index/ranking behind capability dependencies; it does not extract a `LexicalIndex` production interface, does not introduce Postgres, and does not rewrite `server/search.js`.

## What Changes

- Introduce a canonical `rs.search.lexical` operation implementation that owns the host-independent slice of public lexical search behavior: strict v1 query-param allowlist, `q`-required check, `limit` clamping, `streams[]` normalization, `filter[...]` coupling, cross-stream advertisement gate, mode classification, client-mode `streams[] ⊆ grant.streams` rejection, owner-mode soft `streams[]` filter, cursor encode/decode, snapshot orchestration, slice math, score-advertisement gate, `search_result` shaping, list-envelope shape, and `disclosure.served` data block.
- Mount the operation from the native Fastify reference server (`GET /v1/search`) and from the Next sandbox route (`/sandbox/v1/search`), preserving response shape, error codes, cursor semantics, scoring semantics, grant filtering, and disclosure-spine semantics.
- Add a sandbox fixture dependency factory in `apps/web/src/app/sandbox/_demo/operations-fixtures.ts` that wires `rs.search.lexical` to deterministic substring matching over the demo dataset. The factory MAY reuse the previous `buildLiveSearchResponse` matching logic, demoted to a fixture-only helper that route handlers SHALL NOT import.
- Extend the boundary tests so the new operation module is gated by the shared `operation-boundary.js` rule and add a per-operation boundary test asserting the public sandbox route does not statically import `buildLiveSearchResponse`.
- Native `server/search.js` keeps its FTS5/ranking/snapshot helpers; the operation receives them as capability dependencies (`buildSearchPlanForGrant`, `buildSnapshot`, `persistSnapshot`, `loadSnapshot`, `getLexicalAdvertisement`, `listOwnerVisibleConnectorIds`, `resolveOwnerManifestForConnector`, `buildOwnerReadGrantForManifest`, `resolveGrantManifest`, `formatRecordUrl`).
- Do not migrate semantic search, hybrid search, attachment blobs, runs, traces, or any `_ref` route in this slice.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `reference-implementation-architecture`: `rs.search.lexical` becomes operation-owned, joining the existing canonical operations.
- `reference-web-bridge-contract`: `/sandbox/v1/search` SHALL mount the canonical `rs.search.lexical` operation through the sandbox fixture environment instead of constructing the public response through the website-local `buildLiveSearchResponse` builder.

## Impact

- Affected code: `reference-implementation/operations/rs-search-lexical/**`, `reference-implementation/server/index.js` (`/v1/search` route only), `reference-implementation/server/search.js` (the `runLexicalSearch` shell becomes a thin native adapter; FTS5/snapshot helpers stay), `apps/web/src/app/sandbox/v1/search/route.ts`, `apps/web/src/app/sandbox/_demo/operations-fixtures.ts`, `apps/web/src/app/sandbox/_demo/builders.ts` (demote `buildLiveSearchResponse` to a fixture-only helper), `reference-implementation/package.json` (operation export), and tests.
- No public API shape change for `/v1/search`: it continues to return its existing JSON envelope, error codes, cursor format, scoring metadata, grant filtering behavior, stream/filter query semantics, and disclosure-spine event shape. `/sandbox/v1/search` continues to return the same `LiveSearchResponse` envelope (`object: 'list'`, `url: '/sandbox/v1/search'`, `has_more`, `data: search_result[]`) for valid requests, and now obeys the same canonical request contract as native `/v1/search`: empty/missing `q` returns `invalid_request` (per owner guidance, the prior sandbox "empty `q` → empty list" behavior was a route-level fork being deleted by this slice; the sandbox UI/data-source may render an empty state without calling the API). The sandbox additionally gains real `streams[]`/`limit`/`cursor`/`filter[...]` query-param handling because those flow through the operation.
- No production `LexicalIndex` interface is extracted, no Postgres adapter is introduced, no semantic or hybrid retrieval is touched, and no broad rewrite of `server/search.js` is performed.
