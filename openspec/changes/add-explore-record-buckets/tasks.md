# Tasks: add-explore-record-buckets

## 1. Server operation

- [x] 1.1 Add an Explore bucket operation that validates scope/window/granularity input and returns exact dense bucket counts.
- [x] 1.2 Add SQLite and Postgres aggregate implementations using the merged timeline semantic-time expression and scoped record set.
- [x] 1.3 Ensure the aggregate query does not select or scan `record_json`.

## 2. Reference route and contract

- [x] 2.1 Wire `GET /_ref/explore/records/buckets` behind owner-session auth in `ref-admin`.
- [x] 2.2 Add reference-contract metadata and generated OpenAPI/docs entries for the new route.

## 3. Tests

- [x] 3.1 Add SQLite node tests for extent-aware auto granularity and dense zero-filled buckets.
- [x] 3.2 Add Postgres node tests for the same behavior when `PDPP_TEST_POSTGRES_URL` is available.
- [x] 3.3 Add a guard proving bucket aggregation does not read `record_json`.

## 4. Validation

- [x] 4.1 Run `openspec validate add-explore-record-buckets --strict`.
- [x] 4.2 Run the relevant reference implementation node tests.
- [x] 4.3 Run TypeScript checks.
