## ADDED Requirements

### Requirement: `rs.search.semantic` SHALL be operation-owned

The reference implementation SHALL serve public semantic search behavior through a canonical `rs.search.semantic` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, embedding-backend implementation, vector-index implementation, the native `server/search-semantic.js` helper module, and process environment.

#### Scenario: Native semantic search route

- **WHEN** the native reference server handles `GET /v1/search/semantic`
- **THEN** it SHALL execute the canonical `rs.search.semantic` operation for public semantic-search semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, query/disclosure instrumentation, response writing, and capability dependency wiring

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.search.semantic` operation is implemented
- **THEN** it SHALL depend on capability-shaped advertisement, current-backend-identity, manifest, grant, plan-compilation, snapshot-build, snapshot-storage, result-hydration, and record-url-formatting dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox modules, the native `server/search.js` helper module, the native `server/search-semantic.js` helper module, or `process` / `process.env`

#### Scenario: Existing public semantic search semantics are preserved on the native route

- **WHEN** the native `GET /v1/search/semantic` route is migrated to the operation
- **THEN** the public JSON response shape, error codes, cursor format (including the `sem1.` prefix and stale-cursor backend-identity rejection), scoring metadata (`score.kind: "semantic_distance"`, `score.order: "lower_is_better"`, `score.value_semantics: "distance"`, `score.comparable_with` carrying backend identity), per-hit `retrieval_mode: "semantic"`, grant filtering behavior, stream/filter query semantics, backend/profile/model identity disclosure, and `disclosure.served` event shape (`query_shape: "search_semantic"`) SHALL remain equivalent to the previous native route behavior
- **AND** the migration SHALL NOT broaden, narrow, or otherwise change the v1 query-parameter allowlist (`q`, `limit`, `cursor`, `streams`, `streams[]`, `filter`)
- **AND** the migration SHALL NOT change the explicit forbidden-parameter list (`vector`, `embedding`, `embed`, `model`, `model_id`, `model_family`, `rank`, `boost`, `weights`, `blend`, `connector_id`, `fields`, `expand`, `expand[]`, `expand_limit`, `expand_limit[]`, `order`, `sort`, `mode`)
- **AND** the migration SHALL NOT change the score-advertisement gate, the cross-stream advertisement gate, the `filter[...]` requires-exactly-one-`streams[]` rule, or the snippet grant-safety property (snippet text is a verbatim contiguous substring of the matched field's stored value)

#### Scenario: No-silent-fallback invariant continues to hold

- **WHEN** the operation module and the native `server/search-semantic.js` helper are read as source
- **THEN** neither SHALL statically import the native lexical helper module `server/search.js`
- **AND** the operation module SHALL NOT statically import `server/search-semantic.js` either, so the operation cannot become a back door around the no-fallback invariant
