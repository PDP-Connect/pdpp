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

## 3. All-stream payload-free drift scanner

- [x] 3.1 Add `scripts/repair/record-current-projection-scan-all.mjs`: read-only,
  payload-free, all-stream Postgres scanner with the seven-class taxonomy and a
  remediation disposition per class. Exit 1 on any drift, 0 when clean.
- [x] 3.2 Add `test/record-current-projection-scan-all.test.js` pinning every one
  of the seven classes (plus consistent controls) via the pure classifier.
- [x] 3.3 Verify the scanner SQL and the prune fix end-to-end against a real
  Postgres (ephemeral DB): all seven classes classify correctly and the
  Postgres prune preserves the cold anchor while bounding the hot tail.

## 4. OpenSpec

- [x] 4.1 Add the anchor-preservation scenarios to the durable ingest and direct
  delete atomicity requirements, and an ADDED requirement for the read-only
  all-stream drift scanner.
- [ ] 4.2 `openspec validate preserve-current-history-anchors-during-pruning
  --strict` passes. (run in validation)

## 5. Owner-gated follow-ups (deferred, not in this change)

- [ ] 5.1 Owner runs the all-stream scanner against live Postgres to enumerate
  the current residue by class.
- [ ] 5.2 Owner repairs `missing_current` / `stale_current` residue with the
  existing per-scope repair tool (`--apply`).
- [ ] 5.3 Owner decides, per `unverified_*` / `current_*_history` row, between
  source resync and an explicit owner-gated synthetic maintenance anchor. No
  synthetic anchor is written by code without an explicit, owner-reviewed
  design and apply path.
