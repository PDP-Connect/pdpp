# reference-implementation-architecture — pilot-storage-backend-interface delta

## ADDED Requirements

### Requirement: StorageBackend interface backend-agnostic orchestration

Shared orchestration code SHALL invoke a storage operation that has been
migrated to the `StorageBackend` interface through a single typed interface
method, with no `isPostgresStorageBackend()` branch in the orchestration path.
Each backend SHALL provide one adapter that satisfies the interface method,
keeping dialect-specific query logic (placeholder syntax, `deleted` boolean
representation, JSON normalization) inside the adapter rather than in shared
code. A migrated operation SHALL be exercised by a dual-backend conformance
harness that runs the production code path against both the SQLite adapter and a
real Postgres adapter and asserts identical observable results, so that
divergence between the two backends becomes a test failure rather than a
silent production difference.

This requirement is piloted by the `listRowsForAggregation` operation. Migrating
an operation SHALL NOT change its observable behavior on either backend, proven
by the conformance harness passing both before and after the migration.

#### Scenario: Migrated operation dispatches through the interface

- **WHEN** shared orchestration invokes a storage operation that has been
  migrated to the `StorageBackend` interface (the pilot: `listRowsForAggregation`)
- **THEN** it SHALL call a single typed interface method and SHALL NOT branch on
  `isPostgresStorageBackend()` in the orchestration path
- **AND** the active backend's adapter SHALL execute the operation, keeping its
  dialect-specific query inside the adapter

#### Scenario: Both backends conform to identical observable results

- **WHEN** the dual-backend conformance harness seeds the same records and runs
  the migrated operation against the SQLite adapter and against a real Postgres
  adapter
- **THEN** both SHALL return the same observable result shape, and the
  `record_json` field SHALL be a string from both backends (the Postgres adapter
  normalizing any object representation to a string)

#### Scenario: Migration preserves behavior

- **WHEN** the conformance harness is run against the operation's production code
  path before the interface migration and again after it
- **THEN** it SHALL pass in both cases, proving the migration introduced no
  behavior change on either backend
