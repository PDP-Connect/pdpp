## MODIFIED Requirements

### Requirement: Semantic retrieval is an experimental, optional, advertised, named extension

`GET /v1/search/semantic` SHALL remain the semantic retrieval endpoint even when a server also advertises hybrid retrieval. Hybrid retrieval SHALL NOT silently alter semantic result ranking, filtering, scoring, model identity, or response shape.

#### Scenario: Hybrid retrieval is also available

- **WHEN** a server advertises both semantic retrieval and hybrid retrieval
- **THEN** `GET /v1/search/semantic` SHALL continue to behave as semantic retrieval
- **AND** clients that want blended recall SHALL call the advertised hybrid endpoint.
