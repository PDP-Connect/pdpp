# reference-implementation-architecture — Exclusive storage-mode boot boundary

## ADDED Requirements

### Requirement: A configured Postgres runtime SHALL NOT require a persistent SQLite database at startup

The reference implementation SHALL select exactly one runtime persistence
backend at startup via `resolveStorageBackend()`. When the resolved backend is
`postgres`, normal `startServer()` startup SHALL NOT depend on opening,
creating, or migrating a persistent SQLite database. The configured SQLite file
path (`PDPP_DB_PATH` / `DB_PATH`) SHALL NOT be opened in Postgres mode.

A non-durable in-memory SQLite handle MAY remain available in Postgres mode for
compatibility with modules that hold a `getDb()` reference, provided it opens no
file, runs no persistent migration, serves no durable operator read or ingest
write, and is discarded on shutdown. Postgres SHALL own all runtime persistence
in Postgres mode.

When the resolved backend is `sqlite`, startup SHALL open and migrate the
configured persistent SQLite database as the runtime persistence store.

Backend-aware startup steps that persist state — including pre-registered client
seeding — SHALL execute after the active backend is established, so they
dispatch to the backend that owns runtime persistence.

#### Scenario: Postgres-mode boot does not open the persistent SQLite file
- **WHEN** the reference is configured for the Postgres storage backend and starts
- **THEN** `startServer()` SHALL reach HTTP readiness without opening or migrating the configured persistent SQLite database file
- **AND** the configured SQLite file path SHALL remain untouched on disk
- **AND** a persistent SQLite database that would fail to open or migrate SHALL NOT prevent Postgres-mode startup

#### Scenario: Postgres-mode boot seeds pre-registered clients into Postgres
- **WHEN** the reference starts in Postgres mode with pre-registered public clients configured
- **THEN** those clients SHALL be persisted to the Postgres backend
- **AND** they SHALL be readable through the active Postgres-backed client read path after startup

#### Scenario: SQLite-mode boot still owns persistence on the persistent file
- **WHEN** the reference is configured for the SQLite storage backend and starts
- **THEN** `startServer()` SHALL open and migrate the configured persistent SQLite database
- **AND** pre-registered clients SHALL be persisted to and readable from that SQLite database after startup

### Requirement: Both storage backends SHALL have explicit startup smoke coverage

The reference implementation SHALL exercise `startServer()` startup for both the
SQLite and Postgres backends through focused, repeatable tests, so a change that
breaks one backend's boot does not pass under the other backend's coverage. The
Postgres startup smoke MAY be gated on a configured Postgres test database; when
that database is unavailable the test SHALL register as skipped rather than
failing, and SHALL NOT be silently absent.

#### Scenario: SQLite-only startup smoke runs by default
- **WHEN** the reference test suite runs without a configured Postgres test database
- **THEN** a SQLite-mode startup smoke test SHALL boot `startServer()`, confirm readiness, and run by default
- **AND** the Postgres-mode startup smoke test SHALL register as skipped rather than be absent

#### Scenario: Postgres-only startup smoke runs against a real Postgres
- **WHEN** the reference test suite runs with a configured Postgres test database
- **THEN** a Postgres-mode startup smoke test SHALL boot `startServer()` against that Postgres backend
- **AND** it SHALL confirm startup reaches readiness without opening the configured persistent SQLite file
