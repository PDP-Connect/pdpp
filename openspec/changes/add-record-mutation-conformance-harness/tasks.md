## 1. Harness Shape

- [x] 1.1 Inventory assertions in `records-ingest-atomicity.test.js` and `records-delete-atomicity.test.js`.
- [x] 1.2 Define a test-only record mutation conformance driver shape under `reference-implementation/test/**`.
- [x] 1.3 Keep the driver shape narrow enough that it is not a production `RecordStore` contract.

## 2. Conformance Suite

- [x] 2.1 Port changed-write monotonic version assertions into the harness.
- [x] 2.2 Port no-op re-ingest and repeated/absent delete assertions into the harness.
- [x] 2.3 Port ingest-delete and direct-delete semantics into the harness.
- [x] 2.4 Port rollback/fault assertions into the harness.
- [x] 2.5 Port mixed mutation contiguity assertions into the harness.

## 3. Drivers And Falsifiability

- [x] 3.1 Add a SQLite-backed driver that uses current `ingestRecord`, `deleteRecord`, and test-only DB reads.
- [x] 3.2 Add a negative/falsifiability test proving the harness fails on at least one broken durable mutation behavior.
- [x] 3.3 Decide whether to keep or replace the existing focused atomicity test files; avoid duplicate coverage unless replacement is risky.

## 4. Validation

- [x] 4.1 Run the record mutation conformance tests.
- [x] 4.2 Run existing ingest/delete/db-wrapper targeted tests if they remain separate.
- [ ] 4.3 Run nearby retrieval/spine tests only if runtime code changes.
- [x] 4.4 Run `openspec validate add-record-mutation-conformance-harness --strict`.
- [x] 4.5 Run `openspec validate --all --strict`.
- [ ] 4.6 Run `pnpm workstreams:status -- --no-fail` before owner review/merge.
