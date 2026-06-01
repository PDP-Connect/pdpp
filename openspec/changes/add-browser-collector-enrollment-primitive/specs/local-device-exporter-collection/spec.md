## ADDED Requirements

### Requirement: Device-exporter enrollment SHALL be binding-aware

Device-exporter enrollment SHALL derive the enrolled binding's source kind from
the connector manifest `runtime_requirements.bindings` rather than recording a
fixed source kind. A `filesystem` binding SHALL enroll as `local_device`. A
`browser` binding (with no `filesystem` binding) SHALL enroll as
`browser_collector`. A connector whose manifest declares neither binding, or for
which no manifest is registered, SHALL be rejected with a typed error; enrollment
SHALL NOT default to a source kind.

The binding marker the enrollment path reads is the marker the manifest already
declares. This requirement does not redefine or bless any binding name as a Core
or Collection Profile binding; the reconciliation of the reference `browser`
marker against the spec-defined `browser_automation` / `browser_profile` registry
is a separate decision.

#### Scenario: Filesystem connector enrolls as a local device

- **WHEN** an owner enrolls a connector whose manifest declares a `filesystem` binding
- **THEN** the reference SHALL record the enrolled binding with source kind `local_device`

#### Scenario: Browser-bound connector enrolls as a browser collector

- **WHEN** an owner enrolls a connector whose manifest declares a `browser` binding and no `filesystem` binding
- **THEN** the reference SHALL record the enrolled binding with source kind `browser_collector`
- **AND** it SHALL NOT record the binding as `local_device`

#### Scenario: Caller supplies a source kind that contradicts the manifest

- **WHEN** an enrollment request supplies an explicit source kind that contradicts the connector manifest bindings
- **THEN** the reference SHALL reject the request with a typed error
- **AND** it SHALL NOT record an enrolled binding with the contradicting source kind

#### Scenario: Connector has no resolvable binding

- **WHEN** an enrollment request names a connector with no registered manifest or a manifest that declares neither a `filesystem` nor a `browser` binding
- **THEN** the reference SHALL reject the request with a typed error
- **AND** it SHALL NOT default the enrolled binding to any source kind

### Requirement: Browser-collected bindings SHALL keep browser automation off the central server

A `browser_collector` enrolled binding SHALL collect through a local collector
that drives a browser session on the owner's environment. The central personal
server SHALL receive normalized records, state, health, and diagnostics for that
binding and SHALL NOT receive raw browser control or remote browser access. This
mirrors the filesystem rule: local collection stays local.

#### Scenario: A browser-bound connector collects through a browser-collector binding

- **WHEN** a local collector collects a browser-bound connector enrolled as `browser_collector`
- **THEN** the browser session SHALL run in the owner's local environment
- **AND** the central personal server SHALL receive normalized records, state, health, and diagnostics rather than raw browser control

### Requirement: Browser-bound connection initiation SHALL reach an owner-mediated next step without activating the connection

The reference SHALL return a typed, auditable next step and SHALL keep
`connection_active` false when a trusted owner agent initiates a connection for a
browser-bound connector. The connection SHALL materialize only after the owner's
local collector enrolls, the owner completes any provider login locally, and the
collector ingests through the device-exporter path. The initiation SHALL NOT
return provider credentials, SHALL NOT complete provider login or 2FA on the
owner's behalf, and SHALL NOT log the bearer token or any minted enrollment code.

#### Scenario: Owner agent initiates a browser-bound connection before proof exists

- **WHEN** a trusted owner agent initiates a connection for a browser-bound connector and the browser-collector enrollment proof has not been committed
- **THEN** the reference SHALL return a typed `unsupported` next step whose reason names the missing browser-collector enrollment primitive
- **AND** the response SHALL report `connection_active` false

#### Scenario: Owner agent initiates a browser-bound connection after proof exists

- **WHEN** a trusted owner agent initiates a connection for a browser-bound connector and the browser-collector enrollment proof has been committed
- **THEN** the reference MAY return a typed `enroll_browser_collector` next step carrying a single-use enrollment code and the enroll endpoint
- **AND** the response SHALL report `connection_active` false
- **AND** the connection SHALL materialize only after the owner's collector enrolls, the owner logs in locally, and the collector ingests

#### Scenario: Initiation does not perform provider authentication

- **WHEN** a browser-bound connection initiation returns a next step
- **THEN** the response SHALL NOT include provider credentials
- **AND** the reference SHALL NOT complete provider login or 2FA on the owner's behalf

### Requirement: Browser-bound connectors SHALL NOT advertise a real next step without committed proof

The reference SHALL NOT advertise a real browser-collector next step (or
otherwise present a browser-bound connector as supported for initiation) until a
committed test drives a browser-bound connector end-to-end through enrollment, a
browser session, and device-exporter ingest, accompanied by a scrubbed fixture
proving the ingested record shape. Until that proof is committed, the honest
output for a browser-bound connector SHALL be `unsupported` with the gap named.

#### Scenario: Proof has not been committed

- **WHEN** no committed test and scrubbed fixture demonstrate end-to-end browser-collector ingest for a browser-bound connector
- **THEN** the reference SHALL present that connector's initiation as `unsupported`
- **AND** it SHALL NOT advertise an `enroll_browser_collector` next step for that connector

#### Scenario: Proof has been committed

- **WHEN** a committed test drives a browser-bound connector through enrollment, a browser session, and device-exporter ingest, with a scrubbed fixture proving the ingested shape
- **THEN** the reference MAY advertise an `enroll_browser_collector` next step for that connector
- **AND** the flip and the proof SHALL be reviewable as one unit
