## ADDED Requirements

### Requirement: Remaining reference routes SHALL be operation-owned

The reference implementation SHALL serve the remaining inline AS, RS, and `_ref`
route semantics through canonical operation modules or explicit
capability-shaped operation helpers that are independent of the HTTP framework,
sandbox UI, concrete database driver, and process environment.

#### Scenario: Final route adapter boundary

- **WHEN** a covered route is mounted in `reference-implementation/server/index.js`
- **THEN** route-specific code SHALL be limited to HTTP wiring, authentication or
  owner-session checks, request/header adaptation, request id and trace id setup,
  instrumentation dispatch, response writing, and concrete capability wiring
- **AND** protocol/business/storage-shaped semantics SHALL live in the canonical
  operation for that route family

#### Scenario: Operation dependency boundary

- **WHEN** a new operation module is implemented for this change
- **THEN** it SHALL depend on explicit capability-shaped dependencies
- **AND** it SHALL NOT import Fastify, Next, sandbox modules,
  `reference-implementation/server/index.js`, raw SQL handles, concrete database
  drivers, generic repository abstractions, or `process` / `process.env`

#### Scenario: Public behavior preservation

- **WHEN** a route family is migrated to operations under this change
- **THEN** existing public response envelopes, auth gates, error codes, status
  codes, trace/request id behavior, and audit/disclosure event semantics SHALL
  remain equivalent to the previous native route behavior

#### Scenario: Storage-sensitive migrations

- **WHEN** blob, record mutation, ingest, consent, token, or device-code behavior
  is migrated to operations under this change
- **THEN** the migration SHALL preserve existing atomicity, visibility,
  redaction, and secrecy guarantees
- **AND** those guarantees SHALL be pinned by focused tests before merge
