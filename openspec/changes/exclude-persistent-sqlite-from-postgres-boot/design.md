# Design: Exclude persistent SQLite from Postgres-mode startup

## The storage-mode boundary (SLVP definition)

The reference implementation has exactly two runtime persistence modes, selected
once at boot by `resolveStorageBackend()`:

- **SQLite mode** (`PDPP_STORAGE_BACKEND` unset or `sqlite`): SQLite owns runtime
  persistence. `startServer()` opens and migrates the configured persistent
  SQLite file. This is the local-first default and is unchanged by this change.
- **Postgres mode** (`PDPP_STORAGE_BACKEND=postgres` + `PDPP_DATABASE_URL`):
  Postgres owns runtime persistence. Startup SHALL NOT depend on opening or
  migrating a persistent SQLite database.

"Owns runtime persistence" means: every durable read or write that serves an
operator answer or accepts ingest goes to that backend. The other backend's
engine is not a runtime persistence dependency.

Permitted SQLite use in Postgres mode is narrow and each instance must be one of:

1. **Test-only** — tests open in-memory SQLite directly.
2. **Migration-tool-only** — `scripts/migrate-storage/` reads/writes both stores
   by explicit operator command, never during normal `startServer()`.
3. **Explicitly non-durable, non-blocking compatibility** — the in-memory handle
   this change introduces (below). This is the category the task says to be
   skeptical of; the skepticism is satisfied because the handle opens no file,
   runs no persistent migration, serves no durable answer, and is discarded on
   shutdown.

## Why an in-memory non-durable handle rather than a null handle

Two shapes were considered for Postgres mode:

- **Null handle**: skip `initDb` entirely; `getDb()` returns `null`. Strictest
  boundary — no SQLite engine at all. But `lib/db.ts:requireDb()` throws
  `"[db] No database is open"` the moment any code path reaches a SQLite
  execution helper. The 2026-05-28 audit found every runtime path dispatches on
  `isPostgresStorageBackend()` first, so in principle nothing reaches it — but
  that is a *static* audit. A null handle converts any missed path from a
  silent empty-read (already guarded by `storage_backend_mismatch` on the one
  known class-C module) into a hard process crash. That is a poor trade for an
  SLVP-confident boot change.

- **In-memory non-durable handle (chosen)**: in Postgres mode, `initDb` opens
  `:memory:` — the same path tests use — building the schema with no file, no
  WAL, and no persistent migration. `getDb()` stays non-null so any guarded or
  import-time reference is safe, while the *persistent* SQLite dependency (the
  actual boot defect) is removed. The handle is genuinely non-durable: it is
  process-local and discarded on shutdown.

The chosen shape directly satisfies the normative requirement ("SHALL NOT
require opening/migrating a **persistent** SQLite database") with the lowest
blast radius. It does not weaken any guard: the class-C
`dataset-summary-read-model.js` guard (`assertSqliteBackendForDatasetSummary`)
still throws in Postgres mode before any SQLite read, so the in-memory
emptiness is never relied upon as truth.

This is deliberately *not* a broad storage abstraction. Per
`design-notes/broad-storage-abstraction-2026-04-24.md` (decided-defer), the
explicit `isPostgresStorageBackend()` seams are sufficient; this change adds one
backend-aware branch at the boot site, not a new repository layer.

## Boot-order correction

`seedPreRegisteredClients(...)` and `upsertRegisteredClient(...)` both dispatch
on `isPostgresStorageBackend()`. That predicate reads `activeBackend`, which is
only set to `postgres` inside `initPostgresStorage(...)`. Today the seed runs at
the call site *before* `initPostgresStorage`, so in Postgres mode the seed takes
the SQLite branch and writes pre-registered clients to the (now in-memory,
previously persistent) SQLite store instead of Postgres.

Fix: order `initPostgresStorage(...)` before `seedPreRegisteredClients(...)`.
Every other backend-dispatching boot step (`emitControllerBootedAndStashEpoch`,
`reconcileOrphanedRunsAtBoot`, polyfill manifest reconciliation, scheduler) already
runs after `initPostgresStorage` and dispatches correctly; only the seed is
mis-ordered.

## Audit: SQLite-touching paths reachable in Postgres-mode startup

Builds on `design-notes/postgres-runtime-boundary-sqlite-classification-2026-05-28.md`.
Disposition column is this change's action.

| Path | Touches SQLite at boot in PG mode? | Disposition |
| --- | --- | --- |
| `startServer()` → `initDb(DB_PATH)` (index.js) | **Yes — opens/migrates persistent file** | **FIX**: open `:memory:` in PG mode; no persistent file |
| `startServer()` → `seedPreRegisteredClients` (index.js) | Yes — dispatch fires before `initPostgresStorage` sets backend | **FIX**: reorder `initPostgresStorage` before seed |
| `server/queries/index.ts` `loadReferenceQueries()` (module load) | No — reads `.sql` files from disk only, never `getDb()` | No change (SQLite-free import) |
| `server/queries/index.ts` `validateReferenceQueries()` | N/A — defined but **never invoked** in runtime | No change; docstring is stale |
| `lib/db.ts` `exec`/`getOne`/`transaction` → `requireDb()` | Only inside SQLite branches (lazy `getDb()`), unreached in PG mode | No change (guarded) |
| `lib/controller-boot.ts` boot emit + reconcile | Dispatches on `isPostgresStorageBackend()`; runs after `initPostgresStorage` | No change (guarded, correctly ordered) |
| `lib/spine.ts` emit | Dispatches on `isPostgresStorageBackend()` | No change (guarded) |
| `server/auth.js` manifest reconcile | Dispatches on `isPostgresStorageBackend()` | No change (guarded) |
| `server/dataset-summary-read-model.js` | Guarded by `assertSqliteBackendForDatasetSummary` (throws in PG mode) | No change (fail-fast guard from prior change) |
| records / search / retained-size / browser-surface stores | Per-operation `isPostgresStorageBackend()` dispatch | No change (guarded) |
| `scripts/migrate-storage/` | Reads both stores by explicit operator command, not at `startServer()` | Out of scope (migration-tool-only, allowed) |

Net: exactly two runtime boot edits. Everything else already honors the boundary.

## Breakage resistance ("hard to break the other backend")

The follow-up guidance asks whether the construction makes it hard to break
SQLite while testing Postgres (and vice versa). Findings:

- **Shared conformance harnesses already exist and are the right pattern.** Seams
  like record-read, connector-state/scheduler, and consent/device-auth use a
  backend-agnostic scenario runner (`test/helpers/*-conformance.js`) parameterized
  by a `makeDriver` factory, with a SQLite half and a Postgres half
  (`*-conformance-postgres.test.js`) gated on `PDPP_TEST_POSTGRES_URL`. This is
  "shared contract, two drivers," not bespoke per-backend tests that drift.
- **What this change adds:** an explicit *startup* smoke for both modes — the one
  contract that was only ever exercised in SQLite mode by the default test run.
  The Postgres half follows the established env-gated/skip-fallback shape so the
  default suite stays green without Postgres, and the owner runs the real half
  against Compose.
- **The smallest practical Postgres harness** is the existing Compose proof
  service (`add-compose-postgres-proof-service`, archived). The owner sets
  `PDPP_TEST_POSTGRES_URL` to that service and runs the Postgres-gated tests; the
  exact commands are in `tasks.md`.
- **Backend-interface conformance over broad abstraction.** Consistent with the
  deferred broad-abstraction note, breakage resistance comes from durable-seam
  conformance tests, not a new storage interface layer.

This change does not overbuild CI; it adds the missing startup contract to the
existing conformance pattern and documents the smallest both-backend command.

## Acceptance checks

- Postgres-mode `startServer()` reaches HTTP readiness with no persistent SQLite
  file opened (asserted by the smoke test via a non-existent / unwritable
  `PDPP_DB_PATH` that the boot must not touch).
- SQLite-mode `startServer()` still opens and migrates the configured file.
- Pre-registered clients are readable via the active backend after boot in both
  modes.
- `openspec validate exclude-persistent-sqlite-from-postgres-boot --strict` and
  `openspec validate --all --strict` pass.

## Out of scope

- Removing the SQLite engine dependency from the Node build (still needed for
  SQLite mode, tests, and migration tooling).
- Splitting `lib/db.ts` / `server/db.js` into a SQLite-only module.
- Any protocol, wire, or manifest change.
- New conformance seams beyond the startup smoke.
