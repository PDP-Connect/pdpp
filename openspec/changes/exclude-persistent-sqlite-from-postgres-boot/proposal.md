# Exclude persistent SQLite from Postgres-mode startup

## Why

A Postgres-backed reference deployment still opens and migrates the configured
persistent SQLite file on every boot. `startServer()` calls `initDb(DB_PATH, …)`
unconditionally (`reference-implementation/server/index.js`) before it calls
`initPostgresStorage(...)`, so a Postgres runtime carries a hidden, required
SQLite schema-boot dependency: if that persistent SQLite database fails to open
or migrate, the server never reaches HTTP startup even though no durable read or
write will ever touch it.

The 2026-05-29 `complete-postgres-runtime-boundary` change classified every
reachable Postgres-mode SQLite use and explicitly deferred "lazy/disabled SQLite
initialization in Postgres mode" to a follow-on slice
(`design-notes/postgres-runtime-boundary-sqlite-classification-2026-05-28.md`,
section D). This is that slice.

There is also a latent ordering defect: `seedPreRegisteredClients(...)` dispatches
on `isPostgresStorageBackend()`, but it runs *before* `initPostgresStorage(...)`
sets the active backend, so in Postgres mode the pre-registered OAuth clients are
seeded into SQLite instead of Postgres.

## What Changes

- When `resolveStorageBackend()` resolves `postgres`, `startServer()` SHALL NOT
  open or migrate the configured persistent SQLite database during normal
  startup. SQLite remains available only as an explicitly non-durable in-memory
  compatibility handle so guarded modules that hold a `getDb()` reference do not
  observe `null`. No persistent SQLite file is opened, created, or migrated.
- `initPostgresStorage(...)` runs before `seedPreRegisteredClients(...)` so the
  pre-registered client seed dispatches to the active backend.
- SQLite-only mode is unchanged: it opens and migrates the configured persistent
  SQLite file exactly as today.
- Add explicit startup smoke coverage for both modes, and assert the persistent
  SQLite file is never opened in Postgres mode.

## Capabilities

### Modified

- `reference-implementation-architecture` — adds the Postgres-mode storage
  boundary requirement and the both-backend startup-smoke requirement.

## Impact

- `reference-implementation/server/index.js` — boot order and backend-aware DB
  init in `startServer()`.
- `reference-implementation/test/` — startup smoke tests for both backends.
- No protocol Core, Collection Profile, or wire-contract change. This is
  reference-implementation runtime/architecture only.
- No new dependency, no broad storage abstraction.

## Residual Risks

- Live Postgres startup smoke depends on `PDPP_TEST_POSTGRES_URL` (the Compose
  proof service). Where that is unavailable, the Postgres half registers a
  skipped test and the owner runs it against a real Postgres. Documented in
  `tasks.md` acceptance checks.
