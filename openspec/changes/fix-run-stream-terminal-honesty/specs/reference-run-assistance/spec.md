## MODIFIED Requirements

### Requirement: Dashboard assistance UX is derived from state
The reference dashboard SHALL derive assistance copy and controls from the structured assistance fields and run terminal state rather than from connector-specific string matching or from the presence of a pending interaction alone.

#### Scenario: Owner must approve elsewhere
- **WHEN** the current assistance has progress posture `running`, owner action `act_elsewhere`, and response obligation `none`
- **THEN** the dashboard SHALL show passive waiting copy that explains the external approval
- **AND** it SHALL NOT show a required browser-stream or submit button unless an explicit fallback state is active

#### Scenario: Owner must provide a value
- **WHEN** the current assistance has progress posture `blocked`, owner action `provide_value`, and response obligation `response_required`
- **THEN** the dashboard SHALL render an input form derived from the assistance schema
- **AND** it SHALL treat secret inputs as ephemeral run responses rather than durable credentials

#### Scenario: Owner must operate a browser surface
- **WHEN** the current assistance has progress posture `blocked`, owner action `operate_attachment`, response obligation `response_required`, and a `browser_surface` attachment
- **THEN** the dashboard SHALL render the streaming companion entry point and browser-control instructions

#### Scenario: Assistance is gone because the run failed
- **WHEN** a stream companion page has no current browser assistance
- **AND** the run terminal status is `failed`, `cancelled`, or `abandoned`
- **THEN** the dashboard SHALL NOT render success or recovery copy
- **AND** it SHALL direct the owner to the run timeline for the terminal details

#### Scenario: Assistance is gone but the run is still active
- **WHEN** a stream companion page has no current browser assistance
- **AND** the run has no terminal status
- **THEN** the dashboard SHALL NOT render success or recovery copy
- **AND** it SHALL explain that no browser action is waiting at that moment
