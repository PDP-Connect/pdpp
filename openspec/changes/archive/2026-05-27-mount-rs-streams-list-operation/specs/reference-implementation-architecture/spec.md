## ADDED Requirements

### Requirement: `rs.streams.list` SHALL be operation-owned

The reference implementation SHALL serve stream-list behavior through a canonical `rs.streams.list` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, and process environment.

#### Scenario: Native stream list route

- **WHEN** the native reference server handles `GET /v1/streams`
- **THEN** it SHALL execute the canonical `rs.streams.list` operation for stream-list semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, response writing, and reference instrumentation

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.streams.list` operation is implemented
- **THEN** it SHALL depend on capability-shaped stream/manifest/grant dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, or `process.env`

#### Scenario: Existing disclosure behavior is preserved

- **WHEN** the native `GET /v1/streams` route is migrated to the operation
- **THEN** existing request id, trace id, query-received, and disclosure-served behavior SHALL remain equivalent to the previous native route behavior
- **AND** the migration SHALL include regression evidence for that preservation or an explicit owner-reviewed explanation if a specific event is intentionally unchanged outside the operation
