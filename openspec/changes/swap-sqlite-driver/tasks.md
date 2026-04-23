## 1. Dependencies

- [ ] 1.1 Add `better-sqlite3` to `reference-implementation/package.json` `dependencies`.
- [ ] 1.2 Remove `@databases/sqlite` from `reference-implementation/package.json`.
- [ ] 1.3 Add `better-sqlite3` to `packages/polyfill-connectors/package.json` `dependencies`.
- [ ] 1.4 Remove `@databases/sqlite` from `packages/polyfill-connectors/package.json`.
- [ ] 1.5 Run `pnpm install` at the repo root, verify both packages compile their native addon (N-API build).

## 2. Query tree

- [ ] 2.1 Create `reference-implementation/server/queries/` directory.
- [ ] 2.2 Add a `queries/index.js` loader that walks the tree, reads each `.sql`, calls `db.prepare(text)`, and returns a nested object keyed by snake_case → camelCase file names.
- [ ] 2.3 Extract every static `sql\`...\`` into its own `.sql` file, organized by table/domain:
  - [ ] `queries/schema/` for `CREATE TABLE IF NOT EXISTS …` and `CREATE INDEX …` statements (or keep inline in `db.js` as `db.exec(...)` — pick whichever reads cleanest; document the choice in `design.md`).
  - [ ] `queries/connectors/`
  - [ ] `queries/grants/`
  - [ ] `queries/records/`
  - [ ] `queries/record_changes/`
  - [ ] `queries/spine/`
  - [ ] `queries/owner_device_auth/`
  - [ ] `queries/pending_consents/`
  - [ ] `queries/tokens/`
  - [ ] `queries/sync_state/`
  - [ ] (any others discovered during migration — enumerate in the change's design-notes if non-obvious)

## 3. Rewrite `server/db.js`

- [ ] 3.1 Replace the `@databases/sqlite` import with `better-sqlite3`.
- [ ] 3.2 In `initDb(path)`: open the DB, apply PRAGMAs synchronously (WAL, synchronous=NORMAL, etc.), run schema statements via `db.exec(...)`, then call `loadQueries(db, path.to.queries)` and stash the result alongside the db handle.
- [ ] 3.3 Export `getDb()` (returns `Database` instance) and `getQueries()` (returns the loaded registry).
- [ ] 3.4 Confirm PRAGMAs `journal_mode = WAL`, `synchronous = NORMAL`, `temp_store = MEMORY`, `mmap_size = 268435456`, `cache_size = -65536` still apply for file-backed DBs (and are skipped for `:memory:`, matching existing behavior).

## 4. Migrate call sites — runtime code

- [ ] 4.1 `reference-implementation/server/records.js` (36 sql templates): move each into `queries/records/*.sql` or `queries/record_changes/*.sql`, rewrite handler to `queries.X.Y.all(...)` / `.get(...)` / `.run(...)`.
- [ ] 4.2 `reference-implementation/server/auth.js` (25 sql templates): migrate to `queries/grants/`, `queries/owner_device_auth/`, `queries/pending_consents/`, `queries/tokens/`. Convert the single `db.tx(async tx => ...)` to a `db.transaction(fn)` wrapper at module scope.
- [ ] 4.3 `reference-implementation/server/index.js` (2 sql templates): migrate.
- [ ] 4.4 `reference-implementation/server/ref-control.js` (8 sql templates): migrate.
- [ ] 4.5 `reference-implementation/lib/spine.js` (8 sql templates): migrate to `queries/spine/*.sql`. Note the handful of queries that filter dynamically (`WHERE trace_id = ?` vs `WHERE grant_id = ?` etc.) — each filter variant becomes its own `.sql`, chosen by an `if/else` in the caller.
- [ ] 4.6 `reference-implementation/runtime/controller.js` (6 sql templates): migrate.

## 5. Migrate call sites — tests

- [ ] 5.1 `reference-implementation/test/pdpp.test.js` (57 sql templates): largest test file. Migrate. The two `sql.join(setClauses, sql\`, \`)` UPDATE builders become small in-test helpers.
- [ ] 5.2 `reference-implementation/test/cli.test.js` (25 sql templates).
- [ ] 5.3 `reference-implementation/test/control-plane.test.js` (1).
- [ ] 5.4 `reference-implementation/test/event-spine.test.js` (1).
- [ ] 5.5 `reference-implementation/test/owner-auth.test.js` (3).
- [ ] 5.6 `reference-implementation/test/query-contract.test.js` (1).

## 6. Migrate polyfill-connectors usages

- [ ] 6.1 `packages/polyfill-connectors/connectors/imessage/index.ts`: swap `@databases/sqlite` read-only open of Apple's `chat.db` to `better-sqlite3` with `{ readonly: true, fileMustExist: true }`.
- [ ] 6.2 `packages/polyfill-connectors/bin/verify-all.ts`: same swap.
- [ ] 6.3 Delete `packages/polyfill-connectors/types/databases-sqlite.d.ts` (no longer needed).

## 7. Regression & crash verification

- [ ] 7.1 Run `pnpm --filter pdpp-reference-implementation test`. All suites pass except the pre-existing `composed-origin.test.js` flake (verify failure signature is unchanged — i.e. still `dashboard should not leak the internal AS origin`, not anything new).
- [ ] 7.2 `pnpm dev`. Both servers start. Log output shows structured lines from the add-reference-impl-logging change (which stays intact).
- [ ] 7.3 Reproduce the exact crash sequence that killed the server pre-migration:
  ```
  for i in 1..10; do
    curl /dashboard/records & curl /dashboard/search?q=personal+server &scope=messages & curl /planning/changes & wait
  done
  ```
  Reference server SHALL survive all 10 rounds.
- [ ] 7.4 Use `agent-access.md` device flow to mint an owner token, fetch `/v1/streams/messages/records?connector_id=https://registry.pdpp.org/connectors/slack&limit=500`. Confirm the response shape is unchanged.

## 8. Capability spec update

- [ ] 8.1 Confirm the delta in `specs/reference-implementation-architecture/spec.md` covers what this change actually delivers.
- [ ] 8.2 After merge, archival folds the `ADDED Requirements` into `openspec/specs/reference-implementation-architecture/spec.md`.

## 9. Clean up

- [ ] 9.1 Remove now-unused repro harnesses: `reference-implementation/repro-crash.mjs`, `repro-dashboard.mjs`, `repro-sqlite-crash.mjs` — keep one canonical crash-reproducer if useful for future regressions, put it under `scripts/` with a README.
- [ ] 9.2 Remove the temporary diagnostic `[diag] exit code=…` prints in `server/index.js` (added during the hunt). The crash handlers from `add-reference-impl-logging` stay.
- [ ] 9.3 Restore `node --watch` in the reference dev script — or deliberately leave it off with a comment. (Decision deferred to implementation; the `--watch` concern was mooted by root cause not being `--watch` after all.)

## 10. Follow-ups (not in this change)

- [ ] 10.1 `/dashboard/reference/queries` page that surfaces the `queries/` tree for inspection.
- [ ] 10.2 Static analyzer that parses every `.sql` and asserts referenced tables/columns exist in the live schema.
- [ ] 10.3 Evaluate migrating per-run polyfill-connectors DB usage (separate concern).
