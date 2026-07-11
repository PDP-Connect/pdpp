# w1 Postgres records decomposition report

## Baseline tally

PIN gate: **RED — stopped before production changes.**

Command run from `reference-implementation/`:

```sh
PDPP_TEST_POSTGRES_URL=postgres://pdpp:pdpp@127.0.0.1:55432/postgres node --test --test-force-exit test/storage-utils.test.js test/postgres-records-ingest-noop.test.js test/postgres-records-filter-sql.test.js test/postgres-runtime-storage.test.js test/postgres-records-version-floor.test.js test/records-meta-window.test.js test/records-delete-postgres-routing.test.js
```

Result: 7 test files, 0 passed, 7 failed, 0 skipped.

- `test/postgres-records-filter-sql.test.js` failed while loading because Node could not resolve the `pg` package imported by `server/postgres-storage.js`.
- The other six files failed while loading because Node could not resolve the `better-sqlite3` package imported by `server/db.js`.
- No test body ran, so there is no green behavior baseline against which a behavior-preserving refactor can be proven.

## Decomposition map

Not produced. The non-negotiable PIN protocol requires stopping when the covering baseline is red.

## Cognitive-complexity mass

- Before: 251 excess mass (task-provided measurement; not re-measured after the red PIN gate).
- After: not applicable; no production files changed.

## Gates

- Covering suite: **failed at baseline** (missing runtime dependencies).
- `pnpm typecheck`: not run after the failed PIN gate.
- Biome cognitive-complexity lint: not run after the failed PIN gate.
- Test expectations: unchanged.
- `server/postgres-records.js`: unchanged.
- `server/records.js`: unchanged.

## Required unblock

Restore/install the `reference-implementation` dependencies so both `pg` and `better-sqlite3` resolve, then rerun the exact PIN command above. Decomposition must not begin until that command is green.
