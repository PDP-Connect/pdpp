## ADDED Requirements

### Requirement: Static-secret credentials SHALL be stored encrypted and instance-scoped

The reference implementation SHALL store a static-secret connector credential (such as a Google app password or a GitHub personal access token) as durable state encrypted at rest and keyed to exactly one connection (its `connection_id` / `connector_instance_id`). The credential SHALL be a per-instance resource, a peer of the instance-scoped storage, schedule, and active-run-lease state, and SHALL NOT be process-global or shared across connector instances. The encryption key SHALL be owner- or operator-held and SHALL NOT be an agent-held or client-held key.

#### Scenario: Two mailboxes hold two distinct credentials

- **WHEN** the owner configures two Gmail connections for two different mailboxes
- **THEN** the reference SHALL store each connection's app password keyed to its own `connection_id`
- **AND** one connection's stored credential SHALL NOT be readable by, overwrite, or be used to authenticate the other connection.

#### Scenario: Credential is recoverable only by the orchestrator

- **WHEN** a scheduled run begins for a connection that has a stored static-secret credential
- **THEN** the reference orchestrator SHALL be able to recover the plaintext secret to authenticate to the provider for that one connection
- **AND** recovery SHALL require the owner/operator-held encryption key, not an owner-agent or client bearer.

### Requirement: Static-secret credentials SHALL never be returned by any read surface

The reference implementation SHALL NOT return a stored static-secret credential's plaintext through any REST, MCP, or console read. Reads MAY expose only non-secret credential metadata: which connection has a credential, the credential kind, capture and rotation timestamps, and a validity state.

#### Scenario: Owner agent reads connection state

- **WHEN** a trusted owner agent reads a connection that has a stored static-secret credential
- **THEN** the response MAY indicate that a credential is present, its kind, and its validity state
- **AND** the response SHALL NOT include the app password, personal access token, or any secret bytes.

#### Scenario: Audit evidence records a capture

- **WHEN** the reference records audit evidence for a credential capture or rotation
- **THEN** the evidence SHALL identify the actor, the connection, and the outcome
- **AND** the evidence SHALL NOT include the secret, the owner session cookie, or the bearer token.

### Requirement: Static-secret capture SHALL be owner-mediated and SHALL NOT expose the secret to an agent

The reference implementation SHALL capture a static-secret credential only through an owner-trusted surface — a local collector `credentials` interaction or an owner-session surface — where the owner, not a trusted owner agent, supplies the secret. The owner-agent surface SHALL observe only a typed next step and the resulting `connection_id`, never the secret.

#### Scenario: Owner agent initiates a static-secret connection

- **WHEN** a trusted owner agent initiates a connection for a static-secret connector and the primitive is enabled
- **THEN** the response SHALL return a typed next step directing the owner to complete credential capture through an owner-trusted surface
- **AND** the response SHALL NOT carry the secret, and `connection_active` SHALL remain false until capture and first ingest complete.

#### Scenario: Connection materializes after owner capture and first ingest

- **WHEN** the owner completes credential capture locally and the connector ingests at least one batch for the new connection
- **THEN** the reference SHALL materialize the connection as an addressable, labelable `connection_id`
- **AND** no `connector_instances` row SHALL have been written by the intent before capture and first ingest.

### Requirement: Static-secret credentials SHALL be injected scoped to one connection run

The reference orchestrator SHALL inject a static-secret credential into a connector subprocess scoped to the one connection being run, using the connector's credential input channel, rather than placing the secret in a process-global environment shared across runs.

#### Scenario: Two Gmail connections run with distinct secrets

- **WHEN** two Gmail connections for two mailboxes are eligible to run
- **THEN** each run SHALL receive only its own connection's credential
- **AND** neither run SHALL authenticate using the other connection's secret or a shared process-global secret.

### Requirement: Static-secret credential lifecycle SHALL be distinct from connection lifecycle

The reference implementation SHALL keep credential rotation, credential revocation, connection revocation, and connection deletion as distinct operations. A revoked or deleted credential SHALL NOT implicitly resurrect on a subsequent ingest.

#### Scenario: Owner rotates a credential

- **WHEN** the owner re-captures the static secret for an existing connection
- **THEN** the reference SHALL replace the stored secret and record a rotation timestamp
- **AND** the connection, its `connection_id`, its history, and its schedule SHALL be preserved.

#### Scenario: Owner revokes a credential

- **WHEN** the owner revokes a connection's static-secret credential
- **THEN** the reference SHALL stop future runs for that connection
- **AND** previously collected records SHALL remain governed by normal retention and grant/query rules
- **AND** the connection row SHALL NOT be deleted solely because its credential was revoked.

#### Scenario: Owner deletes a connection

- **WHEN** the owner deletes a connection that has a stored static-secret credential
- **THEN** the reference SHALL delete the stored credential so no orphaned secret survives the connection
- **AND** a later ingest SHALL NOT recreate the credential or the connection without an explicit owner re-capture.
