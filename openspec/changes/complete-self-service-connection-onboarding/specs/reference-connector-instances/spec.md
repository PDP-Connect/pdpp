## ADDED Requirements

### Requirement: Connection setup SHALL materialize instances only through typed setup lifecycle gates

The reference implementation SHALL materialize or activate connector instances
only through typed setup lifecycles appropriate to the connector's setup
modality. A setup intent or setup plan SHALL NOT silently create an active
connection row unless the modality's proof boundary has been satisfied.

#### Scenario: Local collector setup enrolls before activation

- **WHEN** an owner starts setup for a local-collector connector
- **THEN** the reference SHALL return a typed enrollment next step for the local
  collector
- **AND** the connection SHALL become active only after an authorized local
  binding is established and accepted according to the local collector lifecycle

#### Scenario: Static-secret setup uses draft then first-ingest activation

- **WHEN** an owner starts setup for a static-secret connector
- **THEN** the reference SHALL create or direct the owner to create a draft or
  pending setup state and capture the credential through an owner-mediated
  secret surface
- **AND** the owner UI SHALL expose the pending setup or running first sync after
  submission with the connection id, run id when present, and any actionable
  failure state
- **AND** the connection SHALL become active only after first successful ingest
  accepts records for that draft
- **AND** owner-authenticated collection mutations for that first sync,
  including record ingest, blob upload, and state checkpoints, SHALL target the
  same explicitly addressed draft connection id so records, media, provenance,
  and checkpoints cannot split across sibling connections
- **AND** owner-authenticated collection state reads and writes for that
  explicitly addressed draft connection id SHALL be accepted during first sync
  so checkpoint persistence cannot fail solely because activation has not yet
  occurred

#### Scenario: Static-secret setup does not disappear after submission

- **WHEN** an owner submits a valid static-secret setup form and the first sync
  has not yet accepted records
- **THEN** the reference SHALL expose a pending or running setup state to owner
  surfaces
- **AND** it SHALL NOT rely on an invisible draft row or transient redirect
  notice as the only owner-visible state

#### Scenario: Static-secret validation failure does not create an invisible setup row

- **WHEN** an owner submits a static-secret credential and synchronous
  provider validation rejects it before storage
- **THEN** the reference SHALL NOT store the rejected credential or credential
  metadata
- **AND** if the target is a first-time static-secret draft, the reference
  SHALL retire that draft so it cannot remain as an invisible setup row
- **AND** if the target is an active connection, the reference SHALL leave that
  active connection active so a failed rotation cannot revoke a working
  connection

#### Scenario: Owner reads a durable connection-scoped setup status

- **WHEN** an owner reads the setup status for a static-secret connection by its
  connection id through an owner-session surface
- **THEN** the reference SHALL return a connection-scoped setup-status view that
  resolves a not-yet-ingested draft as well as an active connection
- **AND** the view SHALL carry the connection id, the connector and account
  identity when known, a setup lifecycle state projected from the connection
  health and run state (not a parallel onboarding-only enum), the current or
  last run id and status when present, and the credential presence metadata
- **AND** the setup-status view SHALL NOT include the provider secret, owner
  session cookie, browser session cookie, or any bearer-equivalent credential

#### Scenario: Failed first sync is visible with a non-secret remediation

- **WHEN** the first sync for a static-secret draft connection fails before any
  records are accepted
- **THEN** the owner setup-status view SHALL report a failed setup state with an
  actionable remediation next step
- **AND** the failure surface SHALL NOT leak the provider secret or any
  bearer-equivalent credential

#### Scenario: Browser-bound setup remains proof-gated

- **WHEN** a connector requires browser-bound collection but the reference lacks
  committed end-to-end live proof for that connector's browser-bound setup path
- **THEN** the setup lifecycle SHALL return a proof-gated or unsupported setup
  state
- **AND** it SHALL NOT create or advertise an active browser-bound connection as
  supported

#### Scenario: Provider authorization setup separates app readiness from account authorization

- **WHEN** a connector uses provider authorization such as OAuth or a Link-style
  account-linking flow
- **THEN** deployment-level provider app readiness SHALL be verified before the
  owner account authorization starts
- **AND** the connection SHALL become active only after the provider callback or
  token exchange completes and any required account inventory or connection test
  succeeds

#### Scenario: Revoked connections remain owner-manageable

- **WHEN** an owner revokes a connection to stop future collection while
  retaining already-collected records
- **THEN** owner read surfaces SHALL keep the revoked connection visible with
  its connection id, connector identity, retained record evidence, lifecycle
  state, and revocation timestamp when known
- **AND** owner UI surfaces SHALL NOT redirect the owner to an excluded detail
  route after revoke
- **AND** owner UI surfaces SHALL provide a clear re-connect action that starts
  the supported setup path for that source
- **AND** owner UI surfaces SHALL NOT present a revoked connection as runnable
  or healthy active collection

### Requirement: Setup credentials SHALL be connection-scoped and secret-safe

Provider credentials collected during setup SHALL be scoped to exactly one
connection or draft connection, stored according to that modality's credential
storage rules, and never returned by owner-agent, MCP, grant-scoped REST, console
read, or CLI read surfaces. Reads MAY expose non-secret metadata such as
credential kind, presence, validity, capture timestamp, rotation timestamp, and
fingerprint. The credential-kind vocabulary SHALL support single-secret app
passwords, single-secret personal access tokens, sealed multi-field secret
bundles, and username/password pairs without requiring deployment-wide
per-account environment variables.

#### Scenario: Two accounts use the same connector type

- **WHEN** an owner configures two accounts for the same static-secret or
  provider-authorization connector type
- **THEN** the reference SHALL represent them as two distinct connection ids
- **AND** each connection SHALL use its own credential or provider authorization
  material without reading, overwriting, or sharing the sibling connection's
  credential

#### Scenario: A connector requires multiple bearer-equivalent values

- **WHEN** a static-secret connector requires multiple bearer-equivalent values
  for one source account, such as a token plus cookie or OAuth client secret plus
  account password
- **THEN** the reference SHALL store those values as one connection-scoped sealed
  credential bundle
- **AND** it SHALL inject only the connector-declared fields into the subprocess
  for that connection's run
- **AND** non-secret setup identity or configuration fields MAY be stored as
  source-binding metadata rather than inside the sealed secret

#### Scenario: Agent reads setup status

- **WHEN** a trusted owner agent reads setup or connection status for a
  credential-backed connection
- **THEN** the response MAY include non-secret credential metadata and the next
  owner action
- **AND** it SHALL NOT include the provider secret, provider access token, owner
  session cookie, browser session cookie, or any bearer-equivalent credential
