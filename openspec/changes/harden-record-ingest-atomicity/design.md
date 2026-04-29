## Context

The `define-reference-operation-environments` work identified record ingest atomicity as the first correctness prerequisite for the ideal reference architecture. The issue is not primarily Postgres. The current SQLite reference must itself guarantee that record versions, live record state, and change-log rows stay coherent under contention and failure.

The relevant durable record mutation state is:

- `records`
- `record_changes`
- `version_counter`

Search indexes and disclosure-spine events are adjacent effects, but they are not the durable mutation unit for this change.

## Goals / Non-Goals

**Goals:**

- Prove the current write path has or lacks atomicity using focused tests.
- Make durable record mutation atomic in SQLite.
- Preserve current public API behavior and existing test expectations.
- Make the future `RecordStore.ingest` contract safer by fixing the concrete implementation first.

**Non-Goals:**

- Do not introduce `RecordStore`.
- Do not add Postgres support.
- Do not move code into the ideal `src/operations/**` layout.
- Do not make lexical/semantic indexes transactionally coupled to record writes.
- Do not make disclosure-spine append part of the record transaction.
- Do not redesign `changes_since` cursors beyond what is necessary to prove version consistency.

## Decisions

### 1. Atomic unit is durable record mutation only

The transaction boundary covers:

- current-state read
- no-op decision
- version allocation
- live `records` update/delete
- `record_changes` append
- `version_counter` advance
- pruning of old `record_changes` rows only if current behavior already performs it as part of ingest

It does not cover:

- `lexicalIndexUpsert` / lexical delete
- `semanticIndexUpsert` / semantic delete
- disclosure-spine append
- HTTP route-level event emission
- connector runtime behavior

Rationale: `records`, `record_changes`, and `version_counter` define durable record history. Search indexes are derived and recoverable. Spine events are observability/control-plane artifacts and should be able to record both success and failure without rolling back durable data.

### 2. Use explicit SQLite transaction semantics

SQLite implementation should use an explicit transaction rather than relying on `better-sqlite3` statement-level autocommit. The desired lock posture is writer-serialized for the affected mutation unit, likely `BEGIN IMMEDIATE` or an equivalent `better-sqlite3` transaction wrapper if it proves to acquire the correct lock.

Rationale: the reference should not rely on implicit single-writer behavior as a semantic guarantee. The code should show the intended atomic unit.

### 3. Allocate versions inside the mutation unit

The next version for `(connector_id, stream)` must be allocated in the same transaction that writes `record_changes` and advances `version_counter`.

Rationale: `changes_since` correctness depends on the per-stream version sequence being unique, monotonic, and coherent with the change log. If allocation and change append can separate, clients can observe gaps, collisions, or stale cursors.

### 4. Tests should prove both no-op and fault behavior

The test suite should cover:

- concurrent same-stream writes
- no-op re-ingest
- repeated delete
- injected failure between durable mutation steps
- post-failure next ingest does not collide with an existing change version

If direct crash simulation is too heavy for the first pass, inject a test-only fault between the live record mutation and version-counter advance so the old behavior fails and the new transaction rolls back.

## Risks / Trade-offs

- SQLite write contention can increase if the transaction is too broad -> keep the transaction minimal and do not include search/spine work.
- Tests can become implementation-coupled -> assert durable outcomes through public or stable reference helpers where possible; use white-box fault injection only for the crash-boundary case.
- Index staleness windows may become more visible -> keep existing index update behavior after successful commit, and leave index recovery/state work to the retrieval conformance track.
- A worker may turn this into an abstraction refactor -> reject broad extraction in owner review.

## Migration Plan

1. Add focused failing tests around ingest version consistency.
2. Add a minimal test hook or injectable fault point only if necessary to prove rollback.
3. Wrap the durable mutation portion of `ingestRecord` in an explicit transaction.
4. Run targeted record/changes tests and broader reference checks.
5. Remove or keep any test hook only if it is clearly internal and non-production-affecting.

Rollback is straightforward: revert this change. No schema migration is expected.

## Open Questions

- Whether `better-sqlite3`'s default transaction wrapper is sufficient, or whether the implementation should explicitly issue `BEGIN IMMEDIATE`.
- Whether existing tests can simulate crash/fault behavior without adding a test-only hook.
- Whether pruning old `record_changes` rows should be inside the transaction if it is currently part of ingest.
