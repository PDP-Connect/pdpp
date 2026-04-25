## MODIFIED Requirements

### Requirement: A sandbox surface SHALL be mock-backed and pedagogical

Any public sandbox surface SHALL be mock-backed, resettable, and clearly labeled as simulated. It SHALL teach protocol flows, API shapes, and reference-instance behavior without collecting real platform credentials or presenting itself as a live owner reference instance. A sandbox route family MAY include both lightweight guided walkthroughs and a mock reference demo instance, but it SHALL keep both distinct from the live `/dashboard/**` operator surface.

#### Scenario: A visitor opens the sandbox
- **WHEN** a visitor uses `/sandbox/**`
- **THEN** the surface SHALL use mock or seeded data
- **AND** the visitor SHALL be told that the environment is simulated and resettable
- **AND** the sandbox SHALL NOT request real connector credentials or imply that it stores real owner data

#### Scenario: Sandbox UI reuses dashboard components
- **WHEN** sandbox pages reuse components from the live dashboard
- **THEN** the sandbox SHALL retain distinct chrome or labeling so users can distinguish simulated education from live operation
- **AND** the live `/dashboard/**` owner-auth and live-reference behavior SHALL NOT be weakened to support the demo

#### Scenario: Sandbox hosts a mock reference demo instance
- **WHEN** `/sandbox/**` presents dashboard-like or API-like reference behavior
- **THEN** the behavior SHALL be backed by deterministic mock state
- **AND** the route family SHALL make clear that it is a demo reference instance rather than a hosted live owner dashboard
