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
- **THEN** the reference SHALL create or direct the owner to create an invisible
  draft connection and capture the credential through an owner-mediated secret
  surface
- **AND** the connection SHALL become active only after first successful ingest
  accepts records for that draft

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

### Requirement: Setup credentials SHALL be connection-scoped and secret-safe

Provider credentials collected during setup SHALL be scoped to exactly one
connection or draft connection, stored according to that modality's credential
storage rules, and never returned by owner-agent, MCP, grant-scoped REST, console
read, or CLI read surfaces. Reads MAY expose non-secret metadata such as
credential kind, presence, validity, capture timestamp, rotation timestamp, and
fingerprint.

#### Scenario: Two accounts use the same connector type

- **WHEN** an owner configures two accounts for the same static-secret or
  provider-authorization connector type
- **THEN** the reference SHALL represent them as two distinct connection ids
- **AND** each connection SHALL use its own credential or provider authorization
  material without reading, overwriting, or sharing the sibling connection's
  credential

#### Scenario: Agent reads setup status

- **WHEN** a trusted owner agent reads setup or connection status for a
  credential-backed connection
- **THEN** the response MAY include non-secret credential metadata and the next
  owner action
- **AND** it SHALL NOT include the provider secret, provider access token, owner
  session cookie, browser session cookie, or any bearer-equivalent credential
