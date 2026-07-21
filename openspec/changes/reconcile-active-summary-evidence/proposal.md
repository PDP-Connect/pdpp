## Why

The connector-summary evidence table is a repairable read model, but its normal
reconciler only visits rows that already exist and are marked dirty. Live
metadata therefore proved three invalid resting states: active connections with
no row, changed-ingest rows that remain stale, and retained streams that no
longer belong to the current manifest. A health read can consume missing or
stale latest-attempt facts without naming the projection failure. The current
owner-summary value cache can also return a pre-repair verdict after a durable
repair has completed.

## What Changes

- Reconcile the canonical connection set against observed summary-evidence rows
  before any connection summary, cache value, or health synthesis, repairing
  missing, dirty, identity-, manifest-, and source-checkpoint-mismatched rows.
- Use an exact reset-safe record checkpoint and monotonic terminal-event fold so
  best-effort invalidation hooks are never the sole correctness mechanism.
- Make retained stream observation state and manifest membership explicit,
  including exact zero, unobserved, stale/unknown, and dormant retained history.
- Make the current valid manifest own the active stream namespace: dormant
  history remains diagnostic but is excluded from active totals, coverage,
  discovery, and serving.
- Expose record snapshot, terminal fact, manifest declaration, and retained-byte
  reliability as independent typed evidence components.
- Feed unavailable or contradictory summary evidence into the existing
  projection-reliability health axis so health cannot silently render green.
- Preserve SQLite/Postgres parity, scope-safe orphan cleanup, and the existing
  connection lifecycle while keeping derived repair outside record acceptance.

## Impact

This is a reference-implementation read-model and owner-health contract change.
It does not alter connector record payloads, connector behavior, grant-scoped
reads, credentials, or the normative PDPP protocol.
