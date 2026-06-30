## ADDED Requirements

### Requirement: Browser-session run stream SHALL label a run with its connection identity when available

The run interaction stream SHALL use the run's connection instance identity when resolving owner-facing subject copy.

#### Scenario: Multiple connections share one connector type

- **WHEN** a run stream has a `connector_id`
- **AND** the run status or timeline identifies a `connector_instance_id` or `connection_id`
- **AND** the owner has multiple connector summaries for that `connector_id`
- **THEN** the stream SHALL choose the summary matching the run's connection identity
- **AND** it SHALL NOT choose the first summary for the connector type alone

#### Scenario: Connection identity is unavailable

- **WHEN** a run stream has only a `connector_id`
- **THEN** the stream MAY fall back to connector-type display copy
