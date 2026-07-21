## ADDED Requirements

### Requirement: Schedules and active-run leases SHALL remain instance-scoped and fail closed on conflict

The reference implementation SHALL continue to treat active-run leases as
connector-instance resources. For any `connector_instance_id`, a live active-run
lease SHALL not be overwritten by a concurrent admission attempt. A duplicate
admission SHALL fail closed and SHALL preserve the incumbent lease row until
that run becomes terminal.

#### Scenario: A second attempt cannot replace the live lease

- **WHEN** two run admissions target the same connector instance while the first
  remains live
- **THEN** the second admission SHALL be rejected or coalesced as a neutral
  defer outcome
- **AND** the first run's durable lease SHALL remain the active row
