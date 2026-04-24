## ADDED Requirements

### Requirement: The reference implementation SHALL implement filtered retrieval through the public search surfaces

The reference implementation SHALL implement stream-scoped filters on `GET /v1/search` and `GET /v1/search/semantic` through the public endpoints, reusing the same filter validation semantics as record listing. Filtered retrieval SHALL remain grant-safe and SHALL NOT introduce a second filter grammar.

#### Scenario: Lexical retrieval applies a declared range filter
- **WHEN** a caller invokes `GET /v1/search` with `q`, exactly one `streams[]` value, and a declared `filter[field][gte|gt|lte|lt]`
- **THEN** the reference SHALL validate the filter against the stream metadata and caller authorization
- **AND** every returned result SHALL hydrate to a visible record satisfying that filter

#### Scenario: Semantic retrieval applies a declared range filter
- **WHEN** a caller invokes `GET /v1/search/semantic` with `q`, exactly one `streams[]` value, and a declared `filter[field][gte|gt|lte|lt]`
- **THEN** the reference SHALL validate the filter against the stream metadata and caller authorization
- **AND** every returned result SHALL hydrate to a visible record satisfying that filter

#### Scenario: Filter validation fails
- **WHEN** a search request contains a filter without exactly one `streams[]` value, an unauthorized field, an undeclared range field, an unsupported range operator, or a malformed filter value
- **THEN** the reference SHALL reject the request before returning retrieval results
- **AND** the reference SHALL NOT return partial results from streams or connectors where the filter happened to be valid

#### Scenario: Forbidden retrieval controls remain rejected
- **WHEN** a caller passes expansion, sort, ranking knobs, connector-specific query parameters, model selectors, raw vectors, score/debug parameters, or DSL-shaped parameters to a retrieval endpoint
- **THEN** the reference SHALL reject those parameters according to the relevant retrieval contract
- **AND** filtered retrieval SHALL NOT be used as a backdoor to widen the public query surface
