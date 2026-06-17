## Context

The aggregation hot path builds a `GROUP BY` query over `spine_events`, applying stable filters such as `source_kind` and `source_id` before hydrating bounded summary rows. Postgres bootstrap and migration DDL already include `idx_pg_spine_events_source_run_summary` for the source-filtered run summary shape.

## Decision

Add the SQLite equivalent index:

```sql
CREATE INDEX IF NOT EXISTS idx_spine_events_source_run_summary
  ON spine_events(source_kind, source_id, run_id, occurred_at DESC)
  WHERE run_id IS NOT NULL;
```

The index is created in the base SQLite schema and the idempotent source-column migration so both fresh and existing SQLite stores converge without data rewrites.

## Alternatives

- Add only a broader source index. Rejected because SQLite already has source filtering coverage and the audited gap was the source/run aggregation shape.
- Add live maintenance or provider verification. Rejected for this change; this lane is DDL and local tests only.

## Acceptance Checks

- SQLite boot creates `idx_spine_events_source_run_summary`.
- SQLite and Postgres DDL both contain equivalent source/run summary index coverage.
- Existing aggregation results remain unchanged because only index DDL changes.
