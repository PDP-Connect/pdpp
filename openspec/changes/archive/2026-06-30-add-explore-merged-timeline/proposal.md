# Proposal: add-explore-merged-timeline

## Why

The Explore canvas needs a single durable server endpoint that can serve a
fully-paginated, time-ordered feed spanning ALL of the owner's sources. The
previous approach (per-stream fan-out capped at a fixed total, assembled in the
browser layer) has three compounding defects:

1. **Silent cap.** Per-stream per-connection fan-out with a hard FEED_TOTAL_CAP
   presents a bounded window as if it were complete. An owner with 1,183 Amazon
   orders sees 6 and has no path to the rest.
2. **No cursor stability.** Records ingested while the owner is paging shift
   earlier pages, producing duplicates and missing rows.
3. **No merged cursor.** Each per-stream next_cursor is discarded after the fan-
   out; there is no composite handle the console can use to load the next page of
   the merged feed.

The existing reference implementation partially addresses these defects in
`reference-implementation/operations/rs-explore-timeline/index.ts` and the
substrate wired at `reference-implementation/server/explore-timeline-substrate.ts`,
but the server-side endpoint at `GET /_ref/explore/records` (ref-admin.ts:415)
has no OpenSpec delta. Per repo rules (openspec/README.md), any durable
owner/operator endpoint with a new response contract requires an OpenSpec change.

## What Changes

- **New durable endpoint:** `GET /_ref/explore/records` — an owner-session-gated
  reference/operator route that returns a page of merged, time-ordered records
  across all of the owner's (connector_instance_id, stream) partitions, with a
  single composite cursor for stable keyset-pageable deep pagination. This is NOT
  a PDPP Core protocol route; it is a reference-surface route shaped for the
  console Explore canvas.
- **Response shape:** `{ object: "list", data: ExploreTimelineRecord[],
  has_more, next_cursor, snapshot_at, new_since_snapshot }`. Each record in
  `data` carries `connector_id` (connector TYPE), `connector_instance_id`
  (connection INSTANCE), `stream`, `record_key`, `emitted_at`, and `data`.
- **Composite cursor (v3):** a base64url-encoded blob encoding per-partition keyset
  positions (SEMANTIC time — `COALESCE(NULLIF(semantic_time, ''), emitted_at)` —
  plus record_key tiebreaker for each (connector_instance_id, stream) partition)
  plus a snapshot anchor on the MONOTONIC INGEST SEQUENCE (MAX(id), not
  MAX(emitted_at)). ORDERING is by semantic time (when the thing happened);
  MEMBERSHIP is by the ingest-sequence anchor — different keys. The ingest-sequence
  anchor correctly excludes backfilled records ingested after the snapshot with old
  authored timestamps. The keyset key changed from `emitted_at` to semantic time at
  cursor v3; stale v2 cursors are rejected as `invalid_cursor`.
- **Point-in-time stability:** records ingested after the snapshot are NOT
  included in paged results and do not shift prior pages; they are counted and
  surfaced in `new_since_snapshot` so the UI can offer an "N new" affordance.
- **No silent partition cap:** partition enumeration uses SELECT DISTINCT with NO
  LIMIT. Every (connector_instance_id, stream) pair the owner has data in is
  included, so every record is reachable via pagination.
- **Set-descriptor contract:** the endpoint returns a typed descriptor that
  constrains what the UI may claim. The merged timeline set is
  `complete_chronological` (everything, newest first, exhaustively reachable);
  the descriptor is a discriminated union the renderer switches on, not ad-hoc
  strings. The UI cannot claim completeness or ordering the descriptor does not
  carry.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: add `GET /_ref/explore/records` as a
  durable owner-session reference route with a k-way-merge response contract,
  composite keyset cursor, ingest-sequence snapshot anchor, and a set-descriptor
  field constraining what the console Explore canvas may claim about this set.

## Impact

- Affected code: `reference-implementation/server/routes/ref-admin.ts`
  (mountRefExploreRecords, already present), `reference-implementation/server/
  explore-timeline-substrate.ts` (backend wiring, already present),
  `reference-implementation/operations/rs-explore-timeline/index.ts` (the
  operation, already present). This change formalizes an existing implementation
  into the OpenSpec contract; no new code is introduced by this change alone.
- The endpoint is ONLY reachable over owner-session authentication. It MUST NOT
  be reachable via /mcp or with a grant-scoped token.
- No PDPP Core protocol change. `/v1/` and `/mcp` are unaffected.

## Out of Scope

- Day-grouping and burst-collapse rendering (console Explore canvas concern,
  tracked separately under the Explore canvas implementation lane).
- The search lens (relevance_bounded / keyword_pageable set-descriptors) is
  addressed in the Explore canvas lane, not this endpoint change.
- Lexical search cursor forwarding (separate Explore assembler lane).
- Adding the set-descriptor wire to the console canvas UI (a console-side
  implementation task; this change documents the contract the endpoint must carry).

## Residual Risks

- Owner-only live proof (pagination to the last record across multiple sources on
  a live PDPP instance) deferred per project convention; the operation is
  deterministically proven by the rs-explore-timeline test suite. Recorded here
  rather than holding the change active.
- `new_since_snapshot` is a best-effort count: for very large corpora with rapid
  ingest, the COUNT query may be expensive. A deferred / approximate count may be
  substituted if performance requires it; this does not change the cursor
  stability contract.
