## Context

`harden-record-ingest-atomicity` fixed the main connector ingest path by opening its durable mutation unit with `BEGIN IMMEDIATE`. During owner review, the worker correctly identified a symmetric residual gap: `deleteRecord` still performs the same durable table sequence outside an explicit transaction.

The relevant direct-delete state is:

- `records`
- `record_changes`
- `version_counter`

Search indexes are derived and recoverable. They should not be part of the durable delete transaction.

## Goals / Non-Goals

**Goals:**

- Prove the existing direct delete path can drift without an atomic durable unit.
- Make direct record delete atomic in SQLite using the already-reviewed `writeTransaction` helper.
- Preserve current route behavior and return values.
- Keep this as a symmetry patch, not a storage abstraction.

**Non-Goals:**

- Do not introduce `RecordStore`.
- Do not add Postgres support.
- Do not move code into the ideal `src/operations/**` layout.
- Do not transactionally couple lexical/semantic index deletes to durable record deletes.
- Do not redesign `changes_since` cursors.
- Do not alter connector-runtime delete semantics beyond the direct `deleteRecord` helper.

## Decisions

### 1. Atomic unit mirrors ingest

The direct delete transaction boundary covers:

- current-state read
- absent/already-deleted no-op decision
- version allocation
- live `records` delete marker update
- `record_changes` deleted-row append
- `version_counter` advance
- pruning of old `record_changes` rows because current delete behavior already prunes

It does not cover:

- `lexicalIndexDelete`
- `semanticIndexDelete`
- HTTP route-level event emission
- disclosure-spine append
- connector runtime behavior

Rationale: `records`, `record_changes`, and `version_counter` define durable record history. Search rows are derived and can be reconciled after commit.

### 2. Use `writeTransaction`

The implementation should reuse `writeTransaction(fn)` from `reference-implementation/lib/db.ts`. That helper opens with `BEGIN IMMEDIATE`, so the write lock is acquired before reading `version_counter`.

Rationale: using the same helper keeps direct deletes and ingest aligned and avoids reopening the `BEGIN` versus `BEGIN IMMEDIATE` decision.

### 3. Prefer extending the atomicity test file

The existing `records-ingest-atomicity.test.js` already has table readers and record helpers. It is acceptable to extend it or rename/generalize it if that improves clarity, but the implementation should avoid broad test restructuring.

## Risks / Trade-offs

- SQLite write contention can increase if the transaction is too broad -> keep the transaction minimal and leave index deletes after commit.
- Index drift remains possible if post-commit index deletes fail -> that is intentional and consistent with ingest; recovery belongs to index reconciliation.
- Test-only fault hooks can leak into production surfaces -> reuse or add a hook only if it defaults to no-op and is clearly test-only.

## Migration Plan

1. Add tests that pin successful direct delete, absent/already-deleted no-op, contiguous version history, and rollback on injected failure.
2. Wrap the durable portion of `deleteRecord` in `writeTransaction`.
3. Keep index deletes after successful commit.
4. Run targeted atomicity/db tests, nearby retrieval/spine tests as needed, and OpenSpec validation.

Rollback is straightforward: revert the change. No schema migration is expected.
