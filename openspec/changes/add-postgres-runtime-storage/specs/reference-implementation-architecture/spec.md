## ADDED Requirements

### Requirement: Runtime Postgres storage SHALL be explicit and default-safe

The reference implementation SHALL keep SQLite as the default runtime storage
backend and SHALL only use Postgres storage when explicitly configured.

#### Scenario: Default runtime remains SQLite

- **WHEN** the reference runtime starts without `PDPP_STORAGE_BACKEND`
- **THEN** it SHALL use the existing SQLite-backed storage path
- **AND** it SHALL NOT require `PDPP_DATABASE_URL`
- **AND** existing SQLite tests SHALL continue to pass without Postgres.

#### Scenario: Postgres runtime requires an explicit database URL

- **WHEN** `PDPP_STORAGE_BACKEND=postgres` is configured without
  `PDPP_DATABASE_URL`
- **THEN** startup SHALL fail fast with a configuration error
- **AND** it SHALL NOT silently fall back to SQLite.

#### Scenario: Postgres runtime uses runtime dependency scope

- **WHEN** Postgres runtime storage is enabled
- **THEN** the reference runtime SHALL be able to import and use `pg` from
  runtime dependency scope
- **AND** test-only Postgres proof drivers SHALL remain env-gated.

### Requirement: Postgres runtime storage SHALL cover records, blobs, spine, and retrieval

The Postgres runtime backend SHALL provide backing storage for live records,
record changes, blob rows and bindings, disclosure spine events, lexical
retrieval state, semantic retrieval state, and hybrid search composition inputs.

#### Scenario: Record and blob APIs preserve public behavior

- **WHEN** records and blobs are ingested, read, listed, deleted, and expanded
  while `PDPP_STORAGE_BACKEND=postgres`
- **THEN** public response envelopes, error codes, blob-reference decoration,
  pagination cursors, and grant filtering SHALL match the SQLite-backed
  behavior for the same fixtures.

#### Scenario: Disclosure spine APIs preserve public behavior

- **WHEN** disclosure events are emitted and read while
  `PDPP_STORAGE_BACKEND=postgres`
- **THEN** event ids, event sequence pagination, correlation summaries, trace
  timelines, run timelines, and public redaction semantics SHALL match the
  SQLite-backed behavior for the same fixtures.

#### Scenario: Search APIs preserve public behavior

- **WHEN** lexical, semantic, or hybrid search is executed while
  `PDPP_STORAGE_BACKEND=postgres`
- **THEN** the returned records SHALL be grant-safe
- **AND** response envelopes and pagination semantics SHALL match the existing
  public search contracts
- **AND** scoring implementation details MAY differ only where the public
  contract does not require exact score equality.

### Requirement: Postgres runtime writes SHALL preserve durable ordering guarantees

The Postgres runtime backend SHALL preserve the durable write ordering,
transactionality, and post-commit index-maintenance boundaries currently
required for record mutations and disclosure spine events.

#### Scenario: Record mutation transaction remains atomic

- **WHEN** concurrent writers mutate the same `(connector_id, stream)` in
  Postgres mode
- **THEN** per-stream versions SHALL be unique and monotonically increasing
- **AND** live-record updates and `record_changes` appends SHALL commit or roll
  back together
- **AND** lexical and semantic index maintenance SHALL occur after the durable
  record transaction.

#### Scenario: Spine event sequence remains stable

- **WHEN** disclosure events are emitted in Postgres mode
- **THEN** each event SHALL receive a stable monotonic `event_seq`
- **AND** timeline pagination SHALL use that logical sequence rather than a
  backend-specific physical row identifier.

### Requirement: Postgres runtime validation SHALL be evidence-backed

The Postgres runtime backend SHALL be validated through env-gated tests that run
against a real Postgres service and through SQLite default tests that prove the
default runtime remains unchanged.

#### Scenario: Postgres-gated runtime tests execute against the Compose service

- **WHEN** `PDPP_TEST_POSTGRES_URL` is set to the profile-gated Compose
  Postgres service
- **THEN** Postgres runtime storage tests SHALL exercise records, blobs,
  disclosure spine, lexical search, semantic search, and hybrid search behavior
- **AND** those tests SHALL fail on semantic drift rather than only checking
  successful connection.

#### Scenario: SQLite default tests still pass without Postgres

- **WHEN** `PDPP_TEST_POSTGRES_URL` is unset
- **THEN** Postgres-specific tests SHALL skip or remain unregistered by explicit
  env gate
- **AND** the existing SQLite-backed test suite SHALL continue to pass.
