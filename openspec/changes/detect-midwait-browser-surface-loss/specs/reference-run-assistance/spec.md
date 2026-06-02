# reference-run-assistance Specification Delta

## ADDED Requirements

### Requirement: Runtime SHALL detect and report browser-surface availability failure during an open interaction

The reference runtime SHALL monitor the browser surface during any open interaction that requires browser control and SHALL fail the interaction fail-closed if the surface becomes unavailable before the owner responds.

#### Scenario: Surface becomes unavailable during manual_action wait
- **WHEN** a connector emits a `manual_action` INTERACTION and the browser surface passes the preflight readiness probe
- **AND** the surface becomes unreachable (CDP endpoint stops responding) before the owner submits a response
- **THEN** the reference runtime SHALL detect the surface loss via periodic polling
- **AND** it SHALL emit a `run.browser_surface_lost` event with the typed probe failure code and detail
- **AND** it SHALL resolve the interaction as `cancelled` without waiting for owner input
- **AND** it SHALL NOT deliver a response to the connector that implies the owner completed the action

#### Scenario: Surface loss prevents re-prompt
- **WHEN** a `run.browser_surface_lost` event has been emitted for an interaction
- **AND** an owner attempts to submit a response for that same interaction id
- **THEN** the reference runtime SHALL reject the response with `no_pending_interaction`
- **AND** it SHALL NOT deliver that response to the connector

#### Scenario: Non-browser interactions are unaffected
- **WHEN** a connector emits an `otp` or `credentials` INTERACTION without a browser surface
- **THEN** the reference runtime SHALL NOT run a mid-wait surface loss detector
- **AND** the interaction SHALL wait for owner response or connector-specified timeout as normal
