## MODIFIED Requirements

### Requirement: Connection delete SHALL be safe, typed, and non-resurrecting

Connection delete SHALL execute as a single all-or-nothing transaction, SHALL refuse to run while a collection run is active for the connection, SHALL return typed results for idempotent, unknown, foreign-owner, and ambiguous cases, and SHALL NOT allow a deleted connection's identity to silently re-materialize as an active connection through ANY subsequent write path — default-account materialization, device-exporter re-enrollment, or any other caller that upserts a connector instance. The delete cascade SHALL durably record the deleted identity (`owner_subject_id`, `connector_id`, `source_kind`, `source_binding_key`) in the SAME transaction that removes the `connector_instances` row, so the record of deletion survives a process restart and is not lost when the row itself is erased. A write path that would otherwise materialize a NEW row for a tombstoned identity SHALL fail closed with a typed error instead of silently succeeding; restoring collection for that identity SHALL require an explicit, distinctly-identified re-enrollment (a new binding), never an implicit reactivation of the deleted identity.

#### Scenario: Delete is transactional

- **WHEN** a failure occurs partway through the delete cascade, whether during the record-family purge OR during the schedule / device-back-ref / `connector_instances`-row cleanup after the record-family purge has already executed
- **THEN** the reference SHALL roll back the entire durable cascade as one transaction
- **AND** the connection and all of its data SHALL remain present, with no partially-erased state — in particular a failure after the record-family purge has run SHALL still leave the connection's records present
- **AND** no tombstone record SHALL be written for the identity if the cascade rolls back

#### Scenario: Delete refuses while a run is active

- **WHEN** the owner attempts to delete a connection that currently holds an active-run lease
- **THEN** the reference SHALL refuse with a typed run-active error
- **AND** it SHALL NOT erase any of the connection's data while the run is in flight

#### Scenario: Repeat delete and unknown connection are typed

- **WHEN** the owner deletes a connection and then issues the same delete again, or deletes a `connector_instance_id` that does not exist
- **THEN** the second or unknown delete SHALL return a typed not-found result rather than crashing or reporting a false success

#### Scenario: Foreign-owner connection is not deletable

- **WHEN** a delete targets a `connector_instance_id` owned by a different subject
- **THEN** the reference SHALL resolve ownership before any erasure and return a typed not-found result
- **AND** it SHALL NOT erase data belonging to another owner, and SHALL NOT leak whether the connection exists

#### Scenario: Deleted default-account connection does not re-materialize

- **WHEN** the owner deletes a default-account connection and a subsequent owner read or resolution would normally materialize a default-account connection for that connector type
- **THEN** the reference SHALL NOT silently re-create the deleted connection as an active connection
- **AND** restoring collection for that connector type SHALL require an explicit owner re-initiate, not implicit re-materialization

#### Scenario: A deleted device-collected connection is not resurrected by re-enrollment under the same binding

- **GIVEN** a `local_device` or `browser_collector` connection was owner-deleted (its `connector_instances` row removed and a tombstone recorded for its identity)
- **WHEN** a device-exporter enrollment (or any other store `upsert` call) later targets the EXACT SAME identity — the same owner, connector, source kind, and `local_binding_name`-derived binding key, whether from the same physical device, a reinstalled device, or a different device paired under the same logical binding name
- **THEN** the reference SHALL NOT materialize a new active row on the deleted connection's identity
- **AND** the store SHALL raise a typed `connection_tombstoned` error instead of silently succeeding
- **AND** the caller (the device-exporter enroll route) SHALL surface this as a typed 409 directing the operator to re-enroll under a distinct binding, not as an enrollment success

#### Scenario: A tombstoned identity's record survives a process restart

- **GIVEN** a connection was owner-deleted (tombstone recorded, row removed) before the reference process restarts
- **WHEN** the reference process restarts against the same durable store (SQLite file or Postgres database) with no data loss
- **AND** a later write path attempts to upsert the SAME identity
- **THEN** the tombstone SHALL still be present and SHALL still block silent resurrection
- **AND** no boot-time reconciliation, manifest registration, or scheduled sweep SHALL consult, clear, or bypass the tombstone

#### Scenario: A distinct new binding is unaffected by an unrelated tombstone

- **WHEN** the owner deletes one device-collected connection (binding key A) and later enrolls a genuinely new binding (binding key B, e.g. a different `local_binding_name`) for the same owner and connector
- **THEN** the new enrollment SHALL succeed normally as a new connection with its own `connector_instance_id`
- **AND** the tombstone for binding key A SHALL NOT affect binding key B in any way
