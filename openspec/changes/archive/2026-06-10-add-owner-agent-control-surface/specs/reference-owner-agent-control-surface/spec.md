## ADDED Requirements

### Requirement: Owner-agent credentials SHALL authorize an explicit owner REST control surface

The reference implementation SHALL expose a documented owner-agent REST control surface for trusted local agents that have completed owner-agent onboarding. The surface SHALL be separate from grant-scoped MCP and SHALL require explicit owner-agent bearer authorization for bearer-based access.

#### Scenario: Trusted owner agent discovers control capabilities

- **WHEN** a trusted owner agent reads the reference instance metadata after onboarding
- **THEN** the metadata SHALL advertise the owner-agent control surface entrypoint
- **AND** it SHALL identify supported owner-agent action families without exposing secrets

#### Scenario: Owner bearer is used on MCP

- **WHEN** a client presents an owner-agent bearer to `/mcp`
- **THEN** the reference implementation SHALL reject the bearer for MCP tool access
- **AND** the response SHALL point the client toward grant-scoped MCP or owner-agent REST control as appropriate

### Requirement: Owner-agent control SHALL distinguish connector templates from connection instances

The owner-agent control surface SHALL expose connector templates separately from configured connection instances. Connector templates SHALL identify connector implementation metadata. Connection instances SHALL identify owner-approved bindings using `connection_id` and SHALL include the connector type identity that produced them.

#### Scenario: Owner agent lists Amazon state

- **WHEN** the owner has one configured Amazon connection
- **THEN** the owner-agent connection listing SHALL include a connection row with `connection_id`
- **AND** the row SHALL include connector type identity such as `connector_id` or `connector_key` equal to `amazon`
- **AND** the row SHALL include an owner-visible `display_name`

#### Scenario: Owner has two Amazon accounts

- **WHEN** the owner has two configured Amazon connections
- **THEN** both connection rows SHALL share the Amazon connector type identity
- **AND** each row SHALL carry a distinct `connection_id`
- **AND** owner-agent operations SHALL require or resolve to the intended `connection_id` before mutating instance state

### Requirement: Owner-agent control SHALL initiate connections as typed owner-mediated intents

The owner-agent control surface SHALL let a trusted owner agent initiate a new connection through a typed intent. The intent SHALL return the next owner-mediated step instead of silently creating a provider connection or bypassing provider authentication.

#### Scenario: Connector supports OAuth

- **WHEN** a trusted owner agent initiates a connection for an OAuth-backed connector
- **THEN** the reference implementation SHALL create an auditable connection intent
- **AND** the response SHALL include an owner-openable authorization URL or equivalent typed `open_url` step
- **AND** no connection instance SHALL be marked active until the provider authorization completes

#### Scenario: Connector requires browser assistance

- **WHEN** a trusted owner agent initiates a connection for a browser-bound connector
- **THEN** the response SHALL describe the browser-assistance step required from the owner or local environment
- **AND** it SHALL NOT claim that the agent can complete provider login or 2FA by bearer authority alone

#### Scenario: Connector does not support agent initiation

- **WHEN** a trusted owner agent initiates a connection for an unsupported connector
- **THEN** the response SHALL be typed as unsupported
- **AND** it SHALL include a concise reason and any available dashboard or manual next step

### Requirement: Owner-agent control SHALL advertise and enforce per-connection actions

The owner-agent control surface SHALL advertise supported actions for each connector template and connection instance, and SHALL reject unsupported or ambiguous actions with typed errors.

#### Scenario: Agent inspects available actions

- **WHEN** a trusted owner agent lists connection instances
- **THEN** each instance SHALL describe supported owner actions such as rename, run now, schedule, pause, resume, delete, revoke credentials, or inspect diagnostics when available
- **AND** unavailable actions SHALL be omitted or marked unsupported with a typed reason

#### Scenario: Agent targets connector type when instance is ambiguous

- **WHEN** a trusted owner agent requests an instance-scoped action using only `connector_id`
- **AND** more than one active connection exists for that connector type
- **THEN** the reference implementation SHALL reject the request with a typed ambiguity error
- **AND** it SHALL include the available `connection_id` values and retry guidance

### Requirement: Owner-agent control SHALL advertise owner-agent-capable surface families honestly

The owner-agent control surface SHALL advertise as `supported` any non-connection-scoped action family whose routes already accept a trusted owner-agent bearer, so the control catalog is a complete discovery source and a trusted owner agent never has to read route source to find an owner-agent-usable capability. Advertising such a family SHALL NOT widen `/mcp`: the routes remain reachable only over the REST control plane, and `/mcp` SHALL continue to reject owner bearers.

#### Scenario: Owner agent discovers event-subscription management

- **WHEN** a trusted owner agent reads the owner-agent control capability document
- **THEN** it SHALL include an event-subscription management family marked `supported`
- **AND** the family SHALL point at the `/v1/event-subscriptions` route family that already accepts a trusted owner-agent bearer
- **AND** the advertised family SHALL NOT be projected onto any single connection's per-connection action list, because it is not bound to one connection

#### Scenario: Advertised surface family does not widen MCP

- **WHEN** a trusted owner agent presents its owner-agent bearer to `/mcp`
- **THEN** the reference implementation SHALL reject the bearer for MCP tool access
- **AND** advertising the event-subscription family in the REST control catalog SHALL NOT make those routes reachable over `/mcp` with an owner bearer

### Requirement: Owner-agent control mutations SHALL be auditable and secret-safe

Owner-agent control mutations SHALL record non-secret audit evidence including actor kind, client identity, target resource, operation, and outcome. Audit evidence SHALL NOT include bearer tokens, provider credentials, callback secrets, raw uploaded files, or provider session cookies.

#### Scenario: Owner agent renames a connection

- **WHEN** a trusted owner agent renames a connection display name
- **THEN** the mutation SHALL record that an owner-agent client performed the rename
- **AND** subsequent owner-agent and read surfaces SHALL expose the updated `display_name`

#### Scenario: Mutation fails

- **WHEN** a trusted owner agent attempts a control mutation that fails validation or authorization
- **THEN** the response SHALL use a typed error envelope
- **AND** audit evidence SHALL record the failed operation without logging secrets
