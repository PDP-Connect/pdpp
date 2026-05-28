## ADDED Requirements

### Requirement: Reference dashboard Explore route SHALL host the time-range lens

The reference dashboard SHALL accept `since` and `until` query parameters on `/dashboard/explore` and render the cross-stream time-anchored feed for that window using existing manifest metadata and per-connection record reads, without introducing any new RS or `_ref` endpoint.

#### Scenario: Explore renders the time-anchored feed when a time window is specified

- **WHEN** an authenticated operator visits `/dashboard/explore` with a `since` and/or `until` query parameter and no `q`
- **THEN** the dashboard SHALL load the time-anchored cross-stream feed by querying each visible connection instance's time-anchored streams with that connection's `connector_instance_id`
- **AND** the rendered feed SHALL interleave records from every stream that declares a `consent_time_field`, sorted by that field's value descending
- **AND** each rendered row SHALL preserve the concrete connection identity used for the read
- **AND** the lens label on the Explore canvas SHALL identify the active lens as the time-range view
- **AND** the page SHALL NOT call any RS or `_ref` endpoint that was not already used by the previous Timeline page or by Explore's existing recency and search lenses

#### Scenario: Explore preserves chip state inside the time-range lens

- **WHEN** an operator has one or more connection or stream chips selected and applies a `since`/`until` window
- **THEN** the time-anchored fan-out SHALL only query selected connection instances and selected streams (when chips are present)
- **AND** the chip URLs SHALL preserve the active `since` and `until` parameters so toggling a chip does not silently drop the window

#### Scenario: Query and time-range do not compose silently

- **WHEN** an operator submits a non-empty `q` while `since` or `until` is present
- **THEN** the dashboard SHALL render the existing record search feed (lexical or hybrid) without applying the time window to the search request
- **AND** the lens label SHALL state explicitly that the time window is not applied to search, so the operator is not misled into believing the result is filtered by both lenses
- **AND** the URL SHALL retain `since`, `until`, and `q` so the operator can clear `q` to fall back to the time-range lens without re-entering dates

### Requirement: Reference dashboard SHALL redirect the legacy Timeline route to Explore

The reference dashboard SHALL redirect `/dashboard/records/timeline` to `/dashboard/explore` with the `since` and `until` query parameters preserved, and SHALL NOT keep the Timeline subpage as a separately-reachable view.

#### Scenario: Legacy Timeline deep links land on Explore

- **WHEN** an operator or external link navigates to `/dashboard/records/timeline` with any combination of `since` and `until`
- **THEN** the dashboard SHALL redirect to `/dashboard/explore` with the same query string
- **AND** the redirect SHALL NOT be permanent so a later IA tranche can retire the records-subtree URL prefix cleanly
- **AND** the rendered Explore page at the redirect destination SHALL behave identically to the previous `/dashboard/records/timeline` for the same `since` / `until` parameters

#### Scenario: The Records subnav no longer surfaces a separate Timeline entry

- **WHEN** an operator is viewing any `/dashboard/records/**` page and the Records subnav is shown
- **THEN** the subnav SHALL NOT contain a `Timeline` link
- **AND** the time-range lens SHALL be reachable only via the top-level `Explore` entry, by typing the `since`/`until` URL directly, or by following the redirect from a stale Timeline link

### Requirement: Reference dashboard Records subnav SHALL use Connections vocabulary

The reference dashboard SHALL relabel the Records subnav header to `Connections` so the operator-visible vocabulary aligns with the canonical noun, without altering the underlying `/dashboard/records/*` URL prefix.

#### Scenario: The Records subnav header reads Connections

- **WHEN** an operator views any `/dashboard/records/**` page
- **THEN** the subnav's header text SHALL be `Connections`, not `Records`
- **AND** the subnav SHALL continue to contain a `Connectors` entry that links to `/dashboard/records` and an `Explorer` entry that links to `/dashboard/explore`

#### Scenario: The Records URL subtree is not renamed in this tranche

- **WHEN** an operator visits the records-index page or any per-connection drilldown
- **THEN** the URL SHALL remain rooted at `/dashboard/records` in this tranche
- **AND** the rename of the Records subtree to `/dashboard/connections` (and the corresponding nav relabel) SHALL be scoped to a subsequent OpenSpec change, not this one
