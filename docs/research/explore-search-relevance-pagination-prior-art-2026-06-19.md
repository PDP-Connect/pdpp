# Explore Search Lens: Relevance Pagination Prior Art and SLVP Verdict

**Date:** 2026-06-19
**Scope:** Prior art on paginating relevance-ranked and hybrid search results; SLVP-ideal recommendation for PDPP's Explore search lens
**Status:** Definitive -- do not relitigate without new facts

---

## 1. The Problem Stated Precisely

PDPP's Explore surface has three lenses:

- **Recent** (empty-query): cross-source fan-out, keyset-cursor-based per stream, k-way timestamp merge. Pageable today with stable cursors.
- **Time-range**: same fan-out, bounded by time window. Same keyset approach.
- **Search**: lexical or hybrid. Lexical returns `next_cursor` (snapshot-backed, offset into a frozen ranked list). Hybrid (RRF round-robin of lexical + semantic) returns `has_more` but **NO `next_cursor`** -- v1 by design.

Tim's bar: "no terminal caps presented as complete; if bounded, there must be a real path to the complete set."

The hard question: can relevance-ranked hybrid search results be honestly deep-paginated? If not, what is the SLVP-honest UX?

Source files grounding this analysis:
- `packages/operator-ui/src/explore/explore-data-assembler.ts:SEARCH_PAGE_LIMIT=25` -- current cap
- `reference-implementation/operations/rs-search-hybrid/index.ts:parseSearchHybridParams` -- explicit cursor rejection, `invalid_request` with `param:'cursor'`
- `reference-implementation/operations/rs-search-lexical/index.ts:executeSearchLexical` -- snapshot-backed cursor: build ranked snapshot once, slice it with offset cursors across pages
- `explore-data-assembler.ts:loadSearchFeed` lines 795-864 -- `has_more` triggers the `search_page_limited` warning with copy "Narrow the query or open a matching stream to browse complete records"

---

## 2. How the Industry Handles This

### 2.1 Algolia

Algolia uses offset-based page+hitsPerPage pagination over a relevance-ranked window bounded by `paginationLimitedTo`. Default: 1,000 hits. Maximum: 20,000. Above 1,000, **sort order cannot be guaranteed**. Above 20,000, the `browse` endpoint (no relevance, full scan) is the only path.

Algolia's own docs state: "You can only page so deep." Their philosophy: optimize first-page relevance so users never need page 2. The recommended UX for when users do not find results is **query refinement suggestions** (post-query refinement, facet chips), not deeper pagination.

Source: https://support.algolia.com/hc/en-us/articles/18548759100177-How-can-I-retrieve-more-than-20-000-search-results
Source: https://www.algolia.com/doc/guides/building-search-ui/ui-and-ux-patterns/pagination/js
Source: https://medium.com/design-bootcamp/post-query-refinement-suggestions-in-search-ux-and-an-algolia-demo-app-502eb9aa2fbd

### 2.2 Elasticsearch

`from`/`size` (offset pagination) hits a hard wall at `index.max_result_window` = 10,000 by default. Beyond that, memory exhaustion on shards. For **relevance-ranked results with no stable sort field**, deep offset pagination is the only option and it is bounded.

`search_after` is ES's cursor for **sorted** results. It requires a stable tiebreak sort key (e.g., `(score DESC, id ASC)`). For pure BM25 relevance, scores are stable within a Point-in-Time (PIT) snapshot but differ across re-queries. With a PIT, `search_after` on `(score, id)` works and is unbounded -- but it is only sound when the score is stable (frozen index slice). Without a PIT the ranked list can shift between pages (inserts/updates change BM25 scores), causing missed or duplicated hits.

RRF hybrid in Elasticsearch: ranked over a fixed `rank_window_size`. Pagination via `from` works only within that window. Beyond the window you get zero results. True cursor scroll is not available for RRF results.

Source: https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results
Source: https://medium.com/@imadsaddik/16-deep-pagination-in-elasticsearch-search-after-vs-from-size-11fb39131b63
Source: https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/

### 2.3 Meilisearch

Meilisearch was designed with the explicit philosophy that "users should never need to go to page 2." Their default returns `estimatedTotalHits` (an upper-bound approximation, not exact). Numbered/finished pagination is explicitly discouraged: retrieving the 2,000th result via offset is far more expensive than the first 20. The recommended UI is previous/next arrow pagination (no page numbers) over a bounded top-N result set.

Source: https://www.meilisearch.com/docs/capabilities/full_text_search/how_to/paginate_search_results
Source: https://meilisearch.com/blog/pagination-vs-infinite-scroll-vs-load-more

### 2.4 Stripe Search

Stripe search (used for searching Customers, Charges, PaymentIntents) uses cursor-based `next_page` pagination over a relevance-ranked result set. `total_count` is only accurate up to 10,000 and must be explicitly opted in. The cursor points into a frozen result snapshot. This is the SLVP reference for honest search cursor design: the cursor exists, it works forward-only, and the total count is capped/disclosed.

Source: https://docs.stripe.com/api/pagination/search
Source: https://docs.stripe.com/pagination

### 2.5 Linear

Linear uses Relay-style cursor pagination (`first`/`after`, `last`/`before`) on all list endpoints. Results are ordered by `createdAt` by default -- a stable sort field. For text search, Linear returns top matches without documented deep pagination. This is a sorted-list cursor, not a relevance-rank cursor.

Source: https://linear.app/developers/pagination

### 2.6 Notion

Notion search defaults to "Best Matches" (recency-weighted relevance). Users can switch to sort by last-edited or created. The API returns up to 100 results per page with `start_cursor`/`next_cursor` -- but this is over a bounded ranked set, not an exhaustive traversal of all matching pages. The UI exposes a sort switcher (relevance vs. time) so users can shift from the bounded ranked view to an exhaustive time-ordered view.

Source: https://www.notion.com/help/search
Source: https://developers.notion.com/docs/working-with-page-content

### 2.7 Airtable Deep Match

Airtable's AI-powered linked-record search ("Deep Match") surfaces "Top matches" -- the 20 most semantically similar records. If the target table has more than 20 candidates, **only the top 20 appear**. The UI labels this explicitly: "Top matches." Users can combine with view filters to narrow the target set. This is the canonical SLVP-level honest UX for semantic search results: name the bound, give a path to narrow.

Source: https://support.airtable.com/docs/linking-records-in-airtable

---

## 3. Why Deep Pagination of Relevance-Ranked / Hybrid Results Is Fundamentally Bounded

Three independent reasons why relevance-ranked results cannot be deep-paginated the way a time-ordered feed can:

### 3.1 ANN / Vector Search: Top-K Is Not a Prefix

HNSW (the index structure underlying pgvector semantic search) runs a greedy graph traversal returning the **approximate** top-K nearest neighbors. It is not a full scan. Asking for "results 26-50" of a semantic search requires re-running the ANN search with K=50 and discarding the first 25 -- not resuming from a cursor. There is no stable "position 26" in an HNSW graph.

pgvector 0.8+ adds `hnsw.iterative_scan` which can extend the search to find more results, but this re-runs the traversal with a larger candidate set and is bounded by `hnsw.max_scan_tuples` (default 20,000). Beyond that, approximate results are unavailable; an exact (sequential) scan is required.

Critically: the results at positions 26-50 of a second ANN query with K=50 are not guaranteed to be a stable superset of results 1-25 from a K=25 query. ANN is approximate.

Source: https://neon.com/blog/understanding-vector-search-and-hnsw-index-with-pgvector
Source: https://supabase.com/blog/increase-performance-pgvector-hnsw

### 3.2 RRF / Hybrid: The Fused Rank Is Not Decomposable

Reciprocal Rank Fusion merges two ranked lists into a single score based on position in each list. The fused ranking is a property of the full merged set -- you cannot compute the rank of position N without knowing the ranks of all items 1 through N in both sub-lists. This means:

- An RRF cursor would need to encode (or re-fetch) the full sub-list ranks at each page boundary.
- If the sub-lists change between requests (new data ingested), the fused ranking shifts. A cursor that pointed to position 26 in an earlier ranking may now point to a different item or no item.
- Elasticsearch's own RRF pagination is bounded by `rank_window_size`. Beyond the window, results are zero.

PDPP's hybrid operation (rs-search-hybrid/index.ts) already chose the honest path: cursor param is explicitly rejected (`invalid_request`, `param: 'cursor'`). The `data[]` array is the result of round-robin merge of lexical+semantic hits, truncated to `limit`. `has_more` is informational: it means "the merged list has more items than the limit" but there is no stable way to resume from position N.

Source: https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/
Source: https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking

### 3.3 Lexical with Snapshot: Cursor IS Sound, But Snapshot Expires

PDPP's lexical search already solves this correctly: on the first request, a ranked snapshot is built and persisted; the cursor encodes `(snapshot_id, offset)`. Pages walk the frozen ranked list. This is equivalent to Stripe's `next_page` cursor over a relevance-ranked snapshot.

The tradeoff: the snapshot must expire (memory/storage). When it expires, the cursor is invalid. This is disclosed: `invalid_cursor` error on expired snapshot. Elasticsearch PIT + `search_after` has the same semantics.

This design is **sound and pageable** for lexical. The same design could theoretically be applied to hybrid: freeze the merged result list, assign it a snapshot ID, page through the frozen list. This is the path to cursor-supporting hybrid search.

---

## 4. The SLVP-Ideal UX Model

Based on prior art synthesis:

### 4.1 Search Is Not a Feed -- It Is a Ranked Sample

The mental model shift that all SLVP-tier products have made: **search results are a ranked sample, not a feed**. A feed (time-ordered records) is exhaustive -- you can always page to the next item in time order. A relevance-ranked result is a curated ranking of the most relevant items -- there is no meaningful "item 251" in a search for "restaurant receipt" because relevance degrades as you go deeper, and the boundary between "relevant" and "not relevant" is fuzzy.

Google's own UX makes this visible: very few users go past page 2 (empirically <1%). The correct response to "I didn't find what I wanted on page 1" is to refine the query, not to go to page 10.

### 4.2 The SLVP Answer for Hybrid Search

The honest answer for hybrid search is: **"These are the top N most relevant results. To see more, narrow your query or switch to a stream's full records."**

This is not a cop-out. It is what Algolia, Meilisearch, Airtable Deep Match, and Notion "Best Matches" all do. The key requirement (Tim's bar) is:

1. Be honest about the bound: do not say "1 of 1,183" with no path forward.
2. Provide a real path to the complete set: the stream's full record list (time-ordered, fully paginated via keyset cursors) is the path.
3. Provide refinement affordances: connection/stream filters that narrow the search scope.

### 4.3 The SLVP Answer for Lexical Search

Lexical search CAN be deep-paginated via the existing snapshot cursor. The question is whether it is worth offering. Given that lexical search already has `next_cursor`, the honest answer here is yes: offer "Load more" or next-page navigation for lexical results. The current `SEARCH_PAGE_LIMIT=25` with no load-more is a gap for lexical (not hybrid).

### 4.4 The Sort Switcher as the Path to Exhaustive

Notion and GitHub both offer this: a sort switcher that lets users go from "Best match" (relevance-ranked, bounded) to "Recently updated" or "Newest" (time-ordered, exhaustive). PDPP already has the time-sorted feed (recent lens) and time-range lens. The SLVP-ideal Explore UX is:

- Search returns top-N relevance results with honest copy.
- A "Sort by date" or "View in [Stream] records" link switches the user to the exhaustive time-ordered view, possibly pre-filtered by the search query or the matched stream.
- Stream-specific search: when a user clicks through to a stream's full records page, the query can pre-populate the filter there (where lexical search IS cursor-paginated).

---

## 5. Concrete Recommendations for PDPP

### 5.1 Hybrid: Keep Cursor Rejection, Be Honest in the UI

The current decision in `rs-search-hybrid/index.ts` to reject `cursor` is correct and matches the industry. Do not add a cursor to hybrid until the full snapshot-backed hybrid design is built (see 5.4).

Current UI gap: the `search_page_limited` warning at `explore-data-assembler.ts:849` says "Narrow the query or open a matching stream to browse complete records." This is honest but passive. The SLVP upgrade is:

- Make the boundary prominent (not just a warning): "Showing the top 25 most relevant results" as a visible badge/count near the result list header.
- Make the path to more explicit: a "Browse all records in [Stream]" CTA on matching stream chips or result rows that deep-links to the stream's full keyset-paginated record list.
- Make the query refinement affordances active: connection and stream filter chips are already present; label them as "Narrow results" rather than generic "Filter."

### 5.2 Lexical: Add "Load More" / Cursor Pagination

Lexical search already has `next_cursor` in the envelope (`rs-search-lexical/index.ts:1136`). The Explore UI does not yet use it -- `loadSearchFeed` at `explore-data-assembler.ts:809` discards the cursor. This is a true gap.

SLVP upgrade: persist the lexical `next_cursor` on the first page load; offer a "Load more results" button that issues a second lexical search request with the cursor. Accumulate results in the feed. This mirrors Stripe's auto-pagination and Algolia's infinite-scroll InstantSearch pattern.

Since hybrid falls back to lexical when hybrid is unavailable, this also covers the degraded-mode path.

### 5.3 Recent/Time-Range Lenses: Already Sound, Need UI Completion

The recent and time-range lenses use per-stream `has_more` flags (e.g., `loadEmptyQueryFeed:hasMoreRecords`). The assembler sets `truncated: true` and the activity summary says "recent sample; select a row to open that stream's full records." This is honest but has the same UX gap: no direct "load more" for the cross-stream feed.

For the cross-stream merged feed, "load more" requires advancing per-stream cursors and re-merging -- a k-way merge continuation. This is architecturally sound (keyset cursors are stable) and is the correct SLVP answer for Tim's "no terminal caps" requirement on the recent/time-range lens. This is separate from the search lens problem and is a separate implementation task.

### 5.4 Future: Snapshot-Backed Hybrid Cursor

If the product bar requires deep pagination of hybrid results (unlikely to be user-demanded based on all prior art), the correct architecture is:

1. On first hybrid search request: build merged result list (current logic), freeze it as a snapshot with a `snapshot_id`.
2. Return `next_cursor = encode({snap: snapshot_id, off: limit})` in the hybrid envelope.
3. On subsequent requests with cursor: load the frozen merged list from the snapshot store, slice by offset.
4. The snapshot expires (configurable TTL); expired cursor returns `invalid_cursor`.

This mirrors what lexical already does in `executeSearchLexical`. The implementation cost is moderate: the merged result list is already computed in-memory; persisting it is the only new step. The UX honest note: pages beyond the first are walking a potentially stale ranked list (the snapshot was built at time T; new records ingested after T will not appear until a fresh search).

---

## 6. Summary Verdict

| Lens | Deep Pagination Sound? | Current State | SLVP Upgrade |
|---|---|---|---|
| Hybrid search | No (RRF fused rank, ANN top-K) | First page only, `has_more` informational | Honest "top N" badge + "Browse stream" CTA |
| Lexical search | Yes (snapshot cursor exists) | Cursor discarded; no load-more in UI | Wire `next_cursor` into "Load more" button |
| Recent feed | Yes (keyset, stable) | `truncated` warning only, no load-more | K-way merge continuation cursor |
| Time-range feed | Yes (keyset, stable) | Same as recent | Same as recent |

**The SLVP-ideal answer for hybrid is:** "Showing top N most relevant results" with (a) an honest label, (b) stream-level CTAs to browse the exhaustive record list, and (c) connection/stream filters to narrow. This is exactly what Algolia, Airtable, and Notion do. Forcing a cursor onto hybrid before snapshot persistence is built would require shipping a lie (re-querying and hoping the ranking is stable) or a half-measure (freeze the already-computed merged list in the HTTP response, return a fake cursor, lose pagination on server restart).

**The SLVP-ideal answer for lexical is:** wire the existing `next_cursor` into the Explore UI with a "Load more" button. The infrastructure already exists; the UI gap is small.

---

## 7. Sources

- Algolia pagination docs: https://www.algolia.com/doc/guides/building-search-ui/ui-and-ux-patterns/pagination/js
- Algolia 20K limit: https://support.algolia.com/hc/en-us/articles/18548759100177
- Algolia relevant sort: https://www.algolia.com/doc/guides/managing-results/refine-results/sorting/in-depth/relevant-sort
- Algolia query refinement UX: https://medium.com/design-bootcamp/post-query-refinement-suggestions-in-search-ux-and-an-algolia-demo-app-502eb9aa2fbd
- Elasticsearch pagination: https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results
- Elasticsearch deep pagination analysis: https://medium.com/@imadsaddik/16-deep-pagination-in-elasticsearch-search-after-vs-from-size-11fb39131b63
- Elasticsearch RRF: https://www.elastic.co/docs/reference/elasticsearch/rest-apis/reciprocal-rank-fusion
- OpenSearch RRF introduction: https://opensearch.org/blog/introducing-reciprocal-rank-fusion-hybrid-search/
- Meilisearch pagination: https://www.meilisearch.com/docs/capabilities/full_text_search/how_to/paginate_search_results
- Meilisearch pagination vs infinite scroll: https://meilisearch.com/blog/pagination-vs-infinite-scroll-vs-load-more
- pgvector HNSW: https://neon.com/blog/understanding-vector-search-and-hnsw-index-with-pgvector
- pgvector HNSW performance: https://supabase.com/blog/increase-performance-pgvector-hnsw
- Stripe search pagination: https://docs.stripe.com/api/pagination/search
- Stripe pagination overview: https://docs.stripe.com/pagination
- Linear pagination: https://linear.app/developers/pagination
- Azure AI hybrid search RRF: https://learn.microsoft.com/en-us/azure/search/hybrid-search-ranking
- Notion search: https://www.notion.com/help/search
- Airtable Deep Match: https://support.airtable.com/docs/linking-records-in-airtable
- PDPP hybrid operation: `reference-implementation/operations/rs-search-hybrid/index.ts`
- PDPP lexical operation: `reference-implementation/operations/rs-search-lexical/index.ts`
- PDPP explore assembler: `packages/operator-ui/src/explore/explore-data-assembler.ts`
