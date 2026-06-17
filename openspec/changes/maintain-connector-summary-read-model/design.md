## Context

`accelerate-connection-summary-projection` improved live performance with a 5-second cache and a shallow overview read. That was a safe tranche, not the SLVP-ideal construction. The remaining issue is architectural: the un-cached projection performs many reads per connection, while the cache freezes `now`-relative health/verdict copy and is not invalidated by record ingest.

The existing `reference-implementation/server/retained-size-read-model.js` is the internal prior art to copy. It maintains denormalized evidence across SQLite and Postgres, supports dirty marking, lazy reconciliation, full rebuilds, and an honesty envelope.

## Load-bearing Decision

Persist durable evidence only. Do not persist the whole `ConnectorSummary`.

Materialized evidence:

- identity and lifecycle fields: `connector_instance_id`, `connector_id`, display names, status, revoked time;
- retained-size and record counts by stream;
- last run and last successful run evidence;
- acquisition coverage inputs, detail-gap counts, attention records, outbox/local-coverage/browser-surface evidence;
- schedule and refresh-policy inputs;
- maintenance fields: `dirty`, `computed_at`, `source_event_seq`, `state`, and sanitized error metadata.

Synthesized at read time:

- freshness;
- `connection_health`;
- collection report;
- rendered verdict and next action.

Reason: these fields are time-relative and runtime-relative. Persisting them would recreate the failure mode where a cached verdict says a source is healthy or calm after its evidence has become stale or blocked.

## Update Model

Use the same broad shape as retained size:

- dirty marking on every existing `invalidateConnectorSummariesCache` mutation seam;
- record-ingest dirty marking colocated with retained-size deltas;
- run lifecycle dirty marking for start/finish/fail/gap-drain events;
- lazy reconcile on read, plus a full rebuild utility for migrations or repair;
- dual-backend schema and migrations for SQLite and Postgres.

The initial implementation can keep the current cache behind a flag while the read model warms, but the final state should remove the cache from the hot path.

## Read Path

Unscoped `/_ref/connectors`:

- read all connector-summary evidence rows in one indexed scan;
- run pure synthesis per row using current `now` and runtime/controller liveness;
- return the existing list shape.

Scoped `/_ref/connectors?connection=...` and detail/diagnostics:

- resolve one connection exactly;
- read that connection's evidence;
- include deep run evidence required for diagnostics;
- never fall back to the shallow full-list projection.

## Acceptance Checks

- Full-list `/_ref/connectors` does not issue per-connection run/retained-size/evidence fan-out reads in the steady state.
- A record ingest that changes a connection's count marks the connection evidence dirty and the next read sees updated evidence without waiting for a TTL.
- Time passing across a freshness threshold changes the synthesized verdict on read without a write or cache expiry.
- SQLite and Postgres produce the same evidence and synthesis for the same fixtures.
- Scoped detail still includes deep run evidence and diagnostics.
- Live browser benchmark remains fast on `/dashboard`, `/dashboard/records`, source detail, and `/dashboard/runs`.

## Risks

- Naively persisting health/verdict copy would be faster but dishonest. The two-layer split is mandatory.
- Dirty marking can become another parallel invalidation engine. Keep it at existing mutation and retained-size delta seams.
- A partially built read model can drift from `projectConnectorSummaryForInstance`. Refactor shared evidence extraction first so rebuild/reconcile/detail use one code path.
