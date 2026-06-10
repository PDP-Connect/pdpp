## ADDED Requirements

### Requirement: Reference Schedule Read Operations

The reference implementation SHALL expose owner-only schedule reads through canonical operation modules before host route adapters shape HTTP responses.

#### Scenario: Schedule list operation preserves route behavior

**WHEN** the `/_ref/schedules` route serves an owner-authenticated request
**THEN** it SHALL delegate schedule list response shaping to a boundary-checked operation module
**AND** SHALL preserve the existing `{object: "list", data}` response contract.

#### Scenario: Connector schedule operation preserves success projection

**WHEN** the `/_ref/connectors/:connectorId/schedule` route serves an owner-authenticated request and a schedule exists for the connector
**THEN** it SHALL delegate schedule projection to a boundary-checked operation module
**AND** SHALL return the existing `schedule` response body unchanged.

#### Scenario: Connector schedule operation preserves not-found envelope

**WHEN** the `/_ref/connectors/:connectorId/schedule` route serves an owner-authenticated request and no schedule exists for the connector
**THEN** the operation module SHALL surface a typed not-found condition
**AND** the host adapter SHALL respond with the existing PDPP 404 `not_found` error envelope.

#### Scenario: Schedule operations do not import host or storage internals

**WHEN** the operation-boundary gate inspects `operations/ref-schedules-list/` and `operations/ref-connector-schedule-get/`
**THEN** neither module SHALL import Fastify, Next, SQLite, Postgres, the runtime controller, the scheduler store, the server auth module, or `process` / `process.env`.
