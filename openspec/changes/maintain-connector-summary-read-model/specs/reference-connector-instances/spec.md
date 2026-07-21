## ADDED Requirements

### Requirement: Connector summary evidence SHALL be maintained as a read model

The reference implementation SHALL maintain durable connector-summary evidence in a read model rather than recomputing every durable evidence input through a per-connection fan-out on each full-list read. The read model SHALL support SQLite and Postgres with equivalent schema, dirty marking, lazy reconciliation, and full rebuild or repair.

#### Scenario: Full connector list reads maintained evidence

- **WHEN** the owner console reads the full `/_ref/connectors` list
- **THEN** the reference SHALL read maintained connector-summary evidence through a bounded number of indexed storage reads
- **AND** it SHALL NOT issue the deep per-connection evidence fan-out for every connection in the steady state.

#### Scenario: Record ingest updates summary evidence

- **WHEN** a connector ingests records that change retained count or stream evidence
- **THEN** the reference SHALL mark the affected connector-summary evidence dirty or apply an equivalent maintained update
- **AND** a later summary read SHALL observe the new evidence without waiting for a wall-clock cache to expire.

### Requirement: Time-relative connector verdicts SHALL be synthesized on read

The reference implementation SHALL synthesize connector freshness, connection health, rendered verdict, and next action from maintained evidence at read time using the current observation time and runtime liveness. It SHALL NOT persist a full rendered connector verdict as the source of truth for owner-facing health.

#### Scenario: Freshness threshold changes without a write

- **WHEN** a connection's durable evidence is unchanged but the current observation time crosses a freshness threshold
- **THEN** the next connector-summary read SHALL project the new freshness and verdict state
- **AND** the projection SHALL NOT require a persisted summary rewrite or cache expiry to become honest.

#### Scenario: Scoped detail keeps deep diagnostics

- **WHEN** an owner reads an exact scoped connection detail or diagnostics surface
- **THEN** the reference SHALL expose the deep run evidence and diagnostics for that exact connection
- **AND** it SHALL NOT fall back to the shallow full-list overview projection.
