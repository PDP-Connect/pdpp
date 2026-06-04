## ADDED Requirements

### Requirement: Local collector bounds retained acknowledged outbox work automatically

The local collector runner SHALL bound the number of acknowledged
(server-confirmed `succeeded`) rows retained in the durable local outbox, as an
intrinsic part of a normal run, without requiring a separate timer, schedule, or
operator command for correctness. After a drain attempt completes, the runner
SHALL prune retained acknowledged rows that exceed a conservative bound defined
by BOTH a most-recent-count floor AND an age floor, so that a row is removed
only when it is both outside the most-recent retained set AND older than the age
floor. The prune SHALL operate only on acknowledged rows and SHALL NOT remove
pending/ready, leased, retryable, or dead-letter work. The automatic prune SHALL
NOT create a database backup file on each run. The runner SHALL expose how many
acknowledged rows the prune reclaimed on its run result so the reclaimed count
is visible for diagnostics. An operator SHALL be able to disable or retune the
bound through run configuration or environment without rebuilding the collector,
and a malformed override SHALL NOT prevent the run from completing.

#### Scenario: A clean run accumulates acknowledged rows beyond the bound

- **WHEN** a local collector completes a drain and the durable outbox retains
  acknowledged rows that exceed both the most-recent-count floor and the age
  floor for the run's source instance
- **THEN** the runner SHALL remove the acknowledged rows that exceed both floors
- **AND** it SHALL retain the rows within either floor
- **AND** it SHALL report the number of acknowledged rows reclaimed on the run
  result

#### Scenario: A run leaves undelivered work behind

- **WHEN** a local collector completes a drain attempt that leaves
  pending/ready, leased, retryable, or dead-letter rows in the durable outbox
- **THEN** the automatic prune SHALL NOT remove any of those rows
- **AND** it SHALL remove only acknowledged rows that exceed the configured
  bound

#### Scenario: Acknowledged rows are within the bound

- **WHEN** a local collector completes a drain and the retained acknowledged
  rows are within the most-recent-count floor or younger than the age floor
- **THEN** the runner SHALL retain those acknowledged rows
- **AND** it SHALL report that no acknowledged rows were reclaimed

#### Scenario: An operator disables or retunes the automatic prune

- **WHEN** an operator disables the automatic prune, or retunes its
  most-recent-count or age floor, through run configuration or environment on a
  deployed collector
- **THEN** the runner SHALL honor the override without requiring a rebuild
- **AND** when disabled it SHALL retain all acknowledged rows and report that
  the automatic prune did not run
- **AND** a malformed override value SHALL fall back to the lower-precedence
  setting rather than fail the run

#### Scenario: The automatic prune runs without a per-run backup

- **WHEN** the automatic prune removes acknowledged rows during a normal run
- **THEN** it SHALL NOT write a database backup file for that prune
- **AND** the removal SHALL be bounded by both the most-recent-count floor and
  the age floor so it can never remove all acknowledged rows in one pass
