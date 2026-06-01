# reference-connector-instances Specification

## Purpose
TBD - created by archiving change define-connector-instances. Update Purpose after archive.
## Requirements
### Requirement: Connector instances SHALL be the durable configured-binding identity

The reference implementation SHALL distinguish connector type identity from configured connector instance identity. `connector_id` SHALL identify the connector implementation or manifest. `connector_instance_id` SHALL identify one owner-approved configured binding for that connector type, such as one account authorization or one enrolled-device local binding.

#### Scenario: Two Gmail accounts use the same connector type

- **WHEN** an owner configures two Gmail accounts
- **THEN** both configured bindings MAY share the same `connector_id`
- **AND** each binding SHALL have a distinct `connector_instance_id`
- **AND** runtime state, records, schedules, active-run leases, diagnostics, and owner actions SHALL target the intended connector instance.

#### Scenario: Two devices collect the same local connector

- **WHEN** two enrolled devices collect Claude Code or Codex data for the same owner
- **THEN** both collectors MAY use the same `connector_id`
- **AND** each authorized device/local-binding pair SHALL resolve to a distinct connector instance before collection writes are accepted.

### Requirement: Instance-scoped storage SHALL prevent connector-id collisions

The reference implementation SHALL include connector instance identity in durable namespaces for connector state, checkpoints, records, idempotency keys, schedules, active-run leases, run history, diagnostics, and freshness.

#### Scenario: Connector-local record keys collide across instances

- **WHEN** two connector instances emit records with the same `connector_id`, stream id, and connector-local record key
- **THEN** the reference SHALL preserve both records as distinct instance-scoped records
- **AND** one instance's record SHALL NOT overwrite, tombstone, deduplicate, or advance freshness for the other instance unless an explicit approved cross-instance identity rule applies.

#### Scenario: One instance updates checkpoint state

- **WHEN** a connector run commits checkpoint state for one connector instance
- **THEN** subsequent runs for another instance of the same connector type SHALL NOT read or overwrite that checkpoint state.

### Requirement: Schedules and active-run leases SHALL be instance-scoped

The reference scheduler and controller SHALL treat connector schedules and active-run leases as connector-instance resources rather than connector-type resources.

#### Scenario: One Gmail account is paused

- **WHEN** the owner pauses the schedule for one Gmail connector instance
- **THEN** the reference SHALL stop automatic runs for that instance
- **AND** it SHALL NOT pause or disable schedules for other Gmail connector instances unless the owner explicitly targets them.

#### Scenario: Two instances run concurrently

- **WHEN** two connector instances with the same `connector_id` are eligible to run
- **THEN** an active run for one instance SHALL NOT block the other solely because the connector type matches
- **AND** each instance SHALL still enforce its own active-run lease and retry policy.

### Requirement: Local collector uploads SHALL resolve to authorized connector instances

The reference implementation SHALL require local collector records, state, run events, heartbeats, and diagnostics to resolve to an authorized connector instance before accepting the upload as trusted collection data.

#### Scenario: Collector submits an unregistered local binding

- **WHEN** an enrolled device submits data for a connector/local binding that is not associated with an active connector instance for that device
- **THEN** the reference SHALL reject the upload
- **AND** it SHALL NOT create records, advance checkpoints, or update trusted freshness for that binding.

#### Scenario: Device credential is revoked

- **WHEN** a device credential is revoked
- **THEN** the reference SHALL reject subsequent uploads for connector instances bound to that device credential
- **AND** previously accepted records SHALL remain governed by normal retention and grant/query rules.

### Requirement: Owner UX SHALL expose connector instances without losing connector grouping

Owner-facing reference surfaces SHALL make connector instances visible and actionable while preserving connector type grouping for comprehension.

#### Scenario: Owner inspects connectors

- **WHEN** the owner views connector status, schedules, records, run history, or diagnostics
- **THEN** the UI or reference-only operation SHALL identify the connector type and the specific connector instance
- **AND** actions such as refresh, pause, resume, revoke, and inspect diagnostics SHALL target one instance unless the owner explicitly selects a bulk connector-type action.

#### Scenario: Connector-only operation is ambiguous

- **WHEN** an owner or compatibility caller targets a connector by `connector_id` and more than one matching connector instance exists
- **THEN** the reference SHALL reject the operation with an ambiguity error
- **AND** it SHALL NOT choose an arbitrary instance.

### Requirement: Migration SHALL preserve existing single-instance behavior

Migration from connector-keyed reference state SHALL create connector instances before new multi-account or multi-device writes depend on instance-scoped namespaces.

#### Scenario: Existing deployment has one binding for a connector

- **WHEN** migration runs on an existing owner deployment with one configured binding for a connector type
- **THEN** the migration SHALL create one connector instance for that owner and connector type
- **AND** existing connector state, records, schedules, active-run metadata, run history, diagnostics, and freshness SHALL be associated with that instance.

#### Scenario: Legacy connector-only compatibility is used

- **WHEN** a legacy owner operation identifies a connector only by `connector_id`
- **THEN** the reference MAY route the operation to the sole matching active instance for that owner during a compatibility window
- **AND** it SHALL reject the operation when zero or multiple matching instances exist.

### Requirement: Public protocol posture SHALL remain honest

Connector instance identity SHALL be treated as reference-owned collection/runtime identity unless and until a later accepted PDPP or Collection Profile change promotes it to a public protocol field.

#### Scenario: Client-facing reads return records

- **WHEN** a grant-authorized client reads disclosed records
- **THEN** the reference SHALL NOT expose connector instance metadata beyond the approved public/grant-safe shape
- **AND** owner-facing reference surfaces MAY expose connector instance metadata for operations and diagnostics.

#### Scenario: Profile semantics are proposed later

- **WHEN** a future change proposes connector instance identity as Collection Profile or PDPP vocabulary
- **THEN** that change SHALL define public field names, grant behavior, privacy constraints, and interoperability expectations rather than relying on this reference-only design.

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

### Requirement: Static-secret credentials SHALL be stored encrypted and instance-scoped

The reference implementation SHALL store a static-secret connector credential (such as a Google app password or a GitHub personal access token) as durable state encrypted at rest and keyed to exactly one connection (its `connection_id` / `connector_instance_id`). The credential SHALL be a per-instance resource, a peer of the instance-scoped storage, schedule, and active-run-lease state, and SHALL NOT be process-global or shared across connector instances. The encryption key SHALL be owner- or operator-held and SHALL NOT be an agent-held or client-held key.

#### Scenario: Two mailboxes hold two distinct credentials

- **WHEN** the owner configures two Gmail connections for two different mailboxes
- **THEN** the reference SHALL store each connection's app password keyed to its own `connection_id`
- **AND** one connection's stored credential SHALL NOT be readable by, overwrite, or be used to authenticate the other connection.

#### Scenario: Credential is recoverable only by the orchestrator

- **WHEN** a scheduled run begins for a connection that has a stored static-secret credential
- **THEN** the reference orchestrator SHALL be able to recover the plaintext secret to authenticate to the provider for that one connection
- **AND** recovery SHALL require the owner/operator-held encryption key, not an owner-agent or client bearer.

### Requirement: Static-secret credentials SHALL never be returned by any read surface

The reference implementation SHALL NOT return a stored static-secret credential's plaintext through any REST, MCP, or console read. Reads MAY expose only non-secret credential metadata: which connection has a credential, the credential kind, capture and rotation timestamps, and a validity state.

#### Scenario: Owner agent reads connection state

- **WHEN** a trusted owner agent reads a connection that has a stored static-secret credential
- **THEN** the response MAY indicate that a credential is present, its kind, and its validity state
- **AND** the response SHALL NOT include the app password, personal access token, or any secret bytes.

#### Scenario: Audit evidence records a capture

- **WHEN** the reference records audit evidence for a credential capture or rotation
- **THEN** the evidence SHALL identify the actor, the connection, and the outcome
- **AND** the evidence SHALL NOT include the secret, the owner session cookie, or the bearer token.

### Requirement: Static-secret capture SHALL be owner-mediated and SHALL NOT expose the secret to an agent

The reference implementation SHALL capture a static-secret credential only through an owner-trusted surface — a local collector `credentials` interaction or an owner-session surface — where the owner, not a trusted owner agent, supplies the secret. The owner-agent surface SHALL observe only a typed next step and the resulting `connection_id`, never the secret.

#### Scenario: Owner agent initiates a static-secret connection

- **WHEN** a trusted owner agent initiates a connection for a static-secret connector and the primitive is enabled
- **THEN** the response SHALL return a typed next step directing the owner to complete credential capture through an owner-trusted surface
- **AND** the response SHALL NOT carry the secret, and `connection_active` SHALL remain false until capture and first ingest complete.

#### Scenario: Connection materializes after owner capture and first ingest

- **WHEN** the owner completes credential capture locally and the connector ingests at least one batch for the new connection
- **THEN** the reference SHALL materialize the connection as an addressable, labelable `connection_id`
- **AND** no `connector_instances` row SHALL have been written by the intent before capture and first ingest.

### Requirement: Static-secret credentials SHALL be injected scoped to one connection run

The reference orchestrator SHALL inject a static-secret credential into a connector subprocess scoped to the one connection being run, using the connector's credential input channel, rather than placing the secret in a process-global environment shared across runs.

#### Scenario: Two Gmail connections run with distinct secrets

- **WHEN** two Gmail connections for two mailboxes are eligible to run
- **THEN** each run SHALL receive only its own connection's credential
- **AND** neither run SHALL authenticate using the other connection's secret or a shared process-global secret.

### Requirement: Static-secret credential lifecycle SHALL be distinct from connection lifecycle

The reference implementation SHALL keep credential rotation, credential revocation, connection revocation, and connection deletion as distinct operations. A revoked or deleted credential SHALL NOT implicitly resurrect on a subsequent ingest.

#### Scenario: Owner rotates a credential

- **WHEN** the owner re-captures the static secret for an existing connection
- **THEN** the reference SHALL replace the stored secret and record a rotation timestamp
- **AND** the connection, its `connection_id`, its history, and its schedule SHALL be preserved.

#### Scenario: Owner revokes a credential

- **WHEN** the owner revokes a connection's static-secret credential
- **THEN** the reference SHALL stop future runs for that connection
- **AND** previously collected records SHALL remain governed by normal retention and grant/query rules
- **AND** the connection row SHALL NOT be deleted solely because its credential was revoked.

#### Scenario: Owner deletes a connection

- **WHEN** the owner deletes a connection that has a stored static-secret credential
- **THEN** the reference SHALL delete the stored credential so no orphaned secret survives the connection
- **AND** a later ingest SHALL NOT recreate the credential or the connection without an explicit owner re-capture.

