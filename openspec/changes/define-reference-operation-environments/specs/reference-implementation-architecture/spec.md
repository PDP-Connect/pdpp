## ADDED Requirements

### Requirement: Reference AS/RS semantics SHALL be operation-owned

The reference implementation SHALL define AS, RS, and `_ref` behavior through canonical operation implementations that can be mounted by multiple hosts. HTTP frameworks, website route handlers, tests, and sandbox surfaces SHALL call those operations rather than reimplementing their semantics.

#### Scenario: Same operation mounted by multiple hosts

- **WHEN** the same reference operation is exposed by the native local server and by a sandbox route host
- **THEN** both hosts SHALL execute the same operation implementation
- **AND** host-specific code SHALL be limited to request adaptation, response adaptation, origin resolution, and environment profile selection

#### Scenario: Host attempts to reimplement reference behavior

- **WHEN** a host or UI surface constructs an AS/RS response that corresponds to a canonical reference operation
- **THEN** the change SHALL be rejected unless it is explicitly marked as a fixture-only test helper and cannot be reached as a public reference surface

### Requirement: Environment profiles SHALL compose dependencies, not fork behavior

The reference implementation SHALL model local, Docker, sandbox, and test environments as profiles that provide concrete dependencies to the same reference operations. Profiles SHALL NOT define alternate AS/RS semantics.

#### Scenario: Sandbox fixture profile

- **WHEN** the sandbox exposes `/sandbox/v1/**`, `/sandbox/_ref/**`, or `/sandbox/.well-known/**`
- **THEN** those routes SHALL mount reference operations using a sandbox fixture profile
- **AND** the sandbox fixture profile SHALL provide deterministic storage, deterministic clock/ids, fixture search indexes, and disabled or scripted connector execution

### Requirement: Storage and retrieval contracts SHALL be capability-specific

Storage and search abstractions used by reference operations SHALL be named around PDPP capabilities and obligations. Generic repository or table-shaped abstractions SHALL NOT be introduced as operation dependencies.

#### Scenario: Record listing abstraction

- **WHEN** `rs.records.list` needs data access
- **THEN** it SHALL depend on a record-capability contract such as `RecordStore.listGrantedRecords`
- **AND** it SHALL NOT depend on a generic table repository, raw SQLite handle, raw Postgres pool, or query-builder instance

#### Scenario: Retrieval abstraction

- **WHEN** lexical, semantic, or hybrid retrieval is implemented through an adapter
- **THEN** the adapter contract SHALL preserve retrieval-mode-specific score semantics, index identity, filtering, freshness state, and fallback behavior
- **AND** operation code SHALL NOT collapse those modes into an ambiguous generic search provider

### Requirement: Paginated reference contracts SHALL use explicit cursor semantics

Reference-runtime contracts SHALL NOT depend on implicit SQLite `rowid` behavior. Any paginated capability method SHALL define an explicit stable tiebreaker and SHALL treat cursors as opaque adapter-owned tokens.

#### Scenario: Adapter without implicit rowid

- **WHEN** a reference operation is backed by an adapter that does not expose SQLite `rowid`
- **THEN** the operation SHALL still paginate deterministically using the capability contract's explicit ordering and tiebreaker
- **AND** operation code SHALL NOT inspect or construct database-specific cursor internals

### Requirement: Record storage contracts SHALL own ordering and version semantics

Record storage contracts SHALL define cursor-field comparison semantics, missing-value bucket semantics, and per-stream version allocation. These semantics SHALL NOT be inherited accidentally from a database engine's JSON extraction, collation, or single-writer behavior.

#### Scenario: Record cursor field is database JSON

- **WHEN** an adapter stores record data as JSON or JSONB
- **THEN** `RecordStore` SHALL preserve the manifest-declared cursor ordering and missing-value behavior regardless of the database's native JSON value affinity
- **AND** unsupported cursor comparison modes SHALL fail or fall back explicitly rather than silently changing page order

#### Scenario: Concurrent record ingest

- **WHEN** two records are ingested for the same `(connector_id, stream)`
- **THEN** the adapter SHALL allocate monotonically increasing versions in the same atomic unit that writes the live record and change-log row
- **AND** the reference operation SHALL not rely on SQLite's single-writer behavior for correctness

### Requirement: Retrieval contracts SHALL disclose backend identity

Lexical and semantic retrieval contracts SHALL expose backend identity and score semantics needed for truthful capability advertisement. Retrieval adapters SHALL NOT hide tokenizer, ranker, vector-index, distance, model, or recall-determinism differences behind a generic search interface.

#### Scenario: Lexical backend changes

- **WHEN** lexical retrieval is backed by an engine other than SQLite FTS5
- **THEN** the capability advertisement and result scores SHALL disclose the backend's score direction and implementation-relative semantics
- **AND** drift detection SHALL account for tokenizer or ranker identity when that identity affects indexed content or ranking

#### Scenario: Semantic backend is approximate

- **WHEN** semantic retrieval is backed by an approximate vector index
- **THEN** the capability advertisement SHALL disclose index kind and recall determinism
- **AND** the adapter SHALL NOT present approximate recall as exact flat-index behavior
