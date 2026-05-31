## MODIFIED Requirements

### Requirement: Reference dashboard exposes a records explorer surface

The reference dashboard SHALL expose an owner-only records-explorer surface at `/dashboard/explore` (with the legacy `/dashboard/records/explorer` URL preserved by redirect) that browses owner-visible records through existing public PDPP and existing `_ref` read endpoints, without introducing new RS or `_ref` endpoints. The explorer SHALL render type-aware record cards dispatched from declared field types when present, falling back to a presentation-only heuristic otherwise, and SHALL present Search, Explore, and Timeline as one coherent owner mental model. The explorer SHALL NOT claim any backend behavior that the public read contract or the active token does not support.

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

#### Scenario: Record cards dispatch from declared field types when present
- **WHEN** the explorer renders a row whose record body is in hand (the recency or time-range lens) AND the stream's `field_capabilities` carry a declared presentation `type` for the row's fields
- **THEN** the card SHALL dispatch its layout from the declared `type` (for example a `currency` field renders a money card, a `person` field renders an author, a `timestamp` field renders an event time)
- **AND** the card SHALL NOT invent a field shape the declared `type` does not assert

#### Scenario: Record cards fall back to the heuristic when types are absent
- **WHEN** the explorer renders a row whose stream exposes no declared presentation `type` (a connector that has not yet declared a typed schema) OR whose record body is not in hand (a search hit that carries only a snippet)
- **THEN** the card SHALL fall back to the presentation-only `record-kind` heuristic and the one-line summary
- **AND** the fallback SHALL NOT be presented as a declared type, and SHALL degrade to a generic card rather than guessing a precise shape

#### Scenario: Field projection is represented honestly under the active token
- **WHEN** the explorer renders fields for a stream whose `field_capabilities` mark one or more fields as not usable under the active token's grant projection
- **THEN** the explorer SHALL represent the projected-out fields honestly (for example as withheld) rather than silently omitting them as though they did not exist
- **AND** the explorer SHALL NOT thereby imply a client-scoped grant on the owner-token surface

#### Scenario: Blob-backed records show grant-aware preview affordances
- **WHEN** the explorer renders a record whose stream declares a `blob` field type AND the record carries a `blob_ref`
- **THEN** the card MAY show a preview or download affordance that reads only through the existing blob read path
- **AND** the affordance SHALL respect the active token's grant: a blob outside the token's projection SHALL be represented as unavailable rather than fetched
- **AND** the explorer SHALL NOT introduce a new RS or `_ref` blob route to render the affordance

#### Scenario: Corpus and activity summaries are bounded and honest
- **WHEN** the explorer renders a corpus or activity summary (for example "spans N years" or an activity strip)
- **THEN** it SHALL source the summary from declared aggregate metadata (`meta.window`) when the read provides it
- **AND** when no aggregate metadata is available, the explorer SHALL either omit the summary or label it as derived from the bounded recency sample rather than claiming a full-corpus figure
- **AND** the explorer SHALL NOT compute a full-corpus summary by an unbounded per-stream fan-out scan

#### Scenario: Search, Explore, and Timeline form one coherent model
- **WHEN** an operator navigates between record browsing, free-text query, time-window browsing, and spine artifact lookup
- **THEN** Explore SHALL be the single records canvas hosting the recency, time-window, and query lenses
- **AND** Timeline SHALL be reachable as an Explore lens (a time window), not as a competing top-level records surface
- **AND** `/dashboard/search` SHALL be reserved for spine artifact jumps (trace, grant, run by id) and SHALL route free-text record queries to Explore
- **AND** the navigation labels SHALL NOT present two surfaces that do the same job under different names

## ADDED Requirements

### Requirement: Stream metadata field capabilities SHALL carry an optional declared presentation type

The reference implementation SHALL allow each `field_capabilities` entry on stream metadata to carry an optional declared presentation `type` (for example `currency`, `timestamp`, `person`, `blob`, `text`) sourced from the stream manifest. The `type` is additive and optional: a manifest that does not declare it SHALL produce a `field_capabilities` entry with no `type`, and consumers SHALL treat an absent `type` as "not declared." This declared `type` is a presentation/dispatch hint for reference surfaces; it is not a Core protocol field and SHALL NOT change grant, projection, filter, or retrieval semantics.

#### Scenario: A manifest declares a typed field
- **WHEN** a stream manifest declares a presentation `type` for a top-level field
- **AND** an owner or client token requests `GET /v1/streams/<stream>`
- **THEN** the field's `field_capabilities` entry SHALL include that declared `type`
- **AND** the live manifest type SHALL accept the same typed field shape the sandbox demo manifests already encode

#### Scenario: An undeclared field omits the type
- **WHEN** a stream manifest does not declare a presentation `type` for a field
- **THEN** the field's `field_capabilities` entry SHALL omit `type`
- **AND** a consumer SHALL treat the absence as "not declared" and fall back to its own heuristic, never inventing a type

#### Scenario: The declared type does not alter query or grant semantics
- **WHEN** the declared presentation `type` is present on a field
- **THEN** exact-filter support, range operators, lexical/semantic participation, and grant usability for that field SHALL be unchanged from a field without a declared `type`
- **AND** the `type` SHALL NOT be writable by a client, SHALL NOT appear in selection requests, and SHALL NOT be treated as a grantable capability

### Requirement: The record-list read MAY expose bounded window aggregate metadata

The reference record-list read (`GET /v1/streams/:stream/records`) MAY include an optional `meta.window` object carrying bounded aggregate metadata for the addressed read — `total`, `earliest_at`, and `latest_at` — computed under the same grant projection and the same exact/declared range-filter validation as the records themselves. When present, `meta.window` SHALL describe the filtered, grant-scoped corpus, not the unfiltered stream. When the read cannot compute the aggregate cheaply or the contract does not provide it, `meta.window` SHALL be omitted rather than estimated.

#### Scenario: A record-list read includes window metadata
- **WHEN** a client reads `GET /v1/streams/<stream>/records` and the resource server can compute the bounded aggregate under the request's grant and filters
- **THEN** the response MAY include `meta.window` with `total`, `earliest_at`, and `latest_at`
- **AND** those figures SHALL reflect the same grant projection and the same range-filter validation applied to the returned records

#### Scenario: Window metadata is omitted rather than estimated
- **WHEN** the resource server cannot compute the bounded aggregate cheaply or does not implement `meta.window`
- **THEN** the response SHALL omit `meta.window`
- **AND** a consumer SHALL treat the absence as "not available" and SHALL NOT synthesize a full-corpus figure from a bounded sample

### Requirement: The sandbox SHALL expose the records explorer at parity with the live surface

The reference sandbox SHALL expose the records explorer at `/sandbox/explore`, rendering the same explorer view through the sandbox (mock-backed) data source. Any divergence between the sandbox and live explorer SHALL be intentional and visibly labeled — never an accidental gap — and the sandbox SHALL remain clearly distinct from live operation per the surface topology.

#### Scenario: Sandbox explore renders the same view through mock data
- **WHEN** a visitor opens `/sandbox/explore`
- **THEN** the page SHALL render the same records-explorer view as `/dashboard/explore`, sourced from the sandbox data source with deterministic fictional data
- **AND** the page SHALL NOT require an owner token, collect real credentials, or read from a live resource server

#### Scenario: Sandbox-only divergences are labeled, not hidden
- **WHEN** the sandbox explorer shows something the live explorer cannot (for example an illustrative read URL or seeded records)
- **THEN** that divergence SHALL be visibly labeled as a sandbox specimen
- **AND** the sandbox SHALL NOT present a capability as live behavior, and a retired sandbox records route SHALL redirect to `/sandbox/explore` rather than 404 or render a stale surface
