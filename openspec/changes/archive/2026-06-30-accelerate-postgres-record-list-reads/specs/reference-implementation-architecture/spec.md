## ADDED Requirements

### Requirement: Postgres record-list reads use maintained read models when available

The Postgres-backed reference record-list path SHALL preserve the public
record-list contract while avoiding per-request full-stream work when an
equivalent maintained read model exists.

#### Scenario: A stream declares a cursor field

- **WHEN** a Postgres-backed record-list request reads a stream with a
  manifest-declared cursor field
- **THEN** the reference SHALL order and paginate records from the maintained
  stored sort-position columns
- **AND** new record ingests SHALL populate those stored sort-position columns
  from the connector manifest
- **AND** manifest registration or refresh SHALL provide an idempotent repair
  path for existing rows whose stored cursor value is missing while the JSON
  payload contains the declared cursor field

#### Scenario: A full-stream count has a clean projection

- **WHEN** a Postgres-backed record-list request asks for `count:"exact"` or
  `count:"estimated"` for the full visible stream without request filters,
  resource scope, or time-range narrowing
- **AND** the retained-size stream projection for the connection and stream is
  present and clean
- **THEN** the reference MAY satisfy the count from that projection
- **AND** the response SHALL still report `meta.count.kind` as `exact`

#### Scenario: A count request is narrowed or the projection is not clean

- **WHEN** a Postgres-backed record-list request asks for a count with request
  filters, resource scope, or time-range narrowing
- **OR** the retained-size stream projection is missing or dirty
- **THEN** the reference SHALL fall back to the canonical SQL count for the
  effective visible set
