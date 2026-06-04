## ADDED Requirements

### Requirement: Local collector bounds retained acknowledged outbox work automatically

The local collector runner SHALL bound the number of acknowledged
(server-confirmed `succeeded`) rows retained in the durable local outbox, as an
intrinsic part of a normal run, without requiring a separate timer, schedule, or
operator command for correctness. After a drain attempt completes, the runner
SHALL prune acknowledged rows that exceed a most-recent-count cap for the run's
source instance, removing every acknowledged row outside the most-recent
retained set REGARDLESS of how recently it was acknowledged, so that the
retained acknowledged row count can never exceed the configured cap. The prune
SHALL operate only on acknowledged rows and SHALL NOT remove pending/ready,
leased, retryable, or dead-letter work. The automatic prune SHALL NOT create a
database backup file on each run. The runner SHALL expose how many acknowledged
rows the prune reclaimed on its run result, and the outbox counts it reports on
its run result and heartbeat after a run SHALL reflect the post-prune state. An
operator SHALL be able to disable or retune the cap through run configuration or
environment without rebuilding the collector, and a malformed override SHALL NOT
prevent the run from completing.

#### Scenario: A clean run accumulates acknowledged rows beyond the cap

- **WHEN** a local collector completes a drain and the durable outbox retains
  more acknowledged rows than the most-recent-count cap for the run's source
  instance
- **THEN** the runner SHALL remove the acknowledged rows outside the most-recent
  retained set
- **AND** it SHALL retain exactly the most-recent rows up to the cap
- **AND** it SHALL report the number of acknowledged rows reclaimed on the run
  result

#### Scenario: A large acknowledged tail was all acknowledged recently

- **WHEN** a local collector completes a drain and the durable outbox retains
  far more acknowledged rows than the cap, all of which were acknowledged within
  a short recent window
- **THEN** the runner SHALL still remove every acknowledged row outside the
  most-recent retained set, so the recency of acknowledgement does not protect
  rows beyond the cap
- **AND** the retained acknowledged row count SHALL be reduced to the cap on
  that run

#### Scenario: A run leaves undelivered work behind

- **WHEN** a local collector completes a drain attempt that leaves
  pending/ready, leased, retryable, or dead-letter rows in the durable outbox
- **THEN** the automatic prune SHALL NOT remove any of those rows
- **AND** it SHALL remove only acknowledged rows that exceed the cap

#### Scenario: Acknowledged rows are within the cap

- **WHEN** a local collector completes a drain and the retained acknowledged
  rows are within the most-recent-count cap
- **THEN** the runner SHALL retain those acknowledged rows
- **AND** it SHALL report that no acknowledged rows were reclaimed

#### Scenario: An operator disables or retunes the automatic prune

- **WHEN** an operator disables the automatic prune, or retunes its
  most-recent-count cap, through run configuration or environment on a deployed
  collector
- **THEN** the runner SHALL honor the override without requiring a rebuild
- **AND** when disabled it SHALL retain all acknowledged rows and report that
  the automatic prune did not run
- **AND** a malformed override value SHALL fall back to the lower-precedence
  setting rather than fail the run

#### Scenario: The automatic prune runs without a per-run backup

- **WHEN** the automatic prune removes acknowledged rows during a normal run
- **THEN** it SHALL NOT write a database backup file for that prune
- **AND** the removal SHALL be bounded by the most-recent-count cap so it can
  never remove all acknowledged rows in one pass
