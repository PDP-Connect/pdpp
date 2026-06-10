## ADDED Requirements

### Requirement: `rs.search.lexical` SHALL be operation-owned

The reference implementation SHALL serve public lexical search behavior through a canonical `rs.search.lexical` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, lexical-index implementation, and process environment.

#### Scenario: Native lexical search route

- **WHEN** the native reference server handles `GET /v1/search`
- **THEN** it SHALL execute the canonical `rs.search.lexical` operation for public lexical-search semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, query/disclosure instrumentation, response writing, and capability dependency wiring

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.search.lexical` operation is implemented
- **THEN** it SHALL depend on capability-shaped advertisement, manifest, grant, plan-compilation, snapshot-build, snapshot-storage, and record-url-formatting dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox modules, the native `server/search.js` helper module, or `process` / `process.env`

#### Scenario: Existing public lexical search semantics are preserved on the native route

- **WHEN** the native `GET /v1/search` route is migrated to the operation
- **THEN** the public JSON response shape, error codes, cursor format, scoring metadata, grant filtering behavior, stream/filter query semantics, and `disclosure.served` event shape SHALL remain equivalent to the previous native route behavior
- **AND** the migration SHALL NOT broaden, narrow, or otherwise change the v1 query-parameter allowlist (`q`, `limit`, `cursor`, `streams`, `streams[]`, `filter`)
- **AND** the migration SHALL NOT change the score-advertisement gate, the cross-stream advertisement gate, or the `filter[...]` requires-exactly-one-`streams[]` rule
