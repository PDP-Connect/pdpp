## ADDED Requirements

### Requirement: Controller-managed active-run admission SHALL fail closed

The reference runtime controller SHALL treat `controller_active_runs` as the
durable admission gate for connector-instance runs. For a given
`connector_instance_id`, the controller SHALL admit at most one live run at a
time. If a live row already exists for that connector instance, a new admission
attempt SHALL fail closed without replacing the incumbent row.

An admission conflict SHALL be a neutral coordination outcome, not a run
failure, health regression, or owner-attention event. Scheduled, manual run-now,
and recovery-continuation paths SHALL all use the same admission gate.

#### Scenario: A live invocation may retain the reservation while it is still pending

- **WHEN** a managed run is admitted and remains live while browser-surface
  readiness is still in progress before `runNow()` resolves
- **THEN** the controller SHALL keep the reservation active until that
  invocation becomes terminal

#### Scenario: Returned queued, deferred, or failed outcomes clear the reservation

- **WHEN** browser-surface acquisition returns a queued, deferred, or failed
  outcome before the connector child starts
- **THEN** the controller SHALL clear the active-run reservation and streaming
  nonce before returning
- **AND** any browser-surface queue or projection MAY persist under its own
  lifecycle
- **AND** the final `getActiveRun()` state for that connector instance SHALL be
  `null`

#### Scenario: A started connector child keeps the reservation until terminal

- **WHEN** the connector child has started and remains live
- **THEN** the controller SHALL keep the active-run reservation until the child
  becomes terminal

#### Scenario: Duplicate live admission preserves the incumbent row

- **WHEN** the controller admits a run for a connector instance that already has
  a live active-run row
- **THEN** the controller SHALL reject the new admission without overwriting the
  incumbent row
- **AND** the incumbent row SHALL remain the durable source of truth until that
  live run becomes terminal

#### Scenario: A restart does not let in-memory emptiness bypass the durable gate

- **WHEN** the controller restarts and its in-memory active-run map is empty
- **AND** `controller_active_runs` already contains a live row for a connector
  instance
- **THEN** a new manual or scheduled admission for that connector instance SHALL
  still fail closed
- **AND** the existing durable row SHALL remain unchanged

#### Scenario: Recovery continuation cannot bypass the gate

- **WHEN** a recovery-continuation run is requested for a connector instance
  that already has a live active-run row
- **THEN** the controller SHALL treat the conflict as a neutral deferred outcome
- **AND** it SHALL NOT overwrite the live row or emit a run failure solely for
  the conflict

### Requirement: Active-run cleanup SHALL remain run-id-scoped

The reference runtime SHALL clear `controller_active_runs` rows using both
`connector_instance_id` and `run_id` for the terminalized run. An old runner
SHALL not be able to delete a newer row that has already replaced it in the
durable registry after the old runner became stale.

#### Scenario: A stale cleanup attempt cannot delete a newer row

- **WHEN** an older run attempts cleanup after a newer live row exists for the
  same connector instance
- **THEN** the cleanup SHALL delete only the row whose `run_id` matches the
  terminating run
- **AND** it SHALL leave the newer live row intact

### Requirement: Boot reconciliation SHALL target only genuinely stale rows

The reference runtime SHALL preserve explicit boot/restart reconciliation for
genuinely stale `controller_active_runs` rows left behind by a crashed or
restarted process. Reconciliation SHALL not be used to reclaim ordinary live
admissions, and it SHALL not overwrite a live row during admission.

#### Scenario: Restart cleanup removes a stale orphaned row

- **WHEN** the runtime boots and finds a durable active-run row with no live
  process behind it
- **THEN** it MAY reconcile that stale row through the existing abandonment
  cleanup path
- **AND** it SHALL leave any concurrently live row untouched
