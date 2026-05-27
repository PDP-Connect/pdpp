## ADDED Requirements

### Requirement: `rs.connectors.list` SHALL be operation-owned

The reference implementation SHALL serve bearer-scoped connector-discovery list behavior through a canonical `rs.connectors.list` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, and process environment.

#### Scenario: Native connector list route

- **WHEN** the native reference server handles `GET /v1/connectors`
- **THEN** it SHALL execute the canonical `rs.connectors.list` operation for connector-list semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, manifest/grant resolution, query/disclosure instrumentation, response writing, and capability dependency wiring

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.connectors.list` operation is implemented
- **THEN** it SHALL depend on capability-shaped source-descriptor and connector-item-list dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox modules, the Fastify host module (`server/index.js`), the records module (`server/records.js`), or `process` / `process.env`

#### Scenario: Existing connector-list semantics are preserved

- **WHEN** the native `GET /v1/connectors` route is migrated to the operation
- **THEN** the public response envelope SHALL remain `{object: 'list', data: [...connector items]}` with byte-equivalent items
- **AND** the `query.received` data block SHALL retain `query_shape: 'connector_list'`
- **AND** the `disclosure.served` data block SHALL retain `query_shape: 'connector_list'` together with `connector_count` and `stream_count` totals computed from the operation result
- **AND** request id, trace id, and source-descriptor selection SHALL remain equivalent to the previous native route behavior

### Requirement: `rs.streams.aggregate` SHALL be operation-owned

The reference implementation SHALL serve stream-aggregate behavior through a canonical `rs.streams.aggregate` operation implementation that is independent of HTTP framework, sandbox UI, concrete database driver, and process environment.

#### Scenario: Native stream aggregate route

- **WHEN** the native reference server handles `GET /v1/streams/:stream/aggregate`
- **THEN** it SHALL execute the canonical `rs.streams.aggregate` operation for aggregate semantics
- **AND** route-specific code SHALL be limited to authentication, request/header adaptation, manifest/grant/storage-binding resolution, query/disclosure instrumentation, response writing, and capability dependency wiring

#### Scenario: Operation dependency boundary

- **WHEN** the `rs.streams.aggregate` operation is implemented
- **THEN** it SHALL depend on capability-shaped source-descriptor, request-validator, and aggregate-execution dependencies
- **AND** it SHALL NOT import Fastify, Next, SQLite, Postgres, a raw SQL handle, a generic repository, sandbox modules, the Fastify host module (`server/index.js`), the records module (`server/records.js`), or `process` / `process.env`

#### Scenario: Existing aggregate semantics are preserved

- **WHEN** the native `GET /v1/streams/:stream/aggregate` route is migrated to the operation
- **THEN** the public response SHALL remain byte-equivalent to the result of the previous native `aggregateRecords` call
- **AND** the `query.received` data block SHALL retain `query_shape: 'stream_aggregate'` together with the previously emitted `metric`, `field`, `group_by`, and `limit` fields parsed from the request query
- **AND** the `disclosure.served` data block SHALL retain `query_shape: 'stream_aggregate'` together with `metric`, `field`, `group_by`, `filtered_record_count`, and `group_count` derived from the aggregate result
- **AND** the owner-branch manifest-stream-not-found check SHALL continue to map to a `not_found` error
- **AND** the request validator (`validateRequestedQueryFieldParams`) SHALL continue to run before the aggregate executes
- **AND** request id, trace id, and source-descriptor selection SHALL remain equivalent to the previous native route behavior
