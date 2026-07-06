## MODIFIED Requirements

### Requirement: Run detail SHALL expose active-run cancellation

The operator dashboard run detail surface SHALL expose an owner-visible control to cancel the run it is displaying, when and only when that run is active (no terminal `run.completed` / `run.failed` / `run.cancelled` / `run.abandoned` event has been recorded). Activating the control SHALL request single-run cancellation over the existing owner-session reference route `POST /_ref/runs/{run_id}/cancel`. The control SHALL NOT be rendered for a run that has already reached a terminal state. The route SHALL cancel any active run for which the reference server owns a cancellation handle, including controller-managed runs and scheduler-direct runs.

#### Scenario: Cancelling requires confirmation and requests cancellation
- **WHEN** the owner opens a run detail page for an active run
- **THEN** the surface SHALL offer a cancel control behind an explicit confirmation
- **AND** confirming SHALL call `POST /_ref/runs/{run_id}/cancel`
- **AND** on a `202` acknowledgement it SHALL reflect that cancellation was requested and that the run will stop shortly

#### Scenario: Already-terminal or unknown run does not pretend to cancel
- **WHEN** an operator confirms cancellation but the run has already reached a terminal state (`409 run_already_terminal`) or is no longer active (`404 no_active_run`)
- **THEN** the surface SHALL show that the run is no longer cancellable
- **AND** it SHALL prompt the owner to refresh the run timeline rather than presenting the cancellation as accepted
