## ADDED Requirements

### Requirement: `rs.records.list` SHALL be operation-owned

The reference implementation SHALL serve record-list behavior through a canonical `rs.records.list` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, and process environment.

#### Scenario: Native record list route

- **WHEN** the native reference server handles `GET /v1/streams/:stream/records`
- **THEN** it SHALL execute the canonical `rs.records.list` operation for record-list semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, query/disclosure instrumentation, response writing, and capability dependency wiring

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.records.list` operation is implemented
- **THEN** it SHALL depend on capability-shaped manifest, grant, source-descriptor, record-query, and record-decoration dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox modules, or `process` / `process.env`

#### Scenario: Existing record-read semantics are preserved

- **WHEN** the native `GET /v1/streams/:stream/records` route is migrated to the operation
- **THEN** existing cursor, `changes_since`, projection, range filter, view, `expand[]`, blob-ref decoration, request id, trace id, query-received, and disclosure-served behavior SHALL remain equivalent to the previous native route behavior
- **AND** the migration SHALL NOT change the public JSON shape of the route response

### Requirement: `rs.records.get` SHALL be operation-owned

The reference implementation SHALL serve single-record-read behavior through a canonical `rs.records.get` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, and process environment.

#### Scenario: Native record detail route

- **WHEN** the native reference server handles `GET /v1/streams/:stream/records/:id`
- **THEN** it SHALL execute the canonical `rs.records.get` operation for single-record semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, query/disclosure instrumentation, response writing, and capability dependency wiring

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.records.get` operation is implemented
- **THEN** it SHALL depend on capability-shaped manifest, grant, source-descriptor, record-fetch, and record-decoration dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox modules, or `process` / `process.env`

#### Scenario: Existing single-record-read semantics are preserved

- **WHEN** the native `GET /v1/streams/:stream/records/:id` route is migrated to the operation
- **THEN** existing `expand[]`, `expand_limit`, blob-ref decoration, request id, trace id, query-received, and disclosure-served behavior SHALL remain equivalent to the previous native route behavior
- **AND** the migration SHALL NOT change the public JSON shape of the route response
