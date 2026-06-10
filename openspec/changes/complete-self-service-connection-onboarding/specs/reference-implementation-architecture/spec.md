## ADDED Requirements

### Requirement: Reference connection setup SHALL use one owner-mediated setup engine

The reference implementation SHALL provide one owner-mediated setup engine as the
source of truth for connector setup modality, support state, deployment
readiness, owner next steps, proof gates, and secret boundaries. Console,
owner-agent REST, CLI, and SDK-style helpers SHALL consume that engine or a
serialized projection of it rather than maintaining separate setup
classification tables.

#### Scenario: Console and owner-agent inspect the same connector

- **WHEN** the console add-connection surface and a trusted owner-agent REST
  caller ask how to add the same connector for the same owner/deployment context
- **THEN** both surfaces SHALL receive setup plans derived from the same setup
  engine
- **AND** they SHALL agree on the connector's setup modality, support state,
  next-step kind, proof-gate state, and deployment-readiness requirements

#### Scenario: CLI helper asks how to add a connector

- **WHEN** a CLI or SDK-style setup helper asks how to add a connector
- **THEN** it SHALL consume the same setup engine projection used by console and
  owner-agent REST
- **AND** it SHALL NOT carry a separate hard-coded list of connector setup
  modalities or supported source credentials

### Requirement: Deployment configuration SHALL be separate from per-connection setup

The reference implementation SHALL treat deployment configuration as
instance-level runtime readiness, not as the normal mechanism for adding one
owner source connection. Instance-level variables MAY configure database access,
public origin, owner authentication, AS/RS ports, deployment credentials, and
credential encryption. Connector-specific per-connection provider credentials
SHALL NOT be required as normal setup for a supported source connection.

#### Scenario: Railway operator adds a second source account

- **WHEN** a Railway or other self-hosted operator has already deployed the
  reference with required instance-level variables and wants to add another
  supported source account
- **THEN** the normal setup path SHALL be an owner-mediated connection setup flow
  rather than adding another connector-specific deployment environment variable
- **AND** any provider credential required for that connection SHALL be captured
  through the setup flow and stored according to that modality's credential
  rules

#### Scenario: Provider app configuration is missing

- **WHEN** a connector requires deployment-level provider app configuration
  before per-account authorization can start
- **THEN** the setup engine SHALL return a typed deployment-readiness state such
  as `needs_deployment_config`
- **AND** it SHALL distinguish the missing platform configuration from the
  owner's per-connection provider authorization or credential capture step

#### Scenario: Compatibility env vars remain available

- **WHEN** a connector still accepts legacy source credential environment
  variables for local development or operator fallback
- **THEN** the reference SHALL document them as fallback or compatibility paths
- **AND** the supported normal setup plan SHALL NOT require those variables for
  each source connection

### Requirement: Static-secret setup SHALL be manifest-authored and key-provider gated

The reference implementation SHALL render static-secret setup from connector
manifest metadata rather than Console-specific connector branches. The setup
descriptor SHALL carry non-secret field labels, field types, help links, required
status, identity markers, and credential kind. Runtime env-var names MAY remain
connector-owned implementation details, but SHALL NOT be exposed as the normal
setup UI contract.

#### Scenario: Console renders a static-secret setup form

- **WHEN** an owner opens the Console setup page for a static-secret connector
- **THEN** the Console SHALL fetch and render the connector-authored setup
  descriptor
- **AND** it SHALL NOT use connector-specific UI branches to decide which
  account fields, secret fields, labels, or help URLs to show

#### Scenario: Credential key provider is missing

- **WHEN** no instance-level credential key provider is configured
- **THEN** the setup descriptor SHALL report a deployment-readiness blocker
- **AND** the Console SHALL block before accepting provider-secret input
- **AND** the draft-create and capture routes SHALL fail closed before storing
  plaintext or writing a draft connection row

#### Scenario: Docker and Railway deployments prepare credential storage

- **WHEN** a Railway operator deploys the reference from the template
- **THEN** the template SHALL generate an instance-level credential key without
  prompting for connector-specific source credentials
- **WHEN** a Docker operator runs the reference secret generator
- **THEN** the generator SHALL fill an instance-level credential key unless one
  is already configured
- **AND** Docker/Kubernetes-style deployments MAY instead mount a secret file and
  point `PDPP_CREDENTIAL_ENCRYPTION_KEY_FILE` at it
