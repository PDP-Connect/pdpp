# Explore canvas integration: the DECISION + resolution map (binding)

Status: DECIDED (Claude RI, 2026-06-19, ~95% earned by mapping all 9 of main's invariants
to the descriptor). This is the binding resolution for rebasing
`workstream/explore-full-visibility` onto local main, which forked because main and the
branch independently built TWO honesty architectures for the same Explore feed surface.

## The decision (do not re-litigate)

**The set-descriptor contract is the ENGINE and the single source of truth. Main's
count-gating UI is KEPT but re-wired to read the descriptor instead of its own ad-hoc
`exactCountIsCurrent` boolean.**

Why (earned, not asserted): main's `exactCountIsCurrent = exactTotal !== null &&
!unsupportedFullStreamState` is a hand-rolled special case of `descriptor.completeness ===
"exact"` for a whole-stream scope. The descriptor GENERALIZES main's guard. Proof it's the
right call: Codex's HOLD (lexical candidate-window labeled "all matching records") is a hole
in MAIN's per-site model that the descriptor closes structurally. "Make illegal states
unrepresentable in the type" is the SLVP-ideal honesty model; main's per-render-site boolean
is the weaker "re-catch the bug at every call site" model. The descriptor wins; main's
better-resolved presentation (copy, shared RecordInspector, full-stream links) is preserved
on top of it.

## All 9 of main's invariants, mapped (page.invariants.test.ts)

ORTHOGONAL — survive untouched, keep main's assertions as-is:
1. connection identity in timeline rows — data plumbing.
2. delegates to shared assembler — architecture.
3. /explore redirect — routing.
4. no demo-era copy — copy hygiene.
5. single active-range helper — refactor hygiene.
7. visible inspect/open affordances — UI affordance.

HONESTY-AXIS — must be RECONCILED onto the descriptor (not dropped):
6. "inspector exposes the complete scoped stream" (no-dead-end escape ramp:
   OPEN_COMPLETE_STREAM_RE, SELECT_STREAM_COMPLETE_LIST_RE, the shared RecordInspector with a
   complete-stream href). SAME honesty axis as the branch's StreamSeeAllLink / "Browse all
   matching records". Keep main's RecordInspector + complete-stream-href helper; the branch's
   StreamSeeAllLink and main's full-stream link are the same escape ramp — unify them, do not
   ship both.
8. "exact scoped count copy" — THE load-bearing one. Maps to descriptor `completeness`:
   - EXACT_TOTAL_LINE_RE "Showing N of M records in this stream" -> only when descriptor is
     `filtered_exact` (true total) or `complete_chronological` with a known total.
   - EXACT_TOTAL_GATED_ON_FULL_STREAM_SCOPE_RE (`exactCountIsCurrent = exactTotal !== null &&
     !unsupportedFullStreamState`) -> THE ONE WIRING OBLIGATION: an Explore-only local-filter
     slice (text + date + local operators applied over a bounded window, no server-true total)
     MUST be classified as a BOUNDED descriptor kind (keyword_pageable / relevance_bounded),
     NOT `filtered_exact`. Then the descriptor structurally cannot claim "of M complete". This
     is the subtle signal main encodes as `unsupportedFullStreamState`; port it faithfully as
     the assembler's kind-classification rule. If you cannot make the assembler classify the
     local-slice case as bounded, STOP and report (this is the 5% residual).
   - FULL_STREAM_WHOLE_STREAM_NOTE_RE "The full-stream list opens the whole stream; text
     search, date range, and local operators stay in Explore" -> keep this note; it is the
     plain-language version of the same rule.
   - OPEN_ALL_RECORDS_GATED_RE "open all M records" denominator -> only when descriptor exact.
9. "bounded-search truth" (SEARCH_HAS_MORE_RE: search has_more makes the page visibly
   bounded) -> descriptor `keyword_pageable.has_more` / `relevance_bounded`. Plus the
   RECALL FIX (Codex HOLD): a bounded lexical candidate window must NOT get
   `completeness: "pageable"` — see below.

NET: no invariant is orthogonal-and-unrepresentable. Everything main encodes is a projection
of the descriptor's completeness/ordering/has_more, GIVEN the one local-slice classification
rule is ported.

## The recall fix (Codex Explore HOLD — falls out of the descriptor)

The server already discloses recall (`meta.count`, `meta.count_accuracy: "lower_bound"`,
`meta.recall.ranking_scope: "candidate_window"`, `recall.complete: false`) per the
`disclose-lexical-recall-windows` OpenSpec. The console `SearchResultPage` type
(apps/console/src/app/dashboard/lib/rs-client.ts ~315) DROPS meta/count/recall;
`searchRecordsLexical()` returns only warnings. Fix:
1. Add `meta`/`count`/`count_accuracy`/`recall` to `SearchResultPage` and thread through both
   data sources (live + sandbox) into the assembler.
2. The descriptor already carries the recall facts (RelevanceBoundedDescriptor has
   `total`/`candidate_window_limit`; the doc references ranked_candidate_count). Make
   `keyword_pageable` carry a recall discriminant OR route a candidate-window lexical result
   to a bounded descriptor (relevance_bounded / a keyword_pageable variant that is NOT
   completeness:"pageable"). A bounded window MUST NOT claim exhaustive/pageable-to-the-end.
3. In explore-data-assembler.ts (the lexical Most-recent paths ~1081/1114/1279 region), READ
   `meta.recall`: emit the exhaustive descriptor ONLY when recall is complete/exact.
4. explore-canvas.tsx: render "Browse all matching records, newest first" ONLY when the
   descriptor permits exhaustive recall; for candidate_window use bounded copy (e.g. "Browse
   ranked keyword window, newest first") or a true chronological escape not described as "all
   matching records."

## Assembler conflict resolution (9 regions, commit cdcd7dc5)

The branch's `loadMergedTimelineFeed` (the /_ref/explore/records k-way merge endpoint) is the
feature and REPLACES main's `loadEmptyQueryFeed` per-stream fan-out (`selectFeedStreams`,
`StreamFetchResult`, parallel queryRecords, `hasMoreRecords`/`exactWindows`/fan-out cursor).
Take the BRANCH side for the feed-loading mechanism and the FeedLoadResult/RecordsExplorerData
shape (which already has `descriptor`, `nextCursor`, `newSinceAnchor`, `snapshotAnchor`,
`streamDoor`, `streamSeeAllLinks`). RE-APPLY main's genuinely-orthogonal changes that the
branch's base predates:
- `buildPeek` semantic-timestamp logic from the date fix (main commit 9b161aa1) — the
  `semanticTimestamp` field on ExplorerPeekData. (NOTE: explorer-utils.ts ExplorerPeekData on
  the branch does NOT yet have semanticTimestamp; main's date-fix added it. Re-apply.)
- `manifestFieldCapabilities` and any lint/format-only deltas main made.
- main's enriched `activitySummaryForFeed` (+total) — adapt `feed.hasMoreRecords` references
  to the branch's `searchHasMore`/descriptor where main's fan-out fields no longer exist.
Verify every main "MISSING" line is architecture-SUPERSEDED (the deleted fan-out), not a lost
improvement. explorer-utils.ts warning-code union: keep BOTH `search_page_limited` (main) and
`search_cursor_unavailable` (branch) — ALREADY RESOLVED in the worktree.

## Canvas integration (explore-canvas.tsx + page.invariants.test.ts + perf test)

The git auto-merge is incoherent (references BOTH variable sets). Do NOT mechanically merge.
Rebuild the canvas as: descriptor-driven feed status, with main's FeedStatusLine/RecordInspector
PRESENTATION re-wired to read `data.descriptor`:
- FeedStatusLine reads descriptor.completeness: exact -> "Showing N of M"; bounded/pageable ->
  bounded copy; relevance_bounded -> no count claim. Keep main's exact strings where the
  descriptor is exact (so main's invariant assertions still pass against real rendered copy).
- Keep main's shared RecordInspector + complete-stream href helper (invariant 6); unify with
  the branch's StreamSeeAllLink (same escape ramp).
- Keep the branch's feedHeaderLabel/descriptorIsTimeOrdered/day-grouping where they don't
  conflict with main's count copy.
- page.invariants.test.ts: KEEP main's 9 tests. Where a test asserts a count string, the
  rendered copy must still produce it FOR THE EXACT-DESCRIPTOR CASE (so the assertion holds).
  Only adjust an assertion if the descriptor model genuinely renders different (honest) copy
  for a case main got wrong (the candidate-window recall case) — and then the adjustment makes
  the test MORE honest, with a comment.
- perf test (explore-default-feed-performance.test.ts): main's tests 2&3 assert the removed
  fan-out + search_page_limited. Re-express against the merged-timeline feed (the branch's
  loadMergedTimelineFeed makes ONE endpoint call — assert THAT bound), keeping the perf intent
  (first-paint endpoint call is bounded).

## Hard gates (all must pass before commit)
- console tsc 0; operator-ui tsc 0; reference tsc if touched.
- openspec validate add-explore-merged-timeline --strict + --all --strict.
- ALL of main's 9 page.invariants tests green (run via node --import tsx -e import() for
  bracket-dir files).
- Branch's explore suites green: explore-acceptance, explore-p2-search-sort,
  explore-frontend-codex-hold-fixes, explore-feed-grouping, set-descriptor, descriptor+perf.
- NEW recall regression test (meta.recall.complete=false / candidate_window / lower_bound):
  descriptor NOT pageable-exhaustive, copy not "all matching". PROVE it fails pre-fix.
- conformance 4/4 (PG on :55467) if substrate touched (it should NOT be — scoped pagination
  already landed).
- ultracite check clean on every console/operator-ui file touched (lefthook does NOT gate
  these packages).
- git diff --check clean. Author/committer Tim Nunamaker <tnunamak@gmail.com>.
