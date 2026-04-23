# Design: swap SQLite driver to `better-sqlite3`, extract SQL into `.sql` files

## Purpose

Fix a reproducible native-level crash in the reference implementation by moving off the async `sqlite3`-based driver (`@databases/sqlite`) to the synchronous, widely-deployed `better-sqlite3`. While we're touching every query site, take the opportunity to extract static SQL into inspectable `.sql` files, which matches the reference implementation's "system to inspect and build from" goal.

## Root-cause summary

Reproduced via `curl`: three concurrent dashboard requests in a loop cause SIGSEGV inside `node_sqlite3::Statement::RowToJS` / `Statement::Work_AfterAll`. Full gdb backtraces captured from four separate core dumps all show the same stack. The trigger: large TEXT rows (some records exceed 400KB of JSON) being marshaled from SQLite into V8 strings on a libuv worker thread while the main thread runs GC. The failure mode is V8 scavenger finding corrupt heap state — consistent with mis-scoped handles in `sqlite3`'s N-API binding.

The crash reproduces on Node 24.14 LTS and Node 25.8; not a Node regression. Multiple community reports describe the same failure class ([#1605](https://github.com/TryGhost/node-sqlite3/issues/1605)). The fix we need is to stop using this driver.

## Why `better-sqlite3`

Community consensus (verified via SQG 2026 benchmark, PkgPulse 2026 comparison, WiseLibs/better-sqlite3 issues #1234 and #1266):

- **No async work queue.** `better-sqlite3` is synchronous. There is no `Work_AfterAll`, no row-batch marshaling on a worker thread. The crash class we hit does not exist in its architecture.
- **Most-deployed SQLite driver on Node.** Drizzle's default. ~3M weekly downloads. Years of production bake time on every Node LTS.
- **Node's access pattern is already sync-shaped.** Every `await db.query(...)` in our code is awaited before any subsequent DB work, so switching to sync is a drop-in semantic match.

Alternatives considered:

- **`node:sqlite` (Node 22+ built-in).** Still flagged experimental in 2026; smaller feature surface; weaker error messages ([nodejs/node#61051](https://github.com/nodejs/node/issues/61051)). Directionally right but not ready for a reference implementation.
- **Stay on `@databases/sqlite`, downgrade `sqlite3` or use an ORM shim.** Doesn't fix the crash class. `sqlite3`'s `RowToJS` issue is in the current 5.1.7 release and there is no 5.2 planned.
- **Migrate to `libsql` or Turso.** Async again, wrong dialect surface, overkill for local reference.

## Why extract SQL to `.sql` files

The reference implementation explicitly positions itself as **"a system to inspect and build from,"** not a walkthrough. Today, answering the question *"what queries does the AS/RS actually run against SQLite?"* requires grepping 13 JS files. After the migration, a reviewer can:

```
ls reference-implementation/server/queries/grants/
  select_active_by_id.sql
  select_by_subject.sql
  insert.sql
  update_status.sql
  update_revoke.sql
  …
```

That's a qualitative change in reviewability. It matches the same move the server-side SQL ecosystem has made (`yesql`, `pgtyped`, `sqlc`, `ts-sql-query` generators): static SQL belongs in `.sql` files. Editors syntax-highlight it. Diff tools show query changes cleanly. Grep works naturally.

Dynamic SQL (the three `UPDATE ... SET ${sql.join(setClauses)}` patterns in tests, and the `db.transaction(fn)` wrapper in `issueToken`) stays in JS as a small helper. Don't contort static-file patterns to handle cases they weren't designed for.

## Layout

```
reference-implementation/
  server/
    db.js              # init(), getDb(), getQueries(); opens DB + loads queries/*
    queries/
      index.js         # loader — walks the tree, prepares each .sql file,
                       #   returns a typed-shaped nested object of prepared stmts
      connectors/
        select_manifest.sql
        upsert.sql
        …
      grants/
        select_active_by_id.sql
        insert.sql
        update_status.sql
        …
      records/
        select_by_id.sql
        list_by_stream.sql
        …
      spine/
        insert_event.sql
        list_by_trace.sql
        list_by_grant.sql
        list_by_run.sql
        list_by_event_type.sql
        list_all.sql
        …
      owner_device_auth/
        insert.sql
        approve.sql
        deny.sql
        exchange.sql
        …
      pending_consents/
        …
  lib/
    spine.js           # calls queries.spine.*
  runtime/
    controller.js      # calls queries.runtime.*
```

Each call site becomes:

```js
// Before
const rows = await db.query(sql`SELECT * FROM grants WHERE grant_id = ${id}`);
// After
const rows = queries.grants.selectById.all(id);
```

## Loader

A tiny loader reads every `.sql` file at startup, calls `db.prepare(text)`, and returns a nested object whose shape mirrors the directory tree. File name → camelCase key:

```js
// queries/index.js (sketch)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadQueries(db, root) {
  const out = {};
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) out[entry.name] = loadQueries(db, path);
    else if (entry.name.endsWith('.sql')) {
      const key = entry.name.slice(0, -4).replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = db.prepare(readFileSync(path, 'utf8'));
    }
  }
  return out;
}
```

All statements are prepared exactly once, shared across requests. That's canonical `better-sqlite3` usage and the recommended performance pattern.

## Transactions

`better-sqlite3` exposes `db.transaction(fn)` which returns a new function; calling it wraps `fn` in `BEGIN`/`COMMIT` (or `ROLLBACK` on throw). Our one transaction (`issueToken` in `auth.js`) migrates cleanly:

```js
// Before
return db.tx(async (tx) => {
  const grantRows = await tx.query(sql`SELECT ... WHERE grant_id = ${grantId}`);
  // …
  await tx.query(sql`INSERT INTO tokens ...`);
});

// After
const issueTokenTx = db.transaction((grantId, tokenRow) => {
  const grant = queries.grants.selectById.get(grantId);
  // …
  queries.tokens.insert.run(tokenRow);
  return result;
});
export async function issueToken(grantId, subjectId, clientId, expiresAt, meta = {}) {
  // build inputs (async where it needs to be)
  return issueTokenTx(grantId, tokenRow);  // sync within the transaction
}
```

## Dynamic-SQL helpers

The three `sql.join(setClauses, sql`, `)` patterns in tests build dynamic UPDATE SET clauses. These become small builders in JS:

```js
function buildUpdate(table, where, updates) {
  const keys = Object.keys(updates);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const binds = keys.map(k => updates[k]);
  const stmt = db.prepare(`UPDATE ${table} SET ${sets} WHERE ${where.clause}`);
  return stmt.run(...binds, ...where.binds);
}
```

Cost is minimal (these are test-only today) and keeps the 99% static-SQL case clean.

## Schema and migration

No schema changes. The existing `CREATE TABLE IF NOT EXISTS …` statements in `db.js` that build the schema at startup migrate over (they become `.sql` files in `queries/migrations/` and run in numeric order, or stay inline in `db.js` as `db.exec(...)` calls).

**Critical:** an existing on-disk database file (`packages/polyfill-connectors/.pdpp-data/polyfill.sqlite`, currently holding ~350k Slack records the owner just ingested) MUST open and operate unchanged. `better-sqlite3` reads the same SQLite file format as `sqlite3`, so this is automatic, but we verify it in acceptance check 5.

## Acceptance checks

1. `pnpm --filter pdpp-reference-implementation test` passes on the full suite (578 tests across 14 files). The single pre-existing `composed-origin.test.js` failure remains pre-existing.
2. `node -e "const db = require('better-sqlite3')('packages/polyfill-connectors/.pdpp-data/polyfill.sqlite'); console.log(db.prepare('SELECT COUNT(*) as n FROM records').get())"` returns a sensible number (~600k records) against the owner's existing DB.
3. `pnpm dev` starts both the web and reference servers cleanly. Open `/dashboard/records`, `/dashboard/search?q=personal+server&scope=messages`, `/planning/changes` concurrently — the exact sequence that crashed pre-migration. Do 10+ rounds. Reference server survives.
4. The owner-token device flow still works end-to-end (mint via `agent-access.md` steps; fetch Slack records via `/v1/streams/messages/records?connector_id=…`).
5. `ls reference-implementation/server/queries/` shows a clean directory layout. `wc -l` on every `.sql` file sums to roughly the extracted volume (~190 files × a few lines each). A reviewer opening any file sees a valid, standalone SQL statement.

## Out of scope

- Dashboard query-surface browser (follow-up).
- Static `.sql` ↔ live schema alignment checker (follow-up).
- Migrating the per-run polyfill-connectors runtime DB files (they have their own story).
- TypeScript types for prepared-statement return shapes. `better-sqlite3` + TS is doable via `Database.prepare<Row, Bind>()` generics, but our DB layer is JS. Deferred.
