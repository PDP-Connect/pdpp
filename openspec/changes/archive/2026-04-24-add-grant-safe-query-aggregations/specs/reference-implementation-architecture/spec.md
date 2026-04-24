## ADDED Requirements

### Requirement: Public aggregations SHALL be single-stream and grant-safe
The reference implementation SHALL expose public aggregation only for one stream at a time. Aggregation input fields, grouping fields, and filters SHALL be authorized under the caller's grant or owner scope before evaluation.

#### Scenario: Client counts granted records
- **WHEN** a client token authorized for `<stream>` requests a count aggregation for `<stream>`
- **THEN** the response SHALL count only records visible under that grant
- **AND** fields outside the grant SHALL NOT influence the result

#### Scenario: Cross-stream aggregation is requested
- **WHEN** a client requests an aggregation across multiple streams
- **THEN** the reference SHALL reject the request unless a later accepted change defines cross-stream semantics

### Requirement: Public aggregations SHALL be manifest-declared
The reference implementation SHALL evaluate only aggregation operations and fields declared by the stream manifest. Undeclared fields, non-scalar fields, arrays, objects, blobs, and high-cardinality fields that are not explicitly declared SHALL be rejected.

#### Scenario: Declared numeric sum is accepted
- **WHEN** a stream declares a numeric field as summable
- **AND** the caller is authorized for that field
- **THEN** the client MAY request a sum aggregation over that field

#### Scenario: Undeclared field is rejected
- **WHEN** a client requests an aggregation over a field absent from the stream's aggregation declaration
- **THEN** the reference SHALL reject the request with a clear query error

### Requirement: Public aggregations SHALL reuse record-list filter semantics
Aggregation requests SHALL use the same exact and declared range filter validation as record-list requests. Unsupported, unauthorized, or malformed filters SHALL fail with the same error class as record-list filtering.

#### Scenario: Date-windowed aggregation
- **WHEN** a client requests an aggregation with `filter[date][gte]=...`
- **AND** the field and operator are declared under `query.range_filters`
- **THEN** the aggregation SHALL apply the same coercion and comparison semantics as record-list filtering

### Requirement: Grouped aggregation results SHALL be bounded and deterministic
Grouped aggregation responses SHALL enforce a maximum bucket limit and deterministic ordering. If the request exceeds the allowed limit or requests grouping by an unsupported field, the reference SHALL reject it.

#### Scenario: Grouped count with limit
- **WHEN** a client requests `group_by=<field>&limit=N`
- **AND** `<field>` is declared groupable
- **THEN** the response SHALL contain at most `N` group buckets
- **AND** the ordering SHALL be documented and deterministic
