## MODIFIED Requirements

### Requirement: Scheduler SHALL preserve runtime results and avoid unsafe retries

The reference scheduler SHALL preserve runtime result metadata in history, stop overlapping attempts for the same connection, avoid unsafe retries for deterministic failures, and bound each direct connector attempt with a progress watchdog so active-run state cannot remain open indefinitely after the attempt stops making progress. A scheduler-direct active attempt SHALL be cancellable through the same runtime cancellation signal used by the owner run-cancel route, and scheduler history SHALL preserve a runtime `cancelled` terminal status without coercing it to `failed`.

#### Scenario: Scheduled direct run is cancelled by the owner
- **WHEN** a scheduler-direct connector attempt is active
- **AND** the owner requests cancellation for that run id through the reference run-cancel route
- **THEN** the scheduler SHALL request cancellation for only that connector attempt
- **AND** the runtime SHALL record `run.cancel_requested`
- **AND** the runtime SHALL record terminal `run.cancelled` with an owner-cancel reason
- **AND** scheduler history SHALL store status `cancelled`
- **AND** the durable active-run row for that connection SHALL be cleared

#### Scenario: Scheduled direct run exceeds its progress watchdog budget
- **WHEN** a scheduler-managed direct connector attempt emits no valid progress for the configured watchdog budget before reaching a terminal runtime result
- **THEN** the scheduler SHALL request cancellation for that connector attempt
- **AND** it SHALL persist a terminal failed run record with a timeout reason
- **AND** it SHALL clear the durable active-run row for that connection

#### Scenario: Scheduled direct run keeps making progress
- **WHEN** a scheduler-managed direct connector attempt runs longer than the configured watchdog budget
- **AND** it emits valid connector progress before the watchdog expires
- **THEN** the scheduler SHALL keep the attempt active
- **AND** it SHALL NOT fail the run solely because elapsed wall-clock exceeded the watchdog interval
