## MODIFIED Requirements

### Requirement: Static-secret credentials SHALL be stored encrypted and instance-scoped

The reference implementation SHALL store a static-secret connector credential
(such as a Google app password or a GitHub personal access token) as durable
state encrypted at rest and keyed to exactly one connection (its
`connection_id` / `connector_instance_id`). The credential SHALL be a
per-instance resource, a peer of the instance-scoped storage, schedule, and
active-run-lease state, and SHALL NOT be process-global or shared across
connector instances. The encryption key SHALL be owner- or operator-held and
SHALL NOT be an agent-held or client-held key. Each credential-state transition
SHALL retain non-secret latest-transition provenance: a closed cause token and,
when the writer has it, its actor and action-correlation identifiers. A writer
without that evidence SHALL leave it unknown rather than fabricate it.

#### Scenario: Two mailboxes hold two distinct credentials

- **WHEN** the owner configures two Gmail connections for two different mailboxes
- **THEN** the reference SHALL store each connection's app password keyed to its own `connection_id`
- **AND** one connection's stored credential SHALL NOT be readable by, overwrite, or be used to authenticate the other connection.

#### Scenario: Credential is recoverable only by the orchestrator

- **WHEN** a scheduled run begins for a connection that has a stored static-secret credential
- **THEN** the reference orchestrator SHALL be able to recover the plaintext secret to authenticate to the provider for that one connection
- **AND** recovery SHALL require the owner/operator-held encryption key, not an owner-agent or client bearer.

#### Scenario: Connection revocation cascades to a credential

- **WHEN** a connection revocation changes its stored credential to `revoked`
- **THEN** the credential SHALL retain the closed connection-revocation cause
- **AND** it SHALL retain the originating actor and request correlation when the
  connection writer supplied them
- **AND** the credential provenance SHALL NOT contain a credential value or
  sealed credential value.

#### Scenario: Legacy or context-free credential transition

- **WHEN** an existing credential row predates provenance or a current writer
  has no actor evidence
- **THEN** the reference SHALL leave actor provenance absent
- **AND** it SHALL NOT infer an actor from timestamps, owner ids, or state.
