## MODIFIED Requirements

### Requirement: Dashboard assistance UX is derived from state
The reference dashboard SHALL derive assistance copy and controls from the structured assistance fields and run terminal state rather than from connector-specific string matching or from the presence of a pending interaction alone.

Browser-surface deferrals SHALL be terminal but SHALL NOT be rendered as connector failures. When a browser-backed run reaches a run-status handle state of `deferred` before connector execution starts, owner run surfaces SHALL present the state as secure-browser capacity/backpressure and SHALL disable active-run polling and cancellation controls. Browser setup failures such as `surface_failed` SHALL continue to render as failed.

#### Scenario: Browser surface is needed but no response is required
- **WHEN** the current assistance has progress posture `blocked`, owner action `operate_attachment`, response obligation `none`, and a `browser_surface` attachment
- **THEN** the dashboard SHALL render the streaming companion entry point and browser-control instructions
- **AND** it SHALL NOT render a submit, continue, or interaction-response control
- **AND** the run SHALL continue to rely on connector-observed completion rather than an owner-submitted response

#### Scenario: Browser capacity defers a run before connector execution
- **WHEN** a run-status handle reports `status=deferred`
- **AND** the run has no Collection Profile terminal event
- **THEN** the dashboard SHALL treat the run attempt as terminal for polling and cancellation controls
- **AND** it SHALL present the state as a secure-browser slot deferral rather than a failed connector run.

#### Scenario: Browser setup failure remains failed
- **WHEN** a run-status handle reports `status=surface_failed`
- **THEN** the dashboard SHALL continue to present the run as failed.
