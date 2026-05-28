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

