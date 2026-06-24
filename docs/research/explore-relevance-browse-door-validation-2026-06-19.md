# Validation: Relevance-Search to Browse-Door Handoff

**Date:** 2026-06-19
**Scope:** Adversarial validation of one specific claim in docs/research/explore-full-visibility-spec-2026-06-19.md
**Status:** Complete -- cite this file for the verdict; do not relitigate without new evidence

---

## The Claim Under Validation

"When a user searches by RELEVANCE (semantic/hybrid/vector ranking) and wants to go EXHAUSTIVELY past the ranked candidate pool, the right product move is to switch them from search mode to BROWSING a specific source/stream (a time-ordered, fully-paginated list filtered to or scoped by their query) -- rather than deep-paginating the relevance ranking itself."

Falsification was attempted first. The question is whether real SLVP-tier products do THIS handoff, or do they do something else (deeper rank pages, query refinement only, no path at all)?

---

## Corpus Reused (read these; do not re-derive their findings)

- explore-search-relevance-pagination-prior-art-2026-06-19.md (hereafter: SEARCH-PA)
- explore-record-explorer-product-pattern-prior-art-2026-06-19.md (hereafter: RECORD-PA)
- explore-merged-timeline-pagination-prior-art-2026-06-19.md (hereafter: MERGE-PA)
- explore-slvp-recommendation-synthesis-2026-06-19.md (hereafter: SYNTH)

---

## Section 1 -- Key Questions and Evidence

### Q1: When a product ranks by relevance, can users reach the long tail, and how?

**Finding: Multiple paths exist depending on the product and the type of search. The dominant pattern is NOT deep relevance pagination; it is either (a) a sort switch to chronological order, (b) query refinement / facet filtering, or (c) a direct link to a scoped browsable list.**

#### Algolia

Algolia caps relevance pagination at 1,000 hits by default (maximum 20,000 with configuration). Above 20,000, the `browse` endpoint exists but Algolia's own documentation explicitly says browse is for back-end/non-user-facing use only -- it does not apply relevance ranking and is not a user experience path (https://support.algolia.com/hc/en-us/articles/5400135821841-How-do-I-paginate-with-browse-or-browseObjects). Algolia's user-facing answer to "I haven't found it" is query refinement with facet chips and post-query refinement suggestions, NOT a mode switch to a browsable sorted list (https://medium.com/design-bootcamp/post-query-refinement-suggestions-in-search-ux-and-an-algolia-demo-app-502eb9aa2fbd). Algolia does NOT offer a user-facing "switch to date-ordered browse" path -- the philosophy is "fix your query" not "switch modes." SEARCH-PA Section 2.1.

**Algolia verdict on the specific claim: PARTIALLY SUPPORTED. Algolia's answer is refinement, not a browse-door mode switch. But this is because Algolia's search context is typically a single bounded catalog -- the equivalent of one PDPP stream -- not a cross-source multi-stream federation where a browse door to a specific stream is meaningful.**

#### Slack

Slack is the strongest precedent for the specific "relevance vs. chronological" toggle pattern. Slack's `search.messages` API provides a `sort` parameter with two values: `score` (relevance) and `timestamp` (chronological). The UI exposes these as "Most Relevant" and "Most Recent" sort options. This is a LIVE, SHIPPED product pattern where the escape from relevance-ranked search is exactly a switch to chronological order.

Key facts from the Slack engineering blog (https://slack.engineering/search-at-slack/):
- "Recent search finds the messages that match all terms and presents them in reverse chronological order."
- "Relevant search relaxes the age constraint and takes into account the Lucene score of the document."
- Most Recent mode uses cursormark pagination (cursor-based, exhaustive) via `next_cursor` so the user CAN page through all matching messages in date order.

However, critical distinction: in Slack, the "Most Recent" mode is still a search-scoped result (messages matching the query terms, sorted by time). It is NOT a navigation to a specific channel's full message history. It is closer to "same query, different ranking" than "same query, switch to browse a specific container." The user remains in a filtered search view, not on a channel page.

**Slack verdict: STRONG SUPPORTING PRECEDENT for "sort toggle from relevance to chronological" but WEAKER for "switch to browsing a specific stream/container." The browse-door framing is a further abstraction from what Slack does.**

#### Gmail

Gmail's search results historically defaulted to relevance ordering and then, under user pressure, evolved. The mobile Gmail app now tests a toggle between "Most relevant" and "Most recent" beneath the search bar (https://www.phonearena.com/news/gmail-working-on-search-filters-to-help-you-find-what-youre-looking-for-more-easier_id164308). The web version does not have a native sort toggle; sorting by date within a search requires using `before:` / `after:` date operators to narrow to a time window, which is a query-refinement path rather than a mode switch.

Gmail search results ARE exhaustively pageable in both modes via the web UI's page arrows. When the user has enough results, they can page through all of them. The default ordering is relevance-weighted (with a "Top results" section above date-ordered results per support thread at https://support.google.com/mail/thread/351406016). Gmail does not offer a "switch to this specific folder's full inbox" CTA from a search result; it stays in the unified inbox/search frame.

**Gmail verdict: WEAK support for the browse-door specifically. Gmail does chronological reordering within search (query-constrained), not navigation to a specific sub-container. The mobile "Most relevant / Most recent" toggle is a near-match for Slack's pattern.**

#### Notion

Notion search explicitly offers four sort options: Best Matches (relevance-weighted), Last Edited Newest First, Last Edited Oldest First, Created Newest First, Created Oldest First (https://www.notion.com/help/search). Switching from "Best Matches" to "Last Edited: Newest First" is exactly the "sort from relevance to chronological" pattern, and with cursor-based API pagination (`next_cursor` in the search API, https://developers.notion.com/docs/working-with-page-content) the date-sorted results can be exhaustively retrieved.

Notion also offers linked database views on dashboards: a bounded "widget" preview on a dashboard links to the full database. This is the browse-door pattern -- but it is a database view pattern, not the search UI pattern. RECORD-PA Section 2.6 and SYNTH Section Q1.

**Notion verdict: STRONG SUPPORTING PRECEDENT for both the sort-switcher (relevance to date) AND the browse-door (widget preview links to full database).**

#### GitHub

GitHub search supports `sort:created`, `sort:updated`, and `sort:interactions` qualifiers (https://docs.github.com/en/search-github/getting-started-with-searching-on-github/sorting-search-results). The web UI's Sort dropdown includes Newest, Oldest, Most Recently Updated options alongside relevance. This allows users to switch from relevance ranking to chronological ordering within the search surface -- a near-identical pattern to Slack's toggle.

GitHub's web UI caps search at 5 pages; the API supports 1,000 results. Beyond that, GitHub has no "switch to a per-repo full list" CTA from global search. For per-repo lists, the Issues/PRs list pages are separately fully paginated -- but there is no automated handoff from global search to per-repo list. Users navigate there manually. MERGE-PA Section 2, RECORD-PA Section 2.4.

**GitHub verdict: SUPPORTS the relevance-to-date sort switch; weakly supports browse-door (per-repo page exists but no automated handoff from search).**

#### Elasticsearch / OpenSearch

Elasticsearch's relevance-ranked `search` with `from`/`size` hits a 10,000 result wall. For sorted results, `search_after` with a Point-in-Time (PIT) is the standard. To deep-paginate beyond 10,000 with relevance ranking, `search_after` on `(score, id)` is possible within a PIT but requires the PIT to remain open (server-side state). For RRF hybrid results, deep pagination beyond `rank_window_size` returns zero results -- there is no cursor (https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/).

Elasticsearch's documentation explicitly recommends: when the result window exceeds `index.max_result_window`, either use `search_after` with sorted results (which is a switch to a stable-sort ordering, not pure relevance) or use the scroll API (deprecated for new use; server-side state). The practical recommendation in ES docs is: if you need deep access to all matching documents, use a sorted field (timestamp, ID) -- which is exactly the "switch to chronological" pattern. SEARCH-PA Section 2.2.

**ES verdict: STRONG SUPPORT for the "switch to a stable sort (chronological) to exhaust" pattern at the API level. This is the documented expert recommendation from ES itself.**

#### Airtable Deep Match

Airtable's semantic-linked-record search ("Deep Match") surfaces "Top matches" -- the 20 most semantically similar records. It does NOT offer a path to "see all matches" at all; the UI labels the set explicitly as "Top matches" and the resolution is to use view filters to narrow the target set (https://support.airtable.com/docs/linking-records-in-airtable). SEARCH-PA Section 2.7.

**Airtable verdict: PARTIAL SUPPORT. Airtable does the "label the bound honestly" half but offers only filter-refinement, not a chronological browse-door, as the exhaustive path. For a linked-record use case this is reasonable; for a personal-data product it would be a dead-end.**

#### Meilisearch

Meilisearch explicitly discourages deep pagination of search results: "users should never need to go to page 2." Their recommended UX is a bounded top-N result set with query refinement affordances (https://www.meilisearch.com/docs/capabilities/full_text_search/how_to/paginate_search_results). No browse-door pattern is mentioned; the philosophy is "get search quality good enough that page 2 is never needed." SEARCH-PA Section 2.3.

**Meilisearch verdict: WEAK / IRRELEVANT to PDPP. This philosophy works for a product search where "50 blue shoes" is a sufficient result; it does not work for "all my overdraft records" where completeness is the bar.**

---

### Q2: Is "switch from relevance-search to chronological-browse to exhaust the set" an actual pattern in shipping products, or was it invented?

**Finding: The SORT SWITCH component (relevance -> chronological within the same search surface) is a real, shipped, multi-product pattern. The BROWSE-DOOR component (switch to a specific container's full paginated list) is a real but distinct pattern. The CLAIM conflates these two -- which are actually complementary, not synonymous.**

Real shipping examples of the SORT SWITCH pattern:
- Slack `search.messages` sort=score vs sort=timestamp (https://api.slack.com/methods/search.messages) -- most documented case
- Notion search: Best Matches vs Last Edited vs Created (https://www.notion.com/help/search)
- GitHub search Sort dropdown: Relevance vs Newest vs Oldest (https://docs.github.com/en/search-github/getting-started-with-searching-on-github/sorting-search-results)
- Gmail mobile: "Most relevant" vs "Most recent" toggle (in testing, https://www.phonearena.com/news/)
- Elasticsearch: from/size (relevance) vs search_after on timestamp+id (documented recommendation for exhaustive access)

Real shipping examples of the BROWSE-DOOR pattern (bounded summary -> per-entity full list):
- Stripe Activity Breakdown: summary row -> full filtered Payments list (https://docs.stripe.com/reports/activity-breakdown) -- RECORD-PA Section 2.2
- Notion dashboard: bounded widget -> full linked database -- RECORD-PA Section 2.6
- Datadog Log Explorer: scoped filter -> exhaustive filtered result (when narrow enough) -- RECORD-PA Section 2.1
- Linear "My Issues": scoped personal view -> per-project full list -- RECORD-PA Section 2.3

**These are TWO distinct patterns that often coexist. The claim under validation describes the BROWSE-DOOR pattern. The SORT SWITCH pattern is more commonly implemented and better documented. The browse-door is more commonly used for BROWSE surfaces (recent/time-range lenses) than for the search lens itself.**

---

### Q3: Is the more common pattern "refine the query/add filters" rather than a mode switch?

**Finding: Query refinement is the MORE common pattern in catalog/SaaS search, but it is NOT the only pattern, and it fails to satisfy the PDPP bar of "reach the complete set."**

- Algolia's primary recommendation for relevance overflow is post-query refinement (facets, filters). SEARCH-PA Section 2.1.
- Meilisearch's philosophy is "fix the query." SEARCH-PA Section 2.3.
- Airtable Deep Match offers view filters as the resolution. SEARCH-PA Section 2.7.

However, query refinement achieves "narrow the matching set" not "reach the full matching set." For "show me all records matching overdraft" the user wants completeness, not a narrower approximation of completeness. The PDPP product bar ("the owner can always reach the complete set") is a different bar from "give the user a good enough first page."

The more relevant analogies for PDPP are:
- Slack (communication archive): where "Most Recent" mode gives chronological exhaustive access
- Gmail (personal email archive): where the user DOES need to find every instance of something, not just the most relevant N
- Notion (personal knowledge base): where date-sorted view gives chronological exhaustive access

These are all PERSONAL ARCHIVE products where completeness matters, not CATALOG search where best-match sufficiency is the standard. PDPP is a personal archive product.

**Verdict on Q3: In catalog/SaaS search, refinement is more common than mode switch. In personal archive products, the sort switch (relevance to chronological) IS the pattern -- and the browse-door is the related but distinct pattern appropriate for browsing a known source.**

---

### Q4: For vector/semantic search specifically, is deep pagination meaningful?

**Finding: No. This is the one sub-claim that is most strongly supported by technical evidence from multiple independent sources.**

- HNSW (pgvector) ANN is a greedy graph traversal returning approximate top-K nearest neighbors. "Results 26-50" requires re-running with K=50 and discarding the first 25; there is no stable "position 26." SEARCH-PA Section 3.1.
- pgvector 0.8+ adds `hnsw.iterative_scan` but this re-runs the traversal with a larger candidate set bounded by `hnsw.max_scan_tuples`. Beyond that, an exact sequential scan is required. Source: https://neon.com/blog/understanding-vector-search-and-hnsw-index-with-pgvector
- RRF hybrid: fused rank scores are a function of position across both sub-lists. Deep pagination beyond the `rank_window_size` returns zero results in Elasticsearch. SEARCH-PA Section 3.2.
- Airtable Deep Match is explicitly bounded at "Top 20 matches" with no deeper access -- the canonical honest UX for ANN results.
- PDPP's own `rs-search-hybrid/index.ts` correctly rejects `cursor` parameter with `invalid_request` -- this is the right engineering decision. SEARCH-PA Section 3.2.

**Q4 verdict: STRONGLY SUPPORTED. Deep pagination of vector/hybrid results is not meaningful. The claim that "the right move is to switch to time-browse" rather than deep-paginate is technically correct for this case. There is no alternative that preserves honest semantics.**

---

## Section 2 -- Product Analog Deep Dive: Personal Archive vs. Catalog Search

The PDPP corpus uses Stripe/Linear/Vercel/Plaid as primary analogs. For the search-to-browse handoff specifically, better analogs are personal archive products.

### Rewind AI / Screenpipe (personal screen/audio archive)

Rewind AI / screenpipe captures all screen activity and makes it searchable locally. The product offers both:
- AI-powered search (semantic, query-driven, top-N results)
- Timeline browsing (chronological, per-time-window, exhaustive)

The user experience is: "search for something, find the relevant hits, then navigate the timeline for the surrounding context." This is exactly the search-to-browse handoff described in the claim. Source: https://skywork.ai/skypage/en/Rewind-AI-&-Limitless:-The-Ultimate-Guide-to-Your-Digital-Memory/1976181260991655936

### Google Timeline (location history)

Google Timeline is a pure browse surface (chronological map view of location history) with no relevance search mode. Relevant as a data point: for a personal data sovereignty product, the "see everything" surface is chronological browse, not ranked search. The search surface narrows to find; the timeline surface exhaustively navigates.

### Gmail (personal email archive)

Gmail is the most direct analog to PDPP for personal message data. Gmail's behavior:
- Default search: relevance-weighted with "Top results" section
- Mobile: "Most relevant" / "Most recent" toggle in active testing
- Web: date operators (`before:`, `after:`) as the query-refinement path to chronological narrowing
- Per-label/folder views: fully paginated, always date-ordered (the "browse" surface)
- No direct CTA from search results to "browse all in this label"

Gmail confirms the SORT SWITCH pattern (relevance -> recent within search) but does NOT implement a browse-door to a specific container. Users navigate to a label/folder manually when they want container-scoped browse.

---

## Section 3 -- Verdict on Each Sub-Claim

### Sub-claim A: "When searching by relevance, the path to exhaustive is switching to time-ordered browse, NOT deep-paginating the relevance ranking."

**STRONGLY SUPPORTED for hybrid/vector (ANN is not pageable; RRF is bounded). PARTIALLY SUPPORTED for lexical (lexical IS deep-pageable and PDPP already has `next_cursor` for it; the claim is accurate as a fallback when deep pagination hits limits, but for lexical PDPP should wire the existing cursor before adding a browse-door). Evidence: SEARCH-PA Sections 3.1-3.2; Elasticsearch `search_after` documentation; Algolia 20K cap.**

### Sub-claim B: "The right product move is to switch them to BROWSING a specific source/stream."

**PARTIALLY SUPPORTED. The shipping product precedents use a SORT SWITCH (same query, same result set, chronological order) more than a BROWSE DOOR (navigate to a specific container). Slack, Notion, GitHub, Gmail all implement sort-switch; Stripe and Notion implement the browse-door for SUMMARY->FULL-LIST navigation (not from search). The browse-door and sort-switch are complementary; the strongest approach ships both.**

**However, for PDPP specifically, the browse-door is the RIGHT design given PDPP's cross-source heterogeneous architecture:**
- PDPP search is cross-source; a "Most Recent" sort toggle across all sources is MERGE-PA's Phase 3 (the full k-way merged timeline) -- expensive to build.
- A browse-door to a specific source stream costs less and is more semantically coherent ("you searched for overdraft; here are all records in your USAA stream" is more useful than "here are all matches sorted by time across all your sources mixed together").
- Stripe and Notion use the browse-door pattern precisely when the result set is heterogeneous or multi-entity.

### Sub-claim C: "This is an ACTUAL pattern, not invented."

**SUPPORTED with nuance. The SORT SWITCH half is well-documented in shipping products (Slack, Notion, GitHub, Gmail). The BROWSE-DOOR half is documented in Stripe Activity Breakdown, Notion dashboard views, and Datadog (when narrow enough). Neither are invented. The combination (search returns top-N + a browse-door CTA to a specific container) is an accepted UX pattern; it just requires validating it is the right combination for PDPP's architecture specifically.**

### Sub-claim D: "Deep-paginating the relevance ranking is wrong / not the answer."

**STRONGLY SUPPORTED for hybrid/vector (technically unsound; ANN cannot be honestly deep-paginated; ES/OpenSearch agree). WEAKLY SUPPORTED for lexical (deep pagination of lexical IS sound and PDPP already has the infrastructure for it). The claim should be qualified: for hybrid/semantic, deep pagination is wrong; for lexical, deep pagination is correct and should be implemented.**

---

## Section 4 -- What Real Products Do: Summary Matrix

| Product | Relevance-to-Chronological Sort Switch | Browse-Door to Specific Container | Deep Relevance Pagination | Query Refinement |
|---|---|---|---|---|
| Slack | YES (sort=score vs timestamp; SHIPPED) | No | No (cursormark works on sorted results) | No |
| Notion search | YES (Best Matches vs Last Edited/Created) | YES (dashboard widget to database) | Bounded (cursor over ranked set, ~100 pages) | Partial (title filter) |
| GitHub | YES (Sort: Relevance/Newest/Oldest) | Manual (user navigates to per-repo list) | Capped (5 web pages, 1000 API) | YES (qualifiers) |
| Gmail | PARTIAL (mobile toggle in testing; date operators) | No direct CTA | YES (all pages pageable in web) | YES (date/from/to operators) |
| Algolia | No (browse=back-end only) | No | Capped at 1K-20K; browse endpoint is back-end | YES (facets, primary path) |
| Elasticsearch | YES (switch to sort field for search_after) | No | Capped at 10K via from/size; PIT+search_after for sorted | YES (filters) |
| Airtable Deep Match | No | Partial (view filters) | No (hard cap at Top 20) | YES (view filters) |
| Stripe | No search to begin with | YES (Activity Breakdown -> filtered list) | N/A | YES (API filters) |
| Meilisearch | No | No | Discouraged | YES (primary path) |

**Reading this matrix for PDPP:**
- Sort switch (relevance to date) within the search surface is the most broadly supported pattern (Slack, Notion, GitHub, Gmail). For PDPP this would mean a "Sort: Most Relevant / Most Recent" toggle on the search lens -- achievable via a sort switch on lexical results and a graceful fallback for hybrid.
- Browse-door (search to per-container full list) is supported by Stripe (strongest), Notion (dashboards). For PDPP this is the Phase 1 "escape ramp" pattern. It is correct AND complementary to the sort switch, not a replacement for it.
- The two patterns are additive; the SLVP ideal is: lexical gets Load-more + sort-switch option; hybrid gets honest "Top N" + browse-door CTA per matched stream; recent/time-range gets per-stream "See all N" escape ramps.

---

## Section 5 -- Corrections and Strengthening of the Spec

### 5.1 Correction: The spec over-relies on "browse door" and under-specifies "sort switch"

The spec (Phase 2) describes: "for hybrid/semantic -- frame honestly as 'Top matches' and offer a 'See all records in stream' door." This is correct but incomplete. The sort-switch path (switch to lexical-sorted-by-date) is also a real escape and should be explicitly offered. When the user wants "all overdraft records by date," the lexical-then-sort path gives them that within the search surface without navigating away.

Recommended addition: the search lens should offer a sort toggle (Most Relevant / Most Recent) that switches lexical results to timestamp ordering and allows Load-more on the chronological result set. This is the Slack pattern and the Notion pattern.

### 5.2 Confirmed: Browse-door is correct for hybrid

The browse-door to a specific stream is the RIGHT design for hybrid/semantic because:
(a) ANN results cannot be honestly deep-paginated (Section 3 above)
(b) The stream is the natural "container" for context -- PDPP's per-stream records page already exists and is SLVP-quality
(c) Stripe's "Activity Breakdown -> filtered full list" is the closest SLVP analog

### 5.3 Confirmed: Lexical Load-more is missing (true gap)

The PDPP assembler discards the lexical `next_cursor` (explore-data-assembler.ts:809). Wiring Load-more for lexical is the smallest-cost highest-value gap. Both the spec and the corpus agree on this. It is a confirmed gap, not hypothetical.

### 5.4 New finding: Personal archive products validate "completeness as the bar"

Rewind AI / screenpipe validate that for personal archive products (not catalog SaaS), the UX bar IS completeness, not best-match sufficiency. The browse-door pattern is appropriate for personal data sovereignty products and is not over-engineered. The Meilisearch "users never need page 2" philosophy is WRONG for PDPP's use case.

---

## Section 6 -- Overall Verdict

**VERDICT: PARTIALLY SUPPORTED -- specifically the hybrid/vector sub-case is STRONGLY SUPPORTED; the lexical sub-case needs qualification; the overall browse-door framing is correct but should be paired with the sort-switch pattern.**

**Strongest real-product precedents supporting the claim:**
1. **Slack search.messages sort=timestamp** (https://api.slack.com/methods/search.messages): The definitive "switch from relevance to chronological to exhaust" shipped pattern. Exhaustive via cursormark. Used by millions of users daily.
2. **Stripe Activity Breakdown -> filtered Payments list** (https://docs.stripe.com/reports/activity-breakdown): The definitive browse-door pattern: bounded preview + one-click to the full filtered paginated list. Stripe is the primary SLVP reference.
3. **Notion Best Matches -> Last Edited sort** (https://www.notion.com/help/search) + dashboard widgets -> linked databases: Both the sort-switch AND the browse-door pattern in one product.
4. **Elasticsearch search_after on (score+id) vs timestamp+id with PIT** (https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results): The technical authority that deep relevance pagination is bounded; exhaustive access requires switching to a stable sort.

**What is NOT supported:**
- The claim that "browse door" is the ONLY or PRIMARY escape; sort-switch within the search surface is equally valid and more broadly implemented (Slack, Notion, GitHub, Gmail all do sort-switch).
- The claim applies to lexical search as cleanly as to hybrid. Lexical CAN be deep-paginated and should be (via existing `next_cursor`). The browse-door is the right fallback but should not replace Load-more for lexical.

**Implication for the spec:**
- Phase 2 is correct in its browse-door design for hybrid. No redesign needed.
- Phase 2 should ADD a sort-switch (Most Relevant / Most Recent) to the search lens for lexical results. This is the Slack/Notion pattern and is missing from the current spec.
- The no-fake clause ("do not add a non-working Load-more on hybrid; use the stream door instead") is correct and well-grounded.
- The lexical Load-more is a confirmed gap and should be the highest-priority P2 implementation task.

---

## Sources

### Corpus (primary -- reused extensively)
- explore-search-relevance-pagination-prior-art-2026-06-19.md
- explore-record-explorer-product-pattern-prior-art-2026-06-19.md
- explore-merged-timeline-pagination-prior-art-2026-06-19.md
- explore-slvp-recommendation-synthesis-2026-06-19.md

### New research conducted for this validation

**Slack:**
- Search at Slack engineering blog: https://slack.engineering/search-at-slack/
- search.messages API (sort, cursormark): https://api.slack.com/methods/search.messages
- Evolving API Pagination at Slack: https://slack.engineering/evolving-api-pagination-at-slack/

**Gmail:**
- Gmail search result order community thread: https://support.google.com/mail/thread/351406016/gmail-search-has-a-frustrating-order-not-date
- Gmail "Most relevant/Most recent" toggle in testing: https://www.phonearena.com/news/gmail-working-on-search-filters-to-help-you-find-what-youre-looking-for-more-easily_id164308
- Gmail community on non-chronological search: https://support.google.com/mail/thread/367801531/gmail-search-result-no-longer-chronologogical

**Notion:**
- Notion search help (sort options): https://www.notion.com/help/search
- Notion API search endpoint: https://developers.notion.com/docs/working-with-page-content

**GitHub:**
- Sorting search results: https://docs.github.com/en/search-github/getting-started-with-searching-on-github/sorting-search-results
- GitHub search pagination cap discussion: https://github.com/github/docs/issues/35831

**Algolia:**
- Browse endpoint (back-end only): https://support.algolia.com/hc/en-us/articles/5400135821841-How-do-I-paginate-with-browse-or-browseObjects
- Post-query refinement UX: https://medium.com/design-bootcamp/post-query-refinement-suggestions-in-search-ux-and-an-algolia-demo-app-502eb9aa2fbd

**Personal archive analogs:**
- Rewind AI / Screenpipe: https://skywork.ai/skypage/en/Rewind-AI-&-Limitless:-The-Ultimate-Guide-to-Your-Digital-Memory/1976181260991655936
- Screenpipe open-source: https://rewind.sh/

**Elasticsearch / OpenSearch:**
- ES pagination (from/size cap, search_after): https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results
- OpenSearch RRF (rank_window_size cap): https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/

### PDPP code grounding (read-only, no edits)
- reference-implementation/operations/rs-search-hybrid/index.ts (cursor rejection, invalid_request)
- reference-implementation/operations/rs-search-lexical/index.ts:1136 (next_cursor in envelope)
- packages/operator-ui/src/explore/explore-data-assembler.ts:809 (cursor discarded)
- packages/operator-ui/src/explore/explore-data-assembler.ts:849 (search_page_limited warning)
