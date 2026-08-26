## ADDED Requirements

### Requirement: Every started run SHALL reach exactly one durable terminal state

For every `run.started` event in the spine, either a terminal event SHALL exist
for that run, or the run's `boot_epoch` SHALL equal the current process's boot
epoch. The canonical terminal set is `run.completed`, `run.failed`,
`run.browser_surface_failed`, `run.cancelled`, and `run.abandoned`.

Exactly one component SHALL write a given run's terminal state. A run
interrupted by process death SHALL be adjudicated by the boot reconciler
reading the append-only spine. No other reconciler SHALL emit a terminal event
for an interrupted run, and no component SHALL emit a second terminal event for
a run that already has one.

Adjudication SHALL be idempotent: each emitted terminal event SHALL carry
`caused_by_event_id`, and repeated adjudication passes SHALL produce exactly
one terminal event per orphan.

#### Scenario: A run interrupted by process death is terminalized at the next boot

- **WHEN** a run has a `run.started` event, no terminal event, and a `boot_epoch`
  that is not the current process's boot epoch
- **THEN** the boot reconciler SHALL emit exactly one terminal event for that run
- **AND** the run's `terminal_status` SHALL become non-null

#### Scenario: Repeated adjudication does not duplicate terminal events

- **WHEN** two successive reconcile passes observe the same orphaned run
- **THEN** exactly one terminal event SHALL exist for that run

#### Scenario: A second writer does not emit a competing terminal event

- **WHEN** a reconciler other than the boot reconciler observes a stale
  `controller_active_runs` claim for a run
- **THEN** it SHALL release the stale claim
- **AND** it SHALL NOT emit any terminal event for that run

### Requirement: An interrupted run SHALL terminalize as abandoned, never as failed

A run whose owner process died without reporting SHALL be recorded as
`run.abandoned` with reason `controller_terminated_before_run_finished`. It
SHALL NOT be recorded as `run.failed`, and SHALL NOT be assigned any
failure reason that asserts an observed failure.

`abandoned` and `failed` SHALL remain distinct terminal states because they
carry different remedies: `failed` indicates an observed failure that MAY
require owner attention, while `abandoned` indicates that no owner will ever
report on the unit and the normal schedule will pick the work up.

Adjudicating an interrupted run SHALL NOT request owner attention, SHALL NOT
emit an owner notification, and SHALL NOT re-run, re-queue, or retry the work.

Adjudication SHALL NOT delete or edit any existing event, SHALL NOT modify
ingested records, and SHALL NOT revise `records_emitted`. Records durably
ingested before the interruption SHALL stay committed.

#### Scenario: An interrupted run with staged cursors is not called a failure

- **WHEN** a run staged a cursor or durably ingested a batch and was then
  interrupted by process death
- **THEN** its terminal event SHALL be `run.abandoned`
- **AND** no `run.failed` event SHALL exist for that run

#### Scenario: Adjudication is silent

- **WHEN** an interrupted run for a connector that requires an interactive human
  sign-in is adjudicated
- **THEN** zero owner-attention rows SHALL be created
- **AND** zero owner notifications SHALL be sent
- **AND** the run SHALL NOT be automatically retried

#### Scenario: Durable records survive adjudication

- **WHEN** a run is adjudicated as abandoned after durably ingesting records
- **THEN** those records SHALL remain committed
- **AND** the run's reported `records_emitted` SHALL NOT be revised

### Requirement: Controller identity SHALL be durable across container replacement

The reference implementation SHALL resolve controller identity from
`PDPP_CONTROLLER_ID` when set, and otherwise from a durable single-row
`controller_identity` record stored in the same database that holds the runs.
The record SHALL be seeded from the host name on the first boot that finds it
absent, and SHALL be read back unchanged on every later boot.

The host name SHALL NOT be used as the live controller identity. Under a
container runtime the host name is the container id and is fresh on every
container creation, which makes an ownership filter keyed on it exclude every
prior container's orphans.

The boot epoch SHALL continue to advance on every boot. Only the identity is
stable, so adjudication can still distinguish a prior incarnation's work from
the current process's work.

An identity that must be supplied by operator configuration SHALL NOT be the
default, because omitting it fails silently and reopens the ownership defect
with no signal.

#### Scenario: A replacement container inherits its predecessor's identity

- **WHEN** the reference implementation boots in a new container against a
  database whose `controller_identity` row already exists
- **THEN** it SHALL adopt the stored controller id rather than its host name
- **AND** its ownership filter SHALL select orphans left by the prior container

#### Scenario: First boot seeds the identity

- **WHEN** the reference implementation boots against a database with no
  `controller_identity` row and no `PDPP_CONTROLLER_ID`
- **THEN** it SHALL write one row seeded from the host name
- **AND** every later boot SHALL read that same value back

#### Scenario: The operator override still partitions ownership

- **WHEN** `PDPP_CONTROLLER_ID` is set
- **THEN** it SHALL take precedence over the stored row
- **AND** a multi-controller deployment SHALL remain isolated by controller id

### Requirement: A successor SHALL adjudicate only units whose owner epoch is not its own

A unit of work SHALL carry, in the same durable write that starts it, the
identity of the owner epoch entitled to finish it. A successor epoch SHALL
adjudicate a unit only when that unit's owner epoch is not the successor's own
epoch.

A successor SHALL NOT adjudicate any unit belonging to the newest boot epoch.
A unit started by the process that is still running is live work, not an
orphan: it lacks a terminal event for the ordinary reason that it has not
finished. Adjudicating it would declare live work abandoned and free its
resource for a competing run, reintroducing the duplicate-execution hazard the
epoch fence exists to prevent.

Eligibility SHALL be decided by epoch comparison, not by an age threshold. A
unit with a `NULL` owner epoch SHALL be treated as unclaimed and SHALL be
eligible, since no live process claims it.

An owner-operated repair tool MAY ignore the controller-identity filter, since
that field is the defect being healed, but SHALL NOT ignore the newest-epoch
exclusion.

#### Scenario: Live work in the newest epoch is never adjudicated

- **WHEN** an adjudication pass observes a unit whose owner epoch equals the
  newest `controller.booted` epoch
- **THEN** it SHALL NOT adjudicate that unit
- **AND** it SHALL NOT release or reassign that unit's resource

#### Scenario: A prior epoch's unit is adjudicated without a time threshold

- **WHEN** an adjudication pass observes a unit whose owner epoch is neither its
  own nor the newest epoch
- **THEN** it SHALL adjudicate that unit regardless of the unit's age

#### Scenario: A unit with no recorded owner epoch is eligible

- **WHEN** an adjudication pass observes an in-flight unit whose owner epoch is
  `NULL`
- **THEN** it SHALL treat that unit as unclaimed and eligible for adjudication

### Requirement: In-flight manual-upload artifacts SHALL be swept by owner epoch

The manual-upload artifact store SHALL record the owner epoch of the process
that created an artifact, written in the same INSERT that creates it. An
artifact left in an in-flight state SHALL be eligible for sweep when its owner
epoch is not the current epoch, or when its owner epoch is `NULL`.

Sweep eligibility SHALL NOT be decided by a wall-clock staleness threshold. A
guessed threshold can be wrong in both directions: it can sweep a slow but live
validation out from under itself, or leave a genuinely dead upload in place.

An artifact whose owner epoch matches the current epoch SHALL NOT be swept.
Claiming an artifact for sweep SHALL remain an atomic compare-and-swap and
SHALL stamp the claiming epoch on a win, so a concurrent second claim loses.

The owner-epoch column SHALL be additive and `NULL`-tolerant on both backends so
existing databases migrate without a backfill.

#### Scenario: A live in-flight artifact is never swept

- **WHEN** the boot sweep observes an in-flight artifact whose owner epoch is the
  current epoch
- **THEN** it SHALL leave that artifact untouched regardless of its age

#### Scenario: An orphaned in-flight artifact is swept immediately

- **WHEN** the boot sweep observes an in-flight artifact whose owner epoch is not
  the current epoch
- **THEN** it SHALL claim and sweep that artifact without waiting for any
  staleness interval

#### Scenario: Legacy artifacts written before the column existed are swept

- **WHEN** the boot sweep observes an in-flight artifact whose owner epoch is
  `NULL`
- **THEN** it SHALL treat it as unclaimed and sweep it
- **AND** the backend predicate SHALL NOT reduce to one that spares `NULL` rows

#### Scenario: Concurrent claims resolve to one winner

- **WHEN** two processes attempt to claim the same in-flight artifact for sweep
- **THEN** exactly one SHALL win the compare-and-swap and stamp its epoch
- **AND** the loser SHALL NOT sweep that artifact

### Requirement: Shutdown SHALL NOT attempt to drain in-flight connector runs

The reference implementation SHALL NOT wait for in-flight connector runs on the
`SIGTERM` path. Interrupted runs SHALL be adjudicated by the successor at the
next boot instead.

A shutdown drain SHALL NOT be reintroduced as the mechanism for terminalizing
interrupted work. The container runtime's stop grace period is fixed at
container creation and is shorter than a connector run, so a drain cannot
complete the work, and any drain consumes the grace period that remains before
forced termination. A forced termination receives no shutdown path at all, so a
design that requires the dying process to write its own terminal state has an
unhandled case by construction.

Removing the drain SHALL NOT remove the controller's ability to await in-flight
runs. That capability SHALL remain available to the run watchdog and to
callers awaiting a specific run.

Resources that outlive an abrupt termination, such as browser profile locks,
SHALL continue to be reclaimed at the next boot.

#### Scenario: Shutdown does not wait for a running connector

- **WHEN** the reference implementation receives `SIGTERM` while a connector run
  is in flight
- **THEN** it SHALL NOT block shutdown awaiting that run
- **AND** the run SHALL be adjudicated as abandoned at the next boot

#### Scenario: Awaiting in-flight runs remains available to other callers

- **WHEN** the run watchdog or a caller awaiting a specific run needs in-flight
  run completion
- **THEN** the controller SHALL still provide that capability

#### Scenario: Browser profile locks are reclaimed after an abrupt termination

- **WHEN** the process is terminated without running any shutdown path
- **THEN** stale browser profile locks SHALL be reclaimed at the next boot
