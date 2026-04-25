## ADDED Requirements

### Requirement: Public sandbox SHALL provide a mock reference demo instance

The public sandbox SHALL provide a mock reference demo instance that presents dashboard-like reference behavior backed by deterministic fictional AS/RS state. The demo SHALL be usable without Docker, `.env.local`, connector credentials, a local SQLite database, or a running reference server.

#### Scenario: Visitor opens the sandbox
- **WHEN** a visitor opens `/sandbox`
- **THEN** they SHALL see an interactive demo reference instance rather than only a static future-work placeholder or disconnected story card
- **AND** the surface SHALL identify itself as a demo instance with fictional data
- **AND** the surface SHALL NOT require owner login, connector credentials, or live AS/RS availability

#### Scenario: Hosted documentation deploy serves the sandbox
- **WHEN** the public website is deployed without a live reference stack
- **THEN** the sandbox demo SHALL still render and expose its demo APIs from deterministic mock state

### Requirement: Demo dashboard SHALL cover the core reference journey

The mock reference demo instance SHALL expose dashboard-like pages for the core reference journey: overview, records, search, grants, runs, traces, and deployment/capability inspection. Pages MAY be simpler than the live dashboard, but they SHALL use consistent concepts and labels.

#### Scenario: Visitor browses records
- **WHEN** a visitor opens the sandbox records surface
- **THEN** they SHALL be able to inspect fictional connectors, streams, records, stream metadata, and at least one record detail view

#### Scenario: Visitor searches data
- **WHEN** a visitor uses the sandbox search surface
- **THEN** they SHALL be able to search the fictional records and inspect which stream/record matched

#### Scenario: Visitor inspects control-plane evidence
- **WHEN** a visitor opens sandbox grants, runs, or traces
- **THEN** they SHALL see fictional but coherent timelines that demonstrate request, consent, scoped access, revocation, run success, run failure, and reference-only event evidence where applicable

### Requirement: Demo APIs SHALL be callable and share state with the UI

The sandbox SHALL expose callable demo API endpoints under the `/sandbox` route family. Demo UI pages and route handlers SHALL derive responses from the same seeded state or response-builder layer so the rendered dashboard and HTTP API do not drift.

#### Scenario: Visitor calls demo schema and stream APIs
- **WHEN** a visitor or agent calls `/sandbox/v1/schema`, `/sandbox/v1/streams`, `/sandbox/v1/streams/:stream`, or `/sandbox/v1/streams/:stream/records`
- **THEN** the API SHALL return JSON shaped like the corresponding reference/public surface for the seeded fictional data

#### Scenario: Visitor calls demo search APIs
- **WHEN** a visitor or agent calls `/sandbox/v1/search` with a query
- **THEN** the API SHALL return a deterministic list response over the seeded fictional records
- **AND** the response SHALL include enough fields for the UI or an agent to identify connector, stream, record, matched fields, and snippets

#### Scenario: Visitor calls reference-only demo inspection APIs
- **WHEN** a visitor or agent calls `/sandbox/_ref/traces`, `/sandbox/_ref/grants`, `/sandbox/_ref/runs`, or their timeline/detail variants
- **THEN** the API SHALL return deterministic reference-only inspection JSON for the seeded fictional events

#### Scenario: Visitor calls demo metadata
- **WHEN** a visitor or agent calls `/sandbox/.well-known/oauth-authorization-server` or `/sandbox/.well-known/oauth-protected-resource`
- **THEN** the response SHALL advertise sandbox-prefixed demo endpoints and SHALL identify the service as a demo/mock reference instance

### Requirement: Demo state SHALL be safe, fictional, deterministic, and resettable

All sandbox demo data SHALL be fictional, deterministic, and safe to expose publicly. Reset behavior SHALL return the visitor to the seeded initial view without requiring server-side cleanup.

#### Scenario: Seeded demo data is reviewed
- **WHEN** maintainers inspect the demo dataset
- **THEN** it SHALL contain no real credentials, tokens, emails for real people, account identifiers, source-platform identifiers, private records, or personal data
- **AND** any realistic-looking values SHALL be clearly fictional or use reserved/example domains and names

#### Scenario: Visitor resets the demo
- **WHEN** a visitor activates the sandbox reset control
- **THEN** the UI SHALL return to its initial seeded state
- **AND** any API examples SHALL remain deterministic and safe to call again

### Requirement: Demo fidelity SHALL be honest and bounded

The sandbox demo SHALL label simulated behavior honestly and SHALL NOT claim to be a full protocol conformance suite or a hosted live owner reference instance.

#### Scenario: Demo route uses reference-like APIs
- **WHEN** the sandbox exposes a mock endpoint that resembles a public or reference-only endpoint
- **THEN** the page or API metadata SHALL make clear that the endpoint is demo-only and sandbox-prefixed
- **AND** it SHALL link or point to the real documentation where practical

#### Scenario: Coverage matrix claims demo evidence
- **WHEN** `/reference/coverage` marks a flow as demonstrated by the sandbox
- **THEN** the evidence SHALL link to the sandbox demo surface or tests that prove that exact seeded behavior
