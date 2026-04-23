## Why

The reference implementation's SQLite driver — `@databases/sqlite@4.0.2`, which bundles `sqlite3@5.1.7` — crashes the server under normal dashboard workload. We reproduced this deterministically:

- Hit `/dashboard/records`, `/dashboard/search?q=personal+server&scope=messages`, and `/planning/changes` concurrently, two-to-seven rounds in sequence, and the reference server dies with `SIGSEGV` or `SIGABRT` (`free(): invalid size`).
- gdb backtraces from real core dumps (PIDs 938721, 1100273, 1225662, 1235997) consistently land inside `node_sqlite3::Statement::RowToJS` invoked from `Statement::Work_AfterAll`. The crash is native-level; no JS-level handler can catch it.
- The crash reproduces on Node 24.14 LTS and Node 25.8 — **not a Node-version regression**.
- The community has documented this failure class: [TryGhost/node-sqlite3#1605](https://github.com/TryGhost/node-sqlite3/issues/1605) shows the same `RowToJS` SIGSEGV stack on Node 16 in 2023. [#1392](https://github.com/TryGhost/node-sqlite3/issues/1392) documents `Work_AfterAll` as a known performance/stability hotspot. The shape of the bug is: sqlite3's async N-API layer creates V8 handles in a way the concurrent scavenger trips over when rows contain large TEXT payloads (our records can exceed 400KB).

Beyond the crash, two additional motivations:

- **Inspectability.** The reference implementation is explicitly for reviewers to inspect. Inline `sql\`…\`` tagged templates scattered across 13 files hide the query surface inside JS. A standards reviewer or an engineer forking the reference cannot easily answer "what queries does the AS/RS run?" without grepping JS source.
- **Idiom.** Modern Node SQLite consensus (2026, verified via SQG benchmark, PkgPulse, WiseLibs issue threads) is `better-sqlite3` — synchronous, widely deployed, maintained, used by Drizzle ORM. `@databases/sqlite`'s async wrapper over the legacy `sqlite3` driver is the shape the ecosystem has migrated off.

This change fixes the crash **and** improves reference-ness in one cut: swap to `better-sqlite3` idiomatically, and extract static SQL into `.sql` files under a `queries/` directory so the query surface of the reference is inspectable as artifacts.

## What Changes

- Remove `@databases/sqlite` from `reference-implementation/package.json` and `packages/polyfill-connectors/package.json`.
- Add `better-sqlite3` as a direct dependency of both.
- Rewrite `reference-implementation/server/db.js` to return a `better-sqlite3` `Database` instance via `getDb()`, plus a `getQueries()` registry of prepared statements loaded from `.sql` files at startup.
- Lay down `reference-implementation/server/queries/` with one directory per table/domain (`grants/`, `records/`, `spine/`, `owner_device_auth/`, `pending_consents/`, `connectors/`, etc.). Each static query lives in its own `.sql` file, loaded once, prepared once, reused per call.
- Migrate all ~190 static `db.query(sql\`...\`)` call sites across `server/index.js`, `server/records.js`, `server/auth.js`, `server/ref-control.js`, `lib/spine.js`, `runtime/controller.js`, and associated tests to use `queries.X.Y.get(...) | .all(...) | .run(...)`.
- Keep the handful of dynamic queries (the three `sql.join(setClauses, ...)` UPDATE statements in tests and the one `db.tx()` transaction in `auth.js`) as small in-JS query-builder helpers — *not* as `.sql` files, because their WHERE/SET clauses are variable.
- Replace `db.tx(async tx => ...)` with `better-sqlite3`'s synchronous `db.transaction(fn)` wrapper. Our one transaction-using function (`issueToken` in `auth.js`) becomes synchronous at the DB layer but the handler stays `async` for its external surface.
- Update the two non-reference usages: `packages/polyfill-connectors/connectors/imessage/index.ts` and `packages/polyfill-connectors/bin/verify-all.ts` also migrate to `better-sqlite3` for consistency (they read Apple's `chat.db` file read-only; easy).
- Update the 4 test files that use `sql\`...\`` directly to use the new API.

## Capabilities

### Modified Capabilities
- `reference-implementation-architecture`: add requirements that the reference implementation use `better-sqlite3` as its SQLite driver, that static SQL live in inspectable `.sql` files under `server/queries/`, and that schema/migration behavior remain unchanged so existing on-disk databases (including `packages/polyfill-connectors/.pdpp-data/polyfill.sqlite`, containing ~350k Slack records the owner already ingested) continue to open and function.

## Impact

- `reference-implementation/package.json` (swap dep)
- `reference-implementation/server/db.js` (rewrite: expose `Database` directly + query registry)
- `reference-implementation/server/queries/**/*.sql` (new tree, ~100 files)
- `reference-implementation/server/queries/index.js` (loader)
- `reference-implementation/server/records.js`, `auth.js`, `ref-control.js`, `index.js`, `records.js`, `lib/spine.js`, `runtime/controller.js` (call-site migration)
- `reference-implementation/test/*.test.js` (6 files adjust test-side queries)
- `packages/polyfill-connectors/package.json`, `connectors/imessage/index.ts`, `bin/verify-all.ts`
- **No protocol changes, no HTTP/JSON surface changes, no schema changes.** The migration is purely the DB access layer.

## Follow-ups

- **Query-surface doc page in the dashboard.** Now that every query lives in a named `.sql` file, we can surface them under `/dashboard/reference/queries` so a reviewer can browse every query the reference impl runs. Deferred to its own change.
- **Static analysis of query/schema alignment.** A test that parses `.sql` files and confirms every referenced column exists in the live schema. Deferred.
- **Consider migrating the polyfill-connectors runtime (separate `.sqlite` files per connector run)** to `better-sqlite3` as well for consistency. Those use raw `sqlite3` directly today and haven't shown our crash pattern, but the consistency win is real. Deferred.
