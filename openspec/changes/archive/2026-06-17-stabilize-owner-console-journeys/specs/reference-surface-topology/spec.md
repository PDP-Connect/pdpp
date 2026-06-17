## ADDED Requirements

### Requirement: Owner console SHALL be evaluated by owner journeys

The reference owner console SHALL organize shippability around owner journeys rather than route-local or component-local completion. The journey set SHALL include knowing what data exists, adding more data, identifying what is broken, knowing the next action, inspecting collected data, and connecting AI apps to already-collected data.

#### Scenario: A route-local change affects a journey

- **WHEN** a dashboard UI change alters Sources, Add data, browser-session setup, recovery, Runs, Traces, Explore handoff, or Connect AI apps
- **THEN** the change SHALL identify the owner journey it affects
- **AND** acceptance SHALL include journey evidence rather than only component tests or text scans

#### Scenario: A worker completes a local task

- **WHEN** a worker reports that a route or component task is done
- **THEN** the RI owner SHALL NOT treat the work as shippable until the affected owner journey has passed its acceptance check

### Requirement: Add-source primary actions SHALL be real owner actions

The Add data surface SHALL NOT present a primary setup action for a source that the reference instance cannot actually start from that page. Sources that require server/operator configuration, proof-gated browser setup, unsupported future work, or an off-product developer portal SHALL be hidden from the primary action group or separated with owner-meaningful unavailable copy.

#### Scenario: A source cannot be added from the page

- **WHEN** a connector is unsupported, proof-gated, or lacks an owner-usable setup path in the current deployment
- **THEN** the Add data surface SHALL NOT render a primary "Set up" action for that connector
- **AND** it SHALL NOT send the owner to a provider developer portal as if that were setup completion

#### Scenario: A source requires server setup

- **WHEN** a source requires operator-side provider configuration before owner setup can begin
- **THEN** the surface SHALL separate it from add-now sources
- **AND** the label SHALL describe the owner-meaningful dependency rather than using internal terms such as "deployment needed" or "setup proof"

### Requirement: Browser-session setup SHALL fail inline, not through the dashboard error boundary

Browser-session source setup SHALL use a transport that can survive normal browser navigation and network changes. Starting a browser-session setup SHALL either redirect to the run stream, return to the setup page with an inline error, or show a focused inline waiting state. It SHALL NOT leave the owner on a generic "Something went wrong" dashboard error page for expected start failures.

#### Scenario: Browser-session start succeeds

- **WHEN** the owner starts a browser-session setup for a supported browser-bound source
- **THEN** the console SHALL navigate to the run stream or equivalent focused setup surface
- **AND** the owner SHALL NOT see the generic dashboard error boundary

#### Scenario: Browser-session start fails

- **WHEN** the setup shell cannot be created, the run cannot be started, or the browser surface is unavailable
- **THEN** the console SHALL show an inline, owner-readable failure on the setup or stream surface
- **AND** it SHALL NOT expose missing operator runbook paths or internal browser service names as the normal owner fallback

### Requirement: Sources list rows SHALL remain comparable across states

The Sources list SHALL preserve comparable row geometry across healthy, checking, degraded, attention, revoked, and unavailable states. Status changes SHALL NOT alter row width, corner shape, or layout rhythm in a way that makes rows look like different components.

#### Scenario: A source becomes degraded

- **WHEN** a source row changes from healthy/checking to degraded or attention
- **THEN** the row SHALL preserve the same width, corner geometry, and list rhythm as comparable rows
- **AND** only status affordances, copy, and permitted emphasis SHALL change

#### Scenario: A row is selected

- **WHEN** a source row is selected or focused
- **THEN** the selection affordance SHALL remain visually separated from row content
- **AND** it SHALL NOT butt directly against text or controls

### Requirement: Source detail stream rows SHALL carry useful facts or honest absence

The source detail stream table SHALL not render rows that contain only a stream name and otherwise empty fact columns without explanation. It SHALL either show useful stream facts already known to the reference instance or clearly state that those facts are not available yet.

#### Scenario: Stream facts are available

- **WHEN** a stream has known record count, freshness, cursor, search/read support, or last-result facts
- **THEN** the source detail SHALL render those facts in the stream row or nearby detail

#### Scenario: Stream facts are not available

- **WHEN** a stream exists but useful stream facts are unknown or not computed
- **THEN** the source detail SHALL render an honest unavailable/checking explanation rather than empty placeholder columns

### Requirement: Unknown source state SHALL be checking, not an alarm

The owner console SHALL treat unknown coverage, unknown freshness, and missing evidence as checking/unknown states unless other current evidence requires degradation or attention. Unknown alone SHALL NOT produce retry prompts, degraded tone, or owner-action copy.

#### Scenario: A source has unknown coverage only

- **WHEN** a source has no current evidence for coverage completeness and no current failure evidence
- **THEN** the console SHALL render a checking or unknown state
- **AND** it SHALL NOT render a retry action or degraded tone solely because coverage is unknown
