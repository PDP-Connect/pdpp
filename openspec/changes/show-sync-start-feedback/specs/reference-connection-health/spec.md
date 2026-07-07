## MODIFIED Requirements

### Requirement: Owner Surfaces SHALL Share One Projection Contract

Dashboard, CLI, and owner-control-plane API surfaces SHALL consume the same connection health projection and condition contract.

Owner-console surfaces that expose owner-triggered run controls SHALL render the accepted-start result returned by the reference control action as local, connection-scoped feedback. When that result includes a run id, the owner console SHALL expose a link to the corresponding sync detail. The console SHALL NOT rely solely on a later active-run projection refresh to prove that the click worked, because short runs can start and complete before the refreshed projection observes them as active.

#### Scenario: Fast owner-triggered sync returns a run id

- **WHEN** the owner clicks a source-detail sync control
- **AND** the reference accepts the request and returns a run id
- **THEN** the console SHALL render local confirmation that the sync started
- **AND** it SHALL link to the sync detail for that run id

#### Scenario: Fast sync completes before active projection refresh

- **WHEN** an accepted sync starts and completes before the next health projection refresh observes it as active
- **THEN** the owner console SHALL still show accepted-start feedback from the control action result
- **AND** the source-detail sync button SHALL NOT remain disabled by stale optimistic running state
