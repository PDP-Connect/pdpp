Status note (2026-04-24): the dependency swap itself has landed in
`reference-implementation` and `packages/polyfill-connectors`. Query extraction
has been split to `make-reference-queries-inspectable`; this change now tracks
only driver-swap verification and crash cleanup.

## 1. Dependencies

- [x] Add `better-sqlite3` to `reference-implementation/package.json` dependencies.
- [x] Remove `@databases/sqlite` from `reference-implementation/package.json`.
- [x] Add `better-sqlite3` to `packages/polyfill-connectors/package.json` dependencies.
- [x] Remove `@databases/sqlite` from `packages/polyfill-connectors/package.json`.
- [x] Run `pnpm install` at the repo root and verify the native addon compiles.

## 2. Reference Driver Migration

- [x] Replace the `@databases/sqlite` import in `reference-implementation/server/db.js`.
- [x] Open the DB through `better-sqlite3`.
- [x] Preserve the existing schema initialization and PRAGMA behavior.
- [x] Preserve existing `getDb()` call-site behavior.

## 3. Polyfill Connector SQLite Readers

- [x] Migrate `packages/polyfill-connectors/connectors/imessage/index.ts` to `better-sqlite3` read-only access.
- [x] Migrate `packages/polyfill-connectors/bin/verify-all.ts` to `better-sqlite3`.
- [x] Delete the obsolete `packages/polyfill-connectors/types/databases-sqlite.d.ts` shim.

## 4. Crash and Compatibility Verification

- [ ] Run the original concurrent dashboard/search/planning crash repro for at least ten rounds and confirm the reference server survives.
- [ ] Open the current polyfill SQLite database with the reference server and verify existing records still serve through `/v1` and `/_ref` surfaces.
- [ ] Run `pnpm --dir reference-implementation run verify`.
- [ ] Confirm any remaining full-suite failure matches the known `composed-origin.test.js` baseline and is unrelated to SQLite driver behavior.

## 5. Cleanup

- [ ] Remove temporary diagnostic `[diag] exit code=...` prints if any remain.
- [ ] Decide whether crash repro scripts should be deleted or moved under a deliberate `scripts/` location.
- [ ] Decide whether to restore `node --watch` in the reference dev script or document why it stays off.
- [ ] Run `openspec validate swap-sqlite-driver --strict`.
- [ ] Run `openspec validate --all --strict`.

## 6. Transferred Follow-Up

- [x] Move SQL query extraction and query-surface inspection to `make-reference-queries-inspectable`.
