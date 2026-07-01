## MODIFIED Requirements

### Requirement: Dashboard assistance UX is derived from state
The reference dashboard SHALL derive assistance copy and controls from the structured assistance fields and run terminal state rather than from connector-specific string matching or from the presence of a pending interaction alone.

#### Scenario: Browser surface is needed but no response is required
- **WHEN** the current assistance has progress posture `blocked`, owner action `operate_attachment`, response obligation `none`, and a `browser_surface` attachment
- **THEN** the dashboard SHALL render the streaming companion entry point and browser-control instructions
- **AND** it SHALL NOT render a submit, continue, or interaction-response control
- **AND** the run SHALL continue to rely on connector-observed completion rather than an owner-submitted response

## ADDED Requirements

### Requirement: Browser-surface assistance can mint a stream without an interaction
The reference implementation SHALL allow an owner to open the streaming companion for current no-response browser-surface assistance without requiring a pending interaction response.

#### Scenario: No-response browser assistance has a ready leased surface
- **WHEN** a run has current assistance with response obligation `none`, owner action `operate_attachment`, and a `browser_surface` attachment
- **AND** a ready browser-surface lease is active for that run
- **AND** the owner requests a stream session using that assistance id
- **THEN** the reference implementation SHALL mint a stream session for the leased browser surface
- **AND** it SHALL NOT require `run.interaction_required` to be pending
- **AND** it SHALL reject stale assistance ids or missing/non-ready browser surfaces
