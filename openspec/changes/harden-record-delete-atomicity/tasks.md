## 1. Baseline Investigation

- [x] 1.1 Confirm the current `deleteRecord` durable write order across `records`, `record_changes`, and `version_counter`.
- [x] 1.2 Identify existing direct-delete tests and whether they cover absent/already-deleted no-op behavior.
- [x] 1.3 Document the old direct-delete failure mode in a focused test comment.

## 2. Regression Tests

- [x] 2.1 Add a test proving direct delete appends exactly one delete change and advances `version_counter` once.
- [x] 2.2 Add a test proving absent and already-deleted direct deletes return `0` without appending `record_changes` or advancing `version_counter`.
- [x] 2.3 Add a fault-injection or rollback test proving a failure before durable delete commit leaves `records`, `record_changes`, and `version_counter` unchanged.
- [x] 2.4 Add a contiguity assertion proving mixed ingest/delete/direct-delete writes leave `record_changes.version` contiguous.

## 3. Implementation

- [x] 3.1 Refactor `deleteRecord` so only durable direct-delete mutation is inside `writeTransaction`.
- [x] 3.2 Keep lexical and semantic index deletes outside the durable transaction and only after successful commit.
- [x] 3.3 Ensure absent and already-deleted no-op deletes return without derived-index work.
- [x] 3.4 Avoid broad storage abstractions, Postgres work, operation-capsule moves, or unrelated delete behavior changes.

## 4. Validation

- [x] 4.1 Run the targeted record atomicity tests.
- [x] 4.2 Run relevant reference implementation tests that cover records, record delete, search index deletes, and spine behavior.
- [x] 4.3 Run `pnpm --filter pdpp-reference-implementation typecheck` if TypeScript surfaces are touched.
- [x] 4.4 Run `openspec validate harden-record-delete-atomicity --strict`.
- [x] 4.5 Run `openspec validate --all --strict`.
- [ ] 4.6 Run `pnpm workstreams:status -- --no-fail` before owner review/merge.
