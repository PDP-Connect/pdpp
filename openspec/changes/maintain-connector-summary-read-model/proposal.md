## Why

`GET /_ref/connectors` is a core owner-console read path. Recent performance tranches made it fast by adding a short in-process cache and by making overview rows shallow, but that is not the final construction: the read path still has a large per-connection evidence fan-out underneath the cache, and record-ingest writes do not event-invalidate the summary projection.

The reference already has the right pattern in the retained-size read model: maintained, dual-backend, incrementally updated evidence with dirty reconciliation and honest rebuild state. Connector summaries should use the same construction instead of a parallel TTL cache.

## What Changes

- Add a maintained connector-summary evidence read model for durable per-connection facts.
- Keep time-relative health, freshness, verdict, and next-action synthesis on read, using current `now` and runtime/controller liveness.
- Mark connector-summary evidence dirty from owner mutations, run lifecycle changes, and record ingest hooks.
- Replace the full-list fan-out cache with one indexed evidence read plus pure synthesis.
- Preserve scoped detail reads and diagnostics without falling back to shallow overview evidence.

## Capabilities

Modified:

- `reference-connector-instances`

## Impact

- Affects reference storage, migrations, SQLite/Postgres parity, and `/_ref/connectors` internals.
- Does not change the owner API response shape except for optional freshness/read-model metadata if needed for diagnostics.
- Expected benefit: event-fresh summary counts/evidence with stable low-latency reads and no time-stale verdict cache.
