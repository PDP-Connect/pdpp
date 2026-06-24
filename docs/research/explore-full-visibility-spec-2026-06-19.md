# Explore Full-Visibility Spec (corrected, contract-form)

Status: FINAL design (Tim + Claude RI agreed 2026-06-19). The spine is the SET-DESCRIPTOR CONTRACT (below); P1/P2/P3 and the F2 fix all derive from it. Build to this bar.
Created: 2026-06-19
Owner: Claude RI owner
Confidence: high. The surface is a RECORD WORKBENCH over owned data, and its defining feature is structural honesty: every set of records the owner sees declares what kind of set it is, and the UI is CONSTRAINED by that declaration so it cannot misrepresent completeness or ordering. This is Glean-grade (filterable/sortable result-set object + real relevance/time sort + exhaustive chronological browse) PLUS the differentiator Glean does not ship: the set-type is a first-class, visible, enforced contract. The "computed answers over your data" direction is explicitly REJECTED (it assumes connector schema we do not own; PDPP is an open-connector world). Power comes from GENERIC, manifest-declared manipulation that works for any connector, present or future.

## THE SET-DESCRIPTOR CONTRACT (the spine)

Every collection of records the owner sees carries a typed, machine-DERIVED descriptor of its own completeness and ordering, surfaced in the UI and ENFORCING what the UI may claim. The owner is never left to guess whether they are seeing everything, a page of everything, or a ranked sample. Every silent-cap / lying-label / dead-end failure this project has hit is the ABSENCE of this contract; with it, those failures become structurally impossible (uncompilable), not bugs to re-catch.

Descriptor shape (engine-level truth, carried on every feed/result):
  { kind, ordering, completeness, total?, has_more, cursor? }

kind is a CLOSED enum of the real set-types our system produces, each with a TRUE owner-facing claim the UI must honor:
- complete_chronological: "Everything, newest first." ordering=time; completeness=exhaustive; cursor-stable to the end. (the merged timeline, or a single stream's full list)
- relevance_bounded: "Top matches" / "Best N." ordering=relevance; completeness=BOUNDED ranked sample, explicitly NOT exhaustive; carries the recall facts the server already computes (ranked_candidate_count, candidate_window_limit). This is the honest face of search; it NEVER claims completeness and NEVER offers a fake "Load more" that implies it.
- keyword_pageable: "Keyword matches." ordering=relevance OR time; completeness=pageable to the end via a real cursor (lexical supports this).
- filtered_exact: "Your filtered set: N records." ordering=owner-chosen; completeness=EXACT and complete for that filter, with a true total.

ENFORCEMENT (the load-bearing part): the descriptor is DERIVED from whatever produced the set and DRIVES + CONSTRAINS the UI - header copy, whether a "Load more" appears (and whether it really advances), whether a true total shows, whether an escape-to-exhaustive ramp appears. The UI literally cannot render "newest first" over a relevance_bounded set, or show "6 of 1,183" without the path to 1,183, because the descriptor does not permit it. Implement this as a typed contract (a discriminated union the renderer switches on), not as ad-hoc strings.

PRODUCT/ENGINE SEPARATION (Tim's dial-back guarantee): the descriptor is the ENGINE-level truth and is mandatory. The PRESENTATION (copy, chrome, how loudly the set-type is shown) is a SEPARATE layer that consumes it. We may soften/simplify the product surface without ever letting the UI claim something the descriptor does not support. The honesty contract stays; presentation dials.

HOW THE SURFACE COMPOSES under this contract:
- A search returns relevance_bounded ("best matches", honest, never "complete").
- Sorting/filtering that set yields filtered_exact (now a real total, fully reachable).
- The labeled escape lands on complete_chronological (everything, in order, to the end).
The owner ALWAYS knows which they are in, because the set says so.

F2 RESOLUTION under this contract (the "newest first" lie): the bug is "the descriptor said relevance_bounded but the UI claimed complete_chronological." Fix = make the claim match the set. The search "sort by time" control orders the SET it has (keyword_pageable can order by time honestly; relevance_bounded cannot claim exhaustive-newest-first), and the EXHAUSTIVE newest-first path is the labeled escape to complete_chronological (the merged timeline). No control may claim a completeness/ordering its descriptor does not carry. Thread the recency order through lexical (the server op has an order field) so keyword_pageable can genuinely be time-ordered; do NOT relabel a relevance set as chronological.

Build status (pre-this-rewrite): P3 BACKEND (k-way merge endpoint, composite cursor, snapshot stability, dual-backend conformance) is REAL and verified, and Codex's 5 HOLD findings B1/B2/B3/F1/F3 are fixed (commit 653531b0). F2 remains (resolve per the contract above). The endpoint + frontend now also need the set-descriptor contract threaded through so every set self-declares.
Grounds: docs/research/explore-merged-timeline-pagination-prior-art-2026-06-19.md, explore-record-explorer-product-pattern-prior-art-2026-06-19.md, explore-search-relevance-pagination-prior-art-2026-06-19.md, explore-slvp-recommendation-synthesis-2026-06-19.md
Code grounding: packages/operator-ui/src/explore/explore-data-assembler.ts, apps/console/src/app/dashboard/explore/explore-canvas.tsx, apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx, apps/console/src/app/dashboard/lib/rs-client.ts, reference-implementation/operations/rs-search-*/index.ts

## Why this rewrite exists

A prior agent "removed the cap" by deleting the FEED_LIMIT and the honesty label and adding NO path to the full set. That is the opposite of intent. Root cause was an underspecified instruction (symptom "remove the capped copy" stated as the goal, pagination left conditional and escapable). This spec restates each item as a falsifiable PRODUCT CONTRACT with an acceptance test and an explicit no-fake clause, so an implementer (including a sonnet agent) cannot satisfy the words while missing the intent.

## The product contract (the thing every phase serves)

CONTRACT: The owner can always reach the complete set of records behind any number they see. No surface presents a bounded result as if complete, and no surface dead-ends. "Recent" and time-range browsing are exhaustively reachable; search returns the genuinely-best matches and offers a real door to exhaustive browsing. Engineering cost is not a reason to violate this; if a path cannot be made reachable, STOP and report, do not remove the honesty label.

ACCEPTANCE (global): An owner with 1,183 Amazon orders can, from Explore, reach and page through all 1,183. An owner searching "overdraft" gets the best matches AND a working way to see every overdraft record. At no point does the UI say a bounded result is the whole, and at no point is there a stop with no forward.

## How Explore actually works today (verified facts the spec depends on)

- Three lenses in packages/operator-ui/src/explore/explore-data-assembler.ts:
  - RECENT (empty query): per-stream fan-out (MAX_FEED_CONNECTIONS 6 x MAX_FEED_STREAMS 2 x MAX_FEED_RECORDS 6), merged + sorted by timestamp + sliced to FEED_TOTAL_CAP 32. Per-stream next_cursor values are DISCARDED (only has_more kept). No merged cursor.
  - TIME RANGE: same fan-out shape, wider (TIME_RANGE_RECORDS_PER_STREAM 50, cap 500).
  - SEARCH: a SINGLE GLOBAL call (searchRecordsHybrid OR searchRecordsLexical, limit 25). Global top-N ranked across all the owner's data; each hit carries its own connector_id/stream. NOT per-stream union, NO per-source quota. Hybrid returns no cursor (by design); lexical/semantic return next_cursor, which the assembler currently DISCARDS.
- Per-(connection,stream) reads use KEYSET cursors over a declared cursor_field (timestamp), stable (cursor_field, record_key) tiebreak. encodeCursor/decodeCursor exist. has_more + next_cursor returned per stream.
- The per-stream records page (records/[connector]/[stream]/page.tsx) ALREADY paginates to the EXACT total: it renders "N of {total} total" from page.meta.count.kind === "exact", with a cursor "trail" (stack of cursors in the URL). This is the SLVP-quality full-list browser. It is the link target for escape ramps.
- Hybrid search correctly rejects cursor (invalid_request, param: cursor) and omits next_cursor by design (rs-search-hybrid/index.ts). This is correct, not a bug: fused/relevance ranking is not soundly deep-pageable.

## PHASE 1 - Active escape ramps (closes the dead-end complaint)

CONTRACT: Every place Explore shows a bounded slice of a stream, the owner sees the exact full count and a one-click path to the complete, paginated list for that stream. Replace any "capped/window" language with honest "recent across your sources" framing that invites rather than dead-ends. NEVER remove an honesty label without providing the reachable path in the same change.

Concrete:
- In the fan-out feed (recent + time-range), wherever a stream group has has_more=true (assembler) OR is part of a truncated merge, render the stream group with a LINKED header: "Amazon - Orders - 1,183 records - See all" linking to /dashboard/sources/[connector]/[stream]. Use the exact total from exactWindow/page.meta.count where available; if exact count is not loaded for that stream, load it (the per-stream page proves the count is available) or show "See all" without a number rather than a wrong number.
- Replace the passive caption ("select a row to open that stream's full records") with per-stream "See all N" links.
- Connection facets (left list): each gets a "Browse all records" affordance to that source.
- Remove the silent FEED_TOTAL_CAP-as-complete presentation; the feed is explicitly framed "Recent across your sources" (a preview that points onward), never "N in view (window capped)".

NO-FAKE CLAUSE: Do not delete the truncation indicator unless the same diff adds the working "See all" link to the exact-total paginated page. A diff that removes "(window capped)" without adding the ramp is a spec violation, not a fix.

ACCEPTANCE (P1): From Explore recent view, an owner sees "Amazon - Orders - 1,183 - See all", clicks it, lands on the orders stream page showing "50 of 1,183 total" with working next/prev, and can page to all 1,183. Test: a route/invariant test asserting (a) no "window capped"/"capped"/silent-cap string remains, (b) every truncated stream group renders a link to its /sources/[connector]/[stream] page, (c) the link carries the stream's identity.

## PHASE 2 - Search lens: the result set as a sortable/filterable object (Option D) + a labeled chronological escape

DECISION (Tim, 2026-06-19): Option D is the SLVP-ideal and most-powerful HONEST design for meaning-based search. Validated: no better "E" exists (similarity search has no objective complete set; every alternative either invents an arbitrary cutoff = noise, or drops semantic ranking = less power), and D is strongly supported by best-of-best prior art - Glean (closest peer: enterprise personal-data semantic search, bounded pool + filter + sort), Airtable Deep Match ("Top 20" = exact analog), Datadog Log Explorer (gold standard for bounded-result-as-manipulable-object at scale), Hebbia, Kibana Discover, Weaviate, Linear. See explore-search-result-set-model-validation-2026-06-19.md, explore-search-pagination-primary-sources-2026-06-19.md (all facts PRIMARY-CONFIRMED), explore-search-exhaustion-flow-design-2026-06-19.md. Confidence ~88%; residual is pool-size-K tuning (live-data) + mode-switch label wording, both refinable, neither a fork.

CONTRACT: A search produces a COMPLETE BOUNDED RESULT SET (the fused lexical+semantic candidate pool, which PDPP's hybrid already materializes - unions lexical+semantic with a scores map, rs-search-hybrid/index.ts). That set is presented as a SORTABLE, FILTERABLE OBJECT, not a paginated relevance stream. The SAME set can be ordered "Most relevant" or "Most recent" and filtered by source/date/field; the count never shrinks across orderings (same set, two orderings) - this is what dissolves the seam. The owner never hits a silent wall, and there is always a clearly-labeled path to exhaustive chronological browsing.

WHY a paginated relevance stream is wrong (PRIMARY-CONFIRMED): relevance ranking is bounded everywhere (Algolia paginationLimitedTo default 1000 / max 20000; Elasticsearch index.max_result_window default 10000, from+size beyond errors; GitHub 1000) AND for vector/hybrid it is not even well-defined (pgvector HNSW ANN top-K has no stable position past the candidate pool; Elasticsearch RRF returns 0 results past rank_window_size). So "page deeper into relevance" is a non-answer. The honest model is: the result is a finite SET you manipulate, plus an explicit escape to the (uncapped, total-ordered) chronological surface.

User-facing experience (what the owner reads/does):
- Header: "Results for '<query>'" with the set framed honestly as the best matches across sources (NOT "window capped", NOT presented as literally-every-record-in-existence). Optionally "across Chase, Amazon, and 3 more".
- SORT within the set: "Most relevant / Most recent" re-orders THE SAME result set. Critically: Most-recent here is a re-order of the pool, NOT a different query - the count and membership stay identical, only the order changes. This is honest and seam-free.
- FILTER within the set: by source, by date range, by declared field - faceted refinement of the fixed result set (the Datadog/Algolia/Kibana faceting model).
- LEXICAL keyword search: also wire the next_cursor the assembler currently DISCARDS (it only keeps has_more) so the keyword result set can grow on demand ("Load more" within the keyword pool; #26, #27 ... reachable), since lexical IS deep-pageable.
- THE LABELED ESCAPE (mandatory, the seam-killer): a clearly-labeled, separate control - "Browse all matching records, newest first" - that EXITS the result-set object to the chronological browse surface (the Phase 3 merged timeline) with the query applied as a lexical filter. This is NOT the in-pool sort toggle; it is an explicit, honestly-labeled mode switch to a different surface that IS exhaustive. The label makes clear the owner is leaving "best matches" for "everything, chronologically". (Slack/Notion/Gmail ship this separation; the distinction between an in-set re-sort and a labeled exit-to-exhaustive is the whole point.)

NO-FAKE CLAUSE: Never present the result-set as literally complete-for-all-time; frame it as the best matches you can sort/filter. Never let "Most recent" SILENTLY swap pool membership (semantic pool -> keyword-only results) - that is the seam re-introduced; in-pool sort keeps membership, the labeled escape is where exhaustive chronological lives. Do NOT add a non-working "Load more" on the hybrid relevance ordering (no cursor). The labeled escape MUST actually reach the last matching record (it rides the Phase 3 mechanism for cross-source, or a stream keyset for single-source).

ACCEPTANCE (P2): Searching, the owner sees a result set with Most-relevant/Most-recent sort that re-orders the SAME set (count identical across orderings - assert this). Filtering by source/date narrows the set coherently. Lexical "Load more" grows the keyword pool (cursor forwarded - assert). The labeled "Browse all matching records, newest first" escape lands on the chronological surface filtered to the query and pages to the LAST matching record of a fixture corpus (assert reaches last). No "(window capped)" remains; no sort silently changes membership; no fake Load-more on hybrid relevance.

NO-FAKE CLAUSE: Do not cap any sort mode silently. Do not present "Most relevant" top-N as the complete set. Do NOT add a non-working "Load more" on hybrid's relevance mode (it has no cursor); the exhaustive path is the Most-recent toggle and/or the stream door. The Most-recent mode MUST actually be exhaustively pageable (it depends on the Phase 3 merged-timeline mechanism for the cross-source case; for a single-source/stream query it can use that stream's keyset cursor).

ACCEPTANCE (P2): Searching a keyword in Explore, the owner can Load-more past the first page repeatedly in Most-relevant mode. Toggling to Most-recent, the owner can page through EVERY matching record in time order (verified reaches the last one for a bounded test corpus). Searching with semantic/hybrid, "Most relevant" shows honest "Top matches", and "Most recent" provides the exhaustive chronological path; a per-source "See all in <stream>" door is present. No "(window capped)" remains. Test: assert the sort toggle exists and is URL-backed; assert Most-recent mode pages a small fixture corpus to its last matching record; assert lexical Most-relevant Load-more forwards the cursor; assert hybrid Most-relevant renders no fake Load-more but does render the toggle + stream door.

## PHASE 3 - Unified, fully-paginated cross-source timeline (the signature surface)

RATIONALE (why this is not "optional" for PDPP specifically): PDPP's value proposition is the UNIFIED view of your whole data life ("all yours to read"). Cross-source time questions ("what did I do last Tuesday", "everything from my Portland trip", "everything in 2023") are the signature questions for a personal-data-sovereignty product, in a way they are not for a SaaS like Stripe. So a deep, fully-paginated, time-ordered feed across ALL sources is a candidate PRIMARY surface, not a nice-to-have. (To be validated against personal-data-timeline analogs, not just SaaS analogs - see open validation below.)

CONTRACT: Explore offers a single time-ordered feed across all the owner's sources that can be paged exhaustively (not a 32-row preview). It reads as "your life, legible": grouped by day, with high-volume bursts collapsed, and stable while you scroll as new data arrives.

Mechanism (engineering-free assumption granted):
- New server endpoint (e.g. /v1/explore/records) doing a k-way merge: one keyset cursor per (connection, stream) partition, always emit the globally-newest next record, return a page + ONE composite cursor encoding all per-partition positions (base64url blob). Sound because every partition shares a timestamp sort axis and keyset cursors; standard pattern (Elasticsearch composite agg, Datadog Logs meta.page.after, Mastodon).
- The console renders this as the recent/time lens feed, with a cursor trail in the URL (same UX idiom as the per-stream page), pageable to the end.

IDEAL-VERSION REQUIREMENTS (the two Tim signed off on):
1. POINT-IN-TIME STABILITY + "N new" pill: the composite cursor is anchored to a snapshot time so scrolling does not shift rows under the owner; newly-ingested records surface as a "N new" affordance at the top that refreshes to the live head on click. (Linear/Slack/Datadog pattern.)
2. DAY-GROUPING + BURST-COLLAPSE: records are grouped by day ("Tuesday, June 17"); high-volume same-stream bursts collapse into one expandable group ("84,000 WhatsApp messages") rather than 84,000 rows, so the firehose is legible. (Google Photos/Timeline, life-logging pattern.)

INTERACTION WITH P1/P2: with P3, the recent/time lenses are themselves exhaustively pageable, so the P1 escape ramps become "jump to this stream's dedicated list" (still valuable for single-entity questions like "all my Amazon orders") rather than the only path to completeness. Search lens unchanged from P2 (relevance does not get merged deep-pagination; time-browsing does).

NO-FAKE CLAUSE: P3 is not "raise FEED_TOTAL_CAP to a big number". It is real merged keyset pagination to the end. A larger silent cap is still a cap.

ACCEPTANCE (P3): An owner can open Explore (no query, "all time" or a wide window) and scroll/Load-more through every record across all sources in time order, grouped by day, with bursts collapsed, with stable scroll and a "N new" pill when fresh data lands. Test: assert the merged feed returns a composite cursor; assert paging it forward yields strictly older, non-duplicated records spanning multiple sources; assert day-group and burst-collapse rendering; assert the snapshot cursor does not reshuffle prior pages when new records are inserted.

## Decisions captured (Tim, 2026-06-19)
- Engineering cost is NOT a constraint here; build the ideal.
- P1 and P2: confirmed no-brainers.
- P3: build it, including the two ideal-version items (point-in-time stability + "N new" pill; day-grouping + burst-collapse). If there is later a product reason to present it differently, change the presentation, but build the capability.
- Search is GLOBAL top-N (verified in code), which is correct; keep it global, never per-stream-union.

## Open validation (next step, delegated)
Map every decision above to real-world SLVP products as SUPPORTIVE or NOT, reusing the corpus where possible and adding personal-data-timeline analogs (Google Timeline/Takeout, Rewind/Reflect, life-logging, personal vaults) which fit PDPP better than pure SaaS-observability analogs. Specifically pressure-test: (a) is a deep unified personal-data timeline the signature surface for a sovereignty product (or do even those tools split discovery from per-entity lists), (b) day-grouping + burst-collapse as the legibility pattern, (c) point-in-time + "N new" as the stability pattern, (d) global-top-N search + browse-door as the honest relevance pattern.
