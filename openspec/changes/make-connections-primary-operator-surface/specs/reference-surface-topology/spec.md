## ADDED Requirements

### Requirement: Operator dashboard SHALL expose Connections as a primary control surface

The operator dashboard SHALL present existing data-source connections as a primary operator section, not only as a subordinate Explore workspace. The Connections surface SHALL be the place an operator discovers connection identity, status, and owner-run controls.

#### Scenario: Operator views dashboard navigation

- **WHEN** an operator views the dashboard primary navigation
- **THEN** the navigation SHALL include a top-level item labeled "Connections" that links to the connection list
- **AND** the "Explore" navigation item SHALL remain scoped to record-content search, time-range browsing, and recency feed behavior
- **AND** the "Jump" navigation item SHALL remain scoped to spine artifact id lookup

#### Scenario: Operator opens the Connections surface

- **WHEN** an operator opens the Connections surface
- **THEN** the surface SHALL show existing connection identity, status, and owner actions without requiring the operator to enter the Explore workspace first

### Requirement: Existing owner-runnable connections SHALL expose a run-now control

When an existing connection is runnable through the owner control surface and no active run is already present, the dashboard SHALL expose a run-now control for that connection. Browser-bound existing connections SHALL NOT be categorically hidden behind setup runbook guidance; if starting the run requires browser assistance, that assistance SHALL be surfaced by the run timeline after the run starts.

#### Scenario: Browser-bound existing connection can start a run

- **WHEN** the dashboard renders an existing browser-bound connection such as ChatGPT and that connection has no active run
- **THEN** the dashboard SHALL render a run-now control for that connection
- **AND** activating the control SHALL call the owner connection-run path for that concrete connection
- **AND** any required browser/manual assistance SHALL be handled by the run assistance surface rather than by suppressing the run control

#### Scenario: Push-mode local-device connection remains non-clickable

- **WHEN** the dashboard renders a push-mode local-device connection whose data arrives from a paired local collector
- **THEN** the dashboard SHALL NOT render a remote run-now control
- **AND** it SHALL render guidance that the owner must run or inspect the local collector on the host that holds the data
