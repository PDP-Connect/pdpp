# Tasks

## 1. Anchor-preserving prune (forward fix)

- [x] 1.1 SQLite: add an anchor `NOT EXISTS` guard to
  `queries/records/ingest/prune-record-changes.sql` so the prune DELETE never
  removes a `record_changes` row whose `(cin, stream, record_key, version)`
  equals a current `records` row's `(…, version)`.
- [x] 1.2 SQLite: apply the identical guard (`PRUNE_ANCHOR_PRESERVE_CLAUSE`) to
  `getPrunedRecordChangeCount` and `getPrunedRecordChangeJsonBytes` in
  `records.js` so the retained-size delta accounting matches the rows the
  DELETE actually removes. Both ingest and direct-delete prune call sites use
  these helpers, so both paths are covered.
- [x] 1.3 Postgres: apply the identical `NOT EXISTS` guard to the prune
  count/bytes SELECT and the prune DELETE in `postgres-records.js`.

## 2. Multi-key recurrence guard tests

- [x] 2.1 Add a test: one cold unchanged current row + one hot key that advances
  the stream past the limit; assert no drift and that bounded pruning is
  preserved (cold keeps 1 anchor, hot bounded at the limit).
- [x] 2.2 Add a test: a cold key DELETED after the stream advances keeps its
  deleted tombstone anchor (no resurrection, no orphan).
- [x] 2.3 Add a test: many cold keys + one hot key; every cold anchor survives
  and total history stays bounded.
- [x] 2.4 Confirm the new tests FAIL against pure stream-cutoff pruning and PASS
  with anchor preservation (verified by reverting the SQL).

## 3. Self-heal unanchored current rows on unchanged reingest

- [x] 3a.1 SQLite: add `queries/records/ingest/get-record-change-anchor.sql`
  (anchor-presence probe) and add `version` to
  `get-current-record-state.sql`; register
  `recordsIngestGetRecordChangeAnchor` in `queries/index.ts`.
- [x] 3a.2 SQLite `ingestRecord`: gate the unchanged-upsert no-op on anchor
  presence; on a missing anchor, fall through to the changed-write path to
  re-anchor at a new head-of-window version and surface `self_healed: true`.
- [x] 3a.3 Postgres `postgresIngestRecord`: add `version` to the `FOR UPDATE`
  current-state read, gate the `is_identical` no-op on a symmetric anchor probe,
  and re-anchor / surface `self_healed` identically.
- [x] 3a.4 Verify count/current-bytes deltas are zero and only the appended
  history row (plus any pruned tail) flows into retained-size/dataset-summary.
- [x] 3a.5 Add SQLite tests: self-heal recreates the anchor at a new version;
  an anchored identical reingest stays a plain no-op (anti-churn preserved);
  a full source resync converges a multi-key stranded projection to zero drift.
  The orphan is seeded by a direct anchor delete (raw SQL), NOT via prune churn,
  because anchor-preserving prune no longer strands a live-key anchor.
- [x] 3a.6 Add an env-gated Postgres test
  (`postgres-records-ingest-noop.test.js`): unanchored unchanged reingest
  self-heals at a new version, then stays a no-op once anchored. Proven against
  a throwaway Postgres database (never `pdpp_proof`, never live).

## 4. All-stream payload-free drift scanner

- [x] 4.1 Add `scripts/repair/record-current-projection-scan-all.mjs`: read-only,
  payload-free, all-stream Postgres scanner with the seven-class taxonomy and a
  remediation disposition per class. Exit 1 on any drift, 0 when clean.
- [x] 4.2 Add `test/record-current-projection-scan-all.test.js` pinning every one
  of the seven classes (plus consistent controls) via the pure classifier.
- [x] 4.3 Verify the scanner SQL and the prune fix end-to-end against a real
  Postgres (ephemeral DB): all seven classes classify correctly and the
  Postgres prune preserves the cold anchor while bounding the hot tail.

## 5. OpenSpec

- [x] 5.1 Add the anchor-preservation scenarios to the durable ingest and direct
  delete atomicity requirements, and an ADDED requirement for the read-only
  all-stream drift scanner.
- [x] 5.2 Refine the durable-ingest no-op scenario so an identical reingest of an
  *anchored* current row stays a true no-op, and add a self-heal requirement +
  scenario for the *unanchored* case (re-anchor at a new version, advance
  `version_counter` by one, zero count/payload deltas, drift cleared).
- [ ] 5.3 `openspec validate preserve-current-history-anchors-during-pruning
  --strict` passes. (run in validation)

## 6. Owner-gated follow-ups (deferred, not in this change)

- [ ] 6.1 Owner runs the all-stream scanner against live Postgres to enumerate
  the current residue by class.
- [ ] 6.2 Owner repairs `missing_current` / `stale_current` residue with the
  existing per-scope repair tool (`--apply`).
- [ ] 6.3 Owner decides, per `unverified_*` / `current_*_history` row, between
  source resync and an explicit owner-gated synthetic maintenance anchor. No
  synthetic anchor is written by code without an explicit, owner-reviewed
  design and apply path.
- [ ] 6.4 Owner decides the `changes_since` re-emit contract for self-heal: a
  heal appends one history row, so a consumer whose prior history for that key
  was already pruned sees the record re-emit once (faithful — the history was
  pruned). If feed-invisibility is desired, that is a separate contract change.
