## Why

The reference implementation's previous SQLite driver stack, `@databases/sqlite`
over `sqlite3`, crashed the server under normal dashboard workload. Reproduced
core dumps landed inside `node_sqlite3::Statement::RowToJS` /
`Statement::Work_AfterAll`, which made the failure native-level rather than a
JavaScript error the reference could catch or recover from.

The dependency swap has landed. This change now remains open only to close out
the driver-swap verification and cleanup work.

## What Changes

- Keep `better-sqlite3` as the direct SQLite driver for the reference
  implementation and polyfill connector SQLite readers.
- Prove the original crash repro no longer terminates the reference server.
- Confirm existing on-disk reference databases still open and serve records.
- Remove temporary crash-repro/debug artifacts or move any useful reproducer into
  a deliberate script location.
- Transfer SQL query extraction and query-surface inspection to
  `make-reference-queries-inspectable`.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: the reference SQLite substrate uses
  the stable synchronous driver and preserves existing database compatibility.

## Impact

- `reference-implementation/package.json`
- `reference-implementation/server/db.js`
- `packages/polyfill-connectors/package.json`
- SQLite reader usage in first-party connector tooling
- crash reproduction and verification scripts

No protocol changes, HTTP/JSON surface changes, schema changes, or query-shape
changes are in scope.
