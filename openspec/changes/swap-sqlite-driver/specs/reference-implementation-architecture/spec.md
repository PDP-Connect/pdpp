## ADDED Requirements

### Requirement: The reference implementation SHALL use `better-sqlite3` as its SQLite driver

The reference implementation SHALL access SQLite via `better-sqlite3`. It SHALL NOT depend on `@databases/sqlite` or the legacy `sqlite3` N-API binding for any runtime code path.

#### Scenario: Fresh install includes only the chosen driver
- **WHEN** a developer runs `pnpm install` in `reference-implementation/`
- **THEN** `better-sqlite3` SHALL be installed as a direct dependency
- **AND** `@databases/sqlite` SHALL NOT appear in that package's dependency tree

#### Scenario: Sustained dashboard workload does not crash the server
- **WHEN** a client issues concurrent requests to `/dashboard/records`, `/dashboard/search?q=…`, and `/planning/changes` for ten or more rounds
- **THEN** the reference server process SHALL remain alive throughout
- **AND** SHALL NOT emit `SIGSEGV`, `SIGABRT`, or `free(): invalid size` abnormal termination

### Requirement: Static queries SHALL be inspectable as `.sql` files

Every static SQL query used by the reference implementation's runtime SHALL live in its own `.sql` file under `reference-implementation/server/queries/`. Only queries whose shape is dynamic (variable `SET` clauses, variable `WHERE` fragments, `sql.join`-style list interpolation) MAY remain inline in JS as query-builder helpers.

#### Scenario: A reviewer browses the reference's query surface
- **WHEN** a reviewer opens `reference-implementation/server/queries/`
- **THEN** they SHALL see a directory-per-domain layout (e.g. `grants/`, `records/`, `spine/`)
- **AND** each static query SHALL be one `.sql` file whose contents are a single valid, self-contained SQL statement

#### Scenario: Dynamic query is built in JS
- **WHEN** a handler needs an UPDATE whose SET list or WHERE clause is computed from runtime data
- **THEN** the handler MAY construct the SQL text in JS and call `db.prepare(text).run(...)` directly
- **AND** such dynamic builders SHOULD be small, local to their single call site, and document the reason the query is not a static file

### Requirement: Pre-existing databases SHALL continue to open and operate

The reference implementation SHALL open and operate against any SQLite file that worked with the previous driver. No schema changes, no data migration, and no file-format change SHALL be required.

#### Scenario: Existing polyfill substrate continues to serve records
- **WHEN** the reference implementation starts against the pre-existing `packages/polyfill-connectors/.pdpp-data/polyfill.sqlite` file
- **THEN** it SHALL open the file without error
- **AND** it SHALL serve existing records and spine events from that file via the `/v1` and `/_ref` HTTP surfaces with the same response shapes as before
