> Superseded by `add-mock-reference-demo-instance`. Do not archive this delta as canonical without first reconciling it
> with the mock-owner dashboard direction.

## MODIFIED Requirements

### Requirement: A sandbox surface SHALL be mock-backed and pedagogical

Any public sandbox surface SHALL be mock-backed, resettable, and clearly labeled as simulated. It SHALL teach protocol flows and API shapes without collecting real platform credentials or presenting itself as a live owner reference instance. The primary `/sandbox` entry point SHALL provide at least one functional, end-to-end simulated PDPP walkthrough rather than only describing planned future sandbox behavior.

#### Scenario: A visitor opens the sandbox
- **WHEN** a visitor uses `/sandbox/**`
- **THEN** the surface SHALL use mock or seeded data
- **AND** the visitor SHALL be told that the environment is simulated and resettable
- **AND** the sandbox SHALL NOT request real connector credentials or imply that it stores real owner data

#### Scenario: Sandbox UI reuses dashboard components
- **WHEN** sandbox pages reuse components from the live dashboard
- **THEN** the sandbox SHALL retain distinct chrome or labeling so users can distinguish simulated education from live operation

#### Scenario: A visitor completes a simulated flow
- **WHEN** a visitor follows the primary sandbox walkthrough
- **THEN** the sandbox SHALL demonstrate a coherent PDPP flow across request, owner decision, scoped data access, revocation, and post-revocation refusal
- **AND** the flow SHALL be interactive enough that the visible state changes in response to the visitor's choices

#### Scenario: A visitor inspects integration shape
- **WHEN** the sandbox presents a simulated protocol step
- **THEN** the sandbox SHALL expose an inspectable API-shaped request, response, event, or timeline example for that step
- **AND** the example SHALL be labeled as simulated rather than captured from a live owner instance

#### Scenario: A visitor resets the sandbox
- **WHEN** the visitor activates reset
- **THEN** the sandbox SHALL return to its seeded initial state without requiring server-side cleanup or real account action
