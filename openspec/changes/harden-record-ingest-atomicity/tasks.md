## 1. Baseline Investigation

- [ ] 1.1 Locate every `ingestRecord` durable write statement and confirm the current order of `records`, `record_changes`, and `version_counter` writes.
- [ ] 1.2 Identify existing tests that cover no-op re-ingest, delete, `changes_since`, and version-counter behavior.
- [ ] 1.3 Add a short design note or test comment documenting the old failure mode the new tests are intended to catch.

## 2. Regression Tests

- [ ] 2.1 Add a test proving changed writes for the same `(connector_id, stream)` allocate unique monotonically increasing versions.
- [ ] 2.2 Add a test proving identical re-ingest does not append `record_changes` or advance `version_counter`.
- [ ] 2.3 Add a test proving repeated delete does not append duplicate delete changes or advance `version_counter`.
- [ ] 2.4 Add a fault-injection or rollback test proving a failure before durable commit leaves no partial `records` / `record_changes` / `version_counter` state.
- [ ] 2.5 Add a `changes_since` or direct change-log assertion proving consumers see a contiguous version sequence after the tested writes.

## 3. Implementation

- [ ] 3.1 Refactor `ingestRecord` so only durable record mutation is inside an explicit SQLite transaction.
- [ ] 3.2 Keep lexical and semantic index maintenance outside the durable record transaction and only run it after successful commit.
- [ ] 3.3 Keep disclosure-spine behavior outside the durable record transaction.
- [ ] 3.4 Ensure no-op re-ingest and repeated delete return without opening unnecessary derived-index work.

## 4. Validation

- [ ] 4.1 Run the targeted record-ingest tests.
- [ ] 4.2 Run the relevant reference implementation test subset that covers records, `changes_since`, lexical, and semantic regression risk.
- [ ] 4.3 Run `pnpm --filter pdpp-reference-implementation typecheck` if TypeScript surfaces are touched.
- [ ] 4.4 Run `openspec validate harden-record-ingest-atomicity --strict`.
- [ ] 4.5 Run `openspec validate --all --strict`.
- [ ] 4.6 Run `pnpm workstreams:status -- --no-fail` before owner review/merge.
