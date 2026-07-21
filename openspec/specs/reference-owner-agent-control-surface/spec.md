# reference-owner-agent-control-surface Specification

## Purpose
TBD - created by archiving change add-owner-connection-delete-contract. Update Purpose after archive.
## Requirements
### Requirement: Owner-agent connection delete SHALL be a typed, connection-scoped, audited control action

The owner-agent control surface SHALL model connection delete as a connection-scoped owner-agent action that, when implemented, removes one connection's configuration and erases its collected data, and that until implemented is advertised as a typed unsupported action with a reason pointing at the defined cascade contract. The delete action SHALL be authorized by an owner-agent bearer over the REST control plane only, SHALL NOT be reachable over `/mcp`, and SHALL be distinct from the `revoke_connection` action.

#### Scenario: Control catalog advertises delete honestly

- **WHEN** a trusted owner agent reads the owner-agent control capability document and each connection's supported actions
- **THEN** the `delete_connection` action SHALL appear with a typed status
- **AND** while delete is unsupported the action SHALL be marked `unsupported` with a reason naming the defined cascade contract rather than being silently omitted
- **AND** the catalog SHALL NOT advertise a `delete_connection` method or URL while the action is unsupported

#### Scenario: Owner agent deletes a connection by connection_id

- **WHEN** the `delete_connection` action is supported and a trusted owner agent deletes a connection by `connection_id` over the owner-agent REST control plane
- **THEN** the reference SHALL resolve and verify owner ownership of that `connection_id` before erasing any data
- **AND** it SHALL erase exactly that connection's data and configured row and clear its device back-reference, affecting no sibling connection
- **AND** it SHALL record a non-secret delete audit event including actor kind, client identity, target connection identity, operation, outcome, and deletion summary, without logging bearer tokens, provider credentials, or record contents

#### Scenario: Connector-only delete is ambiguous

- **WHEN** the `delete_connection` action is supported and a trusted owner agent requests a delete using only `connector_id` while more than one active connection exists for that connector type
- **THEN** the reference SHALL reject the request with a typed ambiguity error including the available `connection_id` values and retry guidance
- **AND** it SHALL NOT delete an arbitrarily chosen connection

#### Scenario: Owner bearer cannot delete over MCP

- **WHEN** a client presents an owner-agent bearer to `/mcp`
- **THEN** the reference SHALL reject the bearer for MCP tool access
- **AND** defining a `delete_connection` REST control action SHALL NOT make any delete capability reachable over `/mcp` with an owner bearer

### Requirement: Owner-agent cancel_run SHALL be a typed, run-scoped, non-destructive control action

The owner-agent control surface SHALL model run cancellation as a run-scoped owner control action that stops a single active connector run by its `run_id` without erasing collected records, schedules, grants, or connection configuration. The `cancel_run` action SHALL be distinct from `run_connection`, `revoke_connection`, and `delete_connection`. While the action is reachable only over the owner-session reference control plane and not yet over the owner-agent bearer REST surface, the catalog SHALL advertise it as a typed action without advertising an owner-agent bearer method or URL it does not yet serve.

#### Scenario: Control catalog advertises cancel_run honestly

- **WHEN** a trusted owner agent reads the owner-agent control capability document
- **THEN** a run-scoped `cancel_run` action SHALL appear with a typed status
- **AND** it SHALL be described as non-destructive and distinct from `run_connection`, `revoke_connection`, and `delete_connection`
- **AND** the catalog SHALL NOT advertise an owner-agent bearer method or URL for `cancel_run` while only the owner-session reference route serves it

#### Scenario: Cancellation does not destroy data or sibling runs

- **WHEN** an owner cancels a single active run
- **THEN** the reference SHALL stop only that run
- **AND** it SHALL preserve that connection's already-collected records, schedule, grants, and configuration
- **AND** it SHALL NOT affect any sibling connection's active run or configuration

#### Scenario: Owner bearer cannot cancel over MCP

- **WHEN** a client presents an owner-agent bearer to `/mcp`
- **THEN** the reference SHALL reject the bearer for MCP tool access
- **AND** defining a `cancel_run` control action SHALL NOT make any cancellation capability reachable over `/mcp` with an owner bearer

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

