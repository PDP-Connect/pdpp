## MODIFIED Requirements

### Requirement: Browser-surface assistance can mint a stream without an interaction
The reference implementation SHALL allow an owner to open the streaming companion for current no-response browser-surface assistance without requiring a pending interaction response. The reference implementation SHALL also attach a pending browser interaction to the run's ready managed browser-surface lease when such a lease exists, instead of requiring a separate connector-registered streaming target.

#### Scenario: No-response browser assistance has a ready leased surface
- **WHEN** a run has current assistance with response obligation `none`, owner action `operate_attachment`, and a `browser_surface` attachment
- **AND** a ready browser-surface lease is active for that run
- **AND** the owner requests a stream session using that assistance id
- **THEN** the reference implementation SHALL mint a stream session for the leased browser surface
- **AND** it SHALL NOT require `run.interaction_required` to be pending
- **AND** it SHALL reject stale assistance ids or missing/non-ready browser surfaces

#### Scenario: Pending browser interaction has a ready managed surface
- **WHEN** a run has a pending browser interaction
- **AND** a ready managed browser-surface lease is active for that run
- **AND** the owner requests a stream session using that interaction id
- **THEN** the reference implementation SHALL mint a stream session for the leased browser surface
- **AND** it SHALL NOT require a separate connector-registered CDP target for that interaction
