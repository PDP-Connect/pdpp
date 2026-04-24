## ADDED Requirements

### Requirement: Lexical retrieval SHALL advertise score support before emitting scores
If the reference implementation emits lexical search scores, it SHALL advertise score support in `capabilities.lexical_retrieval` before clients query `/v1/search`. The advertisement SHALL identify the score kind and whether higher or lower values sort better.

#### Scenario: Server emits lexical scores
- **WHEN** protected-resource metadata advertises lexical score support
- **AND** a client queries `/v1/search`
- **THEN** each lexical hit SHALL include a typed score object
- **AND** the score object SHALL identify the score kind and ordering direction

#### Scenario: Server does not advertise lexical scores
- **WHEN** protected-resource metadata omits lexical score support
- **THEN** clients SHALL NOT assume `/v1/search` responses include score fields

### Requirement: Lexical scores SHALL be grant-safe and implementation-relative
Lexical scores SHALL be computed only from fields visible under the active grant and SHALL be documented as implementation-relative unless a later change defines portable score calibration.

#### Scenario: Hidden fields are outside score computation
- **WHEN** a record contains a lexical-search field outside the caller's grant projection
- **THEN** the returned lexical score SHALL NOT include contribution from that hidden field
- **AND** no score explanation SHALL disclose that hidden field
