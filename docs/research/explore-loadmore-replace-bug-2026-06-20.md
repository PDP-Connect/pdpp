# Explore "Load more" hides records above it (replace, not append)

Status: DIAGNOSED (Claude RI, 2026-06-20). Found by Tim using the live Explore feed:
"Load more shows more results but then some above are being hidden."

## Root cause (verified)
Explore "Load more" is a server-rendered REPLACE, not an accumulating append:
- `explore-canvas.tsx:1700`: `onLoadMore={(cursor) => navigate({ cursor })}` → `router.push`
  to a URL with a SINGLE `?cursor=<nextPage>` param.
- `explore/page.tsx:93`: the server component calls `assembleExplorerData(params)` with that
  one cursor.
- `explore-data-assembler.ts` `loadMergedTimelineFeed`: returns `entries = page.data` — ONLY
  the current page's records, never concatenated with prior pages.
Net: clicking "Load more" re-renders the page showing ONLY page 2 (the next, older slice);
page 1 (newer records) is replaced and disappears. The symptom is exactly "more results
appear but the ones above are hidden."

The endpoint/cursor is CORRECT — the conformance test proves pages are non-overlapping and
snapshot-stable. The bug is purely the UI accumulation model: a "Load more" affordance (which
implies append) sitting on top of single-page replace semantics.

NB: the per-stream record list (`records/[connector]/[stream]/page.tsx`) uses a `cursors=`
TRAIL but as an HONEST PAGER (Prev/Next, page N replaces page N-1). That replace is fine
there because it's labeled as paging. Explore's "Load more" is not — it promises accumulation.

## The SLVP-ideal fix: accumulate (true "Load more")
A full-visibility browse feed accumulates on "load more" (Glean, Slack, Linear). Two shapes:
- **(A) Server-side cursor TRAIL that concatenates (chosen).** The URL carries the trail of
  cursors (`cursors=c1,c2,...`, mirroring the per-stream pattern's param). The page reads the
  whole trail; `loadMergedTimelineFeed` fetches page-1 (no cursor) + each trail cursor and
  CONCATENATES the entries into one cumulative feed, returning the LAST page's next_cursor as
  the new Load-more cursor. Keeps the server-component model, no client-state refactor, reuses
  the established trail param. Cost: re-fetches prior pages each click (bounded; snapshot-stable
  so pages are identical across re-fetch; acceptable for a browse feed). "Load more" appends
  `next_cursor` to the trail.
- (B) Client-side accumulation (stateful client canvas). More idiomatic/efficient but a larger
  refactor; deferred — (A) is the consistent, lower-risk fit.

## Acceptance
- Load more appends: page 1 records STAY visible, page 2 records appear BELOW them, in correct
  non-increasing emitted_at order, no duplicates.
- Snapshot stability holds across the accumulated view (all pages share the snapshot anchor
  carried in each cursor).
- Reproduce-the-bug test: assemble with a 2-cursor trail and assert the feed contains BOTH
  pages' records (count = page1 + page2), ordered, deduped — fails on the pre-fix single-page
  return.
