## Why

The live Postgres deployment served stale dashboard totals because a
reference-only read model still read from the SQLite database initialized by
the runtime. Existing Postgres runtime specs require durable control-plane and
read surfaces to be Postgres-backed, but the implementation still permits
accidental SQLite reads in Postgres mode.

## What Changes

- Define the Postgres runtime boundary as an invariant: durable runtime state
  and derived reference read models SHALL NOT use local persistent SQLite when
  `PDPP_STORAGE_BACKEND=postgres`.
- Add an explicit audit and guard for any remaining SQLite use in Postgres
  mode.
- Move the dataset-summary projection to the active backend, including
  Postgres-backed projection rows and rebuild/reconcile paths.
- Preserve SQLite as the default local backend.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Affects reference runtime storage, reference-only dashboard/read-model
  surfaces, and Postgres deployment diagnostics.
- Does not change PDPP Core, Collection Profile messages, grant semantics, or
  public resource-server response contracts.
