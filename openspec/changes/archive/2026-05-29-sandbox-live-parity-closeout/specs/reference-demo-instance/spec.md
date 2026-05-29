## MODIFIED Requirements

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

## ADDED Requirements

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
