# Explore pagination HTTP 431: composite cursor too large for the URL

Status: DIAGNOSED (Claude RI, 2026-06-20). Found by Tim using the LIVE deployed Explore
feature. First page works; clicking "Load more" / paging produces **HTTP 431 (Request
Header Fields Too Large)** — actually the URL/query string is too large for the proxy.

## Root cause (verified)
The merged-timeline composite cursor (`reference-implementation/operations/rs-explore-timeline/index.ts`,
`encodeCompositeCursor`) is a base64url JSON blob carried in the `?cursor=` query param of
`/dashboard/explore`. It encodes, for snapshot stability, **every (connector_id, stream)
partition that existed at snapshot time** — each as `{connectorId, stream, lastEmittedAt,
lastRecordKey}`. Tim's account has ~150 partitions, so:

- Current cursor: **~24 KB** base64 (measured/modelled). Proxy URL+header limit ~8 KB → 431.
- The vast majority of partition entries are `lastEmittedAt: null, lastRecordKey: null`
  (partitions not yet paged into) — carried because of the snapshot-partition-set rule below.

## Why the partition list can't just be dropped (the correctness constraint)
`executeExploreTimeline` Phase 2 (index.ts ~494-503): when resuming from a cursor, the merge
considers ONLY partitions present in the cursor (`initialPositions.has(key)`). Partitions
NOT in the cursor are treated as "new since snapshot" and EXCLUDED from this page. This is
the snapshot-stability mechanism (a partition that appeared after page 1 must not leak into
pagination). So omitting null-position partitions would make their records unreachable past
page 1 — re-introducing the exact "full visibility / no silent cap" violation Codex's B1
finding fixed. The cursor genuinely must remember the snapshot-time partition SET.

## Fix options (ranked)
1. **Collapse the cursor to O(1) — verify the partition list is redundant with snapshotSeq.**
   The page fetch already filters `id <= snapshotSeq` (the monotonic ingest anchor). A
   partition that existed at snapshot time HAS records with `id <= snapshotSeq`; a partition
   that appeared after has only `id > snapshotSeq` records — which the fetch already excludes.
   IF enumerating `listPartitions()` on each page and filtering each bucket's rows by
   `id <= snapshotSeq` gives the SAME membership as the explicit partition list, the cursor
   needs only: `snapshotSeq`, `snapshotAt`, and the FEW partitions with real (non-null)
   positions. That is O(1)-ish (bounded by page size, not partition count). MUST PROVE: this
   preserves (a) no new-since-snapshot partition leaks into pagination, (b) every snapshot-time
   record stays reachable, (c) no dup/skip. Risk: a snapshot-time partition whose newest record
   is still > snapshotSeq edge cases; a partition that had only post-snapshot inserts.
   This is the most elegant fix and fits the existing GET-cursor model.

2. **Server-side cursor storage.** Store the blob keyed by a short opaque id (DB/cache + TTL);
   the URL carries only the id. O(1) URL regardless of partition count, definitely correct,
   matches Stripe/Plaid opaque-cursor practice. Bigger change: storage, TTL/eviction, the
   frontend round-trips an id, and `/_ref/explore/records` must accept+resolve it. Best
   robustness; more surface.

3. **Compact encoding (REJECTED).** Short keys + omit null fields → ~11.5 KB at 150 partitions
   (53% smaller) but STILL over 8 KB and STILL O(N) — breaks again at ~300 partitions. Band-aid.

## Recommendation
Investigate #1 first (could be a small, elegant, correct fix). If the redundancy doesn't hold
under the edge cases, do #2 (server-side storage). Do NOT ship #3. Either fix needs a
reproduce-the-bug test (a many-partition cursor that exceeds a URL-length budget pre-fix,
under the budget post-fix) plus the snapshot-stability conformance the existing
`rs-explore-timeline-conformance.test.js` already exercises, extended to the many-partition case.

## Severity / scope
First-page Explore WORKS (verified: 307→login). Only pagination ("Load more" and any cursor
URL) 431s. For a "full visibility, no dead-ends" feature this is still serious — older records
are unreachable past page 1 at Tim's scale. Live = 744dda56. Not yet fixed.
