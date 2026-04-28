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
