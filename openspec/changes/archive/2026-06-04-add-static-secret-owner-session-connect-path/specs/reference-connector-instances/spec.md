## ADDED Requirements

### Requirement: A draft connector-instance status SHALL exist for static-secret owner-session setup

The reference implementation SHALL support a `draft` connector-instance status,
reserved for static-secret owner-session connection setup. A `draft` instance
SHALL be a real `connector_instances` row that is excluded from every connection
read surface until it activates. No path other than the owner-session
static-secret draft-create surface SHALL produce a `draft` instance, and the
default-account materialization, device enrollment, and ordinary connection
materialization paths SHALL continue to write `active` instances.

#### Scenario: Draft status is admitted by storage

- **WHEN** the reference creates a connector instance with status `draft` for a
  static-secret connector through the owner-session setup surface
- **THEN** the store SHALL persist the row with status `draft`
- **AND** a connector instance created by any non-static-secret-setup path SHALL
  NOT be `draft`.

#### Scenario: Draft is the only pre-activation status

- **WHEN** a static-secret connection is being set up before its first ingest
- **THEN** its instance SHALL be `draft`, not `active`, `paused`, or `revoked`
- **AND** no `active` zero-record connection SHALL be written to represent a
  not-yet-ingested static-secret connection.

### Requirement: Draft instances SHALL be invisible to every connection read surface

The reference implementation SHALL exclude `draft` connector instances from
every connection read surface, including the operator dashboard, the
`/_ref/connections` and `/_ref/connector-instances` listings, owner-agent
connection reads, connector-template listings, and device-exporter listings. A
`draft` instance SHALL NOT appear in any list, count, search, or grant-resolution
result. Owner-internal lookups by explicit `connection_id` MAY resolve a draft
for the setup and ingest paths only.

#### Scenario: Draft does not appear in connection listings

- **WHEN** an owner or owner agent lists connections while a `draft` instance
  exists
- **THEN** the response SHALL NOT include the draft
- **AND** the draft SHALL NOT be counted toward the owner's connection totals.

#### Scenario: Draft is not a read target for agents

- **WHEN** a grant-scoped, client, MCP, or owner-agent read attempts to resolve a
  connection
- **THEN** a `draft` instance SHALL NOT be a resolvable read target
- **AND** only the owner-session capture path and the owner-authenticated ingest
  path (addressing the draft by explicit `connection_id`) MAY resolve it.

### Requirement: An owner-session surface SHALL create a static-secret draft connection

The reference implementation SHALL expose an owner-session-only surface that
creates a `draft` connector instance for a static-secret connector. The surface
SHALL reject any non-static-secret connector with a typed error. Each invocation
SHALL create a distinct connection identity, so that two mailboxes or accounts
for the same connector are two distinct `connection_id`s. The surface SHALL NOT
accept or return a provider secret.

#### Scenario: Owner creates a draft for a static-secret connector

- **WHEN** the owner creates a draft connection for `gmail` or `github` through
  the owner session
- **THEN** the reference SHALL create one `draft` instance and return its
  `connection_id` with a typed next step directing the owner to capture the
  credential
- **AND** the response and its audit evidence SHALL NOT contain any secret.

#### Scenario: Draft create is rejected for a non-static-secret connector

- **WHEN** the owner attempts to create a draft connection for a connector that
  is not a static-secret connector
- **THEN** the reference SHALL reject the request with a typed
  `static_secret_credential_unsupported` error
- **AND** no `connector_instances` row SHALL be written.

#### Scenario: Two drafts are two distinct connections

- **WHEN** the owner creates two draft connections for the same static-secret
  connector
- **THEN** the reference SHALL create two distinct `connection_id`s
- **AND** neither draft SHALL collide with the other or with the deterministic
  default-account connection id.

### Requirement: Owner-session capture SHALL be admissible against a draft connection

The reference implementation SHALL allow the owner-session static-secret capture
surface to seal a credential onto a `draft` connection. No bearer, owner-agent,
client, or MCP path SHALL be able to seal a credential onto a draft or otherwise
resolve a draft as a mutation target other than owner-authenticated first ingest.

#### Scenario: Owner seals a credential onto a draft

- **WHEN** the owner captures a static secret for a `draft` connection through
  the owner session
- **THEN** the reference SHALL store the credential keyed to the draft's
  `connection_id`
- **AND** the connection SHALL remain `draft` and invisible until its first
  successful ingest.

#### Scenario: An agent cannot seal a credential onto a draft

- **WHEN** an owner-agent or client bearer attempts to seal a credential onto a
  draft connection
- **THEN** the reference SHALL NOT admit the draft as a capture target
- **AND** SHALL NOT expose the draft as a resolvable connection.

### Requirement: First successful ingest SHALL activate a draft connection

The reference implementation SHALL flip a `draft` connector instance to `active`
on the first ingest that accepts at least one record for that instance. A run
that accepts zero records, a run that fails, and an ingest into an instance with
no stored credential SHALL leave the instance `draft` and invisible, so that no
phantom active zero-record connection is ever created.

#### Scenario: Draft activates on first records

- **WHEN** the first ingest for a `draft` connection accepts at least one record
- **THEN** the reference SHALL flip the instance to `active`
- **AND** the connection SHALL become visible on the connection read surfaces as
  an addressable, labelable `connection_id`.

#### Scenario: Zero-record or failed ingest leaves the draft invisible

- **WHEN** an ingest for a `draft` connection accepts zero records, or the run
  fails before ingest
- **THEN** the instance SHALL remain `draft`
- **AND** SHALL remain excluded from every connection read surface
- **AND** no `active` zero-record connection SHALL be written.
