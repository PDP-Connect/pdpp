## ADDED Requirements

### Requirement: A reference read SHALL NOT persist a connection

A reference-implementation read operation SHALL NOT create, upsert, or otherwise persist a `connector_instances` row. Default-account connection materialization SHALL be demand-driven by collection ingest or grant/connection resolution that genuinely needs a binding for a specific connector; it SHALL NOT be triggered by a dashboard, catalog, or any owner-facing read that merely enumerates connectors.

#### Scenario: Dashboard read on a fresh instance writes no connection rows

- **WHEN** the owner views the connection dashboard on an instance that has registered public connectors but zero configured connections
- **THEN** the reference SHALL NOT write any `connector_instances` row as a side effect of the read
- **AND** after the read, the owner's set of `connector_instances` rows SHALL remain empty
- **AND** the read SHALL still return the registered connectors as not-connected catalog entries.

#### Scenario: Ingest still materializes a default-account connection on demand

- **WHEN** a collection run ingests at least one record batch for a connector that has no configured connection, or a grant/connection resolution requires a binding for that connector
- **THEN** the reference MAY materialize a single default-account connection for that one connector at that time
- **AND** this on-demand materialization SHALL remain unaffected by the read-time prohibition above.

### Requirement: Catalog connectors SHALL be distinct from connections in owner projections

Owner-facing reference projections SHALL distinguish a catalog connector (a registered `connector_id` the owner can add) from a connection (a configured `connector_instance_id`). A connector that has no connection SHALL be projected as a not-connected catalog entry that carries no `connector_instance_id` and SHALL NOT be presented as an active connection. Connection lifecycle actions — sync, pause, resume, revoke, delete — SHALL target a connection identified by a `connector_instance_id` and SHALL NOT be offered for a catalog connector that has no connection.

#### Scenario: Zero configured connections projects a complete catalog and no connections

- **WHEN** the owner has registered listed connectors and zero configured connections
- **THEN** the owner connection projection SHALL list zero connections
- **AND** it SHALL present the registered listed connectors as not-connected catalog entries with no `connector_instance_id`
- **AND** it SHALL offer an add/initiate action for each catalog connector rather than sync, pause, resume, revoke, or delete.

#### Scenario: A mix of connected and unconnected connectors

- **WHEN** the owner has one configured connection for connector A and no connection for connector B, where both are registered listed connectors
- **THEN** connector A SHALL be projected as a connection with its `connector_instance_id`
- **AND** connector B SHALL be projected as a not-connected catalog entry with no `connector_instance_id`.

### Requirement: Grant resolution SHALL NOT bind to a non-existent connection

Grant and connection resolution SHALL NOT resolve a connector that has no configured connection to a synthesized or phantom binding. When a connector has no connection, resolution SHALL fail closed as "no active connection" rather than returning a fabricated `connector_instance_id`.

#### Scenario: Fan-in resolution for an unconnected connector

- **WHEN** a grant names a connector that has no configured connection and does not pin a specific `connector_instance_id`
- **THEN** resolution SHALL return no active binding for that connector and SHALL read zero records
- **AND** it SHALL NOT bind to a default-account row created by an owner-facing read.
