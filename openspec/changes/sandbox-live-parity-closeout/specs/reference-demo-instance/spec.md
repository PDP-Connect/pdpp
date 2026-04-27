## MODIFIED Requirements

### Requirement: Sandbox dashboard SHALL use a mock data-source seam

The mock reference demo instance SHALL exercise the real dashboard feature layer through a typed data-source seam. `/dashboard/**` SHALL bind that feature layer to live owner-authenticated AS/RS clients. `/sandbox/**` SHALL bind the same feature layer to deterministic mock AS/RS state. Sandbox-specific pages MAY exist for API examples, walkthroughs, and educational documentation, but the primary overview/records/search/grants/runs/traces/deployment experience SHALL NOT be a forked tutorial implementation.

For the dashboard surfaces in scope of `sandbox-live-parity-closeout` (overview and records), `/dashboard/**` and `/sandbox/**` SHALL render through the same shared dashboard view components. The live page SHALL inject the live data source, real actions, and live polling. The sandbox page SHALL inject the mock data source and read-only or no-op actions.

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

#### Scenario: Live overview page renders

- **WHEN** `/dashboard` renders the overview
- **THEN** it SHALL render through the same shared overview view component used by `/sandbox/overview`
- **AND** it SHALL bind the live data source, live actions, and the live overview routes

#### Scenario: Live records page renders

- **WHEN** `/dashboard/records` renders the records index
- **THEN** it SHALL render through the same shared records-list view component used by `/sandbox/records`
- **AND** it SHALL bind the live data source, the live Sync-now action, and the live records-page poller

## ADDED Requirements

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
