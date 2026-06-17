## ADDED Requirements

### Requirement: Store-Parity Spine Source Run Summary Index

The reference implementation SHALL provision equivalent SQLite and Postgres `spine_events` index coverage for source-filtered run-summary aggregation.

#### Scenario: Fresh stores provision equivalent summary coverage

**WHEN** a fresh SQLite or Postgres reference store is initialized
**THEN** the store SHALL include a source/run summary index over `source_kind`, `source_id`, `run_id`, and descending `occurred_at`
**AND** the index SHALL exclude rows without `run_id`.

#### Scenario: Existing stores converge without result changes

**WHEN** an existing SQLite or Postgres reference store runs schema initialization again
**THEN** the store SHALL create the source/run summary index if it is missing
**AND** the migration SHALL NOT rewrite `spine_events` rows or change query results.
