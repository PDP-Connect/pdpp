## ADDED Requirements

### Requirement: Stream metadata SHALL expose normalized field-level query capabilities
The reference implementation SHALL expose a `field_capabilities` object on stream metadata. Each entry SHALL be keyed by a top-level schema field name and SHALL describe the field schema, grant usability, exact-filter support, range-filter operators, lexical-search participation, and semantic-search participation derived from the stream manifest and active bearer context.

#### Scenario: Owner discovers queryable fields
- **WHEN** an owner token requests `GET /v1/streams/<stream>`
- **THEN** the response SHALL include `field_capabilities`
- **AND** fields declared under `query.range_filters` SHALL list their supported range operators
- **AND** fields declared under `query.search.lexical_fields` or `query.search.semantic_fields` SHALL identify their retrieval participation

#### Scenario: Client grant limits usable fields
- **WHEN** a client token requests `GET /v1/streams/<stream>`
- **AND** the stream manifest declares a query capability on a field outside the client's grant projection
- **THEN** the field capability entry SHALL NOT mark that capability as usable under the current token
- **AND** the response SHALL preserve enough reason information for the client to avoid issuing a doomed query

### Requirement: Stream metadata SHALL expose normalized expansion capabilities
The reference implementation SHALL expose an `expand_capabilities` list on stream metadata derived from `query.expand[]` and matching `relationships[]`. Each expansion entry SHALL include relation name, related stream, cardinality, and declared limit metadata when present.

#### Scenario: Expandable relation is discoverable
- **WHEN** a stream declares a relation in both `relationships[]` and `query.expand[]`
- **THEN** stream metadata SHALL include that relation in `expand_capabilities`
- **AND** the entry SHALL identify the related stream and whether the relation is `has_one` or `has_many`

#### Scenario: Descriptive relationship is not public expansion
- **WHEN** a stream has a `relationships[]` entry that is absent from `query.expand[]`
- **THEN** the relation MAY remain visible as descriptive metadata
- **AND** it SHALL NOT be listed as an enabled expansion capability
