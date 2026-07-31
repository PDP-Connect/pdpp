## 1. Operation clock and contract

- [x] Capture one `deps.now()` value on first-page capture and use it for
      BOTH `snapshotAt` and `nowCeiling` — a single captured instant, not two
      independently-timed reads.
- [x] Narrow `fetchSnapshotAnchor`'s dependency contract to
      `{ snapshotSeq } | null` — no display timestamp.
- [x] Empty corpus reports the actual captured instant for `snapshotAt`, not
      an epoch/placeholder sentinel.
- [x] Resumed/rewound pages retain the original first page's `snapshotAt`
      (already true via the existing cursor-decode path — verified
      unchanged, not re-implemented).

## 2. Substrate optimization

- [x] `postgresFetchSnapshotAnchor` returns only `{ snapshotSeq }`, dropping
      the `MAX(emitted_at)` aggregate — a single-column `MAX(id)` lets
      Postgres use its built-in MIN/MAX index optimization instead of a full
      table scan.
- [x] `sqliteFetchSnapshotAnchor` mirrors the same narrowed contract.

## 3. Docs

- [x] Update `CompositeCursorPayload`'s version-history comment: document
      the v4 `nowCeiling` addition (previously undocumented) and the
      `snapshotAt` meaning fix (no wire-format or version-number change).
- [x] Update `fetchSnapshotAnchor`'s JSDoc to state it returns only the
      membership anchor.

## 4. Spec

- [x] `openspec/specs/reference-implementation-architecture/spec.md`:
      `snapshot_at` scenario rewritten to the wall-clock-capture contract;
      3 new/tightened scenarios (future/backfilled-immune, resume/rewind
      retention, empty-corpus actual-capture-time).

## 5. Regressions

- [x] A future-dated `emitted_at` record never changes `snapshot_at`
      (SQLite + Postgres).
- [x] A backfilled record with an old `emitted_at`, ingested AFTER the
      snapshot, never changes `snapshot_at` (SQLite + Postgres).
- [x] Pagination membership stays `snapshotSeq`-based — unaffected by this
      change (existing B2/B3 regression suite re-verified, not re-derived).
- [x] Resumed and rewound pages retain the original page's `snapshot_at`,
      not a freshly re-captured wall-clock value (SQLite + Postgres).
- [x] `snapshot_at` equals `nowCeiling` on a first-page response — the two
      fields are the SAME captured instant.
- [x] Empty corpus reports actual capture time, not the epoch sentinel.

## 6. Verification

- [x] `tsc --noEmit` clean.
- [x] `biome check` clean on all touched files.
- [x] `openspec validate clarify-explore-snapshot-at-capture-time --strict`
      passes.
- [x] `openspec validate --all --strict` passes.
- [x] Full focused Explore test matrix re-run clean (0 regressions).
- [x] Live `EXPLAIN ANALYZE` against the production database confirms the
      optimized `fetchSnapshotAnchor` query cost.
