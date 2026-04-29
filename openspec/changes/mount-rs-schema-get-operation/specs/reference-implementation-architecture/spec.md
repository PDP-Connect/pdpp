## ADDED Requirements

### Requirement: `rs.schema.get` SHALL be operation-owned

The reference implementation SHALL serve schema-discovery behavior through a canonical `rs.schema.get` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, and process environment.

#### Scenario: Native schema route

- **WHEN** the native reference server handles `GET /v1/schema`
- **THEN** it SHALL execute the canonical `rs.schema.get` operation for schema-discovery semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, response writing, environment dependency wiring, and reference instrumentation

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.schema.get` operation is implemented
- **THEN** it SHALL depend on capability-shaped manifest/schema/freshness dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, or `process.env`

#### Scenario: Existing native disclosure behavior is preserved

- **WHEN** the native `GET /v1/schema` route is migrated to the operation
- **THEN** existing request id, trace id, query-received, and disclosure-served behavior SHALL remain equivalent to the previous native route behavior
- **AND** the migration SHALL include regression evidence for bearer projection, connector count, stream count, and source descriptor behavior
