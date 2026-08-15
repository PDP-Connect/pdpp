## ADDED Requirements

### Requirement: Owner-session static-secret retries SHALL preserve a safe draft identity

The owner-session static-secret lifecycle SHALL keep a synchronously rejected
draft in `draft` state and SHALL allow a subsequent submission to update only
manifest-declared non-secret setup fields on that same connection before
re-probing. The Console retry surface SHALL preserve the connection id and
shall never round-trip the secret.

#### Scenario: A corrected mailbox retry reuses the rejected draft

- **GIVEN** a Gmail draft whose submitted credential is rejected
- **WHEN** the owner corrects the non-secret mailbox field and resubmits
- **THEN** the original connection id SHALL remain the target
- **AND** the draft SHALL be probed with the corrected setup fields
- **AND** a successful capture SHALL store the credential on that same
  connection id
- **AND** the rejected credential SHALL not be stored.

### Requirement: Verified static-secret identities SHALL converge through the server binding authority

After a synchronous probe returns a non-secret provider identity, the server
SHALL claim a deterministic owner+connector+verified-identity binding before
storing the credential. Duplicate submissions or retries that race for that
binding SHALL converge to one draft/active connection. A verified active
identity SHALL not silently fork into another active connection.

#### Scenario: Duplicate submission for the same verified identity

- **WHEN** the owner submits the same static-secret account more than once
- **THEN** successful captures SHALL resolve to one connector instance
- **AND** at most one connection for that owner, connector, and verified
  provider identity SHALL be active
- **AND** repeated capture may rotate that one connection's credential but
  SHALL not create another connector instance.

#### Scenario: Distinct provider identities remain separate

- **WHEN** the same owner submits two distinct provider identities for one
  static-secret connector
- **THEN** the server SHALL retain two distinct connection ids
- **AND** each identity SHALL be able to capture and promote independently.

#### Scenario: Ambiguous identity state fails closed

- **WHEN** an identity claim collides with an already verified active connection
  while the requested target is a different active connection
- **THEN** the server SHALL reject the mutation with a typed conflict
- **AND** SHALL not store the submitted credential or silently retarget the
  active connection.

### Requirement: Static-secret credential replacement SHALL remain connection scoped

Replacing a credential on an existing connection SHALL preserve its connection
id and existing records, schedule, and history. Secrets SHALL remain sealed in
the credential store and SHALL never be returned in setup fields, API responses,
audits, or retry URLs.

#### Scenario: Replacing a credential does not fork the connection

- **GIVEN** an existing active static-secret connection with collected records
  and a schedule
- **WHEN** the owner replaces its credential with a valid credential for the
  same verified provider identity
- **THEN** the capture response SHALL use the original connection id
- **AND** the records, schedule, and history SHALL remain attached to that id
- **AND** no second connector instance SHALL be created.
