## MODIFIED Requirements

### Requirement: Connection summaries SHALL prefer exact run identity over connector fallback

When projecting a connection's latest run and collection facts, the reference implementation SHALL prefer run-summary evidence whose `connection_id` or `connector_instance_id` matches the connection. It SHALL use connector-wide run-summary fallback only when exactly one active visible connection exists for the connector and no exact connection identity is available.

#### Scenario: Two same-connector accounts run independently

- **WHEN** an owner has two active connections for the same connector
- **AND** a manual run completes for one connection
- **THEN** the summary for that connection SHALL use the completed run's status and collection facts
- **AND** the sibling connection SHALL NOT borrow that run as its latest evidence.

#### Scenario: Legacy singleton connector-wide evidence remains usable

- **WHEN** an owner has exactly one active visible connection for a connector
- **AND** the latest run summary has only connector-wide source evidence
- **THEN** the reference MAY use that run as the connection's latest run evidence.
