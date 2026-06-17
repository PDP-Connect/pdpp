## 1. Schema

- [x] Add SQLite base-schema source/run summary index.
- [x] Add SQLite idempotent migration creation for existing stores.
- [x] Confirm Postgres already carries equivalent source/run summary DDL.

## 2. Tests

- [x] Add SQLite schema assertion for the new index.
- [x] Add static DDL parity assertion for SQLite and Postgres text.

## 3. Acceptance Checks

- [x] Run `openspec validate add-spine-events-source-run-summary-index --strict`.
- [x] Run focused schema tests.
- [x] Run focused typecheck as feasible.
