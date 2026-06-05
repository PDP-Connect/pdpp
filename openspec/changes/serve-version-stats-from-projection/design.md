# Design: serve version-stats from the maintained projection

## Problem shape

`buildRecordVersionStatsEnvelope` produces a bounded top-churn diagnostic. Today
it always calls `listRecordVersionGroundTruthStreams`, which, unfiltered, runs:

```sql
WITH history AS (
  SELECT connector_instance_id, connector_id, stream,
         COUNT(*)                   AS record_history_count,
         COUNT(DISTINCT record_key) AS record_key_count,
         MAX(emitted_at)            AS last_history_at
    FROM record_changes            -- no WHERE: every connector, full heap scan
   GROUP BY connector_instance_id, connector_id, stream
), current_records AS ( ... FROM records WHERE deleted = FALSE ... )
SELECT ... FROM history LEFT JOIN current_records ...
```

On the live corpus single streams have 84 k–223 k history rows. Two operations
force a full sequential heap scan: `COUNT(DISTINCT record_key)` (sort/hash per
group) and `MAX(emitted_at)` (`emitted_at` is not in the only relevant index
`idx_(pg_)record_changes_record (connector_instance_id, stream, record_key,
version)`, so Postgres visits the heap per row). The JS `rows.slice(0, limit)`
runs *after* the scan, so `limit` never bounds the work.

## Why the scan can't just be skipped (the trap)

Commit `673f8bdf` made this scan authoritative because the incremental
`retained_size_*` projection's `record_history_count` had been observed stale
(test `prefers ground-truth counts over stale projection counts`: projection
468 532 vs ground truth 3 155 820). A "skip the scan when the projection looks
fresh" shortcut would re-introduce exactly that corruption. Any fix must keep the
diagnostic facts ground-truth-correct.

## The invariant the fix relies on

The projection's `record_history_count` and `record_count` are **exact whenever
`dirty = 0`**:

- The per-write delta in `ingestRecord` is `record_history_count += (1 -
  prunedRows)` and `record_count += sharedRecordCountDelta`, applied in the same
  durable mutation. This is exact for append-with-prune.
- Every code path that mutates `record_changes` / `records` in a way the delta
  cannot locally express **sets `dirty = 1`** on the affected stream/connection/
  global rows: bulk delete (`markRetainedSizeStreamDirty` /
  `markRetainedSizeConnectionDirty`), the compaction tool
  (`compact-record-history.mjs`), the point-in-time backfill prune
  (`backfill-point-in-time-stats.mjs`), and the projection repair tool. `rebuild`
  and `reconcile` recompute from `record_changes` and clear `dirty`.

So a `dirty = 0` row's counts equal the ground-truth `COUNT(*)` / current
`COUNT(*)`. The 468 k/3.15 M case the test models is a `dirty` row. **`dirty` is
the staleness signal.** This is the load-bearing fact; tasks pin it with a
regression test.

## Why `record_key_count` and `last_history_at` are NOT delta-maintained

`record_key_count = COUNT(DISTINCT record_key)` and `last_history_at =
MAX(emitted_at)` are not locally computable at write time:

- A normal per-ingest prune by stream-global version cutoff
  (`recordsIngestPruneRecordChanges`) can remove the only retained
  `record_changes` row for a **cold key** while a hot key churns the stream
  forward — changing the distinct-key count — without the write knowing it, and
  **without setting `dirty`**.
- The same prune can remove the row holding the current `MAX(emitted_at)`.

A delta-maintained `last_history_at` could therefore **under-report**. That is
disqualifying: the just-landed `version_disposition` derivation gates
`reviewed_historical_residue` on `last_history_at <= reviewedAt`. An
under-reported `last_history_at` on a reviewed-residue stream that has actually
grown would keep it `reviewed_historical_residue` instead of re-alarming to
`lossless_compaction_candidate` — silently weakening a semantic that just shipped
on `main`. `record_key_count` staleness would corrupt the `versions_per_record`
denominator and thus the risk class. These two facts must come from ground truth
wherever they drive classification.

## Chosen approach: candidate-narrowing

Compute the expensive ground-truth aggregate only for streams that can matter:

1. Read the projection rows (the injected `listStreams`, already fast and
   indexed) for the unfiltered request.
2. Partition into:
   - **clean candidates**: `dirty = 0` rows whose exact projection facts could
     place them at or above the `watch` threshold (see predicate below);
   - **dirty rows**: any `dirty != 0` row (its projection facts may be stale, so
     it must be verified against ground truth regardless of apparent risk);
   - **clean non-candidates**: `dirty = 0` rows below the threshold — classified
     from projection facts alone, never scanned.
3. Run the bounded ground-truth aggregate
   (`listRecordVersionGroundTruthForKeys`) for `candidates ∪ dirty` only — a
   `WHERE (connector_instance_id, stream) IN (…)` query, which the live
   measurement shows is ~90× faster than the unfiltered scan.
4. Merge exactly as today: ground-truth facts override projection facts for the
   scanned keys; clean non-candidates keep projection facts with
   `record_key_count: null` / `last_history_at: null`.

### Candidate predicate (conservative, no false negatives)

`classifyRecordVersionChurn` raises a row above `normal` when any of:
`current == 0 && history > 0`; `history >= 10_000 && vpr >= 10`; `vpr >= 50`;
`vpr >= 5`. With `vpr = history / max(1, keyCount ?? current)`.

For a clean row the projection gives exact `history` and `current` but not
`keyCount`. To guarantee we never *miss* a candidate, the predicate uses the
denominator that **maximizes** `vpr`. Because every current (non-deleted) record
key has at least one retained `record_changes` row, the distinct history-key
count is `>= current` in the normal case, so `history / current >= history /
keyCount` — i.e. `history / current` is an **upper bound** on true `vpr`. Using
`current` (not `keyCount`) as the denominator therefore never under-estimates
`vpr`, so:

```
candidate ⇔  dirty != 0
          OR (current == 0 && history > 0)
          OR history >= 10_000
          OR history >= 5 * max(1, current)      // vpr_upper_bound >= 5
```

This is over-inclusive (a stream with `keyCount > current`, or a stream just
under 10 k history, may be scanned though it turns out `normal`) — harmless, an
extra bounded scan. It is never under-inclusive: any stream ground truth would
classify `watch`/`high` satisfies the predicate. The `history >= 10_000` arm is
kept independent of the ratio arm so the `high_history_count` reason is never
missed even when `current` is large.

### Edge cases

- **Projection-missing ground-truth streams**: today the full scan surfaces
  streams that exist in `record_changes` but not in the projection. The bounded
  path keys off projection rows, so to preserve this the route still includes any
  ground-truth rows the bounded helper returns that the projection lacked
  (`projection_missing: true`), and — because a never-projected stream cannot be
  a projection-derived candidate — the **dirty-global fallback** covers the cold-
  start case where the projection is empty/rebuilding. After the first
  `rebuildRetainedSize`, every stream with history has a projection row, so
  steady state is fully covered by the candidate path.
- **`dirty` global row**: if `retained_size_global.dirty != 0` (never built or
  rebuild pending) the route runs the existing full ground-truth scan. A cold or
  rebuilding instance pays the old cost once rather than risking a thinned
  diagnostic — correctness over speed for the rare cold path.
- **Explicit filters**: an exact `connector_instance_id` / `stream` request keeps
  using `listRecordVersionGroundTruthStreams` with its `WHERE` — already fast and
  already correct; the candidate path is only for the unfiltered hot read.

## Alternatives considered

- **Add `record_key_count` / `last_history_at` columns maintained by write-delta.**
  Rejected: not locally computable (COUNT DISTINCT, MAX-with-prune), would
  under-report and weaken `version_disposition`. This is the trap restated.
- **Add those columns, recomputed only on rebuild/reconcile, marking dirty on
  every write.** Rejected: marking the row dirty on every ingest defeats the fast
  path (every active stream would be permanently dirty during a run).
- **Covering index `record_changes (connector_instance_id, stream, emitted_at)`
  alone, keep the unbounded scan.** Lower ceiling: still touches every group and
  still does `COUNT(DISTINCT record_key)` (the index doesn't cover the distinct
  count). Kept as an *additive complement* to speed the bounded path's
  `MAX(emitted_at)`, not as the primary fix.
- **Short-TTL server cache on the envelope (console-side bandaid).** Explicitly
  out of scope per the lane constraints; masks the cost instead of removing it
  and does not reduce DB load under an active run.

## Scope boundaries

In scope: the unfiltered hot-path sourcing in `record-version-stats.js`, the
bounded ground-truth helper, the optional covering index, and correctness/
fallback/equivalence tests. Out of scope: changing `version_disposition`,
changing the numeric thresholds, the console poller cadence, any UI cache, and
any change to the projection's write-time delta math.

## Acceptance checks

- `node --test reference-implementation/test/record-version-stats.test.js` green,
  including: projection-exact-when-clean invariant; bounded-path rows
  byte-identical to full-scan rows on a seeded multi-stream dataset; a borderline
  (`history` just over `5*current`, `< 10 k`) stream is scanned and classified
  identically; a `dirty` low-risk row is scanned; `dirty`-global forces the full
  scan; explicit-filter path unchanged.
- `openspec validate serve-version-stats-from-projection --strict` and
  `openspec validate --all --strict`.
- Reasoned/measured before-after query shape: unfiltered request issues one
  bounded `WHERE … IN (candidate keys)` aggregate instead of one unbounded
  `GROUP BY` over all `record_changes`. The live ~90× filtered-vs-unfiltered
  delta is the expected magnitude; the SQLite test corpus is too small to time,
  so the live `EXPLAIN ANALYZE` before/after is an owner residual on the
  representative Postgres dataset.

## Residual risks (owner-only live verification)

- The live Postgres `EXPLAIN ANALYZE` before/after on the representative corpus,
  and the live `/dashboard/records` wall-clock improvement, can only be measured
  against the production instance this lane must not mutate. The query-shape
  change and the per-stream cost reduction are proven by code + bounded-helper
  equivalence tests; the live magnitude is the owner's smoke check.
