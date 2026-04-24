## ADDED Requirements

### Requirement: Semantic retrieval SHALL advertise score support before emitting scores
If the reference implementation emits semantic retrieval scores, it SHALL advertise score support in `capabilities.semantic_retrieval` before clients query `/v1/search/semantic`. The advertisement SHALL identify the score kind, ordering direction, model identity, and whether values are distances or similarities.

#### Scenario: Server emits semantic scores
- **WHEN** semantic retrieval capability metadata advertises score support
- **AND** a client queries `/v1/search/semantic`
- **THEN** each semantic hit SHALL include a typed score object
- **AND** the score object SHALL identify the score kind and ordering direction

#### Scenario: Model changes
- **WHEN** the active semantic model, dimensions, dtype, or distance metric changes
- **THEN** clients SHALL NOT treat scores from the old and new identity as comparable

### Requirement: Semantic scores SHALL be grant-safe and avoid vector leakage
Semantic scores SHALL be computed only from fields visible under the active grant. Semantic responses SHALL NOT expose embeddings, raw vector distances beyond the typed score, candidate pool sizes, or hidden matched fields.

#### Scenario: Hidden semantic field exists
- **WHEN** a stream declares semantic fields that are outside the caller's grant projection
- **THEN** those hidden fields SHALL NOT contribute to the returned score
- **AND** the response SHALL NOT disclose hidden-field matches or snippets
