# Explore Spec: SLVP Product-Mapping Verdict Table

**Date:** 2026-06-19
**Status:** Definitive synthesis -- cite this file; do not relitigate without new evidence
**Source documents:**
- explore-relevance-browse-door-validation-2026-06-19.md (hereafter: BROWSE-DOOR)
- explore-unified-personal-timeline-validation-2026-06-19.md (hereafter: TIMELINE)
- explore-timeline-legibility-stability-validation-2026-06-19.md (hereafter: LEGIBILITY)
- explore-escape-ramps-global-search-validation-2026-06-19.md (hereafter: ESCAPE)
- Spec being validated: explore-full-visibility-spec-2026-06-19.md

---

## LEAD FINDING: The one decision that is not fully supported

**P2 Relevance Browse-Door is PARTIALLY SUPPORTED.** The browse-door (search result -> specific stream's full paginated list) is a correct and real pattern, but the prior art shows the SORT SWITCH pattern (same query, switch to chronological order within the search surface) is MORE broadly implemented and better documented. The spec currently specifies the browse-door for hybrid/semantic search but does not specify a sort toggle for lexical search. Both patterns are real, complementary, and the spec is missing the sort-toggle half. See Decision 3 for the full breakdown and the spec correction it implies.

All other decisions are SUPPORTED or SUPPORTED WITH NUANCE. No decision is unsupported or requires redesign of its core mechanism.

---

## Verdict Table

| # | Spec Decision | Verdict | Strongest Named Precedents | Citation |
|---|---|---|---|---|
| 1 | **P1 Escape ramps** -- every bounded stream slice shows exact full count + one-click "See all N" link to per-stream paginated list | **SUPPORTED** | Stripe Activity Breakdown; Notion dashboard widgets | ESCAPE Section A |
| 2 | **P2 Lexical Load-more** -- wire the discarded `next_cursor` to a working "Load more results" control for keyword search | **SUPPORTED** | Slack `search.messages` cursormark (exhaustive via cursor); Elasticsearch `search_after` on timestamp+id; Notion search `next_cursor` API | BROWSE-DOOR Sections 1, 5.3 |
| 3 | **P2 Relevance Browse-Door (THE contested one)** -- for hybrid/semantic search, offer a "See all records in stream" door rather than fake deep pagination | **PARTIALLY SUPPORTED** | Stripe Activity Breakdown (browse-door); Slack sort=timestamp (sort-switch); Notion Best Matches -> Last Edited (sort-switch + browse-door) | BROWSE-DOOR Sections 2-4, 6 |
| 4 | **P3 Unified deep timeline as signature surface** -- a single cross-source time-ordered feed pageable to the beginning is the primary surface for a sovereignty product | **SUPPORTED** | Google My Activity (unified cross-service, deeply paginated, day-grouped, sovereignty-framed, default view); Google Timeline (unified, deeply paginated, sovereignty core); Rewind (unified personal memory, sovereignty inseparable from timeline) | TIMELINE Sections 1-3, Q1-Q4 |
| 5 | **P3 Day-grouping + burst-collapse** -- records grouped by calendar day; high-volume same-stream bursts collapse into one expandable group | **SUPPORTED** | Google Photos (day headers + Photo Stacks burst collapse); WhatsApp/Slack/iMessage (universal day divider); GitHub "pushed N commits" aggregation; Outlook "Today/Yesterday" grouping | LEGIBILITY Section A |
| 6 | **P3 Point-in-time stability + "N new" pill** -- composite cursor anchored to a snapshot time; new data surfaces as a count pill, not silent auto-insert | **SUPPORTED** | Twitter/X "N new tweets" pill (definitive: auto-refresh was explicitly abandoned as a failure); Elasticsearch PIT + search_after; Slack `latest` timestamp ceiling | LEGIBILITY Section B |
| 7 | **Global top-N search** -- one global ranked call across all owner data, not per-stream union with per-source quotas | **SUPPORTED** | Algolia (global ranking is the core product invariant); Elasticsearch (single multi-index query, global score merge); Slack search.messages (global across all channels) | ESCAPE Section B |

---

## Decision-by-Decision Narrative

### Decision 1: P1 Escape Ramps -- SUPPORTED

Every SLVP product examined separates a bounded discovery feed from a fully-paginated per-entity list and provides a counted, one-click escape from the former to the latter.

**Strongest precedents:**
- **Stripe Activity Breakdown** (docs.stripe.com/reports/activity-breakdown): each bounded summary row links to the full filtered Payments list showing every contributing transaction. This is the direct analog to PDPP's "stream group with has_more -> See all N link to per-stream records page."
- **Notion dashboard widgets** (notion.com/help/guides/when-to-use-each-type-of-database-view): bounded preview widget shows count; one click opens the full linked database. Launched 2026.

**Anti-pattern confirmed:** Datadog Log Explorer caps at 1,000 with no inline exit -- the passive caption at `records-explorer-view.tsx:349` ("select a row to open that stream's full records") has exactly this shape and is confirmed by corpus as the anti-pattern.

**Implication:** P1 is a no-brainer. The per-stream records page already exists and is SLVP-quality; the only gap is wiring the "See all N" link.

---

### Decision 2: P2 Lexical Load-more -- SUPPORTED

Deep pagination of lexical (keyword) search results is technically sound and well-implemented in shipping products. PDPP already has `next_cursor` in the lexical search response envelope (`rs-search-lexical/index.ts:1136`) -- the assembler discards it (`explore-data-assembler.ts:809`). Wiring it is the smallest-cost highest-value P2 gap.

**Strongest precedents:**
- **Slack `search.messages` with `sort=timestamp`** (api.slack.com/methods/search.messages): cursormark-based pagination, fully exhaustive.
- **Elasticsearch `search_after` on (timestamp, id)**: the documented expert recommendation for exhaustive access to keyword search results beyond the 10,000-result window.
- **Notion search `next_cursor`** (developers.notion.com/docs/working-with-page-content): cursor-based exhaustive pagination of lexical search results.

---

### Decision 3: P2 Relevance Browse-Door -- PARTIALLY SUPPORTED (read carefully)

**This is the decision Tim flagged and where the validation found the most nuance.**

**The sub-claim that IS strongly supported:** For hybrid/semantic (vector) search, deep pagination is not meaningful. ANN (HNSW/pgvector) cannot be honestly deep-paginated -- "position 26" in an ANN result is not stable. RRF hybrid is bounded by `rank_window_size` (OpenSearch's own docs). PDPP's `rs-search-hybrid/index.ts` correctly rejects the `cursor` parameter with `invalid_request`. The spec's no-fake clause ("do not add a non-working Load-more on hybrid") is correct and well-grounded.

**The sub-claim that is only partially supported:** "The escape from relevance-search is switching to browsing a specific source/stream" -- this is correct but incomplete. The prior art shows TWO real patterns:

**Pattern 1 -- Sort Switch (more broadly implemented):**
Slack (sort=score vs sort=timestamp), Notion (Best Matches vs Last Edited), GitHub (Sort: Relevance/Newest/Oldest), Gmail mobile ("Most relevant / Most recent") all implement a toggle from relevance ordering to chronological ordering within the SAME search surface. The user stays in search; the results re-sort chronologically and become exhaustively pageable.

**Pattern 2 -- Browse-Door (the pattern the spec names):**
Stripe Activity Breakdown (summary -> full filtered list), Notion dashboard widget -> linked database, Datadog (when narrowed enough). This is documented and real, but it is more commonly used for BROWSE surfaces (bounded preview -> per-entity list) than as the primary escape from the search lens.

**What the validation concluded for PDPP specifically:**
The browse-door is the RIGHT design for hybrid/semantic because PDPP's cross-source architecture makes the sort-switch expensive (a chronological sort across all sources IS the Phase 3 k-way merge), and the per-stream records page already exists as the SLVP-quality browse destination. Stripe's Activity Breakdown is the closest SLVP analog.

**What the spec is currently missing:** A sort-toggle (Most Relevant / Most Recent) on the LEXICAL search lens. Lexical results CAN be sorted chronologically and paged exhaustively. The Slack/Notion/GitHub pattern says: give the user both the relevance view (Load-more cursor) AND a sort-switch to date order. The spec specifies Load-more for lexical but does not specify the sort-switch. These are additive; both should ship.

**Summary for this decision:**
- Hybrid/semantic: browse-door STRONGLY SUPPORTED. No redesign needed.
- Lexical: Load-more SUPPORTED + sort-switch (Most Relevant / Most Recent) MISSING FROM SPEC. Add it.
- No-fake clause on hybrid: CORRECT.

---

### Decision 4: P3 Unified Deep Timeline as Signature Surface -- SUPPORTED

**Prior synthesis under-fit PDPP's category.** The prior SLVP synthesis (Stripe/Datadog/GitHub/Linear) concluded "do not build a unified firehose as primary surface." That conclusion is correct for SaaS/observability products where the data is about the company's objects (payments, logs, repositories). It under-fits PDPP where the owner IS the data subject and the primary question is "what is the story of my data life."

**Strongest precedents:**
- **Google My Activity** (myactivity.google.com): unified cross-service chronological timeline is the DEFAULT view; per-service filter is secondary. Deeply paginated to account creation. Day-grouped. Sovereignty/control framing is explicit and central. This is the closest product analog to PDPP.
- **Google Timeline** (support.google.com/maps/answer/14169818): unified location history, navigable through years, day-grouped, sovereignty-framed ("You're in control").
- **Rewind** (original Mac app): unified personal device memory, sovereignty proposition inseparable from the unified timeline. The browse surface IS the sovereignty surface -- they reinforced each other.
- **Facebook Activity Log** (facebook.com/help/930396167085762): all Facebook actions interleaved in one unified timeline, deeply paginated to account creation, per-feature filter secondary.

**The structural argument:** You cannot meaningfully exercise data sovereignty if you can only see your data in per-source silos. The unified view IS the sovereignty view. Google, Rewind, and Facebook all confirm this: sovereignty framing INCREASES centrality of the unified timeline rather than arguing for per-source splits.

**Nuance:** Even Google My Activity provides a per-service filter as a secondary narrowing. PDPP's per-stream records pages (Phase 1 escape ramps) are the correct analog for this secondary drill-down. The spec already accounts for this.

---

### Decision 5: P3 Day-Grouping + Burst-Collapse -- SUPPORTED

**This is the most universally-agreed decision in the corpus.** No SLVP-tier product presents a high-volume chronological feed without day-grouping. No counter-precedent found.

**Strongest precedents:**
- **Google Photos** (medium.com/google-design/google-photos-45b714dfbed1): day headers (Year/Month/Day hierarchy) plus Photo Stacks burst-collapse (visually similar same-cluster photos become one expandable tile). Direct domain match: personal media timeline at 40,000+ items.
- **WhatsApp / Slack / iMessage**: "Today / Yesterday / [date]" day dividers are a universal invariant in all major messaging timelines. The pattern is so established that open-source frameworks (Stream Chat Flutter, MessageKit) file feature requests when they ship without it.
- **GitHub "pushed N commits"**: same-push event commits collapse into one aggregated activity feed row.
- **Microsoft Outlook "Today / Yesterday / Last Week"**: standard default inbox grouping, ON by default, confirmed by widespread user requests to disable it.

**On burst-collapse threshold:** The only open question is the product-level definition of what constitutes a "burst." The corpus offers: Google Photos (visual similarity), Datadog (log pattern clustering), GitHub (push event boundary), Inbox by Gmail (topic category). For PDPP, the natural burst boundary is: same (connection, stream, calendar day). If WhatsApp produces 500 messages on Tuesday, they appear as "Tuesday -- WhatsApp Messages (500, expandable)" rather than 500 rows. This is consistent with all precedents.

---

### Decision 6: P3 Point-in-Time Stability + "N New" Pill -- SUPPORTED

**Strongest precedents:**
- **Twitter/X "N new tweets" pill**: direct analog. Top-most-recent feed. User-controlled refresh. Snapshot cursor. Crucially: Twitter explicitly ABANDONED auto-insert (which scrambled reading position) and replaced it with this pill. The history of the decision is documented: auto-refresh was tried, users hated losing their place, the industry converged on the pill. This is not a preference; it is a documented correction of a known failure mode.
- **Elasticsearch PIT (Point-In-Time) + search_after** (elastic.co/guide/en/elasticsearch/reference/current/point-in-time-api.html): freezes index state at a timestamp; all pages see the same snapshot. The engineering mechanism the spec's composite cursor `ceil` field implements.
- **Slack `latest` timestamp ceiling** (slack.engineering/evolving-api-pagination-at-slack/): `conversations.history` accepts a `latest` Unix timestamp upper bound pinning the snapshot ceiling per page. Identical soft-snapshot mechanism.
- **Datadog / AWS CloudWatch / Google Cloud Logging**: live tail pauses when user scrolls or selects a row; explicit "Restart streaming" affordance re-enables live updates. The pause-on-read pattern is universal for live monitoring feeds.

**Nuance from TIMELINE validation:** Google My Activity does not show a "N new" pill -- it loads a fresh snapshot on each visit. For PDPP, new data arrives via scheduled ingestion (not real-time), so the freshness problem is less acute than for a live chat stream. The snapshot cursor is the more critical correctness requirement; the "N new" pill is a polish layer on top of an already-correct mechanism.

---

### Decision 7: Global Top-N Search -- SUPPORTED

**PDPP's current implementation is already correct.** The validation confirms it.

**Strongest precedents:**
- **Algolia**: global ranking is the core product invariant. Per-index federation uses multi-query, not per-index quotas in the merged result.
- **Elasticsearch**: single multi-index query, global score merge across all shards. No per-index quota.
- **Slack `search.messages`**: global across all channels; the message from the most relevant channel ranks #1 regardless of how many results from that channel already appear.

**Critical distinction for future UI work:** GitHub and Slack GROUP results by type/channel as a PRESENTATION layer for scannability (Issues tab, PRs tab; messages grouped by channel). This is fine and does not distort ranking -- within each group the results are globally ranked. What is bad is a per-source QUOTA that caps how many results from a high-volume source can appear in the ranked list. No SLVP product uses quotas. Future UI work that groups Explore search results by stream for scannability (e.g., "Chase Transactions (8 matches)" then "Amazon Orders (3 matches)") is fine as long as the ranking within each group is global and the groups are not pre-capped.

---

## Decisions That Need Spec Correction

Only one spec amendment is indicated by this validation:

**Add sort-toggle to the P2 lexical search lens.** The spec currently specifies Load-more for lexical (correct) and browse-door for hybrid (correct). It does not specify a "Most Relevant / Most Recent" sort toggle for the lexical lens. The Slack/Notion/GitHub pattern says: offer both. The sort-switch gives the user chronological exhaustive access within the search surface without navigating to a specific stream. For PDPP this is a secondary path (since Load-more already provides exhaustive access in relevance order), but it is the expected pattern and it is cheap to add once Load-more is wired.

**No other decisions require redesign.** The browse-door for hybrid is correct. The unified timeline is the right signature surface. Day-grouping + burst-collapse and the "N new" pill are both well-grounded.

---

## What Is NOT Supported (and Why It Does Not Require Redesign)

Nothing in the spec is technically unsupported or requires architectural change. The one partial finding (browse-door) identifies a complementary pattern that is missing FROM the spec rather than a flaw in the spec's existing design. The browse-door for hybrid is correct; the sort-switch for lexical should be added alongside Load-more, not instead of it.

---

## Summary: Support Level by Decision

- P1 Escape ramps: **SOLID**
- P2 Lexical Load-more: **SOLID**
- P2 Relevance Browse-Door (hybrid): **SOLID** (the contested half is strongly supported for hybrid/vector; the nuance is that sort-switch should be added for lexical)
- P3 Unified deep timeline as signature surface: **SOLID** (personal-data-sovereignty analogs uniformly confirm; prior SaaS synthesis under-fit the category)
- P3 Day-grouping + burst-collapse: **SOLID** (universal pattern, zero counter-precedent)
- P3 Point-in-time + "N new" pill: **SOLID** (Twitter's abandonment of auto-refresh is the definitive prior art)
- Global top-N search: **SOLID** (already implemented correctly; validation is confirmatory)
