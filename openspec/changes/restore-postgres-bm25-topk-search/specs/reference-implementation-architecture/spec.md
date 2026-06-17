## ADDED Requirements

### Requirement: Postgres BM25 lexical retrieval SHALL be optional and fallback-safe
The reference implementation SHALL treat any `pg_search` / ParadeDB BM25 lexical
backend as an optional Postgres runtime capability. The default Postgres lexical
backend SHALL remain the native scoped FTS path unless configuration explicitly
enables the BM25 backend and startup proves the required extension and index are
usable. If the BM25 backend is disabled, unavailable, not ready, or fails at
query time, the reference SHALL fall back to native Postgres lexical retrieval
without changing the public `/v1/search` response shape.

#### Scenario: Postgres runtime starts without pg_search
- **WHEN** the reference starts in Postgres mode and `pg_search` is not available
- **THEN** startup SHALL succeed
- **AND** lexical search SHALL use the native scoped Postgres FTS backend
- **AND** broad lexical responses SHALL continue to disclose any bounded candidate window through `meta.recall`

#### Scenario: BM25 backend is not explicitly enabled
- **WHEN** the reference starts in Postgres mode with `pg_search` available but the BM25 backend disabled by configuration
- **THEN** startup SHALL NOT create or use a BM25 search index
- **AND** lexical search SHALL use the native scoped Postgres FTS backend

#### Scenario: BM25 backend fails after startup
- **WHEN** the optional BM25 backend is enabled but a BM25 query or index-read fails
- **THEN** the reference SHALL fall back to native Postgres lexical retrieval for that search request
- **AND** the response SHALL preserve grant scoping, source identity, cursor snapshot semantics, and recall disclosure

### Requirement: Postgres BM25 backend state SHALL be operator-visible
The reference implementation SHALL expose the active Postgres lexical backend
state on reference diagnostics and capability-adjacent metadata. The exposed
state SHALL distinguish at least disabled, unavailable, enabled, and fallback
native-FTS states without leaking secrets or database connection strings.

#### Scenario: Diagnostics report native fallback
- **WHEN** the reference runs in Postgres mode and `pg_search` is unavailable
- **THEN** reference diagnostics SHALL report that the Postgres lexical backend is using native FTS fallback
- **AND** the diagnostics SHALL NOT imply global BM25 top-k retrieval is active

#### Scenario: Diagnostics report enabled BM25
- **WHEN** the reference runs in Postgres mode with the BM25 backend enabled and ready
- **THEN** reference diagnostics SHALL report that Postgres BM25 lexical retrieval is active
- **AND** the diagnostics SHALL identify the backend without exposing database credentials

### Requirement: Reference images SHALL NOT silently require pg_search
The reference implementation SHALL NOT make published default Docker images or
default Compose profiles depend on `pg_search` unless the dependency,
licensing posture, and image choice are documented explicitly. A ParadeDB or
`pg_search`-enabled profile MAY be added as an opt-in deployment profile.

#### Scenario: Default reference compose starts
- **WHEN** an operator starts the default reference Compose profile
- **THEN** the default database service SHALL NOT require `pg_search` to start or serve lexical search
- **AND** `/v1/search` SHALL remain available through the native Postgres or SQLite backend selected by configuration

#### Scenario: Operator selects a pg_search-enabled profile
- **WHEN** an operator explicitly selects a documented `pg_search`-enabled deployment profile
- **THEN** the reference documentation SHALL identify the non-default database image or extension dependency
- **AND** the documentation SHALL describe the fallback behavior if BM25 readiness cannot be proven
