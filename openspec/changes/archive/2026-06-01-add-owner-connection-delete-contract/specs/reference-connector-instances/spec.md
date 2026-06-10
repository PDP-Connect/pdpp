## ADDED Requirements

### Requirement: Connection delete SHALL erase one connection's data and configuration without affecting siblings

The reference implementation SHALL define a connection-scoped delete operation that removes the configured connection identified by one `connector_instance_id` AND erases the data, history, derived state, blob bindings, and schedule for exactly that connection. The operation SHALL be keyed strictly on the single `connector_instance_id` and SHALL NOT affect any other connection, device, or owner. The operation SHALL NOT erase an in-flight collection run's `controller_active_runs` lease; a connection with an active run SHALL be refused, not deleted. Connection delete SHALL be distinct from connection revoke: revoke stops future collection and preserves previously collected records, whereas delete erases the connection's records.

#### Scenario: Delete erases only the targeted connection's data

- **WHEN** the owner deletes a connection that has collected records across one or more streams, record-change history, blob bindings, and a schedule, and that has no collection run currently in flight
- **THEN** the reference SHALL erase that connection's records, record-change history, version counters, blob bindings, search-index derivatives, attention records, and schedule, all keyed on the connection's `connector_instance_id`
- **AND** the erasure of the records, record-change history, version counters, blob bindings, attention records, schedule, the `device_source_instances` back-reference clear, and the `connector_instances` row removal SHALL commit as one all-or-nothing transaction keyed on that single `connector_instance_id`; the search-index derivatives MAY be torn down as a rebuildable projection after that commit
- **AND** it SHALL remove the connection's configured `connector_instances` row
- **AND** records previously readable for that connection through the grant-scoped read surface SHALL no longer be readable

#### Scenario: Two connections of the same connector type are independent under delete

- **WHEN** the owner has two configured connections for the same `connector_id`, each with collected records, and deletes one
- **THEN** the other connection's configured row, records, schedule, and ability to collect SHALL remain fully intact
- **AND** no records, schedule, or state belonging to the surviving connection SHALL be erased

#### Scenario: Two connections share one device

- **WHEN** two connections on the same enrolled device each have a `device_source_instances` back-reference and the owner deletes one connection
- **THEN** the reference SHALL clear (set null) the deleted connection's `connector_instance_id` back-reference on its `device_source_instances` row without deleting the device edge
- **AND** the sibling connection on the same device SHALL remain intact and collectable
- **AND** the device enrollment itself SHALL NOT be revoked or deleted by the connection delete

### Requirement: Connection delete SHALL preserve audit history and disclosure grants

Connection delete SHALL NOT erase the audit spine or any PDPP disclosure grant. The audit trail of a connection SHALL survive the connection's deletion, and the deletion itself SHALL be recorded as an audit event. Deleting a connection SHALL NOT revoke, narrow, or rewrite any client grant.

#### Scenario: Audit spine survives a delete

- **WHEN** the owner deletes a connection that has prior collection-run and lifecycle audit events
- **THEN** those audit events SHALL remain present after the delete
- **AND** the reference SHALL append a non-secret delete audit event recording the actor kind, target connection identity, operation, outcome, and deletion summary
- **AND** the audit event SHALL NOT contain bearer tokens, provider credentials, or record contents

#### Scenario: Disclosure grants are untouched by connection delete

- **WHEN** the owner deletes a connection for a connector type that has an active disclosure grant
- **THEN** the disclosure grant SHALL remain unchanged in status, scope, and membership
- **AND** the grant SHALL simply read zero records for the deleted connection thereafter, because those records are erased

### Requirement: Connection delete SHALL be safe, typed, and non-resurrecting

Connection delete SHALL execute as a single all-or-nothing transaction, SHALL refuse to run while a collection run is active for the connection, SHALL return typed results for idempotent, unknown, foreign-owner, and ambiguous cases, and SHALL NOT allow a deleted connection to silently re-materialize through default-account materialization.

#### Scenario: Delete is transactional

- **WHEN** a failure occurs partway through the delete cascade, whether during the record-family purge OR during the schedule / device-back-ref / `connector_instances`-row cleanup after the record-family purge has already executed
- **THEN** the reference SHALL roll back the entire durable cascade as one transaction
- **AND** the connection and all of its data SHALL remain present, with no partially-erased state — in particular a failure after the record-family purge has run SHALL still leave the connection's records present

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
