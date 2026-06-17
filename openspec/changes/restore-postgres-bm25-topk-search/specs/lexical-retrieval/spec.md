## ADDED Requirements

### Requirement: Lexical recall completeness SHALL reflect the active ranking backend
Lexical retrieval responses SHALL report exact recall only when the active
backend ranks the full grant-authorized lexical match set before pagination. A
backend that applies a bounded candidate window, approximate prefilter, or any
unproven pre-ranking truncation SHALL report incomplete recall using
`meta.recall.ranking_scope: "candidate_window"` or `"unknown"` as appropriate.

#### Scenario: Optional BM25 backend proves scoped top-k retrieval
- **WHEN** a Postgres BM25 backend ranks the full grant-authorized lexical match set for a `/v1/search` request before pagination
- **THEN** the response MAY include `meta.count_accuracy: "exact"`
- **AND** `meta.recall.complete` SHALL be `true`
- **AND** `meta.recall.ranking_scope` SHALL be `"all_matches"`
- **AND** `meta.recall.truncated` SHALL be `false`

#### Scenario: Optional BM25 backend applies a candidate window
- **WHEN** a Postgres BM25 backend ranks only a bounded subset of grant-authorized lexical candidates
- **THEN** the response SHALL NOT report `meta.recall.complete: true`
- **AND** the response SHALL report `meta.recall.ranking_scope: "candidate_window"` or `"unknown"`
- **AND** `meta.count_accuracy` SHALL NOT be `"exact"` unless the server separately proves the exact caller-visible match count

#### Scenario: Native Postgres fallback remains bounded
- **WHEN** the reference falls back to native Postgres FTS for a broad lexical search that uses a bounded candidate window
- **THEN** the response SHALL preserve the existing candidate-window recall disclosure
- **AND** the response SHALL NOT imply the optional BM25 backend handled the request

### Requirement: Lexical backend score semantics SHALL remain implementation-relative
The reference SHALL keep lexical score values implementation-relative when
lexical retrieval is backed by different engines, including SQLite FTS5, native
Postgres FTS, or optional Postgres BM25. The reference SHALL identify score
kind, ordering direction, and backend capability honestly. Clients SHALL NOT be
required to compare numeric lexical scores across backend families.

#### Scenario: Backend emits BM25 scores
- **WHEN** a lexical backend emits BM25-family scores
- **THEN** the response's score metadata SHALL identify the score kind and ordering direction
- **AND** the response SHALL NOT claim portable numeric score comparability across backend families

#### Scenario: Backend falls back to native Postgres FTS
- **WHEN** a Postgres deployment uses native FTS fallback instead of optional BM25
- **THEN** the reference SHALL not advertise exact BM25 top-k behavior for that request
- **AND** score metadata SHALL remain implementation-relative
