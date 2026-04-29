## 1. Version Allocation Audit

- [ ] 1.1 Locate every production caller of `recordsIngestGetVersionCounter` / `recordsIngestUpsertVersionCounter`.
- [ ] 1.2 Confirm whether existing registered SQL can allocate a version atomically or needs a new artifact.
- [ ] 1.3 Document the old read-then-write failure mode in the new regression test.

## 2. Regression Coverage

- [ ] 2.1 Add a test proving changed writes for the same `(connector_id, stream)` allocate distinct increasing versions.
- [ ] 2.2 Add or extend a test proving no-op re-ingest does not allocate a version.
- [ ] 2.3 Add or extend a test proving repeated delete does not allocate a version.
- [ ] 2.4 Add a `changes_since` or direct change-log assertion proving consumers see a contiguous version sequence.
- [ ] 2.5 Add a falsifiability note or temporary sabotage evidence showing the new test fails if allocation reuses a version.

## 3. Implementation

- [ ] 3.1 Add an atomic version-allocation registered SQL artifact or equivalent existing-query rewrite.
- [ ] 3.2 Refactor `ingestRecord` / delete mutation code to call the atomic allocator only for durable changes.
- [ ] 3.3 Keep derived index and disclosure-spine maintenance outside the durable mutation transaction.
- [ ] 3.4 Grep for stale read-then-write allocation patterns and remove unused query artifacts if safe.

## 4. Validation

- [ ] 4.1 Run record-mutation conformance tests.
- [ ] 4.2 Run focused record ingest/delete/changes_since tests.
- [ ] 4.3 Run lexical and semantic retrieval regression tests touched by derived-index timing risk.
- [ ] 4.4 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [ ] 4.5 Run `pnpm --filter pdpp-reference-implementation check`.
- [ ] 4.6 Run `openspec validate harden-record-version-allocation-atomicity --strict`.
- [ ] 4.7 Run `openspec validate --all --strict`.
