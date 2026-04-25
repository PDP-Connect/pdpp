## ADDED Requirements

### Requirement: Hybrid retrieval is optional, experimental, and separately advertised

PDPP SHALL define an optional experimental `hybrid-retrieval` extension for implementations that combine lexical and semantic retrieval into one result list. Clients SHALL NOT assume the extension exists unless resource-server metadata advertises it.

#### Scenario: A server does not advertise hybrid retrieval

- **WHEN** a client reads resource-server metadata and `capabilities.hybrid_retrieval.supported` is absent or false
- **THEN** the client SHALL NOT assume `GET /v1/search/hybrid` is available
- **AND** the server MAY return 404 if the endpoint is requested.

#### Scenario: A server advertises hybrid retrieval

- **WHEN** resource-server metadata reports `capabilities.hybrid_retrieval.supported: true`
- **THEN** the client MAY call the advertised endpoint
- **AND** the client SHALL treat the extension as experimental unless the advertisement says otherwise.

### Requirement: Hybrid retrieval preserves grant-safe retrieval boundaries

Hybrid retrieval SHALL compute lexical and semantic candidates only over streams and fields visible to the caller's grant, using the same authorization rules as the underlying lexical and semantic retrieval surfaces.

#### Scenario: A stream is outside the grant

- **WHEN** a client-token request names a stream outside the grant
- **THEN** hybrid retrieval SHALL reject the request consistently with lexical and semantic retrieval
- **AND** the unauthorized stream SHALL NOT contribute candidates.

#### Scenario: A field is not visible to the grant

- **WHEN** a stream declares lexical or semantic fields that are not visible under the grant projection
- **THEN** those fields SHALL NOT contribute matches, snippets, or scores.

### Requirement: Hybrid results expose source provenance

Hybrid retrieval SHALL return candidate references, not full hydrated records, and each result SHALL indicate which retrieval source or sources contributed the hit.

#### Scenario: A record matches both retrieval sources

- **WHEN** the same `(connector_id, stream, record_key)` is returned by both lexical and semantic retrieval
- **THEN** the hybrid response SHALL include one result for that record
- **AND** the result SHALL identify both lexical and semantic provenance.

#### Scenario: A record matches only one retrieval source

- **WHEN** a record is returned by only lexical or only semantic retrieval
- **THEN** the result SHALL identify the contributing source
- **AND** it SHALL NOT imply that the other source matched.

### Requirement: Hybrid cursors are opaque and snapshot-honest

If hybrid retrieval supports pagination, its cursors SHALL encode enough server-side state to avoid duplicate, missing, or reordered results caused by independently changing lexical and semantic candidate sets.

#### Scenario: Pagination is not yet implemented

- **WHEN** a first-tranche implementation cannot provide snapshot-honest hybrid pagination
- **THEN** it SHALL omit cursor support or reject cursor parameters rather than exposing misleading offset-only pagination.
