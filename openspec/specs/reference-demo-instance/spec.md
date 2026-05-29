# reference-demo-instance Specification

## Purpose
TBD - created by archiving change add-mock-reference-demo-instance. Update Purpose after archive.
## Requirements
### Requirement: Public sandbox SHALL provide a mock-owner reference demo instance

The public sandbox SHALL provide a mock-owner reference demo instance that presents the real reference dashboard experience backed by deterministic fictional AS/RS state. The demo SHALL be usable without Docker, `.env.local`, connector credentials, a local SQLite database, or a running reference server.

#### Scenario: Visitor opens the sandbox
- **WHEN** a visitor opens `/sandbox`
- **THEN** they SHALL be offered a mock-owner entrypoint into the reference dashboard experience rather than only a static future-work placeholder, disconnected story card, or tutorial fork
- **AND** the surface SHALL identify that the resulting environment uses fictional data
- **AND** the surface SHALL NOT require owner login, connector credentials, or live AS/RS availability

#### Scenario: Hosted documentation deploy serves the sandbox
- **WHEN** the public website is deployed without a live reference stack
- **THEN** the sandbox demo SHALL still render and expose its demo APIs from deterministic mock state

### Requirement: Demo dashboard SHALL use the real dashboard experience in mock-owner mode

The mock reference demo instance SHALL expose the core reference dashboard journey: overview, records, search, grants, runs, traces, and deployment/capability inspection. The primary sandbox experience SHALL use the same dashboard shell, information architecture, feature components, core copy, and data contracts as the live owner dashboard wherever safety permits, binding them to deterministic mock AS/RS data rather than cloning a tutorial-specific dashboard.

#### Scenario: Visitor browses records
- **WHEN** a visitor opens the sandbox records surface
- **THEN** they SHALL be able to inspect fictional connectors, streams, records, stream metadata, and at least one record detail view
- **AND** the interaction model, route-level layout, and core copy SHALL substantially match the live dashboard records experience

#### Scenario: Visitor searches data
- **WHEN** a visitor uses the sandbox search surface
- **THEN** they SHALL be able to search the fictional records and inspect which stream/record matched
- **AND** the interaction model, route-level layout, and core copy SHALL substantially match the live dashboard search experience

#### Scenario: Visitor inspects control-plane evidence
- **WHEN** a visitor opens sandbox grants, runs, or traces
- **THEN** they SHALL see fictional but coherent timelines that demonstrate request, consent, scoped access, revocation, run success, run failure, and reference-only event evidence where applicable
- **AND** timeline rendering, route-level layout, and core copy SHALL substantially match the live dashboard timeline experience

#### Scenario: Visitor enters mock-owner mode
- **WHEN** a visitor chooses the sandbox mock-owner entrypoint
- **THEN** the primary destination SHALL be a dashboard-mode page using dashboard chrome and navigation
- **AND** educational explanations, walkthroughs, and API examples SHALL be secondary affordances rather than the primary dashboard content

### Requirement: Sandbox dashboard SHALL use a mock data-source seam

The mock reference demo instance SHALL exercise the real dashboard feature layer through a typed data-source seam. `/dashboard/**` SHALL bind that feature layer to live owner-authenticated AS/RS clients. `/sandbox/**` SHALL bind the same feature layer to deterministic mock AS/RS state. Sandbox-specific pages MAY exist for API examples, walkthroughs, and educational documentation, but the primary overview/records/search/grants/runs/traces/deployment experience SHALL NOT be a forked tutorial implementation.

For primary dashboard-mode surfaces, `/dashboard/**` and `/sandbox/**` SHALL render through the same shared dashboard feature components unless the divergence is explicitly safety-driven, demo-state-specific, or blocked on a missing canonical operation/feature seam. The live page SHALL inject the live data source, real owner actions, owner authentication, and live polling where applicable. The sandbox page SHALL inject the mock data source, deterministic mock AS/RS adapters, read-only or no-op actions, and mock-owner labeling.

#### Scenario: Live dashboard renders

- **WHEN** `/dashboard/**` renders a dashboard feature
- **THEN** it SHALL use the live data source
- **AND** it SHALL keep owner authentication and live AS/RS behavior unchanged

#### Scenario: Sandbox dashboard renders

- **WHEN** `/sandbox/**` renders the corresponding dashboard feature
- **THEN** it SHALL use the sandbox data source
- **AND** it SHALL NOT mint owner tokens, forward owner-session cookies, or call the live AS/RS
- **AND** it SHALL retain persistent, subtle mock-owner/demo labeling

#### Scenario: Dashboard feature changes

- **WHEN** a dashboard records/search/grants/runs/traces feature changes in a way that affects the user journey
- **THEN** the sandbox-backed version SHALL either inherit the change through shared feature components or explicitly document why the sandbox diverges

#### Scenario: Sandbox copy diverges from dashboard copy

- **WHEN** sandbox primary dashboard copy differs from the live dashboard feature copy
- **THEN** the divergence SHALL be safety-driven or demo-state-specific
- **AND** it SHALL NOT reframe the primary experience as a tutorial, future-work page, or separate sandbox product

#### Scenario: Primary sandbox page lacks a shared feature seam

- **WHEN** a primary sandbox page cannot render through the same feature component as its live dashboard counterpart
- **THEN** the divergence SHALL be documented with its reason
- **AND** the page SHALL still bind deterministic mock state rather than live AS/RS clients
- **AND** the page SHALL retain mock-owner/demo labeling

#### Scenario: Live overview page renders

- **WHEN** `/dashboard` renders the overview
- **THEN** it SHALL render through the same shared overview view component used by `/sandbox/overview`
- **AND** it SHALL bind the live data source, live actions, and the live overview routes

#### Scenario: Live records page renders

- **WHEN** `/dashboard/records` renders the records index
- **THEN** it SHALL render through the same shared records-list view component used by `/sandbox/records`
- **AND** it SHALL bind the live data source, the live Sync-now action, and the live records-page poller

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

### Requirement: Sandbox API routes SHALL use canonical operations with mock adapters

Sandbox route handlers under `/sandbox/v1/**`, `/sandbox/_ref/**`, and `/sandbox/.well-known/**` SHALL bind canonical AS/RS operation modules to deterministic mock adapter dependencies wherever a canonical operation exists for the corresponding live behavior. Fixture builders MAY construct seeded data and mock dependencies, but SHALL NOT become a parallel implementation of AS/RS business logic when an operation module is available.

#### Scenario: Canonical operation exists

- **WHEN** a sandbox API route mirrors behavior covered by a canonical AS/RS operation module
- **THEN** the sandbox route SHALL call that operation module
- **AND** it SHALL provide deterministic mock adapter dependencies
- **AND** it SHALL NOT call live AS/RS clients, mint owner tokens, or require a reference server process

#### Scenario: Canonical operation is missing

- **WHEN** a sandbox API route mirrors behavior that does not yet have a canonical AS/RS operation module
- **THEN** the route MAY use deterministic demo builders
- **AND** the exception SHALL be documented as a temporary operation-gap
- **AND** the builder SHALL remain bounded to mock data and live-shaped envelopes

#### Scenario: Demo builder is reused

- **WHEN** `_demo/builders.ts` or equivalent sandbox fixture code is used by a route handler
- **THEN** the code SHALL be classifiable as seeded fixture construction, mock dependency construction, or a documented operation-gap adapter
- **AND** it SHALL NOT bypass an available canonical operation module

### Requirement: Sandbox connector-health time semantics SHALL use the deterministic sandbox clock

Sandbox dashboard surfaces that compute time-relative labels — including but not limited to "Synced last 24h" and "Stale >7d" on the records connector-health strip — SHALL evaluate those labels against the deterministic sandbox clock (the dataset's frozen "now") rather than the wall-clock `Date.now()`. The live dashboard SHALL continue to use wall-clock time.

#### Scenario: Sandbox visitor reads connector-health labels

- **WHEN** a visitor opens `/sandbox/records`
- **THEN** the "Synced last 24h" count SHALL be computed using the deterministic sandbox clock
- **AND** the "Stale >7d" count SHALL be computed using the deterministic sandbox clock
- **AND** the labels SHALL NOT change as wall-clock time advances past the dataset's frozen "now"

#### Scenario: Live visitor reads connector-health labels

- **WHEN** an owner opens `/dashboard/records`
- **THEN** the same labels SHALL be computed using wall-clock time
