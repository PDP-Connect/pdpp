## ADDED Requirements

### Requirement: PostgreSQL HNSW construction SHALL be optional post-readiness maintenance

The reference implementation SHALL complete required PostgreSQL schema and
semantic representation migrations before listener binding, but SHALL NOT wait
for optional HNSW graph construction. HNSW construction SHALL use one durable,
advisory-locked builder with bounded attempts and retryable persisted state.

#### Scenario: A large semantic corpus is bootstrapped

- **WHEN** required PostgreSQL bootstrap succeeds and HNSW construction would
  take longer than listener startup permits
- **THEN** AS and RS SHALL bind without awaiting HNSW construction
- **AND** semantic reads SHALL remain available without the HNSW index

#### Scenario: A builder is interrupted or fails

- **WHEN** a bounded HNSW attempt is interrupted, times out, or fails
- **THEN** the durable job SHALL retain an observable failure or in-progress
  state
- **AND** a later post-readiness attempt SHALL retry without creating duplicate
  builders or leaving an invalid same-name index as success

#### Scenario: Required bootstrap fails

- **WHEN** a required schema statement or required representation migration
  fails
- **THEN** PostgreSQL initialization SHALL reject and AS/RS SHALL NOT claim
  readiness
