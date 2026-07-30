## Why

The maintained connector-summary evidence row has canonical counts and
checkpoints, but it cannot yet accept a complete, connection-scoped owner LIST
projection from a bounded publisher. A later runtime owner must be able to
publish its observed runtime axis without moving runtime discovery onto GET.

## What Changes

- Add one named terminal LIST-projection payload and freshness envelope to the
  existing `connector_summary_evidence` row on SQLite and PostgreSQL.
- Accept a narrow, already-observed runtime projection as part of the payload.
- Make canonical rebuild and dirty signals invalidate the payload; stale data
  is never returned as current projection truth.

## Impact

- `reference-implementation/server/connector-summary-read-model.ts`
- SQLite and PostgreSQL `connector_summary_evidence` schema/migrations
- Future scoped-runtime maintenance publisher; ordinary GET integration stays
  blocked until that owner is available.
