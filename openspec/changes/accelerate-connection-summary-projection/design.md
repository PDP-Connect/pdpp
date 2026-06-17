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

### 5. Cold projection preloads retained-size rows once

The live browser harness showed that the remaining `/dashboard` and `/dashboard/runs` cold latency was the document response itself, and endpoint probes isolated the cold `/_ref/connectors` call at roughly 4-5 seconds while immediate repeats were 10-20ms. The next uncached fix is to preload the retained-size read-model rows once per full-list projection:

- `listRetainedSizeStreams({})` once, grouped by `connector_instance_id` and `connector_id`.
- `listRetainedSizeConnections({})` once, grouped by `connector_instance_id`.

The per-connection projection remains the single source of summary shape; it receives the request-local snapshot when called from the full-list path. Scoped connection reads (`/_ref/connectors?connection=...`) do not load the global retained-size snapshot, preserving their scoped-performance contract.

### 6. Browser performance harness is committed

The fetch-only `scripts/perf/bench.mjs` cannot see hydration, cold browser cache, aborted prefetches, RSC fetches, or page console errors. The new `scripts/perf/browser-bench.mjs` launches system Chrome with a fresh profile per route, records Web Vitals where available, separates routine aborted prefetches from true failed requests, captures same-route `?_rsc=` fetch timing, and runs RS/API probes in the same JSON output. It uses Chrome DevTools Protocol directly rather than adding Playwright or Puppeteer.

### 7. Overview rows are shallow; scoped diagnostics stay deep

Retained-size preloading did not remove the live cold cost. A local profile
against live Postgres isolated the next dominant cost to deep run-history
hydration: the full overview path was paying for `listSpineCorrelations("run",
sourceId=...)` and timeline classification across every source even though the
live overview payload currently projected those fields as `null`.

The full `/_ref/connectors` list is an overview read. It must answer "what
sources do I have and what state are they in?" quickly. It does not need to
block on deep run timeline hydration for every source before rendering the
owner's first page. Scoped reads keep the deep path:

- `/_ref/connectors?connection=...`
- source detail pages that resolve one connection
- owner-agent connection diagnostics

This preserves the evidence where the user has already chosen a source, while
making the list fast enough to be a navigation primitive.

This is a performance split, not a semantic downgrade. If overview rows later
need latest-run evidence for a connector whose health is not otherwise captured,
the correct next step is a bounded latest-run read model or SQL projection for
overview fields, not returning to deep timeline hydration on every list row.

### 8. Postgres source/run summary index is bootstrap state

The live Postgres proof showed that a partial covering index on
`spine_events(source_kind, source_id, run_id, occurred_at DESC) WHERE run_id IS
NOT NULL` changes source-scoped run grouping from heap-heavy scans to
index-only scans. The live index is not enough; it must be created by bootstrap
and migration code so new Postgres instances and redeploys do not depend on a
manual operator step.

## Alternatives

- Route-level HTTP caching: helps repeated fetches but cannot fix wrong sibling run evidence and is less precise than caching the expensive shared projection.
- Long-lived materialized summary table: likely the right later step if the projection remains expensive, but higher risk overnight because it changes write paths and invalidation.
- Assign connector-scoped legacy runs to every sibling: preserves old data but keeps the live confusion. The reference should prefer honest unknown over false precision.
- Adding Playwright only for performance measurement: more familiar, but unnecessary on this host because Chrome is already installed and CDP is enough for the required metrics.
- Hydrate deep run summaries on every overview row and rely on SQL indexes:
  the source/run index is useful for scoped run grouping, but the product list
  still should not wait on deep run-timeline classification for every source.

## Acceptance Checks

- Two sibling browser-backed connections with different profile-keyed browser runs project different `last_run.run_id` values.
- A `surface_failed` browser run projects a non-null failure reason from browser-surface evidence.
- SQLite connection-summary tests remain isolated.
- Reference and console TypeScript pass.
- Live proof after deploy: repeated `/_ref/connectors` calls and `/dashboard/runs` browser timings improve, and Amazon/Chase rows no longer inherit sibling draft-shell run state.
- Browser harness smoke writes a JSON result with no true failed requests or console errors for a known-fast route.
- Live proof after the shallow-list tranche: first authenticated `/_ref/connectors`
  read improves materially from the ~3.8-5.1s live baseline, while a scoped
  connector detail/diagnostics read still carries deep run evidence.
