## ADDED Requirements

### Requirement: Trusted owner agents SHALL be distinct from routine scoped agents

The reference implementation SHALL distinguish routine agent assistants that use scoped client grants from trusted owner agents that the owner explicitly approves for owner REST administration. Documentation and metadata SHALL NOT present owner-agent credentials as the default path for ordinary third-party or chat-hosted agents.

#### Scenario: Routine agent requests data

- **WHEN** an ordinary agent needs task-scoped PDPP data
- **THEN** the reference guidance SHALL direct it to request a scoped client grant
- **AND** it SHALL NOT ask the owner to paste or mint an owner bearer as the default path

#### Scenario: Trusted local agent needs administration

- **WHEN** the owner intentionally authorizes a trusted local agent for instance administration
- **THEN** the reference guidance SHALL direct it to the owner-agent onboarding flow
- **AND** it SHALL explain that owner-agent REST can perform owner-visible control operations that scoped MCP grants cannot perform

### Requirement: Owner-agent onboarding metadata SHALL describe control-plane scope

Owner-agent onboarding metadata SHALL describe whether the issued credential supports read-only owner access, event-subscription management, connection management, schedule management, or other owner control actions. The metadata SHALL make unavailable action families explicit.

#### Scenario: Owner-agent credential is issued

- **WHEN** a trusted local agent completes device approval
- **THEN** the non-secret status output SHALL identify the owner-agent profile or action families granted
- **AND** it SHALL identify where the agent can discover owner control routes

#### Scenario: Owner agent discovers token-efficient schema

- **WHEN** a trusted local agent reads the owner-agent onboarding metadata
- **THEN** the metadata SHALL include a `schema_compact_endpoint` for token-efficient schema refreshes
- **AND** it SHALL continue to include `schema_endpoint` for the exhaustive schema document

#### Scenario: Control action is not granted

- **WHEN** a trusted owner agent attempts a control action outside the granted owner-agent profile
- **THEN** the reference implementation SHALL reject the action with a typed authorization error
- **AND** the response SHALL identify the missing action family without exposing secret material
