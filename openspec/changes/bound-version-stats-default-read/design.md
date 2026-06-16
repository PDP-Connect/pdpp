# Design: bounded default version-stats reads

## Root Cause

The earlier projection-backed version-stats design optimized the clean case but
kept two exactness fallbacks: dirty stream rows were always verified against
ground truth, and a dirty global projection forced the full `record_changes`
scan. That preserved advisory exactness, but it left the owner dashboard exposed
to the worst case on any rebuilding or dirty projection.

Live measurement shows that worst case is the entire Sources page delay:
`/_ref/connections` is tens of milliseconds, while
`/_ref/records/version-stats?limit=8` spends seconds grouping the whole
`record_changes` table.

## Decision

Default unfiltered version-stats is a bounded advisory read. It SHALL use the
retained-size projection rows it has, SHALL run bounded ground-truth refinement
only for clean rows that could classify above normal, and SHALL mark dirty or
missing projection state in the response instead of forcing a synchronous
whole-history scan.

Exactness is still available through explicit scope. A caller that names a
`connector_instance_id` and/or `stream` is asking for a diagnostic on a bounded
scope, so the route may use ground truth for that request.

The Sources page should not fetch version-stats during first render. Churn
advisories can return later through a non-load-bearing diagnostic surface, but
the source list must not depend on them.

## Alternatives

- **Parallelize the version-stats fetch with source summaries.** Rejected. It
  reduces visible latency only when the query is not the slowest read, and it
  still drives a large aggregate during owner navigation.
- **Add another covering index.** Rejected by live proof. The `COUNT(DISTINCT
  record_key)` all-row aggregate still sorts/groups the corpus and does not
  become a cheap `limit` query.
- **Refresh/rebuild the projection synchronously on read.** Rejected. It moves
  maintenance work onto the page request and can still block for whole-corpus
  work.
- **Remove version-stats.** Rejected. It remains useful as an owner diagnostic;
  it just cannot be a load-bearing dashboard dependency.

## Acceptance Checks

- `/dashboard/records` has no import or call path to `listRecordVersionStats`.
- An unfiltered `buildRecordVersionStatsEnvelope` never calls
  `listRecordVersionGroundTruthStreams`, including when the global projection is
  dirty.
- Dirty projection rows are surfaced as projection-backed advisory rows with
  `projection_dirty: true`, not force-verified on the unfiltered route.
- Explicit scoped requests still use ground truth and preserve the existing
  exact diagnostic behavior.
