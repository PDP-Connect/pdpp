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

- [x] Run the original concurrent dashboard/search/planning crash repro for at least ten rounds and confirm the reference server survives.
  - 2026-04-24: Docker dev reference (`pdpp-reference-1`) survived 20 mixed concurrent rounds across `/dashboard/*`, `/planning/*`, `/_ref/deployment`, `/v1/streams`, record listing, lexical search, and semantic search with zero HTTP failures.
- [x] Open the current polyfill SQLite database with the reference server and verify existing records still serve through `/v1` and `/_ref` surfaces.
  - 2026-04-24: `packages/polyfill-connectors/.pdpp-data/pdpp.sqlite` opened under `better-sqlite3`; `/v1/streams`, `/v1/streams/messages/records`, `/v1/search`, `/v1/search/semantic`, and `/_ref/deployment` returned 200 against the existing 4.9GB DB.
- [x] Run `pnpm --dir reference-implementation run verify`.
  - 2026-04-24: `typecheck` and `ultracite check` passed.
- [x] Confirm any remaining full-suite failure matches the known `composed-origin.test.js` baseline and is unrelated to SQLite driver behavior.
  - 2026-04-24: `pnpm --dir reference-implementation test` passed fully; `composed-origin.test.js` is green on current head.

## 5. Cleanup

- [x] Remove temporary diagnostic `[diag] exit code=...` prints if any remain.
  - 2026-04-24: runtime/source grep found no remaining temporary diagnostic exit-code prints.
- [x] Decide whether crash repro scripts should be deleted or moved under a deliberate `scripts/` location.
  - 2026-04-24: no `repro-*-crash` scripts remain in the tree; no permanent repro script is needed after the 20-round live-stack verification.
- [x] Decide whether to restore `node --watch` in the reference dev script or document why it stays off.
  - 2026-04-24: package-local reference `dev` stays non-watch for quieter host operation; Docker dev keeps `node --watch` in `docker-compose.dev.yml` where container restarts are isolated.
- [x] Run `openspec validate swap-sqlite-driver --strict`.
- [x] Run `openspec validate --all --strict`.

## 6. Transferred Follow-Up

- [x] Move SQL query extraction and query-surface inspection to `make-reference-queries-inspectable`.
