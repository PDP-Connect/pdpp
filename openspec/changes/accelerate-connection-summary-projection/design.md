## Context

`/_ref/connectors` is the owner console's per-connection summary feed. The live browser measurement showed `/dashboard/runs` fetching its RSC payload multiple times; each fetch re-ran the full connector-summary projection. On Postgres, that feed is expensive enough that repeated sequential RSC fetches can stack into 7-12 second page loads.

The same projection read run evidence by `connector_id` only:

```ts
getLatestRunSummary(connectorId)
getLatestRunSummary(connectorId, "succeeded")
```

That is wrong for multi-connection browser-backed connectors. Live Amazon had many active browser-shell connections with overlapping records, and Chase displayed a browser-surface failure from a draft shell because sibling rows shared connector-scoped run summaries.

## Decisions

### 1. Connection run evidence is connection-scoped

When a spine run summary carries `browser_surface_profile_key`, the owner summary matches it to a connection only when that profile key is the connection's expected browser profile. A profile-less summary may match only if it carries explicit `connector_instance_id` or `connection_id` equal to the connection.

This is intentionally conservative. Missing run evidence is better than assigning another account/device's run to the wrong connection.

### 2. Browser-surface failure reason is real failure evidence

Some browser-surface runs terminate before a connector child emits `run.failed`. Their summary status can be `surface_failed` while `failure_reason` is null. The projection now falls back to `browser_surface_wait_reason`, then `browser_surface_status`, then `browser_surface_failed`.

### 3. Duplicate full-list reads are coalesced, not made long-lived

The first performance tranche uses a Postgres-only, in-process, 5-second single-flight cache for the full connection-summary list. The goal is to collapse repeated RSC fetches during one navigation, not to make connection state stale for long periods.

SQLite is excluded because many tests create and tear down SQLite databases in one process, and because the live bottleneck is Postgres. Diagnostic calls with explicit concurrency hooks bypass the cache.

### 4. One projection reuses run pages per connector/status

The uncached path still needs to be cheaper. During one projection, sibling connections reuse the same `listSpineCorrelations("run", { sourceId, status })` page instead of issuing the same run-page query per connection.

## Alternatives

- Route-level HTTP caching: helps repeated fetches but cannot fix wrong sibling run evidence and is less precise than caching the expensive shared projection.
- Long-lived materialized summary table: likely the right later step if the projection remains expensive, but higher risk overnight because it changes write paths and invalidation.
- Assign connector-scoped legacy runs to every sibling: preserves old data but keeps the live confusion. The reference should prefer honest unknown over false precision.

## Acceptance Checks

- Two sibling browser-backed connections with different profile-keyed browser runs project different `last_run.run_id` values.
- A `surface_failed` browser run projects a non-null failure reason from browser-surface evidence.
- SQLite connection-summary tests remain isolated.
- Reference and console TypeScript pass.
- Live proof after deploy: repeated `/_ref/connectors` calls and `/dashboard/runs` browser timings improve, and Amazon/Chase rows no longer inherit sibling draft-shell run state.
