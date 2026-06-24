# Feed interaction dynamics (collapse/expand/load-more) — prior art (2026-06-21)

Research (deep-research, 108 agents, primary-doc-sourced claims). The verify phase was
rate-limited (the synthesis's "all refuted / 0-0 votes" is a rate-limit ARTIFACT, not a
real refutation — every failure line is "API Error: rate limited"); the CLAIMS are
direct quotes from primary product docs and are trustworthy. Extends the static
legibility corpus (explore-timeline-legibility-stability-validation-2026-06-19.md) with
the DYNAMICS. Driver: the "188 but I can only see 32" reachability bug + Tim's call to
ground the collapse/expand/load-more LOGIC in prior art (problem statement:
explore-upcoming-collapse-interaction-problem-2026-06-21.md).

## Q1 — "show all": INLINE expand vs DRILL-IN, by set size
- **Google Photos Stacks**: "show all" = INLINE expansion (grid/strip in place), NOT a
  route navigation. BUT a stack is HARD-CAPPED at 100 photos, and reachability is
  imperfect (some belonging photos silently omitted — an observed anti-pattern of a
  group "promising completeness it does not deliver").
- **Stripe invoice lines**: a hard THRESHOLD — ≤10 lines shown INLINE; >10 → a SEPARATE
  dedicated PAGINATED endpoint (`/v1/invoices/upcoming_in_<id>/lines`). Small set =
  inline; large set = drill-into-a-fully-paginated view.
→ SLVP synthesis: inline expand for SMALL bursts (bounded, fully loaded); DRILL-IN to a
  paginated per-(connection,stream) view for LARGE bursts. The drill-in target already
  exists in PDPP (the per-stream records page — buildCompleteStreamHref).

## Q2 — COUNT == REACHABILITY (the invariant the bug violates)
- **Stripe**: `has_more` boolean; "walk the cursor to exhaustion". DELIBERATELY does NOT
  show a total it can't cheaply guarantee reaching (no default total on lists; search
  total_count only accurate to 10,000). i.e. don't promise a count you can't reach.
- **Linear**: shows a TRUE total per group, tied to full membership (not a visible
  head), clickable to toggle count vs estimate.
- **Anti-pattern (named)**: Google Photos Stacks promising completeness it doesn't
  deliver. → PDPP's "188 upcoming" → 32 reachable is exactly this.
→ SLVP synthesis: EITHER every shown count is fully reachable (inline-if-small, drill-in
  -if-large, or paginate) OR don't show the count. A capped head behind a true total is
  the forbidden state.

## Q3 — LOAD-MORE in a day-grouped multi-stream feed ("collapse down not up")
- **react-virtuoso GroupedVirtuoso** (the canonical mechanic): grouping = a single
  `groupCounts: number[]`. Loading more ABSORBS new items into the EXISTING group OR
  prepends new groups by MUTATING groupCounts in place (and adjusting firstItemIndex by
  exactly the new-item count), NEVER displacing what's already shown. `endReached`
  drives tail load-more; `atTop/atBottom` drive bidirectional incremental load. Supports
  collapsible groups + scroll-to-group so every record is reachable.
→ SLVP synthesis: this IS Tim's "collapse down not up". When load-more brings older
  records, they merge into the existing day groups; a day shown as singles that crosses
  the burst threshold collapses into a burst IN PLACE; rows already shown never reorder.
  Today PDPP re-groups the whole accumulated feed each render (groupFeedWithBursts over
  visibleFeed) — which already merges-in-place by construction (it regroups the full
  set), but the BURST COUNT is the loaded count, not the true per-(conn,stream,day)
  total → the reachability bug recurs inside the main feed too once a day is capped.

## Q4 — the Upcoming/future section: OWN model, not the main feed's
- **Todoist Upcoming**: a SEPARATE top-level surface beneath Today. Navigated by
  WEEK-PAGING (horizontal arrows / week picker + Today button), NOT infinite-scroll.
  Intra-week = vertical scroll; inter-week = horizontal nav. Bounded horizon (2y).
  Per-day = a presence DOT, not a count. Reduced surfaces (widget) cap to 7 days.
- **Things 3 Upcoming**: day-by-day SECTIONS for the next 7 days (starting tomorrow),
  NOT counted bursts. Items auto-migrate into Today on their date. Sections are
  MUTUALLY EXCLUSIVE (a record lives in exactly one) — no count-vs-reach ambiguity.
- **Stripe**: distinct surfaces get INDEPENDENT paginators.
→ SLVP synthesis: the Upcoming section is its OWN thing — day-sectioned (soonest-first),
  with its OWN reachability (its own "load more" / drill-in), NOT the main feed's
  burst-collapse + 32-cap. A future record lives ONLY in Upcoming (mutually exclusive
  with the main feed — already true via the pinned-now clamp). The pill count must be
  reachable: either page the section or drill into a future view.

## Q5 — edge-case matrix → SLVP behavior (exemplar)
- One stream dominates a day (giant burst): collapse to a burst with the TRUE count;
  inline-if-small else drill-in (Stripe >10 threshold; Photos 100 cap).
- Many small streams in a day: individual rows, no burst (below threshold). (Linear)
- Mixed burst+singles in a day: singles render; the bursting partition collapses; both
  under the one day header. (current PDPP shape — keep)
- Load-more crosses a day boundary / fills a partial day: absorb in place, recollapse
  if it crosses the threshold; never displace shown rows. (GroupedVirtuoso)
- All-future first page: main feed leads with Today (server clamp already does this);
  future in the Upcoming section. (Things/Todoist + the deployed v4)
- Empty main feed + non-empty upcoming: show the Upcoming section + an honest empty
  state for the main feed ("nothing today; N upcoming"). (Linear empty-group toggle ethos)
- Expand-state persistence across load-more: keep expanded groups expanded (state keyed
  by stable group id, not index). (GroupedVirtuoso scroll-to-group; current expandedBursts
  is keyed by `${connectionId}::${stream}` — stable, good).
- 3-level nesting (section > day > burst): keep legible with the active level's header
  sticky/visible. (Linear sticky group headers)

## The SLVP-ideal design for PDPP (synthesis → build)
1. **COUNT == REACHABILITY everywhere.** A burst's count = the TRUE per-(connection,
   stream,day) total (from keyset metadata), not the loaded count. The Upcoming pill's
   188 must be reachable.
2. **Burst "show all": inline-if-fully-loaded, else DRILL-IN** to the per-stream records
   page (the existing complete, paginated surface — buildCompleteStreamHref). Threshold:
   if the burst's true total > what's loaded (or > a small inline ceiling), the action
   is "Open all N in <stream> →" (drill-in), not a lying inline "show all".
3. **The Upcoming section is its own day-sectioned surface** with its own reachability:
   each future day shows its records (or a burst that drills into that stream's future).
   Its pill count is reachable because each day's burst drills into the full stream.
   (Simplest correct v1: Upcoming day groups whose bursts drill into the per-stream page
   — every future record reachable via the existing paginated stream view; no new
   Upcoming paginator needed.)
4. **Main-feed load-more = merge-in-place** (already true via full-feed regroup); fix the
   burst count to the true total so a capped day doesn't hide records.
5. **Mutual exclusivity** (future only in Upcoming) — already guaranteed by the pinned
   -now server clamp.

Build follows. The drill-in reuse (per-stream records page) is the key simplifier: it
makes COUNT==REACHABILITY true without inventing a second paginator, matching Stripe's
"big set → drill into the paginated stream" pattern.
