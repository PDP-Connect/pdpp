## ADDED Requirements

### Requirement: Local Docker browser-backed connector deployments SHALL use an explicit host-browser bridge

When the reference implementation runs browser-backed connectors inside a local Docker deployment, it SHALL NOT silently launch an inaccessible headed browser inside the container. The deployment SHALL either use an explicitly configured host-browser bridge or report that browser interaction is unavailable.

#### Scenario: A Dockerized connector needs host browser interaction
- **WHEN** a browser-backed connector running in Docker requires owner interaction in a browser
- **THEN** the reference implementation SHALL use an explicitly configured local host-browser bridge
- **AND** the visible browser SHALL run on the owner's host machine
- **AND** the owner SHALL interact with that host browser directly.

#### Scenario: No host-browser bridge is configured
- **WHEN** a Dockerized browser-backed connector requires browser interaction
- **AND** no host-browser bridge is configured
- **THEN** the run SHALL fail or pause with an actionable deployment message
- **AND** it SHALL NOT appear to wait indefinitely for an invisible browser.

#### Scenario: A host profile is selected
- **WHEN** the host-browser bridge launches or attaches to a browser profile
- **THEN** the default profile SHALL be a dedicated PDPP profile
- **AND** the owner's daily Chrome profile SHALL only be used through an explicit operator override.
