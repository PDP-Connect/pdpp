## ADDED Requirements

### Requirement: Client conformance uses a black-box fixture channel

The conformance suite SHALL provide a `ClientUnderTest` contract that names authorization, initial synchronization, incremental synchronization, and page-read actions. The suite SHALL own an instrumented authorization-server and resource-server fixture, and SHALL use the fixture's inbound request log as the client-behavior observation.

#### Scenario: Client actions use the fixture

- **WHEN** a client conformance case runs an action
- **THEN** the action SHALL send requests to the fixture through the adapter contract
- **AND** the case SHALL judge the behavior from the fixture response and request log rather than client internals.

### Requirement: Client cases prove their observation

Each client-capture MUST clause covered by the suite SHALL have a matrix case and an injected-defect receipt. The clean client SHALL pass the case, and a deliberately non-conformant client behavior SHALL fail the same case.

#### Scenario: Injected client defect is discriminated

- **WHEN** a case runs with its paired defect enabled
- **THEN** the case SHALL fail
- **AND** the clean client run SHALL pass.
