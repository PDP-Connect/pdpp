## ADDED Requirements

### Requirement: Reference dashboard exposes a records explorer surface
The reference dashboard SHALL expose an owner-only records-explorer surface at `/dashboard/records/explorer` that browses owner-visible records through existing public PDPP and existing `_ref` read endpoints, without introducing new RS or `_ref` endpoints.

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

#### Scenario: The explorer does not replace the cross-artifact search page
- **WHEN** an owner needs to jump to a trace, grant, or run by id
- **THEN** that flow SHALL remain at `/dashboard/search` and SHALL NOT be moved into the explorer
- **AND** the explorer SHALL be reachable from the existing Records subnav alongside `Connectors` and `Timeline`

#### Scenario: The explorer does not invent grant or projection chrome the owner token does not have
- **WHEN** the explorer renders under an owner token
- **THEN** it SHALL NOT surface a client-grant chip, field-projection toggle, or any UI element that implies the records are being read under a third-party grant
- **AND** any such affordances SHALL be reserved for a future data-owner-facing surface that holds a real client-scoped grant
