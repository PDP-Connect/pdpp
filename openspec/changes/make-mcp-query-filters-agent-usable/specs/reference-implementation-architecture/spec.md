## ADDED Requirements

### Requirement: Reference Lexical Backfill Uses Active Storage And Connections

The reference implementation SHALL compute lexical index drift against the active
record storage backend and rebuild lexical index rows in that same backend. When
a connector manifest is registered without a pinned connector instance, lexical
backfill SHALL evaluate active owner-visible connector instances for that
connector rather than only the connector's default synthetic instance. Drift
detection SHALL compare the index row count to the exact number of non-empty
declared text values for each `(connector_instance_id, stream)` and SHALL NOT
treat an arbitrary non-zero in-band index count as complete.

#### Scenario: Postgres backfill reads and writes Postgres

- **WHEN** the reference server runs with Postgres-backed record storage
- **THEN** lexical backfill SHALL read records, index rows, and meta fingerprints
  from Postgres
- **AND** rebuilt lexical rows SHALL be written to Postgres

#### Scenario: Unpinned manifest covers active connections

- **WHEN** a registered connector manifest declares searchable fields but is not
  pinned to a single connector instance
- **AND** the owner has an active connection for that connector
- **THEN** lexical backfill SHALL check and rebuild the active connection's
  `(connector_instance_id, stream)` index state
- **AND** it SHALL NOT limit the check to the default synthetic connector
  instance

#### Scenario: Partial historical index is rebuilt

- **WHEN** a stream has more indexable declared text values than lexical index
  rows for the same `(connector_instance_id, stream)`
- **THEN** lexical backfill SHALL treat the stream as stale or partial and
  rebuild it
- **AND** it SHALL NOT accept the partial index merely because at least one index
  row exists
