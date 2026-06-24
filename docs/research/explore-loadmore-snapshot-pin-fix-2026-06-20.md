# Explore Load-more: page-1 must be snapshot-pinned by snapshotSeq, not emitted_at

Status: DESIGN (Claude RI, 2026-06-20). Corrects the b34e1e01 fix after Codex HOLD.

## What was wrong (Codex reproduced it)
The accumulating-trail fix (b34e1e01) re-fetches page 1 with `cursor=null` (a FRESH
snapshot) and pins it with `emitted_at <= snapshot_at`. But `emitted_at` (display
`MAX(emitted_at)`) is NOT the membership anchor — the endpoint pins membership by
`snapshotSeq` (`MAX(id)`, ingest sequence). An after-snapshot BACKFILL (ingested after the
original snapshot, but with `emitted_at <= original snapshot_at` and recent enough to be in
page 1's top-N-by-emitted_at window) PASSES the timestamp filter, and because page 1 has a
fixed limit it DISPLACES an original page-1 tail row. Page 2 (correctly snapshotSeq-pinned)
does not contain that displaced row, so the accumulated view HIDES a record that was
visible before Load more — the exact class we were fixing. Confirmed by Codex against
assembleExplorerData (after-snapshot-backfill appears, original p1-31 disappears).

Second issue (MEDIUM): feed-defining navigation resets `cursors` but can FORWARD a stale
`anchor` (buildNavigateHref only drops anchor on clearCursor). Connection/stream/range
changes then carry the wrong snapshot timestamp into the next Load more (and into
newSinceAnchor). Feed-defining changes must drop BOTH cursors AND anchor.

## The correct fix: re-fetch page 1 against the ORIGINAL snapshotSeq (server-side rewind)
Display timestamp must NOT be a membership proxy. Page 1 must be re-rendered against the
SAME snapshot as pages 2..N.

Key insight: the page-1->page-2 cursor `c1` (first trail element) ALREADY encodes the
original `snapshotSeq` plus the partition list. A "rewind to page 1" fetch = the SAME
`snapshotSeq` + the SAME partition set but ALL positions reset to null (start). Feeding that
to the merge re-fetches page 1 pinned to the original snapshot (endpoint filters `id <=
snapshotSeq`), so an after-snapshot backfill is correctly EXCLUDED (its `id > snapshotSeq`).

Because the cursor is an opaque server-side handle, the frontend cannot construct the rewind
— it must be a server capability. Minimal endpoint change:
- Add an input `rewindToFirstPage?: boolean` (or a distinct param) to executeExploreTimeline /
  GET /_ref/explore/records. When set WITH a `cursor`, the operation decodes the cursor, keeps
  its `snapshotSeq` + `snapshotAt` + partition LIST, but ZEROES every partition position
  (lastEmittedAt/lastRecordKey = null), then runs the normal merge. Result: page 1 of the
  ORIGINAL snapshot. (No new snapshot is captured.)
- The accumulator then fetches: page 1 = rewind(c1); page 2 = c1; page 3 = c2; ... and
  concatenates. Every page shares the original snapshotSeq. No emitted_at membership proxy.
- When the trail is EMPTY (true first load), behave exactly as today (cursor=null, capture
  fresh snapshot) — there is no prior snapshot to pin to.

Drop the `emitted_at <= anchor` page-1 filter entirely (it was the broken proxy).

## Anchor leak fix
buildNavigateHref / NavigateOpts must drop BOTH `cursors` AND `anchor` on every
feed-defining change (query, search_sort, connection, stream, since, until). Preserve
`anchor` (and the trail) ONLY for: Load more within the same recent-lens feed, and pure
peek/selection moves. The "N new" pill already drops both — keep that.

## Acceptance / reproduce-the-bug
- The existing Codex repro (after-snapshot backfill with emitted_at inside page 1) MUST be
  excluded from the accumulated view, AND the original page-1 tail row MUST remain. Add this
  as a regression test: it must FAIL on b34e1e01 (emitted_at proxy) and PASS after (snapshotSeq
  rewind). Use a fake dataSource whose rewind(c1) returns the original page 1 (no backfill) and
  whose cursor=null would return the backfill — assert the accumulator uses the rewind.
- A feed-defining navigation drops anchor (assert buildNavigateHref output).
- All prior accumulate + conformance tests stay green; the endpoint rewind has its own
  conformance case (rewind(cursor) == original page 1, snapshotSeq preserved, after-snapshot
  rows excluded).
