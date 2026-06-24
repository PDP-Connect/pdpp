# Explore Upcoming/collapse interaction — problem statement (2026-06-21)

Status: PROBLEM STATEMENT for the in-flight deep-research on feed interaction
dynamics (`explore-feed-interaction-dynamics-prior-art-2026-06-21.md`, pending).
Driver: Tim — "188 but I can only see 32" + "the auto grouping/collapse/expand thing
doesn't feel good as is … the core mechanism works but the design isn't good UX; we
need prior-art on the LOGIC of it; load-more can collapse rows down not up across
streams; cover all edge cases to the SLVP-ideal."

## The reachability bug (count promises more than the UI surfaces)
Live: the Upcoming pill says "188 upcoming". Expanding shows ONE day group
("Wednesday, July 1, 2026") with ONE burst row: "32 · YNAB / month_categories ·
show all ↓". "show all" reveals 32 rows. The other 156 are UNREACHABLE.

Root cause (code-confirmed):
- The 188 future records are: 130 month_categories (Jul 1) + 2 months (Jul 1) +
  55 month_categories (Aug 1) + 1 month (Aug 1).
- `fetchUpcoming` returns a HEAD capped at `FEED_TOTAL_CAP = 32`
  (explore-data-assembler.ts:47,785) — only the soonest 32 future records (all from
  Jul 1's month_categories). `upcoming_total` is the true 188 (a separate COUNT).
- The client groups those 32 → one day (Jul 1) → one burst of 32.
- `BurstRow` (explore-canvas.tsx:982-1026): the count shown is
  `burst.entries.length` (the LOADED 32, NOT the true total), and "show all" maps
  `burst.entries` INLINE — i.e. it expands only the loaded subset.
- The Upcoming section has NO pagination / no load-more. So 156 future records
  (98 more Jul, all 55 Aug, 3 months) are never fetched → unreachable, and Aug 1
  never even appears as a day group despite being counted in "188".

So: pill count = true total (188, honest), but the surfaced/​reachable set = 32. A
count that promises more than the UI can reach is the anti-pattern.

## The interaction-logic gap (why it "doesn't feel good")
Three independent collapse mechanisms (section-collapse for Upcoming, day-grouping,
burst-collapse per connection+stream+day) plus load-more were NOT designed as one
coherent state machine. Open questions the research must answer:
- Burst "show all": expand-in-place (current) vs drill-into-stream vs paginate-burst?
  Current expand-in-place can't reach beyond the loaded head — broken for capped sets.
- Burst count: must show the TRUE per-burst total, not the loaded count.
- Upcoming section: does it get its OWN load-more, its own burst handling, or a
  drill-in to a full future view? It currently has none.
- Main-feed load-more across multiple streams: when older records load, do they
  append as new day groups, ABSORB into existing partially-shown days (a day shown
  as singles that crosses the burst threshold should "collapse down" into a burst),
  and never reorder/displace rows already shown above? ("collapse down not up")
- Expand-state persistence across load-more.
- The full edge-case matrix (one stream dominating a day; many small streams; mixed
  burst+singles; load-more crossing a day boundary; all-future-first-page; empty main
  feed + non-empty upcoming; 3-level collapse nesting).

## Invariant the fix must satisfy (SLVP)
COUNT == REACHABILITY: any count shown (burst total, "N upcoming", day count) must be
fully reachable through the UI — via inline pagination inside the group, a "show all"
that loads the rest, or a drill-in to a fully-paginated stream/future view. No capped
head masquerading as a complete set.

## Existing corpus (do not duplicate; this extends it)
- explore-timeline-legibility-stability-validation-2026-06-19.md — established WHY
  day-grouping + burst-collapse exist (Google Photos Stacks, GitHub push aggregation,
  Datadog Patterns, Gmail bundles, WhatsApp day separators). Static legibility.
  Notes (line 75) PDPP can have EXACT counts (keyset metadata) unlike Datadog's
  sampled approximate counts — so burst/section counts must be exact AND reachable.
- explore-merged-timeline-pagination-prior-art-2026-06-19.md — keyset pagination.
The GAP this research fills: the DYNAMICS — how show-all/load-more/section+day+burst
collapse compose, and the count==reachability guarantee. Build follows the synthesis.
