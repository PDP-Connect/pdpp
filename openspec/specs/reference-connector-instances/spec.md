# reference-connector-instances Specification

## Purpose
TBD - created by archiving change define-connector-instances. Update Purpose after archive.
## Requirements
### Requirement: Connector instances SHALL be the durable configured-binding identity

The reference implementation SHALL distinguish connector type identity from configured connector instance identity. `connector_key` SHALL identify the connector implementation type by canonical short key. `manifest_uri` SHALL identify the registry or document URI for the connector manifest when such a URI exists. `connector_instance_id` SHALL remain the technical storage/runtime identity for one owner-approved configured binding for that connector type, such as one account authorization or one enrolled-device local binding.

#### Scenario: Two Gmail accounts use the same connector type

- **WHEN** an owner configures two Gmail accounts
- **THEN** both configured bindings SHALL share the canonical `connector_key` for Gmail
- **AND** each binding SHALL have a distinct `connector_instance_id`
- **AND** runtime state, records, schedules, active-run leases, diagnostics, and owner actions SHALL target the intended connector instance.

#### Scenario: Two devices collect the same local connector

- **WHEN** two enrolled devices collect Claude Code or Codex data for the same owner
- **THEN** both collectors SHALL use the canonical `connector_key` for that connector type
- **AND** each authorized device/local-binding pair SHALL resolve to a distinct connector instance before collection writes are accepted.

#### Scenario: Connector manifest has registry provenance

- **WHEN** a first-party connector manifest is registered
- **THEN** the reference SHALL persist its canonical `connector_key` as the active connector type key
- **AND** it SHALL preserve the manifest registry URI as `manifest_uri` metadata rather than using the URI as the active connector key.

### Requirement: Connector keys SHALL be canonical operational identifiers

The reference implementation SHALL use one canonical operational key for each connector type. Active storage, runtime, grant, consent, local-collector, owner dashboard, and MCP surfaces SHALL NOT require URL-shaped connector ids or stale local alias ids to address a connector type.

#### Scenario: Active surface receives a URL-shaped connector id

- **WHEN** a post-migration owner, client, MCP, local-collector, or runtime request uses a URL-shaped connector id where a connector key is required
- **THEN** the reference SHALL reject the request with a typed error naming `connector_key`
- **AND** it SHALL NOT silently normalize the URL through a long-lived alias.

#### Scenario: Custom connector is registered

- **WHEN** an operator registers a custom connector manifest
- **THEN** the manifest SHALL declare a locally unique `connector_key`
- **AND** any registry/document URL SHALL be stored as `manifest_uri` metadata.

### Requirement: Connector key migration SHALL preserve configured connections

The reference implementation SHALL provide a one-time migration from URL-shaped connector ids and stale local aliases to canonical connector keys without changing the configured connection identity.

#### Scenario: Existing records use a URL-shaped connector id

- **WHEN** migration runs on a deployment with retained records, record history, blobs, search rows, grants, schedules, state, runs, diagnostics, or event subscriptions keyed by a URL-shaped first-party connector id
- **THEN** the migration SHALL rewrite those references to the canonical connector key
- **AND** the corresponding `connector_instance_id`, `connection_id`, record keys, stream names, grant ids, package ids, and audit events SHALL remain stable.

#### Scenario: Stale alias has no retained data

- **WHEN** migration finds a stale alias connector instance with no retained records, no active grant, no schedule, no state, and no active subscription
- **THEN** the migration SHALL remove or quarantine that alias so it is not visible as an owner-selectable connection.

#### Scenario: Alias mapping is ambiguous

- **WHEN** migration cannot map a connector id or alias to one canonical connector key without risking data loss
- **THEN** the migration SHALL stop with an explicit diagnostic
- **AND** it SHALL NOT merge, delete, or rewrite the ambiguous rows automatically.

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

### Requirement: Phantom-connection cleanup SHALL accept a legacy default-account id that proves provenance

The reference implementation's operator phantom-connection cleanup (the owner/operator-only, dry-run-default tool that revokes residual zero-record default-account `connector_instances` rows) SHALL NOT refuse to revoke a row solely because its `connector_instance_id` does not match the current deterministic `makeDefaultAccountConnectorInstanceId(owner, connector_id)` value, provided the row independently proves default-account provenance and carries no real evidence.

A row proves default-account provenance when its `source_kind` is `account`, its `source_binding_key` is `default`, its `source_binding_json` is exactly `{ "kind": "default_account" }`, and its `status` is `active`. A row whose `connector_instance_id` does not match the current deterministic value but that proves this provenance is a legacy default-account materialization (minted under an earlier id formula); the cleanup SHALL treat it as a revoke candidate and SHALL disclose the legacy id as an informational note distinct from a current deterministic id.

The cleanup SHALL continue to refuse a row whose source binding is not the default-account marker (a real owner-created connection), regardless of its id and regardless of whether it carries data. The cleanup SHALL continue to refuse any default-account row — current id or legacy id — that carries records, change history, blobs, derived state, version counters, grant connector state, attention records, detail gaps, a load-bearing grant scope, a schedule, an active run, a device source instance, or a stored credential, in both the dry-run plan and the apply-time re-evaluation, and a missing evidence table SHALL fail closed. The revoke SHALL remain the same `connector_instances` soft-flip, and a revoked legacy row SHALL survive subsequent reads without re-materializing.

#### Scenario: A zero-record legacy default-account row is a revoke candidate

- **WHEN** a connection has the default-account provenance markers and an active status, carries no records and no other instance-scoped evidence, is not scoped by any load-bearing grant, and has a `connector_instance_id` that does not match the current deterministic default-account id
- **THEN** the cleanup SHALL treat the connection as a revoke candidate
- **AND** the dry-run output SHALL disclose the legacy default-account id as an informational note distinct from a current deterministic id
- **AND** applying the cleanup SHALL revoke only that `connector_instances` row
- **AND** a subsequent read SHALL NOT resurrect the revoked row and SHALL NOT materialize a replacement row under the current deterministic id.

#### Scenario: A current deterministic-id candidate carries no legacy-id note

- **WHEN** a zero-record default-account connection whose `connector_instance_id` matches the current deterministic default-account id is a revoke candidate
- **THEN** the cleanup SHALL NOT attach the legacy-default-account-id note to that candidate.

#### Scenario: A non-default binding with a legacy id stays out of scope

- **WHEN** a connection has a `connector_instance_id` that does not match the current deterministic default-account id and a source binding that is not the default-account marker, even with zero records
- **THEN** the cleanup SHALL refuse to revoke the connection on default-account-provenance grounds.

#### Scenario: A legacy default-account row with real evidence is refused

- **WHEN** a connection proves default-account provenance and has a legacy `connector_instance_id` but carries any record, load-bearing grant scope, schedule, active run, device source instance, or stored credential
- **THEN** the cleanup SHALL refuse to revoke the connection
- **AND** the refusal SHALL cite the evidence, not the legacy id
- **AND** the refusal SHALL also hold at the apply-time re-evaluation when the evidence appears between the plan and the apply.

### Requirement: Phantom-connection cleanup SHALL distinguish load-bearing grant scope from a display reference

The reference implementation's operator phantom-connection cleanup (the owner/operator-only, dry-run-default tool that revokes residual zero-record default-account `connector_instances` rows) SHALL refuse to revoke a row whose `connector_instance_id` is load-bearing for any active grant's read scope, and SHALL NOT refuse solely because a grant-package member's display reference names the row.

A connection's `connector_instance_id` is load-bearing for grant scope when an active grant pins it through `grant.streams[].connection_id` in the grant body, or names it in the grant's `storage_binding_json`. A `grant_package_members.source_json` reference is NOT load-bearing for grant scope: read fan-in resolves over the connector's currently-active connections and the grant body's pins, never over the member's stored display source.

Cleanup SHALL revoke only the `connector_instances` row (the same soft-flip used by the owner-agent connection revoke). It SHALL NOT revoke, narrow, or rewrite any grant, grant-package member, child grant, or token. All other zero-evidence safety checks — records, change history, blobs, derived state, version counters, attention records, detail gaps, schedules, active runs, device source instances, stored credentials, default-account provenance, deterministic-id self-consistency, and active-only status — SHALL continue to fail closed, in both the dry-run plan and the apply-time re-evaluation, and a missing evidence table SHALL fail closed rather than pass silently.

#### Scenario: A member display reference alone does not block cleanup

- **WHEN** a zero-record default-account connection is referenced only by a grant-package member's `source_json` display reference, with no `grant.streams[].connection_id` pin and no grant `storage_binding_json` naming it
- **THEN** the cleanup SHALL treat the connection as a revoke candidate
- **AND** the dry-run output SHALL disclose the grant-package member reference as an informational note on the candidate
- **AND** applying the cleanup SHALL revoke only that `connector_instances` row
- **AND** the grant package, its member rows, the member's child grant, and the member's token SHALL remain unchanged.

#### Scenario: A load-bearing grant-scope pin blocks cleanup

- **WHEN** an active grant pins a stream to a connection through `grant.streams[].connection_id`, or names the connection in the grant's `storage_binding_json`
- **THEN** the cleanup SHALL refuse to revoke that connection
- **AND** the refusal reason SHALL identify the load-bearing grant scope distinctly from a display reference.

#### Scenario: A stale duplicate connection is cleaned without affecting its data-bearing sibling

- **WHEN** one connector has a stale zero-record default-account connection referenced only by a member display reference and a separate data-bearing connection with its own `connector_instance_id` and non-zero records
- **THEN** the cleanup SHALL revoke the stale zero-record connection
- **AND** the data-bearing connection SHALL be skipped because it has records
- **AND** the data-bearing connection SHALL remain active and SHALL continue to resolve under grant fan-in.

### Requirement: A reference read SHALL NOT persist a connection

A reference-implementation read operation SHALL NOT create, upsert, or otherwise persist a `connector_instances` row. Default-account connection materialization SHALL be demand-driven by collection ingest or grant/connection resolution that genuinely needs a binding for a specific connector; it SHALL NOT be triggered by a dashboard, catalog, or any owner-facing read that merely enumerates connectors.

#### Scenario: Dashboard read on a fresh instance writes no connection rows

- **WHEN** the owner views the connection dashboard on an instance that has registered public connectors but zero configured connections
- **THEN** the reference SHALL NOT write any `connector_instances` row as a side effect of the read
- **AND** after the read, the owner's set of `connector_instances` rows SHALL remain empty
- **AND** the registered connectors SHALL remain discoverable through the connector catalog (the registered `connectors` table and the add-connection surface), which is independent of `connector_instances`.

#### Scenario: Ingest still materializes a default-account connection on demand

- **WHEN** a collection run ingests at least one record batch for a connector that has no configured connection, or a grant/connection resolution requires a binding for that connector
- **THEN** the reference MAY materialize a single default-account connection for that one connector at that time
- **AND** this on-demand materialization SHALL remain unaffected by the read-time prohibition above.

### Requirement: Catalog connectors SHALL be distinct from connections in owner projections

Owner-facing reference projections SHALL distinguish a catalog connector (a registered `connector_id` the owner can add) from a connection (a configured `connector_instance_id`). The owner connection projection SHALL list only connections — rows backed by a real `connector_instance_id`. A connector that has no connection SHALL NOT appear in the connection projection as a synthesized or zero-record "active connection"; it remains a catalog connector, surfaced through the connector catalog (the registered `connectors` table and the add-connection surface). Connection lifecycle actions — sync, pause, resume, revoke, delete — SHALL target a connection identified by a `connector_instance_id`; because a catalog connector with no connection is not present in the connection projection, those actions are not offered for it.

#### Scenario: Zero configured connections projects no connections and a complete catalog

- **WHEN** the owner has registered listed connectors and zero configured connections
- **THEN** the owner connection projection SHALL list zero connections
- **AND** the registered listed connectors SHALL remain discoverable in the connector catalog (an add-connection surface, independent of `connector_instances`)
- **AND** no sync, pause, resume, revoke, or delete action SHALL be offered for a catalog connector that has no connection.

#### Scenario: A mix of connected and unconnected connectors

- **WHEN** the owner has one configured connection for connector A and no connection for connector B, where both are registered listed connectors
- **THEN** connector A SHALL be projected as a connection with its `connector_instance_id`
- **AND** connector B SHALL NOT appear in the connection projection
- **AND** connector B SHALL remain available to add through the connector catalog.

### Requirement: Grant resolution SHALL NOT bind to a non-existent connection

Grant and connection resolution SHALL NOT resolve a connector that has no configured connection to a synthesized or phantom binding. When a connector has no connection, resolution SHALL fail closed as "no active connection" rather than returning a fabricated `connector_instance_id`.

#### Scenario: Fan-in resolution for an unconnected connector

- **WHEN** a grant names a connector that has no configured connection and does not pin a specific `connector_instance_id`
- **THEN** resolution SHALL return no active binding for that connector and SHALL read zero records
- **AND** it SHALL NOT bind to a default-account row created by an owner-facing read.

### Requirement: A draft connector-instance status SHALL exist for static-secret owner-session setup

The reference implementation SHALL support a `draft` connector-instance status,
reserved for static-secret owner-session connection setup. A `draft` instance
SHALL be a real `connector_instances` row that is excluded from every connection
read surface until it activates. No path other than the owner-session
static-secret draft-create surface SHALL produce a `draft` instance, and the
default-account materialization, device enrollment, and ordinary connection
materialization paths SHALL continue to write `active` instances.

#### Scenario: Draft status is admitted by storage

- **WHEN** the reference creates a connector instance with status `draft` for a
  static-secret connector through the owner-session setup surface
- **THEN** the store SHALL persist the row with status `draft`
- **AND** a connector instance created by any non-static-secret-setup path SHALL
  NOT be `draft`.

#### Scenario: Draft is the only pre-activation status

- **WHEN** a static-secret connection is being set up before its first ingest
- **THEN** its instance SHALL be `draft`, not `active`, `paused`, or `revoked`
- **AND** no `active` zero-record connection SHALL be written to represent a
  not-yet-ingested static-secret connection.

### Requirement: Draft instances SHALL be invisible to every connection read surface

The reference implementation SHALL exclude `draft` connector instances from
every connection read surface, including the operator dashboard, the
`/_ref/connections` and `/_ref/connector-instances` listings, owner-agent
connection reads, connector-template listings, and device-exporter listings. A
`draft` instance SHALL NOT appear in any list, count, search, or grant-resolution
result. Owner-internal lookups by explicit `connection_id` MAY resolve a draft
for the setup and ingest paths only.

#### Scenario: Draft does not appear in connection listings

- **WHEN** an owner or owner agent lists connections while a `draft` instance
  exists
- **THEN** the response SHALL NOT include the draft
- **AND** the draft SHALL NOT be counted toward the owner's connection totals.

#### Scenario: Draft is not a read target for agents

- **WHEN** a grant-scoped, client, MCP, or owner-agent read attempts to resolve a
  connection
- **THEN** a `draft` instance SHALL NOT be a resolvable read target
- **AND** only the owner-session capture path and the owner-authenticated ingest
  path (addressing the draft by explicit `connection_id`) MAY resolve it.

### Requirement: An owner-session surface SHALL create a static-secret draft connection

The reference implementation SHALL expose an owner-session-only surface that
creates a `draft` connector instance for a static-secret connector. The surface
SHALL reject any non-static-secret connector with a typed error. Each invocation
SHALL create a distinct connection identity, so that two mailboxes or accounts
for the same connector are two distinct `connection_id`s. The surface SHALL NOT
accept or return a provider secret.

#### Scenario: Owner creates a draft for a static-secret connector

- **WHEN** the owner creates a draft connection for `gmail` or `github` through
  the owner session
- **THEN** the reference SHALL create one `draft` instance and return its
  `connection_id` with a typed next step directing the owner to capture the
  credential
- **AND** the response and its audit evidence SHALL NOT contain any secret.

#### Scenario: Draft create is rejected for a non-static-secret connector

- **WHEN** the owner attempts to create a draft connection for a connector that
  is not a static-secret connector
- **THEN** the reference SHALL reject the request with a typed
  `static_secret_credential_unsupported` error
- **AND** no `connector_instances` row SHALL be written.

#### Scenario: Two drafts are two distinct connections

- **WHEN** the owner creates two draft connections for the same static-secret
  connector
- **THEN** the reference SHALL create two distinct `connection_id`s
- **AND** neither draft SHALL collide with the other or with the deterministic
  default-account connection id.

### Requirement: Owner-session capture SHALL be admissible against a draft connection

The reference implementation SHALL allow the owner-session static-secret capture
surface to seal a credential onto a `draft` connection. No bearer, owner-agent,
client, or MCP path SHALL be able to seal a credential onto a draft or otherwise
resolve a draft as a mutation target other than owner-authenticated first ingest.

#### Scenario: Owner seals a credential onto a draft

- **WHEN** the owner captures a static secret for a `draft` connection through
  the owner session
- **THEN** the reference SHALL store the credential keyed to the draft's
  `connection_id`
- **AND** the connection SHALL remain `draft` and invisible until its first
  successful ingest.

#### Scenario: An agent cannot seal a credential onto a draft

- **WHEN** an owner-agent or client bearer attempts to seal a credential onto a
  draft connection
- **THEN** the reference SHALL NOT admit the draft as a capture target
- **AND** SHALL NOT expose the draft as a resolvable connection.

### Requirement: First successful ingest SHALL activate a draft connection

The reference implementation SHALL flip a `draft` connector instance to `active`
on the first ingest that accepts at least one record for that instance. A run
that accepts zero records, a run that fails, and an ingest into an instance with
no stored credential SHALL leave the instance `draft` and invisible, so that no
phantom active zero-record connection is ever created.

#### Scenario: Draft activates on first records

- **WHEN** the first ingest for a `draft` connection accepts at least one record
- **THEN** the reference SHALL flip the instance to `active`
- **AND** the connection SHALL become visible on the connection read surfaces as
  an addressable, labelable `connection_id`.

#### Scenario: Zero-record or failed ingest leaves the draft invisible

- **WHEN** an ingest for a `draft` connection accepts zero records, or the run
  fails before ingest
- **THEN** the instance SHALL remain `draft`
- **AND** SHALL remain excluded from every connection read surface
- **AND** no `active` zero-record connection SHALL be written.

### Requirement: Owner control surfaces SHALL expose connection identity before instance operations

Owner-facing and owner-agent-facing control surfaces SHALL expose configured connector instances before they allow instance-scoped operations. A connector type such as `amazon` SHALL NOT be the only owner-visible target when multiple configured bindings can exist for that connector type.

#### Scenario: Owner agent lists connector templates

- **WHEN** an owner agent lists connector templates
- **THEN** each template SHALL be identified as connector-type metadata
- **AND** the response SHALL either include related connection summaries or link to the connection-instance listing

#### Scenario: Owner agent lists connection instances

- **WHEN** an owner agent lists configured connection instances
- **THEN** each instance SHALL include `connection_id`
- **AND** each instance SHALL include its connector type identity
- **AND** each instance SHALL include an owner-meaningful `display_name` or an explicit label-needed state

### Requirement: Connection display names SHALL support owner-meaningful disambiguation

The reference implementation SHALL let the owner or trusted owner agent set a connection `display_name` suitable for disambiguating multiple bindings of the same connector type. Registry URLs or raw connector manifests SHALL NOT be the final SLVP display label for multi-connection owner workflows.

#### Scenario: Display name is only a fallback

- **WHEN** a connection has only a registry URL or connector-type fallback label
- **THEN** owner-agent control surfaces SHALL expose that state as a fallback or label-needed condition
- **AND** they SHALL provide a supported rename action when the connection can be renamed

#### Scenario: Owner labels a second Amazon account

- **WHEN** a trusted owner agent labels one Amazon connection `the owner personal` and another `Shared Amazon`
- **THEN** subsequent connection listings and public read result wrappers SHALL expose the updated labels for their respective `connection_id` values
- **AND** agent guidance SHALL still tell clients to persist `connection_id` rather than `display_name` as the stable selector

### Requirement: Connector lifecycle operations SHALL be instance-scoped when stateful

Stateful connector lifecycle operations such as run now, schedule, pause, resume, revoke, delete, diagnostics, and rename SHALL target `connection_id` when they affect a configured binding. Connector-type operations SHALL be limited to template-level metadata or shall raise typed ambiguity when multiple instances exist.

#### Scenario: Owner agent runs one Amazon connection

- **WHEN** two Amazon connection instances exist
- **AND** a trusted owner agent requests a run for one `connection_id`
- **THEN** the reference implementation SHALL run only the targeted connection instance
- **AND** it SHALL NOT run the other Amazon connection unless explicitly requested

#### Scenario: Connector-only action is ambiguous

- **WHEN** a trusted owner agent requests a stateful action with `connector_id` only
- **AND** multiple connection instances exist for that connector type
- **THEN** the reference implementation SHALL reject the request with a typed ambiguity error
- **AND** it SHALL include available `connection_id` values and owner-meaningful labels

### Requirement: Scheduled and manual runs SHALL resolve static-secret credentials identically

The reference implementation SHALL resolve a connection's static-secret
credential from the encrypted per-connection store through one shared seam for
every run-launch path — scheduled, retry, and manual. A run path SHALL NOT
silently depend on process-global credential environment variables when the
connection holds an active stored credential, and an empty-string environment
variable value SHALL NEVER shadow a store-recovered value (the stored
credential is merged last into the connector child environment).

The reference implementation SHALL keep each connector's runtime credential
mapping aligned with that connector's actual authentication inputs. If a
connector authenticates through a stored username/password pair, the runtime
registry SHALL accept that credential kind and inject the connector-declared
username/password environment variables for the targeted connection. A stored
credential kind mismatch SHALL be a mapping or migration defect unless the
runtime registry explicitly declares a backward-compatible accepted variant for
that connector.

#### Scenario: Scheduled run succeeds with no credential env vars

- **WHEN** a scheduled run begins for a connection with an active stored
  static-secret credential and the connector's credential env vars are absent
  or empty strings in the host process environment
- **THEN** the connector child SHALL receive the store-recovered credential
  value(s) in its environment
- **AND** the run SHALL NOT raise a `credentials_required` interaction
- **AND** the run SHALL behave identically to a manual run of the same
  connection.

#### Scenario: Browser-backed username/password connection uses stored credentials

- **WHEN** an Amazon, Chase, Reddit, or USAA connection holds an active stored
  `username_password` credential
- **THEN** scheduled, retry, and manual runs SHALL inject that connection's
  username and password into the connector child environment
- **AND** the run SHALL NOT ask the owner to reconnect solely because the host
  process lacks deployment-wide credential env vars.

#### Scenario: Credential resolution failure refuses the launch

- **WHEN** a scheduled launch begins for a connection whose stored credential
  is revoked, deleted, or unrecoverable
- **THEN** the scheduler SHALL refuse the launch without spawning a connector
  child and record a typed failure
- **AND** the run SHALL NOT fall back to a process-global or stale secret.

### Requirement: Schedule eligibility SHALL accept stored credentials as auth evidence

The reference implementation SHALL treat an active per-connection stored
credential as satisfying `capabilities.auth.required` in boot-time
auto-enrollment and any other schedule-eligibility gate that checks env
presence. Only credential PRESENCE may be consulted; secret bytes SHALL NOT be
recovered, logged, or compared by an eligibility check.

#### Scenario: Env-free deployment auto-enrolls a store-backed connector

- **WHEN** the reference boots with a connector's credential env vars absent or
  empty-string and at least one active connection of that connector holds an
  active stored credential
- **THEN** auto-enrollment SHALL treat the auth requirement as satisfied rather
  than counting the connector as `skipped_env`.

### Requirement: An active account connection SHALL resolve a refresh contract from its manifest, NOT a credential

The reference implementation SHALL require every active `account` connector
instance to resolve a refresh contract from its connector manifest, derived from the
manifest's `recommended_mode` and `background_safe` refresh-policy fields. The
refresh contract SHALL be the creation/lifecycle invariant that keeps impossible
refresh configurations un-constructable. The reference implementation SHALL NOT
require an active `account` connection to hold a stored credential as a creation
invariant: an account connection MAY be active, scheduled, and collecting through
owner-assisted browser sessions with zero stored credentials, so an
`account` ⇒ `credential` invariant SHALL NOT be imposed and SHALL NOT brand such a
connection impossible.

When the resolved refresh contract is `automatic` — the manifest declares the
connector schedulable (`recommended_mode` is not `manual` or `paused` and
`background_safe` is not false) — a schedule row SHALL be attached at activation, so
an "automatic but unscheduled" account connection is un-constructable. When the
resolved refresh contract is `manual` — the manifest declares the connector
manual, paused, or background-unsafe — schedule absence SHALL NOT be treated as a
defect, but the connection SHALL be typed manual so that the connection-health
projection routes its stale freshness to an owner-refresh advisory
(`owner_refresh_due` / `stale_manual_refresh`). Stale freshness alone SHALL NOT
downgrade an otherwise healthy collection-health pill.

The refresh contract SHALL be resolved generically from the manifest refresh-policy
fields and SHALL NOT be keyed on a per-connector name branch or on credential
presence.

#### Scenario: An account connection is active with zero credentials

- **WHEN** an `account` connector instance is active, scheduled, and collecting
  through owner-assisted browser sessions with no stored credential
- **THEN** the reference SHALL treat the connection as a valid active account
  connection that resolves a refresh contract from its manifest
- **AND** it SHALL NOT require a stored credential as a creation invariant and SHALL
  NOT brand the connection impossible for lacking one.

#### Scenario: An automatic account connection has a schedule at activation

- **WHEN** an `account` connector whose manifest resolves an `automatic` refresh
  contract is activated
- **THEN** the reference SHALL attach a schedule row at activation
- **AND** an active `automatic` account connection with no attached schedule SHALL
  be un-constructable.

#### Scenario: A manual account connection is typed manual and routes stale to an advisory

- **WHEN** an `account` connector whose manifest resolves a `manual` refresh
  contract is active and its retained data has aged past its freshness window
- **THEN** schedule absence SHALL NOT be reported as a defect
- **AND** the connection SHALL be typed manual so its stale freshness routes to an
  owner-refresh advisory while the collection-health pill remains driven by
  collection health rather than by freshness alone.

### Requirement: Connection setup SHALL materialize instances only through typed setup lifecycle gates

The reference implementation SHALL materialize or activate connector instances
only through typed setup lifecycles appropriate to the connector's setup
modality. A setup intent or setup plan SHALL NOT silently create an active
connection row unless the modality's proof boundary has been satisfied.

#### Scenario: Local collector setup enrolls before activation

- **WHEN** an owner starts setup for a local-collector connector
- **THEN** the reference SHALL return a typed enrollment next step for the local
  collector
- **AND** the connection SHALL become active only after an authorized local
  binding is established and accepted according to the local collector lifecycle

#### Scenario: Static-secret setup uses draft then first-ingest activation

- **WHEN** an owner starts setup for a static-secret connector
- **THEN** the reference SHALL create or direct the owner to create a draft or
  pending setup state and capture the credential through an owner-mediated
  secret surface
- **AND** the owner UI SHALL expose the pending setup or running first sync after
  submission with the connection id, run id when present, and any actionable
  failure state
- **AND** the connection SHALL become active only after first successful ingest
  accepts records for that draft
- **AND** owner-authenticated collection mutations for that first sync,
  including record ingest, blob upload, and state checkpoints, SHALL target the
  same explicitly addressed draft connection id so records, media, provenance,
  and checkpoints cannot split across sibling connections
- **AND** owner-authenticated collection state reads and writes for that
  explicitly addressed draft connection id SHALL be accepted during first sync
  so checkpoint persistence cannot fail solely because activation has not yet
  occurred

#### Scenario: Static-secret setup does not disappear after submission

- **WHEN** an owner submits a valid static-secret setup form and the first sync
  has not yet accepted records
- **THEN** the reference SHALL expose a pending or running setup state to owner
  surfaces
- **AND** it SHALL NOT rely on an invisible draft row or transient redirect
  notice as the only owner-visible state

#### Scenario: Static-secret validation failure does not create an invisible setup row

- **WHEN** an owner submits a static-secret credential and synchronous
  provider validation rejects it before storage
- **THEN** the reference SHALL NOT store the rejected credential or credential
  metadata
- **AND** if the target is a first-time static-secret draft, the reference
  SHALL retire that draft so it cannot remain as an invisible setup row
- **AND** if the target is an active connection, the reference SHALL leave that
  active connection active so a failed rotation cannot revoke a working
  connection

#### Scenario: Owner reads a durable connection-scoped setup status

- **WHEN** an owner reads the setup status for a static-secret connection by its
  connection id through an owner-session surface
- **THEN** the reference SHALL return a connection-scoped setup-status view that
  resolves a not-yet-ingested draft as well as an active connection
- **AND** the view SHALL carry the connection id, the connector and account
  identity when known, a setup lifecycle state projected from the connection
  health and run state (not a parallel onboarding-only enum), the current or
  last run id and status when present, and the credential presence metadata
- **AND** the setup-status view SHALL NOT include the provider secret, owner
  session cookie, browser session cookie, or any bearer-equivalent credential

#### Scenario: Failed first sync is visible with a non-secret remediation

- **WHEN** the first sync for a static-secret draft connection fails before any
  records are accepted
- **THEN** the owner setup-status view SHALL report a failed setup state with an
  actionable remediation next step
- **AND** the failure surface SHALL NOT leak the provider secret or any
  bearer-equivalent credential

#### Scenario: Browser-bound setup remains proof-gated

- **WHEN** a connector requires browser-bound collection but the reference lacks
  committed end-to-end live proof for that connector's browser-bound setup path
- **THEN** the setup lifecycle SHALL return a proof-gated or unsupported setup
  state
- **AND** it SHALL NOT create or advertise an active browser-bound connection as
  supported

#### Scenario: Provider authorization setup separates app readiness from account authorization

- **WHEN** a connector uses provider authorization such as OAuth or a Link-style
  account-linking flow
- **THEN** deployment-level provider app readiness SHALL be verified before the
  owner account authorization starts
- **AND** the connection SHALL become active only after the provider callback or
  token exchange completes and any required account inventory or connection test
  succeeds

#### Scenario: Revoked connections remain owner-manageable

- **WHEN** an owner revokes a connection to stop future collection while
  retaining already-collected records
- **THEN** owner read surfaces SHALL keep the revoked connection visible with
  its connection id, connector identity, retained record evidence, lifecycle
  state, and revocation timestamp when known
- **AND** owner UI surfaces SHALL NOT redirect the owner to an excluded detail
  route after revoke
- **AND** owner UI surfaces SHALL provide a clear re-connect action that starts
  the supported setup path for that source
- **AND** owner UI surfaces SHALL NOT present a revoked connection as runnable
  or healthy active collection

### Requirement: Setup credentials SHALL be connection-scoped and secret-safe

Provider credentials collected during setup SHALL be scoped to exactly one
connection or draft connection, stored according to that modality's credential
storage rules, and never returned by owner-agent, MCP, grant-scoped REST, console
read, or CLI read surfaces. Reads MAY expose non-secret metadata such as
credential kind, presence, validity, capture timestamp, rotation timestamp, and
fingerprint. The credential-kind vocabulary SHALL support single-secret app
passwords, single-secret personal access tokens, sealed multi-field secret
bundles, and username/password pairs without requiring deployment-wide
per-account environment variables.

#### Scenario: Two accounts use the same connector type

- **WHEN** an owner configures two accounts for the same static-secret or
  provider-authorization connector type
- **THEN** the reference SHALL represent them as two distinct connection ids
- **AND** each connection SHALL use its own credential or provider authorization
  material without reading, overwriting, or sharing the sibling connection's
  credential

#### Scenario: A connector requires multiple bearer-equivalent values

- **WHEN** a static-secret connector requires multiple bearer-equivalent values
  for one source account, such as a token plus cookie or OAuth client secret plus
  account password
- **THEN** the reference SHALL store those values as one connection-scoped sealed
  credential bundle
- **AND** it SHALL inject only the connector-declared fields into the subprocess
  for that connection's run
- **AND** non-secret setup identity or configuration fields MAY be stored as
  source-binding metadata rather than inside the sealed secret

#### Scenario: Agent reads setup status

- **WHEN** a trusted owner agent reads setup or connection status for a
  credential-backed connection
- **THEN** the response MAY include non-secret credential metadata and the next
  owner action
- **AND** it SHALL NOT include the provider secret, provider access token, owner
  session cookie, browser session cookie, or any bearer-equivalent credential

### Requirement: Connector instances MAY aggregate multiple acquisition paths under one logical connection

The reference implementation SHALL allow one owner-facing connection to receive
records for the same logical source through multiple acquisition paths when each
path is represented by acquisition-batch provenance and records remain
instance-scoped.

Adding a second acquisition path SHALL NOT require a second owner-facing
connection when the owner is strengthening coverage for the same logical source.

#### Scenario: Historical and current acquisitions belong to one source

- **WHEN** an owner uses an owner artifact to hydrate historical data for a
  source
- **AND** later authorizes a browser-polyfill, provider API, or device-sync path
  for current data for the same source
- **THEN** the reference MAY keep both acquisition paths under one connection
- **AND** each accepted batch SHALL retain acquisition method and provenance
- **AND** records from one acquisition path SHALL NOT overwrite sibling records
  unless explicit identity rules say they are the same logical record.

#### Scenario: Acquisition path targets a different account or device

- **WHEN** an acquisition path refers to a different account, device, local
  binding, or source identity
- **THEN** the reference SHALL create or require a distinct connection or
  source-instance identity rather than merging it into an existing connection by
  connector type alone.

#### Scenario: Owner adds another artifact to the same source

- **WHEN** an owner imports another supported artifact for the same account,
  profile, device, local binding, or source identity
- **THEN** the reference SHALL allow that artifact to target the existing
  manual/upload connection
- **AND** it SHALL preserve a distinct acquisition-batch receipt for the new
  artifact.

#### Scenario: Existing manual source is visible during add-source

- **WHEN** an owner starts the add-source flow for a connector that already has
  manual/upload connections
- **THEN** the reference SHALL offer those existing connections as import targets
  before asking the owner to create another source identity
- **AND** it SHALL still provide an explicit path to create a distinct source
  for a different account, profile, device, or source identity.

### Requirement: Same-stream writes from multiple acquisition paths SHALL be explicit and non-destructive

When multiple acquisition paths write to the same stream for one connection, the reference SHALL preserve record identity, acquisition provenance, and coverage claim attribution.

A later acquisition path SHALL NOT erase, tombstone, or hide records from an
earlier path merely because the later path did not observe them.

#### Scenario: Daily current-data path does not erase historical archive data

- **WHEN** a historical owner-artifact batch populated records for a stream
- **AND** a later daily provider API or browser-polyfill batch observes only a
  current window for the same stream
- **THEN** the current-data batch SHALL NOT tombstone or hide historical records
  outside its declared coverage window
- **AND** the reference SHALL keep the historical batch's coverage claim visible.

#### Scenario: Full-refresh path has explicit coverage authority

- **WHEN** a connector claims full-refresh coverage for a stream and acquisition
  method
- **THEN** any destructive reconciliation SHALL be limited to that declared
  coverage authority
- **AND** it SHALL NOT apply to records whose only evidence came from a distinct
  acquisition method unless an explicit cross-method identity rule authorizes
  that reconciliation.

### Requirement: Configured provider-account runs SHALL require source-scoped credentials

The reference implementation SHALL require configured connector-instance runs for static-secret or provider-account connectors to resolve provider-account credentials from source-scoped setup material for the targeted connection. Manual, scheduled, retry, and auto-resume run paths SHALL NOT use deployment-wide provider-account environment variables as a substitute for a missing source-scoped credential. A missing, revoked, or unrecoverable source-scoped credential SHALL fail closed before the connector child is spawned.

This requirement applies to configured reference-server runs. It does not forbid standalone connector development or tests from passing connector-declared credential environment variables directly to a connector child outside a configured connector-instance run.

#### Scenario: Configured run lacks a stored source credential

- **WHEN** a manual or scheduled run is started for a configured static-secret connector instance with no active stored source credential
- **THEN** the reference SHALL refuse the launch with a typed credential-unavailable failure
- **AND** it SHALL NOT spawn a connector child
- **AND** it SHALL NOT use deployment-wide provider-account environment variables to authenticate the source.

#### Scenario: Configured run has a stored source credential

- **WHEN** a manual or scheduled run is started for a configured static-secret connector instance with an active stored source credential
- **THEN** the connector child SHALL receive the source-scoped credential environment fragment for that connection
- **AND** that fragment SHALL override same-named deployment environment values for the child process
- **AND** sibling connector instances SHALL NOT receive that connection's credential.

#### Scenario: Connector is not a static-secret provider-account connector

- **WHEN** a configured run is started for a connector whose setup material is not represented by the static-secret credential registry
- **THEN** the static-secret resolver SHALL return no env fragment
- **AND** other connection-scoped setup-material resolvers MAY satisfy the run according to their own contracts.

#### Scenario: Standalone connector execution uses env credentials

- **WHEN** a connector is executed outside the configured reference-server connector-instance run path
- **THEN** the connector MAY read connector-declared credential environment variables
- **AND** that standalone behavior SHALL NOT be treated as satisfying source-scoped setup for a configured reference connection.

### Requirement: Stream definitions SHALL be reusable across acquisition paths without weakening connection identity

The reference implementation SHALL allow multiple connector types, setup methods, or acquisition paths to emit records for the same normalized stream definition when the stream semantics and record shape match. Record storage, runtime state, schedules, diagnostics, and grant-safe read attribution SHALL remain scoped to `connection_id` / `connector_instance_id`, not to the acquisition path alone.

Multiple acquisition paths MAY populate the same logical connection only when an explicit source-identity rule proves they represent the same owner source or account. Without that proof, the paths SHALL remain separate connections that may share stream definitions.

Acquisition-path metadata SHALL be treated as provenance in source binding, run, coverage, or record metadata. It SHALL NOT replace `connection_id` as the public read-surface source identity and SHALL NOT require clients to use a path selector for normal reads.

#### Scenario: API and import paths share a stream definition

- **WHEN** an API-backed connector and an import connector both emit a normalized stream with the same semantics and record shape
- **THEN** the reference SHALL allow both connections to advertise and collect that stream definition
- **AND** records from each path SHALL remain separated by their own `connection_id` unless an explicit source-identity rule links them.

#### Scenario: Path identity is not proven

- **WHEN** one acquisition path is based on an owner-provided export file and another path is based on provider OAuth
- **THEN** the reference SHALL NOT silently merge those paths into one connection
- **AND** owner and read surfaces SHALL continue to attribute records to the connection that collected or imported them.

#### Scenario: Path identity is proven later

- **WHEN** a later accepted change defines and implements a source-identity rule proving two acquisition paths represent the same owner source
- **THEN** those paths MAY write through one logical connection
- **AND** run and coverage metadata SHALL still preserve which acquisition path produced each batch or known gap.

#### Scenario: Client reads shared stream names

- **WHEN** a grant-authorized client reads or searches a stream name that appears under multiple connections
- **THEN** the response SHALL expose grant-safe connection attribution
- **AND** the client SHALL be able to disambiguate by `connection_id` without knowing acquisition-path internals.

### Requirement: Connection summaries expose connection-scoped run evidence

The reference implementation SHALL project `last_run` and `last_successful_run` evidence for a configured connection from run summaries that belong to that connection. When run summaries carry a browser-surface profile key, the projection SHALL match that key to the connection's expected browser profile key. When a run summary does not carry a browser-surface profile key, the projection SHALL NOT assign it to a sibling connection unless the run summary carries explicit `connector_instance_id` or `connection_id` equal to that connection.

#### Scenario: sibling browser connections do not share one run

**WHEN** two active connections for the same connector have browser-surface run summaries stamped with distinct browser-surface profile keys
**THEN** the owner connection-summary list projects each connection's `last_run` from its matching profile-keyed run only
**AND** it does not project one sibling's run as the other's `last_run`.

#### Scenario: browser-surface failure reason is visible

**WHEN** a connection's latest matching browser-surface run has status `surface_failed`
**AND** the run did not emit a terminal `run.failed` reason
**THEN** the owner connection-summary list uses the browser-surface wait/status evidence as `last_run.failure_reason`.

### Requirement: Connection summary list coalesces repeated full-list reads

The reference implementation SHALL coalesce duplicate full connection-summary list reads with a short-lived implementation cache when an equivalent Postgres projection is already in flight, provided scoped connection reads and diagnostic test hooks still execute the underlying projection path.

#### Scenario: duplicate full-list reads reuse one in-flight projection

**WHEN** multiple full connection-summary list reads arrive in the same process while an equivalent Postgres projection is already in flight
**THEN** the reference implementation may serve those reads from the same in-flight projection
**AND** it SHALL NOT use that optimization for explicit scoped connection reads.

### Requirement: Connection summary list avoids repeated retained-size reads

The reference implementation SHALL compute the full owner connection-summary list without issuing retained-size stream and retained-size connection reads once per configured connection when the retained-size read model can provide the same projection rows in one bounded read. Scoped single-connection summary reads SHALL remain scoped and SHALL NOT require the all-connection retained-size snapshot.

#### Scenario: full list reuses one retained-size snapshot

**WHEN** the owner reads the full connection-summary list
**THEN** the reference implementation reads the retained-size stream and connection projections as shared request-local inputs
**AND** projects each connection from the same per-connection summary function.

#### Scenario: scoped read stays scoped

**WHEN** the owner reads a single connection summary by route id
**THEN** the reference implementation projects only that resolved connection
**AND** it does not require the all-connection retained-size snapshot.

### Requirement: Connection overview does not hydrate deep run histories

The reference implementation SHALL treat the full owner connection-summary list
as a shallow overview read for run summaries. It SHALL NOT block that full-list
read on deep per-connection run-history hydration. Scoped connection summary
reads and owner diagnostics SHALL retain deep run evidence for the selected
connection.

#### Scenario: full overview stays shallow

**WHEN** the owner reads the full connection-summary list
**THEN** the reference implementation may omit `last_run` and
`last_successful_run` evidence from overview rows rather than hydrating deep run
history for every configured connection
**AND** it still projects health, freshness, retained-size, coverage, schedule,
and rendered verdict fields from bounded overview inputs.

#### Scenario: scoped diagnostics retain run evidence

**WHEN** the owner reads diagnostics for one configured connection
**THEN** the reference implementation projects that one connection through the
deep run-summary path
**AND** it does not fall back to the shallow full-list projection.

### Requirement: Postgres connection-summary spine indexes are provisioned

The reference implementation SHALL provision Postgres indexes needed by the
connection-summary hot path during schema bootstrap and migrations, including a
source/run summary index for source-scoped run grouping.

#### Scenario: source-scoped run grouping has a bootstrap index

**WHEN** a Postgres reference instance starts or migrates
**THEN** the schema includes an index over source kind, source id, run id, and
run occurrence time for run-bearing spine events
**AND** source-scoped run grouping SHALL NOT depend on a manual live-operator
index creation step.

