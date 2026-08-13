## ADDED Requirements

### Requirement: Connection-scoped record ingest SHALL be admitted inside its durable transaction

When a reference record-ingest caller opts into connector-instance admission,
the reference implementation SHALL read the addressed connector instance in
the same durable transaction as the record mutation. It SHALL refuse a missing
instance and SHALL refuse a revoked instance. This reference-only admission
rule SHALL NOT change connector-agnostic direct callers that do not opt in.
The owner NDJSON batch route SHALL report either refusal through its existing
HTTP 200 per-line rejection envelope; it SHALL NOT add a new top-level HTTP
error-status mapping for those line failures.

#### Scenario: A connection is deleted before an admitted record write

- **WHEN** a connection delete commits before an opted-in record write begins
- **THEN** the reference SHALL refuse the write as a missing connector instance
- **AND** it SHALL NOT create a record for the deleted connection.

#### Scenario: Revocation races an admitted record write

- **WHEN** a connection revoke commits after an early admission read but before
  the durable record mutation begins
- **THEN** the reference SHALL refuse the write as not writable
- **AND** it SHALL NOT create a record for the revoked connection.

#### Scenario: The owner batch route reports an admitted refusal

- **WHEN** a connection revokes after the owner route resolves it but before
  its opted-in durable record write
- **THEN** the route SHALL return HTTP 200 with the record counted as rejected
- **AND** it SHALL NOT create the record.

#### Scenario: A paused connection is admitted for record ingest

- **WHEN** an opted-in direct record-ingest caller addresses a paused connector
  instance
- **THEN** the reference SHALL admit the record write because paused is a
  scheduler policy rather than a write-admission state.

#### Scenario: A direct storage caller does not opt in

- **WHEN** a direct record-storage caller omits connector-instance admission
- **THEN** the reference SHALL preserve its connector-agnostic ingest behavior.
