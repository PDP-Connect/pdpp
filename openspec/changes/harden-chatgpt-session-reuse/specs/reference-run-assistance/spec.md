## MODIFIED Requirements

### Requirement: Dashboard assistance UX is derived from state
The reference dashboard SHALL derive assistance copy and controls from the structured assistance fields and run terminal state rather than from connector-specific string matching or from the presence of a pending interaction alone.

#### Scenario: Browser surface is needed but no response is required
- **WHEN** the current assistance has progress posture `blocked`, owner action `operate_attachment`, response obligation `none`, and a `browser_surface` attachment
- **THEN** the dashboard SHALL render the streaming companion entry point and browser-control instructions
- **AND** it SHALL NOT render a submit, continue, or interaction-response control
- **AND** the run SHALL continue to rely on connector-observed completion rather than an owner-submitted response
