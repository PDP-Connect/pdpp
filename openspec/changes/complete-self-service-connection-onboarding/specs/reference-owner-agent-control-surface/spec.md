## ADDED Requirements

### Requirement: Owner-agent setup intents SHALL project the shared setup engine without exposing secrets

The owner-agent control surface SHALL initiate connector setup by projecting the
shared owner-mediated setup engine. It SHALL return typed next steps, support
states, deployment-readiness requirements, and proof-gate reasons, but SHALL NOT
return provider credentials, owner-session credentials, browser session
credentials, or grant-scoped MCP tokens.

#### Scenario: Owner agent initiates a supported setup flow

- **WHEN** a trusted owner agent initiates setup for a connector whose setup path
  is supported in the current deployment context
- **THEN** the response SHALL include a typed next-step kind from the setup
  engine
- **AND** the response SHALL identify whether the owner must open a URL, enroll a
  collector, capture a credential through an owner surface, upload a file, or
  complete another owner-mediated action
- **AND** it SHALL NOT include any provider secret or owner-session bearer

#### Scenario: Owner agent initiates a proof-gated connector

- **WHEN** a trusted owner agent initiates setup for a connector whose setup path
  exists only behind a live-proof gate
- **THEN** the response SHALL be typed as proof-gated or unsupported with a
  concise reason and documentation pointer
- **AND** it SHALL NOT advertise a connection as active or supported before the
  proof gate is closed

#### Scenario: Owner bearer is presented to MCP for setup

- **WHEN** a caller presents an owner-agent bearer to `/mcp` in order to add or
  manage connections
- **THEN** the reference SHALL reject the bearer for MCP tool access
- **AND** it SHALL point the caller toward owner-agent REST, console, or CLI
  setup surfaces as appropriate

### Requirement: Owner-agent setup SHALL distinguish connector templates, setup plans, drafts, and active connections

The owner-agent control surface SHALL distinguish connector templates from setup
plans, setup plans from draft or pending setup state, and draft/pending setup
state from active connections. It SHALL NOT report a connector as an active
connection merely because a setup intent was created.

#### Scenario: Intent returns an owner next step

- **WHEN** a trusted owner agent creates a setup intent and the owner has not yet
  completed the required owner-mediated step
- **THEN** the response SHALL identify the setup intent or next step as pending
  setup
- **AND** connection read surfaces SHALL NOT show a new active connection unless
  the connector instance lifecycle has crossed its activation proof boundary

#### Scenario: Setup fails before activation

- **WHEN** setup fails before the activation proof boundary
- **THEN** owner-agent status SHALL return a typed failed or blocked setup state
  with non-secret remediation guidance
- **AND** it SHALL NOT leave behind a visible zero-record active connection as a
  false success
