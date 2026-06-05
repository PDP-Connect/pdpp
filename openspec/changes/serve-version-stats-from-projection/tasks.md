# Tasks: serve version-stats from the maintained projection

## 1. Bounded ground-truth helper

- [x] 1.1 Add `listRecordVersionGroundTruthForKeys({ keys })` to
  `reference-implementation/server/record-version-stats.js` (SQLite + Postgres),
  running the identical `history`/`current_records` aggregate bounded to a set of
  `(connector_instance_id, stream)` keys. Postgres uses a `VALUES` join; SQLite
  uses a temp `_vstats_wanted_keys` table (avoids the variable-limit on large
  candidate sets). Returns rows shaped identically to
  `listRecordVersionGroundTruthStreams` (`shapeGroundTruthRow`). Empty key set →
  no query, empty array.
- [x] 1.2 Keep `listRecordVersionGroundTruthStreams` for explicit filters and the
  dirty-global fallback.

## 2. Candidate-narrowing in the envelope

- [x] 2.1 In `buildRecordVersionStatsEnvelope`, detect the unfiltered hot path
  (no `connectorInstanceId`, no `stream`). For it, read the projection rows
  (`listStreams`) and the global projection (`getProjection`, read once and
  reused for the envelope's `projection` block) and derive the conservative
  candidate predicate (`isVersionChurnCandidate`): `dirty OR (current == 0 &&
  history > 0) OR history >= 10_000 OR history >= 5 * max(1, current)`.
- [x] 2.2 Call `listRecordVersionGroundTruthForKeys` for `candidates ∪ dirty`
  only; merge exactly as today (ground truth overrides projection for scanned
  keys; non-candidates keep projection facts with null `record_key_count` /
  `last_history_at`).
- [x] 2.3 When the global projection is dirty, fall back to
  `listRecordVersionGroundTruthStreams` (full scan) for the unfiltered request.
- [x] 2.4 Filtered requests (`connectorInstanceId` or `stream` present) keep the
  existing full-helper path unchanged.
- [x] 2.5 Preserve projection-missing surfacing: the bounded helper still returns
  ground-truth keys the projection lacked (they appear with
  `projection_missing: true`); the projection-missing-for-a-cold-projection case
  is covered by the dirty-global fallback (see design.md edge cases).

## 3. Optional covering index (additive, output-preserving)

- [x] 3.1 Add `idx_record_changes_emitted` /
  `idx_pg_record_changes_emitted` on `record_changes (connector_instance_id,
  stream, emitted_at)` in `db.js` (canonical schema + the index-ensure block) and
  the Postgres `ensurePostgresRecordsBlobSearchInstanceIndexes` path. `IF NOT
  EXISTS`, no behavior change.

## 4. Tests

- [x] 4.1 `record-version-stats.test.js`: projection-exact-when-clean invariant —
  ingest 30 versions of one key + 12 flat keys, rebuild, assert
  `retained_size_stream.record_history_count == record_changes COUNT(*)` and
  `dirty == 0` (`projection record_history_count is exact and clean...`).
- [x] 4.2 Candidate-narrowing equivalence — `unfiltered envelope candidate path
  equals the full-scan envelope`: the hot row's `record_history_count`,
  `record_key_count`, `last_history_at`, `versions_per_record`, `risk_level`,
  `risk_reasons`, `version_disposition`, `projection_authority` are identical
  across the candidate path and the dirty-global full-scan path; the cold/normal
  stream is classified from projection facts only (null distinct/timestamp).
- [x] 4.3 Conservative candidate — `candidate predicate selects hot churn and
  rejects flat streams` pins the predicate (hot=candidate, flat=not, dirty wins,
  history-arm independent of ratio, current==0 arm).
- [x] 4.4 Dirty row always scanned — `a dirty projection row is verified against
  ground truth even when it looks normal`: a hot row whose projection is corrupted
  to look normal + dirty still recovers `record_history_count == 30` via ground
  truth.
- [x] 4.5 Dirty-global fallback — `dirty global projection forces the full scan
  for the unfiltered request` asserts the bounded for-keys helper is NOT called.
- [x] 4.6 Explicit-filter path unchanged + existing envelope/disposition tests
  stay green (the disposition ACs now inject the for-keys seam).

## 5. Validation

- [x] 5.1 `node --test reference-implementation/test/record-version-stats.test.js`
  → 22 pass / 0 fail (run in-lane via symlinked `node_modules`; symlinks removed
  before commit).
- [x] 5.2 `retained-size-read-model`, `version-disposition`,
  `records-version-allocation-atomic`, `records-delete-atomicity`,
  `record-read-conformance`, `compact-record-history`,
  `backfill-point-in-time-stats` suites → all pass (baseline PG-only skips only).
- [x] 5.3 `openspec validate serve-version-stats-from-projection --strict` and
  `openspec validate --all --strict` → 41/41.
- [x] 5.4 Reference `tsc --noEmit` → 0 errors in touched files (and 0 overall once
  the `packages/polyfill-connectors` node_modules is symlinked; the 6 playwright
  TS2307 are the missing-symlink artifact, not this change).

## 6. Owner-only residual (live)

- [ ] 6.1 Live Postgres `EXPLAIN ANALYZE` before/after on the representative
  corpus and a `/dashboard/records` wall-clock before/after. Owner-only; record
  as a residual risk and archive when satisfied (per AGENTS.md residual-risk
  rule). The query-shape change and equivalence are proven by code + tests in
  this lane.
