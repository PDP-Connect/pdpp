## ADDED Requirements

### Requirement: Configured provider-account runs SHALL require source-scoped credentials

The reference implementation SHALL require configured connector-instance runs for static-secret or provider-account connectors to resolve provider-account credentials from source-scoped setup material for the targeted connection. Manual, scheduled, retry, and auto-resume run paths SHALL NOT use deployment-wide provider-account environment variables as a substitute for a missing source-scoped credential. A missing, revoked, or unrecoverable source-scoped credential SHALL fail closed before the connector child is spawned.

This requirement applies to configured reference-server runs. It does not forbid standalone connector development or tests from passing connector-declared credential environment variables directly to a connector child outside a configured connector-instance run.

#### Scenario: Configured run lacks a stored source credential

- **WHEN** a manual or scheduled run is started for a configured static-secret connector instance with no active stored source credential
- **THEN** the reference SHALL refuse the launch with a typed credential-unavailable failure
- **AND** it SHALL NOT spawn a connector child
- **AND** it SHALL NOT use deployment-wide provider-account environment variables to authenticate the source.

#### Scenario: Configured run has a stored source credential

- **WHEN** a manual or scheduled run is started for a configured static-secret connector instance with an active stored source credential
- **THEN** the connector child SHALL receive the source-scoped credential environment fragment for that connection
- **AND** that fragment SHALL override same-named deployment environment values for the child process
- **AND** sibling connector instances SHALL NOT receive that connection's credential.

#### Scenario: Connector is not a static-secret provider-account connector

- **WHEN** a configured run is started for a connector whose setup material is not represented by the static-secret credential registry
- **THEN** the static-secret resolver SHALL return no env fragment
- **AND** other connection-scoped setup-material resolvers MAY satisfy the run according to their own contracts.

#### Scenario: Standalone connector execution uses env credentials

- **WHEN** a connector is executed outside the configured reference-server connector-instance run path
- **THEN** the connector MAY read connector-declared credential environment variables
- **AND** that standalone behavior SHALL NOT be treated as satisfying source-scoped setup for a configured reference connection.
