## Why

`define-reference-operation-environments` identifies connector state and schedule persistence as the next low-risk storage proof after consent/device auth. These tables exercise upsert semantics, per-connector uniqueness, active-run exclusivity, and operator-visible projections without the hard record/search problems of cursors, FTS, vectors, and version allocation.

Before extracting `ConnectorStateStore` or `SchedulerStore`, the reference needs executable conformance scenarios that make the current SQLite behavior adapter-ready.

## What Changes

- Add a test-only conformance harness for connector state, grant-scoped connector state, schedule persistence, and active-run persistence.
- Add a SQLite-backed driver that exercises current reference helpers/controller code without production abstraction changes.
- Add a broken driver or negative proof so the harness is falsifiable.
- Keep existing controller/runtime route tests as end-to-end evidence.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Adds tests/helpers under `reference-implementation/test/**`.
- Does not add production stores, adapters, Postgres, route refactors, or scheduler behavior changes.
- Provides the evidence base for later `ConnectorStateStore` / `SchedulerStore` extraction.
