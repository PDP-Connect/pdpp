## ADDED Requirements

### Requirement: The reference implementation SHALL use `better-sqlite3` as its SQLite driver

The reference implementation SHALL access SQLite via `better-sqlite3`. It SHALL
NOT depend on `@databases/sqlite` or the legacy `sqlite3` N-API binding for any
runtime SQLite code path.

#### Scenario: Fresh install includes only the chosen driver
- **WHEN** a developer installs the reference implementation dependencies
- **THEN** `better-sqlite3` SHALL be installed as a direct dependency
- **AND** `@databases/sqlite` SHALL NOT be required for reference runtime SQLite access

#### Scenario: Sustained dashboard workload does not crash the server
- **WHEN** a client issues concurrent requests to `/dashboard/records`, `/dashboard/search?q=...`, and `/planning/changes` for ten or more rounds
- **THEN** the reference server process SHALL remain alive throughout
- **AND** SHALL NOT emit `SIGSEGV`, `SIGABRT`, or `free(): invalid size` abnormal termination

### Requirement: Pre-existing databases SHALL continue to open and operate

The reference implementation SHALL open and operate against SQLite files that
worked with the previous driver. No schema changes, data migration, or
file-format change SHALL be required solely because of the driver swap.

#### Scenario: Existing polyfill substrate continues to serve records
- **WHEN** the reference implementation starts against a pre-existing polyfill SQLite database
- **THEN** it SHALL open the file without a driver-level migration
- **AND** it SHALL serve existing records and spine events from that file via the `/v1` and `/_ref` HTTP surfaces with the same response shapes as before
