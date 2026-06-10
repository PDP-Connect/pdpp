## ADDED Requirements

### Requirement: Low-risk reference stores expose semantic production interfaces

The reference implementation SHALL expose production storage interfaces for pending consent, owner device authorization, connector state, connector schedules, and active-run coordination only after the relevant semantics have conformance coverage and at least one non-SQLite or Postgres-oriented proof.

#### Scenario: A low-risk store is extracted

**WHEN** a storage seam for pending consent, owner device authorization, connector state, schedules, or active runs is promoted into production code
**THEN** callers SHALL depend on a semantic store interface rather than raw SQLite handles, prepared statements, or query builders.

#### Scenario: A production SQLite store is accepted

**WHEN** the reference implementation provides a SQLite-backed implementation of one of these stores
**THEN** that implementation SHALL pass the existing conformance suite for the capability through a production-store-backed test adapter.

#### Scenario: Runtime backend selection is requested

**WHEN** a change wants to select SQLite, Postgres, or any other storage backend at runtime
**THEN** that behavior SHALL be proposed separately and SHALL NOT be introduced by the low-risk store extraction.

#### Scenario: A harder storage/search surface is considered

**WHEN** code touches record reads, record writes, disclosure-spine storage, lexical retrieval, semantic retrieval, hybrid retrieval, or blob byte storage
**THEN** it SHALL NOT reuse the low-risk store extraction as sufficient proof and SHALL require a separate contract and evidence gate.
