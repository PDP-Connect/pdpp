# reference-owner-agent-control-surface — Run Cancellation Action

## ADDED Requirements

### Requirement: Owner-agent cancel_run SHALL be a typed, run-scoped, non-destructive control action

The owner-agent control surface SHALL model run cancellation as a run-scoped owner control action that stops a single active connector run by its `run_id` without erasing collected records, schedules, grants, or connection configuration. The `cancel_run` action SHALL be distinct from `run_connection`, `revoke_connection`, and `delete_connection`. While the action is reachable only over the owner-session reference control plane and not yet over the owner-agent bearer REST surface, the catalog SHALL advertise it as a typed action without advertising an owner-agent bearer method or URL it does not yet serve.

#### Scenario: Control catalog advertises cancel_run honestly

- **WHEN** a trusted owner agent reads the owner-agent control capability document
- **THEN** a run-scoped `cancel_run` action SHALL appear with a typed status
- **AND** it SHALL be described as non-destructive and distinct from `run_connection`, `revoke_connection`, and `delete_connection`
- **AND** the catalog SHALL NOT advertise an owner-agent bearer method or URL for `cancel_run` while only the owner-session reference route serves it

#### Scenario: Cancellation does not destroy data or sibling runs

- **WHEN** an owner cancels a single active run
- **THEN** the reference SHALL stop only that run
- **AND** it SHALL preserve that connection's already-collected records, schedule, grants, and configuration
- **AND** it SHALL NOT affect any sibling connection's active run or configuration

#### Scenario: Owner bearer cannot cancel over MCP

- **WHEN** a client presents an owner-agent bearer to `/mcp`
- **THEN** the reference SHALL reject the bearer for MCP tool access
- **AND** defining a `cancel_run` control action SHALL NOT make any cancellation capability reachable over `/mcp` with an owner bearer
