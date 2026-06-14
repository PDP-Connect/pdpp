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

### Requirement: Source setup UI SHALL be generated from connector manifests and setup plans

Reference implementation data-source setup UI SHALL render connector identity,
setup support, owner next steps, proof gates, deployment blockers, credential
field labels, and help links from connector manifests, connector-authored setup
descriptors, and the shared setup engine. It SHALL NOT carry provider-specific
data-source labels, example lists, credential-field copy, or help links in the
Console UI layer.

#### Scenario: Future connector declares equivalent setup metadata

- **WHEN** a future connector manifest declares display metadata, runtime
  bindings, and setup metadata matching an already-supported setup modality
- **THEN** the Console source picker SHALL render that connector and its owner
  next step from the manifest and shared setup plan
- **AND** no Console UI code change SHALL be required solely to add the
  connector's display name, provider examples, credential field labels, or help
  links

#### Scenario: Connector requires a new primitive

- **WHEN** a connector's manifest describes a setup modality for which the
  reference lacks an implemented setup primitive or proof gate
- **THEN** the setup engine SHALL return a typed unsupported, proof-gated, or
  deployment-readiness state
- **AND** the Console SHALL render that state generically rather than adding a
  provider-specific UI branch

### Requirement: Normal source setup UI SHALL expose only owner-usable setup paths

The reference implementation SHALL treat commands and links shown in normal
owner source setup UI as product contracts. Normal setup UI SHALL NOT require a
PDPP monorepo checkout, package-internal command, unpublished CLI subcommand,
manual placeholder mapping over internal ids, or per-account deployment
environment variable editing.

#### Scenario: Browser-bound connector has only a maintainer proof path

- **WHEN** a browser-bound connector has a maintainer proof path but no packaged
  owner-usable dashboard setup flow
- **THEN** the normal owner UI SHALL show that add-new setup is pending
- **AND** it SHALL NOT deep-link to monorepo commands or describe that proof path
  as manual owner setup

#### Scenario: Source card would render a CLI command

- **WHEN** the Console renders a source setup card
- **THEN** any command shown on that card SHALL be available in the published
  package/version named by the UI and pass a clean-shell invocation test
- **AND** if that is not true, the command SHALL NOT be rendered in normal owner
  UI

### Requirement: Source setup UI SHALL distinguish existing data from add-new support

The reference implementation SHALL distinguish an existing working connection
from support for adding another account through shipped self-service setup. A
connector MAY have existing healthy data while add-new setup is not yet
owner-usable.

#### Scenario: Existing connector data is present but add-new is not self-service

- **WHEN** an owner has existing records or active connections for a connector
  whose add-new-account setup is not packaged
- **THEN** owner UI SHALL continue to present the existing data as usable
- **AND** the add-source surface SHALL say that adding another account is not
  self-service yet rather than implying the connector itself is unsupported

#### Scenario: Sources first screen keeps existing data, add-new support, and repair distinct

- **WHEN** an owner opens the Sources / Connections surface for a connector that
  has at least one connection
- **THEN** the first screen SHALL present, as separate facts for that source,
  the existing connection/data state, whether adding another account is
  self-service today, and a repair action when a connection needs attention
- **AND** a source whose add-new account setup is self-service SHALL offer one
  add-another-account action, while a source with no self-service add path SHALL
  still show its existing data without a dead add action
- **AND** a needs-attention connection's repair action SHALL land on that
  connection's detail surface, not at the start of the add-source flow

### Requirement: Manual import setup SHALL provide connector-authored acquisition and validation guidance

The reference implementation SHALL, for connectors whose setup modality is
`manual_or_upload`, present owner-usable acquisition, upload, validation, and
refresh guidance from connector-authored setup metadata and the shared setup
engine. It SHALL NOT imply provider authorization, background API sync, or
developer-maintainer setup when the connector's normal source is an
owner-provided artifact.

#### Scenario: Google Maps Timeline uses guided export and upload

- **WHEN** an owner starts setup for Google Maps Timeline data
- **THEN** the setup plan SHALL present it as a manual/import Timeline source
  rather than a live Google account sync
- **AND** owner setup surfaces SHALL provide connector-authored Android/iOS
  export guidance, accepted file/format hints, official help links, and an
  upload/share or large-file handoff action
- **AND** those surfaces SHALL NOT require a PDPP monorepo checkout,
  package-internal command, or manual substitution of internal ids

#### Scenario: Manual import validates before long ingest

- **WHEN** an owner supplies an import artifact for a manual/import connector
- **THEN** the reference SHALL validate the artifact shape before treating setup
  as successful
- **AND** it SHALL surface non-secret validation evidence such as detected
  format, estimated record or segment count, date range when available, duplicate
  or stale-file status, and the next action for unsupported files
- **AND** normal setup surfaces SHALL let the owner import directly, with preview
  as an optional inspection aid rather than a required second submission
- **AND** when connector validation can derive non-secret source identity from
  the artifact, setup SHALL use that identity to suggest the source label instead
  of requiring the owner to type it before upload

#### Scenario: Timeline refresh starts without fixed cooldown

- **WHEN** an owner supplies a valid Timeline file through upload, share target, or import-folder handoff
- **THEN** validation and import SHALL start immediately unless a real capacity, safety, or dependency gate exists
- **AND** checkpoint and provenance state SHALL advance at coverage-safe boundaries rather than only at final completion when the implementation can identify those boundaries
- **AND** fixed cooldowns or source-level waiting periods SHALL NOT be used for manual upload, share, or import-folder refresh flows
- **AND** Google Takeout's two-month cadence SHALL be represented only as a provider/export constraint for the Takeout probe lane, not copied into phone export or direct upload refresh governance

#### Scenario: Acquisition methods share one source identity when semantics match

- **WHEN** multiple acquisition methods such as phone export upload, Android
  share target, server import-folder handoff, or validated Takeout archive
  produce the same owner Timeline record family
- **THEN** the reference MAY ingest them into the same stream definitions and
  source binding
- **AND** each run or record batch SHALL retain non-secret provenance for the
  acquisition method, source format, detected coverage, and source binding

#### Scenario: Google Data Portability remains separate from Timeline import

- **WHEN** a Google Data Portability connector is available for documented Maps
  resources
- **THEN** setup surfaces SHALL present it as a provider-authorization source
  distinct from Google Maps Timeline import
- **AND** they SHALL NOT claim it provides Timeline points or Timeline segments
  unless the provider documents those resources
