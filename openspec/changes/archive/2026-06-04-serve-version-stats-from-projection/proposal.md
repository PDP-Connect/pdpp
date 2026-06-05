# Serve version-stats from the maintained projection

## Why

The owner-only `GET /_ref/records/version-stats` read is the entire cost of the
`/dashboard/records` list page. Live measurement (report
`tmp/workstreams/ri-records-stream-performance-v1-report.md`) shows it takes
**~5.8 s** and is **fixed-cost regardless of `limit`** (limit=1 and limit=500
both ~5.75 s), because `buildRecordVersionStatsEnvelope` unconditionally runs an
**unbounded full-table `record_changes` ground-truth scan** —
`COUNT(*)`, `COUNT(DISTINCT record_key)`, and `MAX(emitted_at)` grouped by
`(connector_instance_id, connector_id, stream)` with **no `WHERE` clause** — and
the `limit` is applied in JS *after* the scan. Adding any `WHERE` makes the same
query ~90× faster (`?connector_instance_id=` → 0.044 s).

The records page is `force-dynamic` and mounts a poller that calls
`router.refresh()` every 3 s during an active run / 30 s idle, so each soft
refresh re-runs the whole scan. Under an active run the 3 s cadence is shorter
than the 5.8 s call, so the scans overlap and the page drives a *perpetual* full
`record_changes` scan against the database. This is ongoing DB load, not just a
one-time page delay.

The scan is **load-bearing for diagnostic truth** and cannot simply be removed:
commit `673f8bdf` made the ground-truth scan authoritative precisely because the
incrementally-maintained `retained_size_*` projection's `record_history_count`
could be stale (a pinned test contrasts a stale projection 468 532 against a
ground-truth 3 155 820). So a naive "skip the scan when the projection looks
fresh" would silently corrupt the churn diagnostic.

The correct, narrow fix uses a fact the codebase already guarantees: the
retained-size projection's `record_history_count` and `record_count` are
**exact whenever the row's `dirty` flag is 0**. The per-write delta math
(`record_history_count += 1 - prunedRows`) is exact, and **every** out-of-band
mutator that could desynchronize a count — bulk delete, the compaction tool, the
point-in-time backfill prune, the projection repair tool — already sets
`dirty = 1` on the touched rows. The 468 k/3.15 M staleness the test models is a
`dirty` row. `dirty` is therefore the honest staleness signal.

The two facts the scan computes that the projection does **not** carry —
`record_key_count` (`COUNT(DISTINCT record_key)`) and `last_history_at`
(`MAX(emitted_at)`) — are **not** safely maintainable by write-delta: a normal
per-ingest prune can drop the only `record_changes` row for a cold key (changing
the distinct count) or the row holding the max timestamp, without setting
`dirty`. A delta-maintained `last_history_at` could therefore lag, and a lagging
`last_history_at` would **suppress a real re-alarm** in the just-landed
`version_disposition` timestamp guard (reviewed-residue → compaction-candidate).
So these two facts MUST be computed from ground truth wherever they drive
classification — but only for the small set of streams that can actually be
non-`normal`.

## What Changes

- Make the **unfiltered** hot path of `buildRecordVersionStatsEnvelope` serve
  from the maintained projection without an unbounded `record_changes` scan.
  The projection's exact (`dirty = 0`) `record_history_count` and `record_count`
  cheaply identify the **bounded candidate set** of streams that could classify
  `watch`/`high`. The expensive ground-truth aggregate
  (`COUNT(DISTINCT record_key)`, `MAX(emitted_at)`, exact `COUNT(*)`) runs **only**
  for that bounded candidate set, plus any `dirty` projection rows, plus any
  explicit `connector_instance_id` / `stream` filter. `normal`-risk streams that
  are not candidates are classified from projection facts alone and never trigger
  the per-stream scan.
- The candidate predicate is deliberately **conservative** (over-inclusive, never
  under-inclusive): a stream is a candidate when its projection facts could place
  it at or above the `watch` threshold under the denominator that *maximizes*
  versions-per-record, OR the row is `dirty`. Over-inclusion costs an extra
  bounded scan; under-inclusion is impossible by construction, so no non-normal
  row is ever missed or downgraded.
- Preserve every existing output guarantee: rows still carry exact
  `record_history_count`, `record_key_count`, `last_history_at`,
  `versions_per_record`, `risk_level`, `risk_reasons`, `version_disposition`, and
  `projection_authority` wherever ground truth drives them. A row classified from
  projection-only facts reports `record_key_count: null` and `last_history_at:
  null` (the existing null-tolerant contract) and `projection_authority:
  retained_size_projection`, exactly as a projection-backed row does today.
- Add an explicit fallback: when the projection global row is itself `dirty`
  (rebuild pending / never built), the route falls back to the existing full
  ground-truth scan so a cold or rebuilding instance is never served a thinned
  diagnostic.

No new HTTP route. No new connector-authored field. No threshold change. No
change to `version_disposition` semantics, the numeric `classifyRecordVersionChurn`
thresholds, or the churn-risk classification. No change to PDPP Core record reads,
Collection Profile messages, or public `/v1` contracts. The route stays owner-only
and reference-only.

## Capabilities

- Modified: reference-implementation-architecture

## Impact

- `reference-implementation/server/record-version-stats.js` —
  `buildRecordVersionStatsEnvelope` gains a projection-first path for the
  unfiltered read: it derives the bounded candidate set from the injected
  `listStreams` projection rows and calls a new bounded ground-truth helper for
  candidates + dirty rows only. The existing full-scan helper
  (`listRecordVersionGroundTruthStreams`) is retained and used for explicit
  filters and the dirty-global fallback. Merge/classify/sort/slice logic and the
  envelope shape are unchanged.
- `reference-implementation/server/record-version-stats.js` — new
  `listRecordVersionGroundTruthForKeys({ keys })` (SQLite + Postgres) that runs
  the identical aggregate bounded to a set of `(connector_instance_id, stream)`
  keys, so the diagnostic facts are identical to the full scan but the work is
  proportional to the candidate set, not the corpus.
- `reference-implementation/server/retained-size-read-model.js` /
  `reference-implementation/server/db.js` /
  `reference-implementation/server/postgres-storage.js` — OPTIONAL covering index
  on `record_changes (connector_instance_id, stream, emitted_at)` to let the
  bounded `MAX(emitted_at)` / `COUNT` go index-friendly. Additive, output-
  preserving; gated behind the same index-maintenance path as the existing
  `idx_(pg_)record_changes_record`.
- `reference-implementation/test/record-version-stats.test.js` — new tests:
  projection-exact-when-clean invariant, candidate-narrowing equivalence (the
  bounded path yields byte-identical rows to the full scan on a seeded dataset),
  conservative-candidate (a borderline stream is still scanned), dirty-row always
  scanned, dirty-global fallback to full scan, and explicit-filter path
  unchanged.
- `openspec/specs/reference-implementation-architecture/spec.md` — a new ADDED
  requirement (via this change) scoped to the projection-backed hot path and its
  staleness-honesty fallback. The existing "Record-version churn observability"
  requirement (and the active `add-version-disposition-for-retained-history`
  delta to it) is left untouched — this change governs *how the row facts are
  sourced for the hot path*, a distinct concern from *what a row contains*.
