## Context

`add-postgres-runtime-storage` made Postgres an explicit runtime backend.
`add-dashboard-summary-read-model` made the dashboard summary a derived
read-model surface so `/dashboard` would not raw-scan the corpus. The live
deployment exposed a gap between those two changes: the summary route still
preferred a SQLite-backed projection even while canonical records lived in
Postgres.

This is not a dashboard-only issue. A reference runtime in Postgres mode should
not have two durable storage authorities. SQLite can remain the default backend
for local/single-process deployments, and local collector packages can use
their own outbox databases, but the reference server must not read local
persistent SQLite for durable AS, RS, control-plane, scheduler, run, connector,
or reference read-model state when Postgres mode is active.

## Decision

Treat Postgres mode as a storage-boundary invariant:

- canonical runtime state lives in Postgres;
- derived read models live in the active backend and are rebuildable from that
  backend's canonical state;
- any SQLite use in Postgres mode must be explicitly classified as
  non-durable/ephemeral/test-only, or removed;
- the server should expose diagnostics or tests that fail when a Postgres
  route silently reads stale SQLite state.

The immediate implementation should prioritize the dataset-summary projection,
because it already caused a user-visible false dashboard headline and it has an
existing read-model contract. The target is not to keep the recent raw Postgres
fallback as the final state. It is correct as a stopgap, but violates the
bounded-read-model requirement and made `/dashboard` accurate but slow.

## Rationale

This follows the existing Postgres runtime design instead of inventing a new
storage abstraction. Backing services should be treated as attached resources;
once the runtime is attached to Postgres, local SQLite must not remain a hidden
second resource for durable server state. For read models, prior art is clear:
derived projections are useful because they are tailored to a read surface, but
they must be rebuildable from the authoritative store and carry freshness
metadata. PostgreSQL materialized views show the same distinction between
persisted derived rows and authoritative source tables, but the reference
implementation needs incremental write hooks plus bounded reconciliation rather
than a full `REFRESH MATERIALIZED VIEW` on every dashboard load.

The design intentionally avoids a generic projection framework. The first
correction is a backend-consistent dataset summary plus a guard/audit pattern.
If a second projection needs the same machinery, extract after the second
concrete use case.

## Alternatives Considered

- Keep the raw Postgres fallback permanently.
  - Rejected: accurate, but it makes dashboard latency corpus-size dependent
    and violates the existing bounded read-model requirement.
- Reuse SQLite projections in Postgres mode and periodically sync them.
  - Rejected: creates dual durable authorities and repeats the exact stale-data
    failure mode.
- Introduce a generic event-processing/projection framework.
  - Rejected for now: more abstraction than the current problem earns.
- Disable SQLite initialization entirely in Postgres mode immediately.
  - Deferred: likely correct long-term, but first needs an audited list of any
    remaining legitimate compatibility paths so startup is not broken blindly.

## Scope

In scope:

- runtime audit of SQLite access reachable in Postgres mode;
- Postgres-backed dataset-summary read-model storage;
- Postgres-aware rebuild/reconcile routes;
- tests or runtime diagnostics proving stale SQLite data cannot drive Postgres
  dashboard/control-plane answers;
- documentation updates for storage-boundary expectations.

Out of scope:

- PDPP Core or Collection Profile changes;
- connector green-state work;
- local collector outbox storage, except to explicitly classify it as outside
  the reference server runtime;
- a general projection/event-processing platform;
- SQLite-to-Postgres migration tooling.

## Acceptance Checks

- `GET /_ref/dataset/summary` in Postgres mode returns from Postgres-backed
  bounded read-model rows, not raw corpus scans and not SQLite rows.
- `POST /_ref/dataset/summary/rebuild` and `/reconcile` update/read the active
  backend's projection.
- A test with deliberately divergent SQLite projection rows and Postgres
  canonical rows proves Postgres mode cannot serve stale SQLite summary data.
- An audit or guard documents every remaining SQLite use that is reachable in
  Postgres mode and fails on unclassified durable use.
- Existing SQLite-default tests still pass.
- Postgres-gated tests run against a real Postgres service and cover the
  corrected route behavior.
