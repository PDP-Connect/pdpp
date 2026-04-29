## 1. Version Allocation Audit

- [x] 1.1 Locate every production caller of `recordsIngestGetVersionCounter` / `recordsIngestUpsertVersionCounter`.
- [x] 1.2 Confirm whether existing registered SQL can allocate a version atomically or needs a new artifact.
- [x] 1.3 Document the old read-then-write failure mode in the new regression test.

## 2. Regression Coverage

- [x] 2.1 Add a test proving changed writes for the same `(connector_id, stream)` allocate distinct increasing versions.
- [x] 2.2 Add or extend a test proving no-op re-ingest does not allocate a version.
- [x] 2.3 Add or extend a test proving repeated delete does not allocate a version.
- [x] 2.4 Add a `changes_since` or direct change-log assertion proving consumers see a contiguous version sequence.
- [x] 2.5 Add a falsifiability note or temporary sabotage evidence showing the new test fails if allocation reuses a version.

## 3. Implementation

- [x] 3.1 Add an atomic version-allocation registered SQL artifact or equivalent existing-query rewrite.
- [x] 3.2 Refactor `ingestRecord` / delete mutation code to call the atomic allocator only for durable changes.
- [x] 3.3 Keep derived index and disclosure-spine maintenance outside the durable mutation transaction.
- [x] 3.4 Grep for stale read-then-write allocation patterns and remove unused query artifacts if safe.

## 4. Validation

- [x] 4.1 Run record-mutation conformance tests.
- [x] 4.2 Run focused record ingest/delete/changes_since tests.
- [x] 4.3 Run lexical and semantic retrieval regression tests touched by derived-index timing risk.
- [x] 4.4 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 4.5 Run `pnpm --filter pdpp-reference-implementation check`.
- [x] 4.6 Run `openspec validate harden-record-version-allocation-atomicity --strict`.
- [x] 4.7 Run `openspec validate --all --strict`.
