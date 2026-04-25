## MODIFIED Requirements

### Requirement: The extension SHALL expose `GET /v1/search` with a constrained query surface

`GET /v1/search` SHALL remain the lexical retrieval endpoint even when a server also advertises hybrid retrieval. Hybrid retrieval SHALL NOT silently alter lexical result ranking, filtering, scoring, or response shape.

#### Scenario: Hybrid retrieval is also available

- **WHEN** a server advertises both lexical retrieval and hybrid retrieval
- **THEN** `GET /v1/search` SHALL continue to behave as lexical retrieval
- **AND** clients that want blended recall SHALL call the advertised hybrid endpoint.
