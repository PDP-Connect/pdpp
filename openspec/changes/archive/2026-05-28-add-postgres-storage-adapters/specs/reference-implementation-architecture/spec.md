## ADDED Requirements

### Requirement: Postgres storage proofs SHALL stay capability-scoped

The reference implementation SHALL introduce Postgres storage support in no
more than two implementation slices: first capability-scoped low-risk storage
proofs, then records/search runtime storage. The low-risk storage proof slice
SHALL cover only storage capability families with executable conformance
harnesses and SHALL NOT migrate records, blobs, disclosure spine, lexical
retrieval, semantic retrieval, hybrid retrieval, or default runtime storage.

#### Scenario: Low-risk storage proof

- **WHEN** a Postgres adapter is added for connector state, scheduler, consent,
  or owner-device-auth storage
- **THEN** the adapter SHALL pass the same conformance harness used by the
  SQLite baseline or a memory adapter
- **AND** the conformance harness SHALL remain falsifiable through a deliberately
  broken driver or equivalent negative proof

#### Scenario: Runtime default remains SQLite

- **WHEN** the low-risk Postgres storage proof is present in the repository
- **THEN** SQLite SHALL remain the default reference runtime backend
- **AND** Postgres execution SHALL require explicit environment configuration
- **AND** default tests SHALL NOT require a running Postgres service

#### Scenario: Records and search are deferred to the second slice

- **WHEN** implementing this low-risk storage proof slice
- **THEN** records, blobs, disclosure spine, lexical retrieval, semantic
  retrieval, hybrid retrieval, cursor semantics, version allocation, and
  record-change semantics SHALL remain out of scope
- **AND** any attempt to migrate those surfaces SHALL require the second and
  final Postgres slice with its own records/search evidence

#### Scenario: Operations remain storage-driver agnostic

- **WHEN** an operation consumes a storage-backed capability covered by this
  slice
- **THEN** the operation SHALL depend on the explicit capability contract rather
  than importing SQLite, Postgres, `pg`, concrete store modules, process
  environment, or test-only drivers
