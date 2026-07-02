## MODIFIED Requirements

### Requirement: Scheduler SHALL preserve runtime results and avoid unsafe retries

The reference scheduler SHALL preserve runtime result metadata in history, stop overlapping attempts for the same connection, avoid unsafe retries for deterministic failures, and bound each direct connector attempt so active-run state cannot remain open indefinitely after the attempt stops making progress.

#### Scenario: Scheduled direct run exceeds its wall-clock budget
- **WHEN** a scheduler-managed direct connector attempt exceeds the configured wall-clock budget before reaching a terminal runtime result
- **THEN** the scheduler SHALL request cancellation for that connector attempt
- **AND** it SHALL persist a terminal failed run record with a timeout reason
- **AND** it SHALL clear the durable active-run row for that connection
