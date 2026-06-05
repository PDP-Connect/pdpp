## ADDED Requirements

### Requirement: Run detail SHALL expose an active-run cancel control

The operator dashboard run detail surface SHALL expose an owner-visible control to cancel the run it is displaying, when and only when that run is active (no terminal `run.completed` / `run.failed` / `run.cancelled` / `run.abandoned` event has been recorded). Activating the control SHALL request single-run cancellation over the existing owner-session reference route `POST /_ref/runs/{run_id}/cancel`. The control SHALL NOT be rendered for a run that has already reached a terminal state.

The control SHALL be non-destructive in presentation and effect: its copy SHALL state that it stops only the current run and preserves already-collected records, the connection's schedule, grants, and configuration, and SHALL distinguish this from revoking (stop future collection) or deleting (erase the past) the connection.

#### Scenario: Active run shows a cancel control

- **WHEN** an operator opens the run detail page for a run that has no terminal spine event
- **THEN** the page SHALL render a cancel control for that run
- **AND** the control's copy SHALL state that it stops only the current run and preserves already-collected records, schedule, grants, and configuration

#### Scenario: Terminal run shows no cancel control

- **WHEN** an operator opens the run detail page for a run that has already recorded a terminal event
- **THEN** the page SHALL NOT render a cancel control

#### Scenario: Cancelling requires confirmation and requests cancellation

- **WHEN** an operator activates the cancel control on an active run
- **THEN** the dashboard SHALL require an explicit confirmation before issuing the request
- **AND** upon confirmation it SHALL call `POST /_ref/runs/{run_id}/cancel` for that concrete `run_id` with the owner session
- **AND** on a `202` acknowledgement it SHALL reflect that cancellation was requested and that the run will stop shortly

#### Scenario: Cancel races a run that just reached terminal

- **WHEN** an operator confirms cancellation but the run has already reached a terminal state (`409 run_already_terminal`) or is no longer active (`404 no_active_run`)
- **THEN** the dashboard SHALL reflect that the run already reached a terminal state rather than presenting a generic error boundary
- **AND** it SHALL refresh the run detail so the now-terminal status and the absence of the cancel control are shown
