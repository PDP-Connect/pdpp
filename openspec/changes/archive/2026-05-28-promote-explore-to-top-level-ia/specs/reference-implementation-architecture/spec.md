## ADDED Requirements

### Requirement: Reference dashboard exposes Explore as a top-level operator-console route

The reference dashboard SHALL expose the records explorer as a top-level operator-console route at `/dashboard/explore`, rendering the same query-driven records canvas previously mounted at `/dashboard/records/explorer` with no change to the underlying RS or `_ref` reads.

#### Scenario: The top-level Explore route renders the records explorer

- **WHEN** an authenticated operator visits `/dashboard/explore`
- **THEN** the dashboard SHALL render the records explorer view
- **AND** the page SHALL read only through endpoints already used by `/dashboard/records/explorer` (the public `GET /v1/search`, `GET /v1/search/hybrid`, `GET /v1/streams`, `GET /v1/streams/:stream/records`, `GET /v1/streams/:stream/records/:id`, and the existing `_ref/connectors` connection-summary surface)
- **AND** the page SHALL NOT introduce or require new RS routes, new `_ref` routes, or new owner-token scopes

#### Scenario: The Explore route is reachable from top-level navigation

- **WHEN** an authenticated operator views any `/dashboard/**` page
- **THEN** the top-level navigation SHALL contain an `Explore` entry whose `href` resolves to `/dashboard/explore`
- **AND** the `Explore` entry SHALL be co-equal with the other top-level navigation entries (such as `Search`, `Traces`, `Grants`, and `Runs`), not nested under a `Records` subnav

#### Scenario: The old explorer path redirects to the top-level route while query parameters are preserved

- **WHEN** an operator or external link navigates to `/dashboard/records/explorer` with any combination of query parameters
- **THEN** the dashboard SHALL redirect to `/dashboard/explore` with the same query string
- **AND** the redirect SHALL NOT be permanent so the legacy path can be retired cleanly in a later IA tranche
- **AND** the rendered records explorer at the redirect destination SHALL behave identically to the previous `/dashboard/records/explorer` for the same query parameters

#### Scenario: The Records subnav continues to surface an Explorer entry during the transition

- **WHEN** an operator is viewing any `/dashboard/records/**` page and the Records subnav is shown
- **THEN** the subnav SHALL still expose an `Explorer` link
- **AND** that subnav link's `href` SHALL resolve to `/dashboard/explore`, the same destination as the top-level navigation entry

#### Scenario: Explore preserves the existing explorer's connection-identity and honesty guarantees

- **WHEN** the top-level Explore route renders results
- **THEN** it SHALL satisfy every connection-identity, partial-fan-in, capability-downgrade, peek-URL, and grant-projection scenario already established for the records explorer in this capability
- **AND** the surface SHALL NOT introduce any UI affordance that implies a backend behavior the RS or `_ref` contract does not support

#### Scenario: Explore does not absorb spine artifact jumps in this tranche

- **WHEN** an operator needs to jump to a trace, grant, or run by id
- **THEN** that flow SHALL remain at `/dashboard/search`
- **AND** the top-level Explore route SHALL be records-only in this tranche, with spine artifact search reserved for `/dashboard/search` until a subsequent change relocates it

#### Scenario: Explore does not absorb the timeline view in this tranche

- **WHEN** an operator needs to browse records by an explicit time-range window
- **THEN** that flow SHALL remain at `/dashboard/records/timeline`
- **AND** the top-level Explore route SHALL retain only the existing query + recency lenses in this tranche, with the time-range lens reserved for a subsequent change that absorbs the timeline view into Explore

#### Scenario: The Records subtree rename is deferred to a separate change

- **WHEN** an operator visits the records-index page or any per-connection drilldown
- **THEN** the URL SHALL remain rooted at `/dashboard/records` in this tranche
- **AND** the rename of the Records subtree to `/dashboard/connections` (and the corresponding nav relabel) SHALL be scoped to a subsequent OpenSpec change, not this one
