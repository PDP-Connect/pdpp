## ADDED Requirements

### Requirement: Manual-default background-safe connections SHALL be owner-schedulable

The reference implementation SHALL treat `recommended_mode: "manual"` as a
conservative default recommendation, not a hard prohibition, when
`background_safe: true`. In that posture, an owner MAY explicitly enable a
per-connection schedule for the configured connection. The reference SHALL NOT
auto-enroll that connection on boot, and an unscheduled manual-default
connection SHALL remain manual until an owner explicitly creates or enables a
schedule.

`background_safe: false` and `recommended_mode: "paused"` SHALL remain hard
prohibitions on background scheduling.

#### Scenario: Manual-default background-safe connection accepts an explicit owner schedule

- **WHEN** an owner configures a connection whose manifest declares
  `recommended_mode: "manual"` and `background_safe: true`
- **AND** the owner explicitly enables a per-connection schedule
- **THEN** the reference SHALL accept the schedule mutation
- **AND** the resulting connection SHALL be treated as scheduled rather than
  as an always-manual connection
- **AND** the connector SHALL remain manual-by-default for boot-time
  auto-enrollment.

#### Scenario: Manual-default connection without an owner schedule remains manual

- **WHEN** an owner configures a connection whose manifest declares
  `recommended_mode: "manual"` and `background_safe: true`
- **AND** no owner-created schedule has been enabled for that connection
- **THEN** the connection SHALL remain manual
- **AND** the reference SHALL NOT auto-enroll it on boot.

#### Scenario: Paused and background-unsafe connectors remain unschedulable

- **WHEN** a connection's manifest declares `recommended_mode: "paused"` or
  `background_safe: false`
- **THEN** the reference SHALL reject enabled background schedule creation
- **AND** it SHALL NOT treat that connection as owner-schedulable by default.

## MODIFIED Requirements

### Requirement: Schedules and active-run leases SHALL be instance-scoped

The reference scheduler and controller SHALL treat connector schedules and
active-run leases as connector-instance resources rather than connector-type
resources.

#### Scenario: One Gmail account is paused

- **WHEN** the owner pauses the schedule for one Gmail connector instance
- **THEN** the reference SHALL stop automatic runs for that instance
- **AND** it SHALL NOT pause or disable schedules for other Gmail connector
  instances unless the owner explicitly targets them.

#### Scenario: Two instances run concurrently

- **WHEN** two connector instances with the same `connector_id` are eligible to
  run
- **THEN** an active run for one instance SHALL NOT block the other solely
  because the connector type matches
- **AND** each instance SHALL still enforce its own active-run lease and retry
  policy.
