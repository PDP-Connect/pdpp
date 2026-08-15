## ADDED Requirements

### Requirement: Setup terminal evidence SHALL use composite run identity

The reference implementation SHALL resolve setup terminal evidence by the pair
`(connector_instance_id, run_id)` when a run id is supplied, and SHALL resolve
the latest terminal product run from `run_history` scoped to the addressed
connection when no run id is supplied. A global run-id-only terminal read SHALL
not be used for setup status.

#### Scenario: Duplicate run ids remain isolated

- **WHEN** two connections have terminal run-history rows with the same `run_id`
- **THEN** each setup-status request SHALL return only its own connection's row

#### Scenario: Revisiting without a run id is durable

- **WHEN** an owner revisits setup status without `run_id` after terminal success
- **THEN** the connection's latest durable run-history row SHALL supply the
  terminal setup disposition
