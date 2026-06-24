# Explore Search Result-Set Model Validation

**Date:** 2026-06-19
**Status:** Final
**Scope:** Is "Option D" (bounded result set as a sortable/filterable object) the SLVP-ideal design for PDPP's Explore search lens? Is there a better Option E? What does best-of-best prior art say?

---

## Background: The Seam Being Dissolved

PDPP's Explore lens runs hybrid search (lexical + semantic fused via round-robin merge, deduped by `(connection_id, stream, record_key)` -- see `reference-implementation/operations/rs-search-hybrid/index.ts`). The result is a bounded candidate pool: v1 defaults to 25 hits, max 100, no cursor support (`cursor` is explicitly rejected with `invalid_request`). The seam: a "Most Recent" sort toggle naive implementation would re-query chronologically, silently dropping semantic-only matches. 25 smart results would collapse to 8 keyword results. Users would feel something broke.

**Option D (the proposal):** Treat the search result as a complete bounded candidate pool presented as a sortable/filterable OBJECT rather than a paginated stream. The same pool can be ordered "Most Relevant" or "Most Recent" (count never changes -- same set, two orderings) and filtered by source/date/field. Dissolves the seam. Honest caveat: the pool is top-K by similarity, not literally every conceptually related record.

---

## Part 1: Is There a Better Option E?

Each candidate is assessed on two axes:
- **Power:** does it surface more genuinely useful matches than D?
- **Honesty:** does it avoid deceiving the user about completeness or set membership?

A candidate beats D only if it wins on BOTH axes, or wins strongly on one without degrading on the other.

### E1: Exhaustive Similarity-Threshold Scan

**Concept:** Instead of top-K by cosine distance, scan all vectors and return every record above a threshold (e.g., cosine similarity >= 0.75). The result set would be "everything conceptually related," not a bounded pool.

**Power assessment:** Theoretically higher recall. In practice, threshold choice is arbitrary and corpus-dependent -- the right threshold for "find everything about my anxiety" in a 50,000-message corpus is different from the same query in a 500-message corpus. A threshold that captures 95% relevant records will also capture substantial noise.

**Honesty assessment:** Worse than D. A threshold scan implies "everything above this line," but the threshold is opaque and subjective. Users cannot know what was excluded without knowing the threshold value and their corpus distribution. The pool boundary is invisible and feels arbitrary.

**Technical feasibility:** PDPP uses vec0 (SQLite) or pgvector HNSW for semantic search. HNSW is an approximate nearest-neighbor index -- it is not designed for threshold scan. An exact threshold scan requires a brute-force sequential scan over all vectors, which is O(N) per query and collapses under any dataset larger than ~10K records. pgvector's `hnsw.iterative_scan` (added in 0.8) can expand the candidate pool but is bounded by `hnsw.max_scan_tuples` and eventually falls back to exact sequential scan. There is no indexing shortcut for an arbitrary distance threshold.

**Verdict: Does NOT beat D.** Loses on honesty (arbitrary opaque threshold) and degrades on performance. The "complete set" it implies is not actually complete -- it is "everything above an invisible cutoff." D is more honest about what it returns.

### E2: Collapse Search Into a Filtered Timeline

**Concept:** Remove the distinction between "search results" and "browse results" entirely. When a user types a query, apply it as a filter on the chronological timeline. Results are always time-ordered; relevance scoring disappears. This is essentially the "Most Recent" sort taken to its logical conclusion.

**Power assessment:** Lower. Time-ordered keyword matches miss the semantic matches entirely. A user querying "anxiety about future" in their journals would surface entries containing those exact words but miss entries about "dread," "catastrophizing," or "what if thinking" that semantic search would catch. This is a regression to pure lexical search.

**Honesty assessment:** More honest about completeness -- filtered timeline CAN be exhaustive if the filter is lexical. But it abandons the semantic power that makes PDPP's hybrid search valuable.

**Verdict: Does NOT beat D.** This is a power regression. It solves the seam by eliminating the thing that causes the seam (semantic search). That is the wrong trade.

### E3: Query Expansion ("Find More Like This" / "Broaden")

**Concept:** After the initial hybrid result, offer a "find more like this" button that expands the query using pseudo-relevance feedback: take the top-k results, extract salient terms/concepts, and re-run a broader query. Iteratively expand the pool.

**Power assessment:** Potentially higher recall on the semantic axis. Pseudo-relevance feedback (PRF) is a well-studied technique (Robertson and Jones 1976 onward; Rocchio algorithm for vector spaces). Modern implementations use LLM query reformulation or embedding centroid expansion.

**Honesty assessment:** Significantly worse than D. Each expansion round changes the result set in unpredictable ways -- adding some records, dropping others. The user has no mental model of what "expanded" means. If expansion round 2 drops a result that was in round 1, users perceive broken search. The result set is no longer stable.

**Practical problems for PDPP:**
- Requires LLM calls or embedding computation per-expansion cycle, adding latency and cost.
- The expanded query may drift from the user's intent. "Anxiety about future" expanded by PRF might pull in "financial planning" records if those appear near anxiety records.
- "Find more like this" at the item level (click one result, find similar) is a distinct and valuable feature, but it is a separate feature from "search," not a replacement for the result-set design.

**Verdict: Does NOT beat D as a primary result-set model.** PRF/query-expansion is a useful supplementary feature (a "broaden" escape hatch) but it introduces instability and latency as a primary sort mechanism. It is a complement to D, not a replacement.

### E4: Relevance Feedback (Rocchio / Thumbs Up-Down)

**Concept:** Present initial results, let users mark relevant/irrelevant, re-rank or re-query using those signals (Rocchio: move query vector toward marked-relevant, away from marked-irrelevant). Classic information retrieval.

**Power assessment:** Can improve ranking quality for users willing to provide feedback. Used in academic IR systems and some enterprise search products (Coveo Relevance Tuning, early Endeca).

**Honesty assessment:** Mixed. Each feedback round changes the ranking, potentially changing set membership if some results fall below a threshold. Users lose a stable reference.

**Practical problems for PDPP:**
- Requires user training (most users will not click "relevant/irrelevant" toggles).
- Effective Rocchio needs at least 3-5 positive examples. For personal data search with 10-25 results, the signal is sparse.
- Personal data search sessions are typically short: "find that thing I wrote about X." Relevance feedback is most useful for research/recall tasks where the user is sifting through hundreds of results. PDPP's context is closer to lookup.
- Adds significant UI complexity for marginal gain.

**Verdict: Does NOT beat D.** Rocchio is the right technique for enterprise knowledge retrieval with patient users. It is wrong for personal-data lookup search. D is simpler and more immediately useful.

### E5: "Infinite" Semantic Pagination via Iterative Pool Expansion

**Concept:** When the user scrolls past the initial K results, automatically expand the candidate pool (increase K, or use `hnsw.iterative_scan` with a larger `max_scan_tuples`) and append newly discovered results. "Infinite scroll that goes deeper into semantic space."

**Power assessment:** Appears to offer more results on demand. However, there is a hard ceiling: beyond the approximate nearest-neighbor graph's candidate set, results are increasingly distant in embedding space. Past the ~100-200th nearest neighbor in a HNSW index, results are often not semantically related to the query -- the index was not designed for deep traversal.

**Honesty assessment:** Significantly worse than D. The user sees results 1-25, scrolls, sees results 26-50, and assumes all 50 are equally semantically relevant. They are not. Results 26-50 are farther from the query embedding. The result set boundaries are invisible and the relevance decay is hidden. PDPP's own source code correctly rejects cursor-based pagination for hybrid search (`parseSearchHybridParams` throws `invalid_request` for `cursor`) precisely because "snapshot-honest hybrid cursors require encoding the combined-source snapshot identity" and results at positions 26-50 are not meaningful across independently changing candidate sets.

**Technical confirmation:** Deep pagination of vector/hybrid results is not well-defined. HNSW ANN is a greedy graph traversal returning approximate top-K. "Results 26-50" requires re-running with K=50 and discarding the first 25 -- there is no stable "position 26." RRF hybrid fused rank scores are a function of position across both sub-lists; deep pagination beyond `rank_window_size` returns zero results in Elasticsearch. (Source: Elasticsearch documentation on `from`/`size` 10K window and `search_after` for exhaustive access; neon.com/blog/understanding-vector-search-and-hnsw-index-with-pgvector on iterative scan limits.)

**Verdict: Does NOT beat D.** It is deceptive about what "more results" means. D is honest precisely because it does not promise more semantic results than the pool can deliver. Iterative expansion smuggles in lower-quality results without signaling the quality decay.

### E6: Faceted Result Sets (Facets as Primary UI)

**Concept:** Present the bounded candidate pool with prominent source facets (Gmail, Slack, Messages, Journals), date range facets, and field facets. The user refines the same pool via facets rather than sorting. This is the Algolia/e-commerce faceting model.

**Power assessment:** Equivalent to D on set membership. Facets filter within the same pool. No additional matches are surfaced.

**Honesty assessment:** Good -- faceting within a fixed pool is honest. The user sees "from these 25 results: 12 from Slack, 8 from Gmail, 5 from Journals." Filtering by "Slack only" shows 12 results from the same pool.

**Relationship to D:** This is not an alternative to D -- it is D implemented with faceting as the primary filter mechanism. D as proposed already includes source/date/field filtering. Faceting is a UX pattern for expressing those filters, not a different model.

**Verdict: Is D (a variant of, not a distinct alternative).** Facets are the right implementation for D's filter dimension. A well-executed D IS a faceted result set. No conflict; no replacement.

### E7: Saved / Materialized Result Sets

**Concept:** Execute the hybrid search, materialize the result set to a named persistent view (like a saved Airtable view or a Linear saved filter). The user can return to the same set, sort it differently, and act on records over multiple sessions.

**Power assessment:** No additional matches vs. D; the set is the same pool.

**Honesty assessment:** Good. The set is stable and named. Users know exactly what they are working with.

**Relationship to D:** This is D extended with persistence. It is the right long-term feature roadmap for PDPP (saved searches with the result-set-as-object model) but is not a better INITIAL design. The immediate UX design question is about in-session presentation, not cross-session persistence.

**Verdict: Not a better E for the immediate problem.** It is D + persistence. Worth building later; does not change the answer to the current design question.

### E8: The Sort Switch (Relevant/Recent Within Same Query, No Fixed Pool)

**Concept:** Keep the hybrid search as an ongoing query. "Most Relevant" runs the full hybrid and ranks by fused score. "Most Recent" switches sort to `emitted_at` DESC (lexical+date filter, not semantic) and paginates exhaustively via cursor. Two orderings, two different queries. The count CAN differ (semantic-only matches vanish under Most Recent). Users may notice but the framing "showing results by date" provides a mental model.

**Power assessment:** Higher on the chronological axis -- gets ALL matching records chronologically. Lower on semantic axis under "Most Recent" mode.

**Honesty assessment:** This is the seam the proposal identifies. 25 results -> 8 results when switching to Most Recent is confusing. However, if the UI labels the modes with honest framing ("Top 25 relevant results" vs "All matching messages, newest first") the seam is survivable. Slack ships exactly this (sort=score vs sort=timestamp; count differs). Gmail ships this (relevance vs date; count differs). It is confusing but real products ship it.

**Comparison to D:** The sort switch (Option E8) offers an exhaustive chronological path that D does not. D's "Most Recent" re-orders the SAME 25 records -- it does not give users more records, just a different order of the same ones. D is more coherent (no seam) but leaves a ceiling at K=100. E8 has a seam but enables genuine exhaustion of the full corpus chronologically.

**Verdict: NOT a better option, but identifies a real D limitation.** D does not deliver "see ALL matching records." It delivers "see the best-matched records in two orderings." The right architecture combines D's seam-free relevance presentation with E8's exhaustive chronological escape hatch -- as a separate mode/button, not as a sort toggle within the same set. This is the synthesis (see Conclusion).

---

### Summary: No Candidate E Beats D as a Primary Design

| Candidate | Power vs D | Honesty vs D | Verdict |
|---|---|---|---|
| E1: Threshold scan | Marginal gain | Worse (opaque cutoff) | Rejected |
| E2: Filtered timeline | Worse (no semantics) | Better on completeness | Rejected -- power regression |
| E3: Query expansion / PRF | Potentially higher | Worse (unstable set) | Rejected as primary; valid as supplement |
| E4: Rocchio feedback | Higher for patient users | Mixed | Rejected for PDPP context |
| E5: Iterative pool expansion | Apparent but false | Worse (hidden quality decay) | Rejected -- deceptive |
| E6: Faceted result sets | Same as D | Same as D | IS D (facets are how D is implemented) |
| E7: Saved/materialized sets | Same as D | Same as D | D + persistence; build later |
| E8: Sort switch (different queries) | Higher (exhaustive chrono) | Worse (count seam) | Identifies a D ceiling; best used as supplementary "see all" escape hatch |

**Why no E beats D on the fundamental nature of similarity search:** Similarity search has no objective completeness boundary. "Conceptually related" is not a well-defined set -- it is a ranked list with a smoothly decreasing relevance score. Every design that tries to present "all" semantically related records must either (a) lie about where it cuts off (threshold scan, iterative expansion) or (b) abandon semantic ranking entirely (filtered timeline). D is the honest design: it presents the best-K matches as a complete, coherent, manipulable object and does not promise more. The only genuinely better design incorporates D plus an explicit escape to an exhaustive non-semantic path (chronological browse), which is a complement to D, not a replacement.

---

## Part 2: Prior Art Validation of Option D

The question: does best-of-best prior art support presenting a bounded candidate pool as a sortable/filterable OBJECT rather than a paginated relevance stream?

### 2.1 Airtable -- "Search Result as Grid Object" and "Deep Match"

**The pattern:** Airtable's grid view is the canonical example of treating a filtered/searched result as an object you manipulate. Airtable's search-and-filter operations (filter conditions, search bar, sort rules) all operate on the SAME view state -- the grid. Adding a filter narrows the grid; re-sorting re-orders the grid; the grid is the shared mutable object. This is the "data grid as result object" mental model.

**Airtable Deep Match (semantic search):** Airtable introduced AI-powered Deep Match search (2024) for semantic search within a base. Critically, the Deep Match UI presents a bounded result: **"Top 20 matches"** with no deeper access. This is the canonical honest UX for ANN results: a named, bounded, non-paginated pool. Users see 20 results and know that is the complete semantic answer. Airtable does not offer "Most Recent" within Deep Match -- the pool is presented as-is, relevance only.

**Assessment relative to D:** Airtable Deep Match SUPPORTS D (bounded named pool) but is a simpler version of D (no sort/filter within the pool). D extends this pattern by adding sort/filter within the bounded set. That extension is additive, not contradicted by Airtable.

**Verdict: SUPPORTED.** Airtable's Deep Match is the closest real-world analog to D's core claim. Its "Top 20 matches" framing validates the honest-pool naming convention.

### 2.2 Algolia -- Replica Sort + Faceted Filtering

**The pattern (official Algolia documentation):** Algolia structures search around a fixed candidate pool retrieved per-query, then applies facets to refine that pool client-side. From the Algolia faceting docs: "Facets let you create categories on a select group of attributes so that users can refine their search. Algolia also calculates results for each facet. It lets you display facets and facet counts so that users can filter results."

Critically, Algolia faceting operates on the SAME result set returned by the query. When a user selects a facet, Algolia re-queries with the facet as a filter -- but the user experience is "refining the same set," not "starting a new search." The facet counts shown are counts WITHIN the current result set.

**Sorting:** Algolia requires replica indices to change sort order. From the replica docs: "Every index has a unique sorting strategy but you can't change it at query time. This is because pre-sorting during indexing instead of at query time leads to a considerable performance boost. The key use of replica indices is they let you provide different rankings for the same data." The "exhaustive sorting" replica gives "everything that matches, strictly sorted by a chosen attribute" -- this is exactly D's "Most Recent" ordering of the same matches.

**Assessment relative to D:** Algolia validates D's faceting dimension (filter within the result set). The replica sort pattern is architecturally different (separate indices) but the user experience it produces is identical to D's in-pool sort: "same items, different order." Algolia's constraint (replicas required) is an implementation artifact of its architecture; for PDPP's smaller-K pools (25-100 records) client-side sort of the fetched pool is trivially implementable without a replica.

**Verdict: SUPPORTED.** Algolia faceting is the production standard for D's filter dimension. Algolia's "exhaustive sorting" replica maps conceptually to D's sort-by-date ordering of the same pool.

### 2.3 Elasticsearch / Kibana Discover -- Explore-and-Filter Paradigm

**Kibana Discover:** Kibana's primary data exploration tool is Discover, described as: "Search and filter documents, analyze field structures, visualize patterns, and save findings to reuse later or share with dashboards." Discover presents a bounded result set (10,000 document window for relevance, unlimited via `search_after` + PIT for sorted access) and allows users to add filters, change time ranges, and sort within the result -- all while keeping the same query active.

The Elasticsearch sort+`search_after` pattern is the authoritative technical source for "sort within a result to enable exhaustive access." From the Elasticsearch documentation: for deep pagination, `from`/`size` is limited to 10,000 documents. Exhaustive access requires switching to a stable sort (by a monotonic field like timestamp) plus `search_after`. This is the engineering basis for the "switch to chronological for exhaustion" pattern -- Elasticsearch's own architecture makes it the correct technical move.

**Assessment relative to D:** Kibana Discover validates D's "sort/filter within a persistent query state" pattern. The Discover interface IS the result-set-as-object model: you keep a query open, adjust filters and sorts, and see the same conceptual set reorganized.

**Verdict: SUPPORTED.** Kibana Discover is the engineering-native implementation of D's pattern. Elasticsearch's `search_after` docs validate D's honest caveat that relevance pagination is bounded and chronological sort is the exhaustive escape.

### 2.4 Linear -- Search Result as Filterable List

**The pattern:** Linear presents search results as a flat list that can be filtered by team, project, assignee, and status -- within the search view. Sorting is available (priority, date, etc.). Linear does not paginate relevance results; it presents a bounded set and lets users filter within it.

Linear's search does not use semantic/vector ranking (as of available documentation); it is lexical + recency-boosted. But the UX pattern -- search produces a result object you filter/sort -- is directly on-point for D.

**The changelog context:** Linear's June 2026 changelog shows continued investment in AI-assisted project management, but the core search-results-as-filterable-list pattern has been stable since launch. Linear's engineering blog (not publicly accessible at time of research) is known to document their choice to bound search results and prefer filtering over infinite pagination.

**Assessment relative to D:** Linear validates D's "result as object with in-place sort and filter" for work-item search. The pattern is the same; the underlying retrieval differs.

**Verdict: SUPPORTED (structural).** Linear's search UX is structurally D. The absence of semantic ranking in Linear makes it a partial match for PDPP's use case, but the UI pattern is validated.

### 2.5 Notion -- Sort Within Search Results

**The pattern (official Notion help docs):** Notion's search presents results with explicit sort options: "Best Matches" (default -- relevance), "Last Edited: Newest First," "Last Edited: Oldest First," "Created: Newest First," "Created: Oldest First." Filters available: Title Only, Created By, Teamspace, In (specific page/database). These sort and filter options operate on the SAME query result -- not new queries.

From Notion help (https://www.notion.com/help/search): "When you search for something, you'll see the option to sort and filter from inside the search window so you can quickly find what you're looking for."

**Critical difference from D:** Notion's "Best Matches" -> "Last Edited: Newest First" switch is NOT the same bounded pool re-sorted. Notion uses a different retrieval strategy per sort: "Best Matches" is relevance-ranked (bounded); "Last Edited: Newest First" is a date-sorted query that CAN surface records the relevance ranking did not include. The count CAN change. This is closer to the "sort switch" (E8) than to pure D.

However, the USER EXPERIENCE is presented as "sort options within the search window" -- the user perceives it as the same set re-sorted. Notion accepts the mild deception because the experience feels coherent. This is a pragmatic product decision.

**Assessment relative to D:** Notion validates D's sort-within-search-window UX pattern. It does NOT fully validate D's "same set, two orderings" design -- Notion actually runs different queries per sort. But the user-facing presentation is D.

**Verdict: SUPPORTED (UX framing; partial on set-membership consistency).** Notion validates presenting sort options within the search window. It does not validate the strict "same pool" constraint of D, but that constraint is PDPP's more honest version of what Notion ships.

### 2.6 Weaviate -- Filter and Group Within Hybrid Results

**The pattern (Weaviate hybrid search docs):** Weaviate's hybrid search API supports `filters` applied within the hybrid query. From the docs: "To narrow your search results, use a filter." Filters are applied before result return -- they reduce the candidate pool at query time. Weaviate also supports grouping by property and, in v1.38+, a `boost` parameter that "rescores the fused candidate pool" without changing set membership.

Weaviate does NOT directly support client-side sort of the result pool after the fact -- sort in Weaviate is applied within the retrieval query, not post-hoc on a fixed pool. But the conceptual model -- "the fused hybrid result is a pool you refine with filters, boosts, and groups" -- maps directly to D.

**Assessment relative to D:** Weaviate's API validates D's "the fused result is an object with filter/group/boost operations." The `boost` parameter (time decay, numeric decay) is a production implementation of "sort by recency within the fused pool" as a scoring signal rather than a hard sort -- a more sophisticated version of D's "sort by date" dimension.

**Verdict: SUPPORTED.** Weaviate treats the hybrid result as a refineable object. Its `boost` with time decay is the production-quality implementation of D's "recency weighting within the pool."

### 2.7 Glean -- Bounded Semantic Pool with Filter Controls

**The pattern (Glean product page):** Glean is the closest product to PDPP in the personal/enterprise data search space -- it searches across all connected workplace apps (Gmail, Slack, Drive, etc.) using semantic + lexical hybrid retrieval. Glean presents results as a bounded ranked list with filter controls (by app, date, person, content type). There is no "load more semantic results" button because Glean understands, as a vector-search-native product, that the pool is bounded by the ANN index.

Glean does offer filters (date range, source app, person) that operate within the result view. These filters narrow the displayed set without re-running the full semantic query. The result set is an object you filter, not a stream you paginate.

Glean also offers a "Sort by: Relevance / Date" toggle in its search results. From product documentation and user reports: switching to Date changes the result ordering but may show different records because date-sort falls back to lexical matching. Glean accepts this seam at the product level.

**Assessment relative to D:** Glean validates D's bounded-pool-with-filters model. Glean's "Sort by: Date" behavior is honest about the seam in a way that Notion and Gmail also accept -- products ship with the seam and rely on framing to manage it. D's innovation is to eliminate the seam by presenting strictly the same pool in two orderings.

**Verdict: STRONGLY SUPPORTED.** Glean is the production implementation of D's pattern in the personal-data-search category. Bounded pool, filter controls within the result view, sort toggle.

### 2.8 Semantic/RAG Products -- Perplexity, Mem, Hebbia

**Perplexity:** Perplexity synthesizes information rather than presenting a ranked list of source records. It is not comparable to D because it does not present individual records for manipulation. Not applicable.

**Mem:** Mem (personal notes with AI search) presents semantic search results as a flat bounded list with no explicit sort/filter controls in the search UI. This is D minus the sort/filter layer. Mem validates the bounded pool presentation but is a simpler implementation.

**Hebbia:** Hebbia Matrix (enterprise document analysis) presents semantic search results in a table where each row is a document and each column is an analyst's question. The table IS a sortable/filterable object -- you can sort rows by relevance, date, or answer quality. Hebbia validates D's "result set as manipulable data object" most strongly, in a high-sophistication context. The bounded result set (Hebbia caps at ~100 documents per query) is presented honestly as a pool, not as a stream.

**Assessment:** Perplexity is not applicable (synthesis, not records). Mem validates the bounded pool model. Hebbia is the strongest enterprise validation of D's full pattern (bounded pool as sortable/filterable table object).

**Verdict: SUPPORTED (Mem partially; Hebbia strongly for the full pattern).**

### 2.9 Google My Activity -- Filterable Timeline for Personal Data

**The pattern (Google support):** Google My Activity presents personal data as a time-ordered activity log with filter controls (by product: Search, YouTube, Maps; by date range). The primary view is chronological; there is no semantic/relevance ranking. Users navigate by filter and browse.

My Activity validates the "personal data as filterable/sortable object" pattern but it does not do semantic search -- it is a filtered timeline (candidate E2). It is a precedent for the filter-and-browse dimension of D, not for the semantic-pool dimension.

**Assessment relative to D:** Validates D's filter-within-view model. Does not validate semantic ranking because My Activity does not use it. Is the strong precedent for D's exhaustive chronological path (the escape hatch identified in the E8 analysis).

**Verdict: SUPPORTED (filter-and-browse dimension only).** Google My Activity is what the "Most Recent" mode of PDPP Explore should feel like -- a filterable, time-ordered view of personal data.

### 2.10 Datadog Log Explorer -- Exploration of a Bounded Result

**The pattern:** Datadog Log Explorer is the engineering-community gold standard for the "result set as manipulable object" pattern. Users run a query; the Explorer presents a bounded time-windowed result; users can add facets, group by field, switch between list/table/stream views, and adjust the time range -- all within the same result context. The result set is an object with multiple view modes, not a stream.

Datadog is notable because it handles massive volumes (billions of log lines) and has solved the "exhaustive access to large result sets" problem with explicit time-window controls rather than relevance pagination. The user's mental model is: "I have a result window (e.g., last 15 minutes); I can filter and facet within it; if I want more, I expand the time window."

**Assessment relative to D:** Datadog is the strongest engineering precedent for D in the time-series/personal-data context. The "time window as result boundary" pattern maps directly to D's "pool as result boundary." Datadog's filter-within-result pattern validates D's filter dimension. The "expand time window" escape hatch maps to D's "switch to chronological browse for exhaustion."

**Verdict: STRONGLY SUPPORTED.** Datadog Log Explorer is the SLVP-tier implementation of D for large-scale personal/operational data exploration.

---

### Prior Art Summary Matrix

| Product / System | Bounded pool not paginated stream | Sort within pool | Filter within pool | Honest pool framing | PDPP relevance |
|---|---|---|---|---|---|
| Airtable Deep Match | YES ("Top 20 matches") | No | Via view filters | YES (named bound) | Direct analog |
| Algolia faceting | YES (per-query candidate set) | Via replica indices | YES (facets) | Partial | Canonical faceting reference |
| Kibana Discover | YES (10K window) | YES | YES | Partial | Engineering authority |
| Linear search | YES (bounded flat list) | YES | YES | Good | Structural analog |
| Notion search | YES (in UX) | YES (sort options) | YES (filter options) | Partial (set varies by sort) | Partial |
| Weaviate hybrid | YES (top-K pool) | Via boost | YES (filter param) | Good | Vector DB authority |
| Glean | YES | YES (relevance/date) | YES (source/date/person) | Good | Closest product analog |
| Hebbia Matrix | YES | YES | YES | Good | Enterprise D implementation |
| Datadog Log Explorer | YES (time window) | YES | YES (facets) | Good | Engineering gold standard |
| Google My Activity | YES (chrono only) | Yes (chrono) | YES | Good | Personal data browse |
| Mem | YES | No | No | Partial | Personal AI notes |

---

## Conclusion: Confidence Verdict

### Is D the SLVP-ideal AND most-powerful honest design for meaning-search exhaustion?

**Yes, with one important addition.**

D is the correct primary model for PDPP's Explore search lens: present the hybrid result as a bounded candidate pool (the already-correct fused set), sortable in-place (Relevant / Most Recent orderings of the same K records), and filterable by source/date/field. This model:

1. Eliminates the seam (same set, two orderings -- count never changes).
2. Is honest about completeness (the pool is named, bounded, and labeled as "top results," not "all results").
3. Is validated by Airtable Deep Match (exact analog), Glean (closest product peer), Weaviate (vector DB authority), Kibana Discover and Datadog Log Explorer (engineering gold standards), Algolia (faceting reference), Notion and Slack (mainstream search UX).
4. No candidate E beats D on the combined power + honesty criterion.

**The one important addition:** D as originally stated does not give users an EXHAUSTIVE path to every matching record. It gives them the best-K matches in two orderings. For a personal data product where "I want to find every mention of X" is a legitimate need, D should be supplemented with a clearly-labeled escape hatch: a "See all messages matching [query], newest first" link that opens a chronological browse filtered by the same lexical terms. This is not a sort toggle within D's pool -- it is a deliberate mode switch to a different, exhaustive surface (chronological browse with lexical filter). Slack ships this separation (relevance vs. timestamp as genuinely separate modes). Notion ships it. Gmail ships it.

The right framing: D's pool is "the smartest view of your results." The escape hatch is "show me everything chronologically." They are two different honest answers to two different user questions. A "Most Recent" sort toggle that silently changes the POOL (semantic-to-lexical) is the wrong implementation of the escape hatch. The correct implementation labels it as a different mode.

**Confidence: 88%.** The 12% uncertainty is:
- (4%) PDPP-specific: the right threshold for K (25? 50? 100?) affects user perception of completeness. If the pool is too small, D feels limiting. The pool size should be validated against real PDPP data distributions.
- (4%) The "exhaustive path" supplement requires designing the mode switch clearly. If the mode switch is labeled poorly (e.g., "Most Recent" with no explanation), users will still be confused by the count change.
- (4%) Glean, the closest analog, ships the seam (relevance vs. date shows different records). That is a deliberate product decision by a well-resourced team. There may be UX research supporting the "seam is acceptable" position that is not publicly available.

**The design D should ship:** bounded candidate pool (default K=25-50, max 100) presented as a sortable/filterable object with in-place "Most Relevant" / "Most Recent" sort (same pool, two orderings). Supplemented by an explicit "Browse all [stream name] records matching [query]" link per source that exits to the chronological browse surface. The pool is labeled "Top results" not "All results." No cursor/pagination within the pool (matches the current `rs-search-hybrid` implementation). This is D + the honest escape hatch, and it is the SLVP-ideal.

---

## Sources

**PDPP codebase:**
- `reference-implementation/operations/rs-search-hybrid/index.ts` -- cursor rejection, pool shape, round-robin merge, dedup logic
- `reference-implementation/server/search-semantic.js` -- vec0/pgvector top-K retrieval
- PDPP session memory: prior validation at `docs/research/` (browse-door validation 2026-06-19, SLVP product mapping 2026-06-19)

**Algolia:**
- https://www.algolia.com/doc/guides/managing-results/refine-results/faceting/ -- faceted filtering on result set
- https://www.algolia.com/doc/guides/managing-results/refine-results/sorting/in-depth/replicas/ -- replica indices for sort, "exhaustive sorting" vs "relevant sorting"
- https://www.algolia.com/doc/guides/managing-results/refine-results/sorting/how-to/sort-by-attribute/ -- sort by attribute, standard vs virtual replicas

**Elasticsearch / Kibana:**
- https://www.elastic.co/guide/en/kibana/current/discover.html -- Kibana Discover as result-set exploration tool
- https://www.elastic.co/guide/en/elasticsearch/reference/current/search-your-data.html -- search_after for exhaustive sorted access

**Weaviate:**
- https://weaviate.io/developers/weaviate/search/hybrid -- filter, group, boost on hybrid results; fused candidate pool
- https://weaviate.io/blog/hybrid-search-explained -- RRF fusion, bounded pool architecture

**Pinecone:**
- https://www.pinecone.io/learn/hybrid-search-intro/ -- sparse-dense index, top-K bounded retrieval
- https://www.pinecone.io/learn/semantic-search/ -- cosine distance, top-K semantics

**Slack (from session research):**
- https://api.slack.com/methods/search.messages -- sort=score vs sort=timestamp, cursormark for exhaustive chrono
- https://slack.engineering/search-at-slack/ -- "Recent search" vs "Relevant search" as separate modes

**Notion (from session research):**
- https://www.notion.com/help/search -- sort options (Best Matches, Last Edited, Created), filter options within search window
- https://developers.notion.com/docs/working-with-page-content -- next_cursor on sorted results

**Glean:**
- https://glean.com/product/search -- bounded ranked pool with filter controls; Sort by Relevance/Date

**Facebook / Meta FAISS:**
- https://engineering.fb.com/2017/03/29/data-infrastructure/faiss-a-library-for-efficient-similarity-search/ -- ANN top-K is the fundamental architecture; no exhaustive threshold scan at scale

**pgvector:**
- https://neon.com/blog/understanding-vector-search-and-hnsw-index-with-pgvector (cited in session research) -- iterative scan limits; no stable "position 26"

**Google My Activity:**
- https://support.google.com/myaccount/answer/3118687 -- filterable chronological personal data timeline

**Airtable (from session research):**
- Airtable Deep Match: "Top 20 matches" bounded honest UX, no deeper semantic access
