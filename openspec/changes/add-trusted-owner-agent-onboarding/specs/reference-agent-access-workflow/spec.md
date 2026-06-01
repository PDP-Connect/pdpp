## MODIFIED Requirements

### Requirement: Agent assistants SHALL use scoped client grants instead of owner tokens

The reference implementation SHALL provide a documented agent access workflow in which routine third-party, coding-agent, and task-scoped assistants request and use scoped PDPP client grants rather than owner bearer tokens for data access. A trusted local owner-agent profile MAY exist separately, but it SHALL be labeled as owner-level local automation and SHALL NOT be presented as the default path for ordinary agents.

#### Scenario: Agent requests data access
- **WHEN** an agent needs PDPP data for a user task and is not explicitly operating as a trusted local owner agent
- **THEN** it SHALL request a client grant scoped to the needed source, streams, fields/views, time range, retention, and access mode
- **AND** it SHALL NOT ask the user for an owner bearer token as the default path

#### Scenario: Agent needs broader access later
- **WHEN** an existing grant is insufficient for a later task
- **THEN** the agent SHALL request an explicit upgrade or additional grant
- **AND** it SHALL NOT silently broaden access or fall back to owner authority

#### Scenario: Trusted local owner agent is selected
- **WHEN** the owner explicitly chooses a trusted local owner-agent onboarding flow
- **THEN** the workflow SHALL identify the resulting credential as owner-level local automation
- **AND** it SHALL distinguish that profile from grant-scoped client access
- **AND** it SHALL NOT imply that owner bearer credentials are appropriate for external MCP clients or routine task-scoped agents

## ADDED Requirements

### Requirement: Trusted owner-agent onboarding SHALL be discoverable from metadata

The reference implementation SHALL publish advisory discovery information for trusted local owner agents when owner-agent onboarding is supported. The advisory information SHALL be reachable from the same entrypoint and `.well-known` metadata that an agent can discover before it has a token.

#### Scenario: Local owner agent starts from the resource root
- **WHEN** a trusted local owner agent fetches the reference Resource Server root pointer or protected-resource metadata
- **THEN** the response SHALL identify the trusted owner-agent onboarding profile when supported
- **AND** it SHALL link to the owner approval, schema, stream discovery, query, token introspection, revocation, and event-subscription discovery surfaces needed for onboarding and ongoing sync

#### Scenario: Owner-agent onboarding is unavailable
- **WHEN** a deployment cannot issue owner-agent credentials safely
- **THEN** the reference SHALL omit the trusted owner-agent onboarding advisory block
- **AND** it SHALL continue to advertise the grant-scoped agent workflow where that workflow is supported

### Requirement: The agent-readable entrypoint SHALL point trusted owner agents at owner-agent onboarding

The reference public-site/operator deployment SHALL serve a compact agent-readable entrypoint at `/llms.txt` that, in addition to the grant-scoped agent skill, points a trusted local owner agent at the owner-agent onboarding surfaces without requiring it to guess a universal URL. The entrypoint SHALL reference the canonical OAuth protected-resource metadata as the live source of owner-agent onboarding fields, the owner-agent onboarding/device-flow guidance, the grant-scoped MCP boundary, and the owner REST/CLI guidance, and SHALL state that bearer tokens are not to be pasted into chat or terminals.

#### Scenario: Trusted owner agent reads the entrypoint

- **WHEN** a trusted local owner agent fetches `/llms.txt` from a reference deployment
- **THEN** the response SHALL be compact agent-readable text or markdown
- **AND** it SHALL point to the canonical OAuth protected-resource metadata, the owner-agent onboarding/device flow, grant-scoped MCP guidance, and owner-agent REST/CLI guidance
- **AND** it SHALL state that bearer tokens are not to be pasted into chat or terminals
- **AND** it SHALL distinguish the owner-level local-automation profile from the default grant-scoped agent path

#### Scenario: Agent probes the well-known namespace

- **WHEN** an agent requests `/.well-known/llms.txt`
- **THEN** the deployment SHALL serve the same compact entrypoint as `/llms.txt` rather than requiring the agent to guess one universal URL

### Requirement: Trusted owner-agent guidance SHALL teach token-efficient local sync

The reference implementation SHALL provide owner-agent guidance that teaches local agents to discover schema and stream metadata before reading data and to maintain incremental state instead of repeatedly scanning every record.

#### Scenario: Daisy receives an owner-agent credential
- **WHEN** a trusted local owner agent receives an owner-level credential
- **THEN** the guidance SHALL direct it to fetch `/v1/schema` and stream metadata before issuing record queries
- **AND** it SHALL direct it to store per-stream and per-connection cursors locally
- **AND** it SHALL prefer `changes_since`, pagination, declared filters, field projections, and blob references over broad unbounded scans

#### Scenario: Local agent wants future updates
- **WHEN** a trusted local owner agent needs to keep its local view current
- **THEN** the guidance SHALL direct it to use event subscriptions only when it has a durable reachable HTTPS callback
- **AND** it SHALL otherwise use cursor polling with backoff and periodic schema refresh
