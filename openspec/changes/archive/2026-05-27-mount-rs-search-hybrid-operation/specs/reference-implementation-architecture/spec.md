## ADDED Requirements

### Requirement: `rs.search.hybrid` SHALL be operation-owned

The reference implementation SHALL serve public hybrid search behavior through a canonical `rs.search.hybrid` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, the native lexical helper module, the native semantic helper module, the native hybrid helper module, and process environment.

#### Scenario: Native hybrid search route

- **WHEN** the native reference server handles `GET /v1/search/hybrid`
- **THEN** it SHALL execute the canonical `rs.search.hybrid` operation for public hybrid-search semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, query/disclosure instrumentation, response writing, advertisement-driven route registration (the route is registered only when both lexical and semantic retrieval are advertised on this server), and capability dependency wiring

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.search.hybrid` operation is implemented
- **THEN** it SHALL depend on `runLexical` and `runSemantic` capability dependencies that return per-source result envelopes already filtered through the caller's grant
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox modules, the native `server/search.js` lexical helper module, the native `server/search-semantic.js` helper module, the native `server/search-hybrid.js` helper module, or `process` / `process.env`

#### Scenario: Existing public hybrid search semantics are preserved on the native route

- **WHEN** the native `GET /v1/search/hybrid` route is migrated to the operation
- **THEN** the public JSON response shape, error codes, per-hit `retrieval_mode: "hybrid"`, per-hit `retrieval_sources` provenance (subset of `["lexical", "semantic"]`, lexical-first order), per-source `scores` map shape (each entry is the underlying surface's score object verbatim — no normalization across surfaces, no flat `score` field on individual hybrid hits), dedup semantics (`(connector_id, stream, record_key)`), grant filtering behavior (delegated to the underlying lexical and semantic runners), stream/filter query semantics, and `disclosure.served` event shape (`query_shape: "search_hybrid"`, `record_count`, `has_more`, `mode`, `lexical_count`, `semantic_count`) SHALL remain equivalent to the previous native route behavior
- **AND** the migration SHALL NOT broaden, narrow, or otherwise change the v1 query-parameter allowlist (`q`, `limit`, `streams`, `streams[]`, `filter`)
- **AND** the migration SHALL NOT change the explicit `cursor` rejection (any `cursor` parameter on the wire ⇒ `invalid_request` with `param: "cursor"` — v1 hybrid does NOT support cursor pagination)
- **AND** the migration SHALL NOT change the explicit forbidden-parameter list (`vector`, `embedding`, `embed`, `model`, `model_id`, `model_family`, `rank`, `boost`, `weights`, `blend`, `connector_id`, `fields`, `expand`, `expand[]`, `expand_limit`, `expand_limit[]`, `order`, `sort`, `mode`)
- **AND** the migration SHALL NOT introduce hybrid cursor pagination — the response envelope SHALL NOT carry `next_cursor`
- **AND** the migration SHALL NOT introduce a new grant-logic path — grant enforcement (advertisement, grant projection, stream-grant intersection, field-grant intersection, record-level grant constraints) SHALL remain inside the underlying lexical and semantic runners; errors from either runner (e.g. `grant_stream_not_allowed`) SHALL propagate unchanged through the operation
- **AND** the migration SHALL NOT normalize lexical and semantic score values together; per-hit hybrid hits SHALL expose per-source scores under a `scores` map keyed by source name and SHALL NOT carry a flat `score` field

#### Scenario: Hybrid retrieval composes the underlying lexical and semantic surfaces under the same grant

- **WHEN** the operation receives a request
- **THEN** it SHALL invoke the lexical and semantic runner dependencies under the caller's grant, passing the parsed sub-request parameters (`q`, `limit`, `streams`, `filter`) verbatim to each
- **AND** it SHALL merge the two per-source result lists in round-robin order (lexical-first), preserving per-source rank order
- **AND** it SHALL deduplicate by `(connector_id, stream, record_key)`, with the dedup map preserving insertion order so overlapping hits get the best available rank from whichever source surfaced them first
- **AND** on overlap it SHALL union `matched_fields` across sources (lexical-first discovery order, no duplicates), forward the underlying score objects under `scores[source]` verbatim, and keep the first non-empty snippet encountered
- **AND** it SHALL apply the caller-requested `limit` AFTER dedup+merge so hybrid never returns fewer hits than requested purely because of cross-source overlap
- **AND** it SHALL emit `has_more: true` when the merged-and-deduped list exceeded the limit, and `has_more: false` otherwise; v1 hybrid `has_more` is informational only since the response envelope does not carry `next_cursor`
