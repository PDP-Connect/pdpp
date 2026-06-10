## 1. Audit (complete)

- [x] 1.1 Confirm `startServer()` opens the persistent SQLite file
  unconditionally before `initPostgresStorage` (index.js `initDb` at the boot
  site).
- [x] 1.2 Confirm `seedPreRegisteredClients` dispatches on
  `isPostgresStorageBackend()` but runs before the active backend is set, so it
  seeds SQLite in Postgres mode.
- [x] 1.3 Confirm `validateReferenceQueries` is defined but never invoked, and
  `loadReferenceQueries` reads `.sql` files without a SQLite handle — so the
  query registry imposes no boot-time SQLite dependency.
- [x] 1.4 Confirm `lib/db.ts:requireDb()` throws on a null handle, and that all
  runtime storage callers dispatch on `isPostgresStorageBackend()` before
  reaching it (per the 2026-05-28 classification).
- [x] 1.5 Record the audit table in `design.md`.

## 2. Boot-boundary implementation

- [x] 2.1 In `startServer()`, when `resolveStorageBackend()` resolves
  `postgres`, open SQLite as an in-memory non-durable handle (`:memory:`)
  instead of the configured persistent file. Leave SQLite mode opening the
  configured persistent file.
- [x] 2.2 Order `initPostgresStorage(storageBackend)` before
  `seedPreRegisteredClients(...)` so the seed dispatches to the active backend.
- [x] 2.3 Verify no other boot step between the old and new ordering depends on
  SQLite being initialized first (controller boot, reconcile, manifest reconcile,
  scheduler all dispatch and run after `initPostgresStorage`).

## 3. Both-backend startup smoke

- [x] 3.1 Add a SQLite-mode startup smoke test: boot `startServer()` against a
  temp persistent SQLite file, assert readiness, assert pre-registered client is
  readable.
  → `test/storage-mode-startup-boundary.test.js` (SQLite half).
- [x] 3.2 Add a Postgres-mode startup smoke test (env-gated on
  `PDPP_TEST_POSTGRES_URL`, skip fallback): boot `startServer()` in Postgres mode
  against a temporary Postgres database with `dbPath` pointed at a path the boot
  must not create, assert the path is never created, assert readiness, assert
  the pre-registered client is readable from Postgres, and drop the temporary
  database after the test.
  → `test/storage-mode-startup-boundary.test.js` (Postgres half, skips when the
    test endpoint is unset).

## 4. Validation

- [x] 4.1 `openspec validate exclude-persistent-sqlite-from-postgres-boot --strict` — valid.
- [x] 4.2 `openspec validate --all --strict` — 40/40 passed.
- [x] 4.3 Focused startup smoke tests — SQLite half passes by default; Postgres
  half registers as skipped when `PDPP_TEST_POSTGRES_URL` is unset and runs
  against a temporary database when it is set.
- [x] 4.4 `pnpm --dir reference-implementation run typecheck` — clean.
- [x] 4.5 `git diff --check` — clean.

## Acceptance checks (reproducible)

Node ≥ 23.6 strips TypeScript types natively; no `tsx`/loader flag is needed
(this worktree runs Node v25). After `pnpm install` at the repo root.

SQLite startup smoke (runs anywhere):

```sh
node --test --test-force-exit reference-implementation/test/storage-mode-startup-boundary.test.js
```

Postgres startup smoke + Postgres-gated boundary conformance:

```sh
docker compose --profile postgres --env-file .env.docker up -d postgres
export PDPP_TEST_POSTGRES_URL='postgres://user:password@localhost:5432/postgres'
node --test --test-force-exit reference-implementation/test/storage-mode-startup-boundary.test.js
node --test --test-force-exit reference-implementation/test/dataset-summary-postgres-boundary.test.js
```

If `PDPP_TEST_POSTGRES_URL` is unavailable in the worker environment, the
Postgres half registers as skipped. When it is available, the startup smoke
creates and drops its own temporary database, so it does not seed or mutate the
operator's live proof database.
