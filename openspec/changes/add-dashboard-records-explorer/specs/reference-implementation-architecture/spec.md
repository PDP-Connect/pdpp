## ADDED Requirements

### Requirement: Reference dashboard exposes a records explorer surface
The reference dashboard SHALL expose an owner-only records-explorer surface at `/dashboard/records/explorer` that browses owner-visible records through existing public PDPP and existing `_ref` read endpoints, without introducing new RS or `_ref` endpoints.

#### Scenario: The explorer reads through the existing RS contract
- **WHEN** the records explorer renders results
- **THEN** it SHALL read only through endpoints already exercised by the dashboard: the public `GET /v1/search`, `GET /v1/search/hybrid`, `GET /v1/streams`, `GET /v1/streams/:stream/records`, `GET /v1/streams/:stream/records/:id`, and the existing `_ref/connectors` connection-summary surface
- **AND** it SHALL NOT introduce or require new RS routes, new `_ref` routes, or new owner-token scopes

#### Scenario: The explorer preserves connection identity
- **WHEN** the explorer renders facet chips, feed rows, or peek metadata for a record
- **THEN** the explorer SHALL key those affordances on `connection_id` and SHALL NOT collapse multiple connections of the same connector type into a single row or chip
- **AND** record reads issued from the peek panel SHALL include the `connector_id` and, when known, the `connector_instance_id` scope used to derive the displayed value

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
