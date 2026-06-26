## ADDED Requirements

### Requirement: First-party connector manifests SHALL declare useful query affordances explicitly

First-party polyfill connector manifests SHALL declare query affordances for useful, granted, top-level fields that the connector author knows are safe and meaningful to retrieve by. A readable field SHALL NOT be treated as searchable, range-filterable, aggregatable, or facetable unless the manifest declares that affordance or the field appears on an explicit justified non-support list.

#### Scenario: Natural-language field supports retrieval

- **WHEN** a first-party connector stream exposes a granted top-level natural-language field that is useful for owner retrieval
- **THEN** the manifest SHALL declare the field in `query.search.lexical_fields`
- **AND** it SHALL declare the field in `query.search.semantic_fields` when the field carries meaning-bearing title, body, note, memo, caption, or description text
- **AND** it SHALL NOT declare identifiers, URLs, hashes, MIME types, opaque paths, timestamps, currency codes, or status codes as semantic fields merely because they are strings.

#### Scenario: Time field supports bounded reads

- **WHEN** a first-party connector stream exposes a granted top-level date or date-time field that is useful for owner filtering or bounded reads
- **THEN** the manifest SHALL declare the field under `query.range_filters`
- **AND** clients SHALL be able to discover the range affordance through the reference schema field capabilities.

#### Scenario: Time field supports calendar buckets

- **WHEN** a first-party connector stream exposes a granted top-level time field that is meaningful for count-over-time aggregation
- **AND** the field's schema type is supported by the reference time-bucket aggregation contract
- **THEN** the manifest SHALL declare the field under `query.aggregations.group_by_time`
- **AND** the reference SHALL reject manifest declarations that target backend-unsupported time field schemas.

#### Scenario: Useful field is intentionally unsupported

- **WHEN** a field appears useful for search, range filtering, grouping, or facets but the connector intentionally does not expose that affordance
- **THEN** the manifest-honesty check SHALL require a short allowlist reason
- **AND** the connector SHALL NOT silently leave the useful affordance absent.

### Requirement: Query affordances SHALL remain distinct from presentation roles

First-party connector manifests SHALL treat presentation roles and query affordances as separate declarations. `x_pdpp_role` SHALL describe how a record is presented; it SHALL NOT imply that a field is searchable, range-filterable, aggregatable, or facetable.

#### Scenario: Timestamp is useful for filtering but not event-card presentation

- **WHEN** a message, transaction, metric, inventory, or stats stream exposes a useful timestamp
- **THEN** the manifest MAY declare the timestamp as a range filter or time-bucket aggregation field when supported
- **AND** it SHALL NOT declare `x_pdpp_role: event-time` solely to make the timestamp discoverable for query behavior.

#### Scenario: Event-like stream has an event presentation time

- **WHEN** a stream represents event-like records whose displayed record card should use a start, captured, or occurred time as the event slot
- **THEN** the manifest MAY declare that field as `x_pdpp_role: event-time`
- **AND** it SHALL still separately declare range or aggregation affordances when clients should filter or group by that field.

### Requirement: Manifest-honesty checks SHALL enforce query affordance coverage

The reference build SHALL include manifest-honesty checks that detect supported first-party streams with useful undeclared query affordances, invalid affordance declarations, and missing allowlist reasons.

#### Scenario: Connector adds a useful field without declarations

- **WHEN** a first-party connector manifest adds or renames a useful owner-facing text, time, category, status, account, amount, or location field
- **THEN** manifest-honesty validation SHALL fail unless the connector declares the applicable query affordance or adds a justified non-support entry.

#### Scenario: Connector declares an unsupported aggregation field

- **WHEN** a first-party connector manifest declares `query.aggregations.group_by_time` on a field whose schema the reference aggregation engine does not support
- **THEN** manifest validation SHALL fail before the manifest can ship.

#### Scenario: Client schema projects manifest affordances

- **WHEN** the reference returns schema or compact schema metadata for a stream
- **THEN** the response SHALL expose the manifest-declared search, range, and aggregation affordances in field capabilities
- **AND** clients SHALL NOT need to inspect raw manifest JSON to discover the supported query behavior.
