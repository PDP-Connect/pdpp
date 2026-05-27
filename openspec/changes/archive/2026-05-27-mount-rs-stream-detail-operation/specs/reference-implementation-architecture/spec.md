## ADDED Requirements

### Requirement: `rs.streams.detail` SHALL be operation-owned

The reference implementation SHALL serve stream metadata/detail behavior through a canonical `rs.streams.detail` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, and process environment.

#### Scenario: Native stream detail route

- **WHEN** the native reference server handles `GET /v1/streams/:stream`
- **THEN** it SHALL execute the canonical `rs.streams.detail` operation for stream metadata semantics
- **AND** route-specific code SHALL be limited to authentication, path/query adaptation, response writing, and reference instrumentation

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.streams.detail` operation is implemented
- **THEN** it SHALL depend on capability-shaped manifest, stream-summary, grant-visibility, and metadata dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, or `process.env`

#### Scenario: Existing disclosure behavior is preserved

- **WHEN** the native `GET /v1/streams/:stream` route is migrated to the operation
- **THEN** existing request id, trace id, query-received, query-rejected, and disclosure-served behavior SHALL remain equivalent to the previous native route behavior
- **AND** any intentional difference SHALL be documented in the change design before implementation is accepted
