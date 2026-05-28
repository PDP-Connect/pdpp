## ADDED Requirements

### Requirement: Reference dashboard SHALL scope Search to spine artifact jumps

The reference dashboard's `/dashboard/search` surface SHALL be a spine
artifact lookup utility for traces, grants, and runs (and any future spine
artifact families served by `GET /_ref/search`). It SHALL NOT render an
owner-token record content search section. Record content search SHALL be
the responsibility of `/dashboard/explore` only. This requirement governs
the dashboard's consumption of the public retrieval endpoints; it SHALL NOT
modify any RS or `_ref` read contract.

#### Scenario: Search renders artifact buckets only

- **WHEN** an authenticated operator visits `/dashboard/search?q=<query>` with `jump=0`
- **THEN** the page SHALL render artifact buckets (traces, grants, runs) returned by `GET /_ref/search`
- **AND** the page SHALL NOT render a record-results section, retrieval-state notice, semantic uplift badge, or hybrid retrieval badge
- **AND** the page SHALL NOT call `GET /v1/search`, `GET /v1/search/hybrid`, or `GET /v1/search/semantic`

#### Scenario: Free-text submit redirects to Explore

- **WHEN** an authenticated operator submits a non-empty `q` to `/dashboard/search` without `jump=0` and the query does not resolve to a spine artifact id
- **THEN** the page SHALL redirect to `/dashboard/explore?q=<query>` so record content search happens on one surface
- **AND** the redirect SHALL preserve the URL-encoded query exactly
- **AND** the empty-state copy SHALL link to `/dashboard/explore` so operators discover the record search surface without needing to know about the redirect

#### Scenario: Exact-id jump still resolves through Search

- **WHEN** an authenticated operator submits a query that exactly matches a known trace, grant, or run id on `/dashboard/search` with `jump=1`
- **THEN** the page SHALL redirect to that artifact's canonical detail route (`/dashboard/traces/<id>`, `/dashboard/grants/<id>`, or `/dashboard/runs/<id>`)
- **AND** the exact-id redirect SHALL take precedence over the free-text redirect to Explore

#### Scenario: The sandbox Search surface mirrors the live scope

- **WHEN** a sandbox visitor submits a query on `/sandbox/search`
- **THEN** the page SHALL render the deterministic mock spine artifact buckets only
- **AND** the page SHALL NOT call the sandbox data source's record search methods
- **AND** the same exact-id and free-text redirect rules SHALL apply, targeting `/sandbox/explore`

#### Scenario: Command palette free-text submit reaches Explore

- **WHEN** an operator types a free-text query into the command palette and submits
- **THEN** the palette SHALL navigate to `/dashboard/search?q=<query>&jump=1`
- **AND** the resulting page SHALL redirect to `/dashboard/explore?q=<query>` when the query does not resolve to a spine id

## MODIFIED Requirements

### Requirement: Reference dashboard exposes a records explorer surface

The reference dashboard SHALL expose an owner-only records-explorer surface at `/dashboard/explore` (with the legacy `/dashboard/records/explorer` URL preserved by redirect) that browses owner-visible records through existing public PDPP and existing `_ref` read endpoints, without introducing new RS or `_ref` endpoints.

#### Scenario: The explorer reads through the existing RS contract
- **WHEN** the records explorer renders results
- **THEN** it SHALL read only through endpoints already exercised by the dashboard: the public `GET /v1/search`, `GET /v1/search/hybrid`, `GET /v1/streams`, `GET /v1/streams/:stream/records`, `GET /v1/streams/:stream/records/:id`, and the existing `_ref/connectors` connection-summary surface
- **AND** it SHALL NOT introduce or require new RS routes, new `_ref` routes, or new owner-token scopes

#### Scenario: The explorer preserves connection identity when known
- **WHEN** the explorer renders facet chips for the visible connections
- **THEN** each chip SHALL key on a concrete `connection_id` and SHALL NOT collapse multiple connections of the same connector type into one chip

#### Scenario: The explorer preserves connection identity on the empty-query feed
- **WHEN** the explorer renders the empty-query recency feed (which derives every row from a known per-connection fan-out)
- **THEN** the row key, the peek URL parameter, the row's full-record link, and the peek-panel record read SHALL all carry the concrete `connection_id` that produced the row
- **AND** two rows from two distinct connections of the same connector type SHALL produce two distinct row keys, peek URLs, and full-record links

#### Scenario: The explorer does not falsely attribute a search hit to a connection
- **WHEN** the explorer renders a search hit and more than one visible connection of the hit's connector type is configured
- **AND** the public search response does not carry a concrete `connection_id` for that hit (which is the current `/v1/search*` contract; the field is additive-optional and a forward-compatible client reads it when present)
- **THEN** the row SHALL NOT attribute the hit to any single connection
- **AND** the row SHALL be rendered as connector-scoped, with no concrete connection display name
- **AND** the row's full-record link SHALL fall back to the connector-scope route rather than guessing a connection
- **AND** the feed's surrounding caption SHALL state that public search results do not yet carry connection identity, so search rows are connector-scoped when multiple connections of that type exist

#### Scenario: The explorer deduces a single visible connection when unambiguous
- **WHEN** the explorer renders a search hit and exactly one visible connection of the hit's connector type is configured
- **THEN** the row MAY attribute the hit to that connection (this is deduction from visibility, not a first-match guess)
- **AND** the row's full-record link SHALL include the concrete `connection_id`

#### Scenario: Selected-connection chips are honest about their search-mode scope
- **WHEN** the owner has selected one or more connection chips AND a query is active
- **AND** the public search response cannot enforce a `connection_id` request filter (the current `/v1/search*` contract)
- **THEN** the resulting feed MAY narrow by the connector types of the selected connections
- **AND** the selected-connection summary SHALL label that constraint as connector-scoped (e.g. "connector (from connection)") rather than claiming a connection filter the request cannot enforce
- **AND** the explorer SHALL NOT pick an arbitrary one of the selected connections to attribute hits to

#### Scenario: Selected-connection chips tighten when hits carry concrete identity
- **WHEN** the owner has selected one or more connection chips AND a query is active
- **AND** a search hit carries a concrete `connection_id` (or its deprecated `connector_instance_id` alias) in the response (forward-compatible with `expose-connection-identity-on-public-read`)
- **THEN** the explorer SHALL drop the hit unless that concrete connection identity matches one of the selected visible connections
- **AND** hits in the same response that do not carry concrete identity SHALL continue to fall through to the connector-scoped post-filter rather than being dropped

#### Scenario: Record reads carry the resolved connection scope
- **WHEN** the explorer issues a record read for the peek panel
- **THEN** the read SHALL include the `connector_id` and, when a concrete `connection_id` (or its deprecated `connector_instance_id` alias) is known for the row, the matching `connector_instance_id` scope used to derive the displayed value
- **AND** the displayed URL SHALL match the URL the typed RS client actually issues

#### Scenario: The explorer is honest about the read URL
- **WHEN** the explorer's peek panel renders a selected record
- **THEN** it SHALL display the exact `GET /v1/streams/<stream>/records/<id>` URL — including any `connector_id` and `connector_instance_id` query parameters — that the dashboard used to read that record
- **AND** the displayed URL SHALL match the URL the typed RS client actually issues

#### Scenario: The explorer degrades gracefully when no query is set
- **WHEN** the explorer renders without a query
- **THEN** it SHALL render a recency-sorted feed sourced from a bounded fan-out over owner-visible connections rather than from a new RS endpoint
- **AND** the fan-out SHALL be bounded by a fixed cap on (connections, streams per connection, records per stream) so the empty-query load remains cheap

#### Scenario: The explorer is the sole owner-token record search surface
- **WHEN** an owner wants to find records by free-text content
- **THEN** the dashboard SHALL surface that query on `/dashboard/explore` only
- **AND** `/dashboard/search` SHALL NOT render an owner-token record-content search section
- **AND** the explorer's search lens SHALL remain reachable via `/dashboard/explore?q=<query>` and via the redirect from `/dashboard/search?q=<query>` (without `jump=0`)

#### Scenario: The explorer does not invent grant or projection chrome the owner token does not have
- **WHEN** the explorer renders under an owner token
- **THEN** it SHALL NOT surface a client-grant chip, field-projection toggle, or any UI element that implies the records are being read under a third-party grant
- **AND** any such affordances SHALL be reserved for a future data-owner-facing surface that holds a real client-scoped grant

#### Scenario: Partial fan-in failures are surfaced, not silently swallowed
- **WHEN** the empty-query recency feed's bounded per-stream fan-out has one or more stream reads fail
- **THEN** the surviving rows SHALL still render
- **AND** the page SHALL surface each failure as a structured warning naming the connection display name and stream
- **AND** the warning surface SHALL state that the rendered rows are partial

#### Scenario: Capability downgrades are surfaced honestly
- **WHEN** the resource server advertises `capabilities.hybrid_retrieval.supported: true` but a hybrid search call fails
- **THEN** the explorer SHALL fall back to lexical retrieval so the owner still gets results
- **AND** the page SHALL surface a structured warning naming the downgrade and the underlying error
- **AND** the warning SHALL NOT be silently swallowed
