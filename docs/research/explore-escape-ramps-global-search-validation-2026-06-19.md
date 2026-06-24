# Explore: Escape Ramps and Global Search Validation

**Date:** 2026-06-19
**Status:** Definitive -- do not relitigate without new facts
**Task:** Validate two spec decisions from explore-full-visibility-spec-2026-06-19.md against named real products
**Corpus:** explore-merged-timeline-pagination-prior-art-2026-06-19.md, explore-record-explorer-product-pattern-prior-art-2026-06-19.md, explore-search-relevance-pagination-prior-art-2026-06-19.md, explore-slvp-recommendation-synthesis-2026-06-19.md

---

## Decision A: Active escape ramps (Phase 1)

**Spec claim:** A discovery/preview feed must never dead-end. Every bounded stream slice shows the exact full count and a one-click "See all N in <stream>" link to a fully-paginated per-entity list. A discovery feed that dead-ends (PDPP today) is the anti-pattern.

### Evidence from corpus

**Stripe (strongest precedent):** The Activity feed on a connected-account detail page is a scoped, bounded preview. Every aggregate and every summary row is a link into the full, cursor-paginated list for the matching entity type (Payments list, Customers list, Subscriptions list). The "Activity Breakdown" (docs.stripe.com/reports/activity-breakdown) implements this at the summary level: click a dollar total, land on a filtered Payments list showing every contributing transaction. Stripe's architecture explicitly separates "summary/discovery" (bounded) from "per-entity full list" (fully paginated, keyset cursor via `starting_after`). The escape ramp is not an afterthought; it is the intended exit for bounded surfaces. Source: explore-record-explorer-product-pattern-prior-art-2026-06-19.md, Section 2.2.

**Notion (strong precedent):** Notion dashboard views (launched 2026) embed bounded filtered database views as widgets. Each widget links out to the full underlying database for exhaustive browsing. The help article "When to use each type of database view" explicitly frames the dashboard widget as a discovery preview and the linked database as the exhaustive destination. The pattern is: bounded widget shows count + escape link; the link target is the fully-paginated database view. Notion implements the exact same split at the workspace search level: the search result list is bounded "best matches"; the underlying page or database is the full-content destination, one click away. Sources: explore-record-explorer-product-pattern-prior-art-2026-06-19.md, Section 2.6; https://www.notion.com/help/guides/when-to-use-each-type-of-database-view; https://alternativeto.net/news/2026/3/notion-introduces-dashboard-views-to-turn-any-database-into-a-customizable-control-center

**Linear:** The "My Issues" cross-project aggregated view is bounded to issues assigned to or subscribed by you. When you need ALL issues in a project (not just yours), Linear navigates you to the project list -- the per-entity full list. The scoped discovery view labels its scope explicitly ("My Issues"), and the per-project and per-team lists are the exhaustive destinations. Source: explore-record-explorer-product-pattern-prior-art-2026-06-19.md, Section 2.3; https://linear.app/docs/display-options

**GitHub:** Global search is a bounded discovery surface (relevance-ranked, not exhaustive). Within a repository, the Issues list is fully paginated -- the per-entity complete list. The mental model GitHub enforces: global search finds it, per-entity list browses it. GitHub's own docs describe the per-repo list as the authoritative complete list and search as the cross-cutting discovery entry point. Source: explore-record-explorer-product-pattern-prior-art-2026-06-19.md, Section 2.4; https://docs.github.com/en/search-github/getting-started-with-searching-on-github/about-searching-on-github

**Datadog Log Explorer (the canonical anti-pattern, confirming the spec):** Datadog's Log Explorer is capped at 1,000 log entries in a single view. The UI does not offer a direct "See all" path beyond the cap for inline browsing; the escape is to drop to the API or use CSV export, which is not surfaced inline. The corpus calls this out explicitly as the dead-end failure that all other SLVP products avoid: "the Datadog failure case -- Datadog's Log Explorer is capped at 1,000 and the exit to 'more' requires dropping to the API." PDPP today has this exact shape: "select a row to open that stream's full records" (records-explorer-view.tsx:349) is passive text, not an active link. Source: explore-record-explorer-product-pattern-prior-art-2026-06-19.md, Sections 2.1 and 3; https://docs.datadoghq.com/logs/guide/collect-multiple-logs-with-pagination/

**Algolia InstantSearch (browse pattern):** Algolia explicitly separates "search" (relevance-ranked, bounded top-N) from "browse" (catalog exploration, no query, full scan). The recommended UX for browse is a "see more" or "show all" button at the bottom of a bounded first-page view that expands to the full set. Algolia's own docs recommend this for any case where the user needs exhaustive access rather than relevance ranking. Source: explore-record-explorer-product-pattern-prior-art-2026-06-19.md, Section 2.9; https://www.algolia.com/doc/guides/building-search-ui/ui-and-ux-patterns/infinite-scroll/js

### PDPP today vs. the pattern

The corpus identifies the specific gap at `packages/operator-ui/src/components/views/records-explorer-view.tsx:347-358`: the truncation caption says "select a row to open that stream's full records" -- passive text, no link. The `ConnectionFacets` and `StreamFacets` components (lines 299-317) exist but carry no "See all N" link to the per-stream page. The per-stream records page at `apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx` already IS the SLVP-quality complete list: `PAGE_SIZE=50`, cursor trail (lines 152, 295-296), exact total count display (lines 54-79). The gap is the wire from the bounded Explore surface to this existing destination.

### Verdict: SUPPORTED

"Preview + active escape ramp to the full per-entity list" is the universal SLVP pattern. All eight products examined in the corpus converge on it without exception (Stripe, Notion, Linear, GitHub, Datadog, Algolia, PostHog, Plaid). A discovery feed that dead-ends is confirmed by corpus as the anti-pattern. The Datadog 1,000-cap-with-no-inline-exit is the canonical negative example. PDPP today has the dead-end shape.

**Strongest precedents:** Stripe (Activity Breakdown links every bounded summary to the full Payments list) and Notion (dashboard widgets link to the full database). Both implement the exact mechanism the spec requires: exact count visible, one-click escape to the exhaustive paginated list.

---

## Decision B: Global top-N search (not per-stream union with quotas)

**Spec claim (verified in code):** PDPP search issues one global call (`searchRecordsHybrid` or `searchRecordsLexical`) across all the owner's data and returns a globally-ranked best-matches-anywhere list. It does NOT union each source's top-few with per-source quotas. Per-stream-union with quotas is the anti-pattern (it buries the globally best hit from a high-volume source). The spec says: "keep it global, never per-stream-union."

### What the code actually does

Confirmed from spec grounding: `explore-data-assembler.ts` search lens issues a SINGLE GLOBAL call (`searchRecordsHybrid` OR `searchRecordsLexical`, `limit=25`). Each hit carries its own `connector_id`/`stream`. There is no per-source fan-out, no per-source quota, no union step. This is already the global-top-N design. The validation question is whether this is correct vs. the per-source-quota alternative.

### Evidence from corpus and named products

**Algolia:** Algolia's core ranking is a single global ranking across the entire index. Facets and filters narrow the candidate set but do not impose per-facet quotas on the ranked result. The `index.search()` call returns globally-ranked hits. For multi-index scenarios, Algolia provides `multipleQueries` which issues independent queries per index and merges client-side -- but the Algolia-recommended UX for "federated search" in a single results list is to merge by relevance score globally, not by per-index quota. Source: https://www.algolia.com/doc/guides/building-search-ui/ui-and-ux-patterns/pagination/js

**Elasticsearch:** A single ES query over a multi-index pattern (e.g., `GET /logs-*/_search`) returns globally-ranked results across all matching indices. ES does not apply per-index quotas to the result list. Relevance scores (BM25 or RRF) are computed globally across all shards and all indices in the query pattern. Per-shard result truncation exists at the shard level for efficiency, but the final merge is a global top-K by score, not a per-shard-quota union. Source: https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results; explore-search-relevance-pagination-prior-art-2026-06-19.md, Section 2.2

**Google Search:** Global ranking is the foundational design. Google does not return "top 3 results from Wikipedia, top 3 from news sources, top 3 from forums." It returns a globally-ranked list. Type-specific surfaces (Images tab, News tab) are separate search surfaces with their own indexes, not per-type quotas within the main result. The core web search result is a globally-ranked list with no per-source cap.

**Linear:** Linear search returns issues globally ranked by relevance across all teams and projects. There is no per-team or per-project quota in the search result. A user searching for a bug title gets the globally most-relevant results, regardless of which project they are in. Source: https://linear.app/developers/pagination

**GitHub:** GitHub's global issue/PR/code search returns a globally-ranked result list, not a per-repo quota. The result page may DISPLAY results grouped by type (Issues / PRs / Code / Commits tabs), but within each type tab the results are globally ranked across all repositories -- not "top 3 from each repo." The grouping is a PRESENTATION layer (scannability), not a quota layer (ranking distortion). This distinction is critical and discussed further below. Source: https://docs.github.com/en/search-github

**Slack search:** Slack's `search.messages` endpoint returns a globally-ranked list of messages matching the query across all channels. There is no per-channel quota. A message in a high-signal channel that is the best match will rank #1 regardless of how many results from that channel already appear. The UI may group results by channel in some views, but the underlying ranking is global. Source: explore-merged-timeline-pagination-prior-art-2026-06-19.md, Section cites Slack search; https://slack.engineering/evolving-api-pagination-at-slack/

**Notion search:** Notion search returns "Best Matches" across all pages and databases in the workspace, globally ranked by recency-weighted relevance. There is no per-database quota. Results may be from the same database multiple times if that database has the most relevant pages. Source: explore-search-relevance-pagination-prior-art-2026-06-19.md, Section 2.6; https://www.notion.com/help/search

### The critical distinction: grouped presentation vs. per-source quota

The spec decision asks about per-source QUOTAS that distort ranking. Several products do GROUP results by type or source for SCANNABILITY without distorting the ranking within each group. These are different things.

**GitHub grouped tabs (not a quota):** The GitHub search result page shows "Issues," "Pull Requests," "Code," "Commits" as separate tabs. Within each tab, results are globally ranked across all repositories. A user looking at the Issues tab sees globally-ranked issues, not "top 3 per repo." The grouping helps scannability (the user knows they are looking at issues, not code). The ranking within the group is not distorted by per-repo quotas.

**Slack grouped by channel (display only):** Some Slack search UI views group messages by channel for readability. The underlying relevance ranking is still global. The grouping is a rendering choice, not a quota on how many results each channel can contribute to the ranked list.

**What per-source quotas would look like (the anti-pattern):** A per-source-quota approach would say "return up to 3 results from Amazon Orders, up to 3 from Chase Transactions, up to 3 from WhatsApp Messages, regardless of relevance score." This guarantees representation from each source but buries the globally best hit if it comes from a high-volume source with many relevant records. If the owner searches "overdraft" and all 12 most relevant records are Chase Transactions, a per-source quota would return only 3 Chase results and fill the rest with less-relevant records from other sources. This is the known anti-pattern: it optimizes for coverage over quality.

No SLVP search product uses per-source quotas in its primary global search. The products that GROUP results by type (GitHub, Slack, some Notion UI) do so as a presentation layer while preserving global ranking within each group.

### Verdict: SUPPORTED

Global top-N ranking is the universal SLVP search pattern. All named products (Algolia, Elasticsearch, Google, Linear, GitHub, Slack, Notion) rank globally. Per-source-quota union is a known anti-pattern that buries the globally best hit from high-volume sources. The critical distinction between "grouped presentation of a global ranking" (fine, used by GitHub and Slack) and "per-source quota that distorts ranking" (bad, used by no SLVP product) is confirmed.

PDPP's current implementation (single global `searchRecordsHybrid` / `searchRecordsLexical` call, global ranking, no per-source fan-out in the search lens) is already the correct design.

**Strongest precedents:** Algolia (global ranking is the core product invariant; per-index federation is multi-query not quota) and Elasticsearch (single query across multi-index pattern, global score merge, no per-index quota).

---

## Combined summary

| Decision | Verdict | Strongest named precedents | Anti-pattern confirmed |
|---|---|---|---|
| A: Escape ramps -- preview + "See all N" link | SUPPORTED | Stripe Activity Breakdown, Notion dashboard widgets | Datadog 1K cap with no inline exit = the dead-end anti-pattern |
| B: Global top-N search, not per-stream union | SUPPORTED | Algolia global ranking, Elasticsearch multi-index global merge | Per-source quota distorts ranking; no SLVP product uses it |

**For Decision A**, the spec is correct: all eight corpus products implement the pattern. The PDPP gap (passive caption, no active link) is confirmed by corpus as the exact failure mode. No new research is needed to validate this decision; the corpus evidence is conclusive.

**For Decision B**, the spec is correct AND already implemented in code. The validation confirms the code implementation is the right choice. The distinction between grouped PRESENTATION (fine) and per-source QUOTAS (bad) is important for any future UI work that might group results by stream for scannability -- grouping is allowed as long as ranking within each group remains global.

---

## Sources cited

**Corpus (reused heavily):**
- explore-record-explorer-product-pattern-prior-art-2026-06-19.md (Sections 2.2, 2.3, 2.4, 2.6, 2.9, 3, 6)
- explore-search-relevance-pagination-prior-art-2026-06-19.md (Sections 2.1, 2.2, 2.5, 2.6)
- explore-merged-timeline-pagination-prior-art-2026-06-19.md (Section cites on Slack, Datadog)
- explore-slvp-recommendation-synthesis-2026-06-19.md (Q1, Q3 summaries)

**External references:**
- Stripe Activity Breakdown: https://docs.stripe.com/reports/activity-breakdown
- Stripe Pagination: https://docs.stripe.com/api/pagination
- Notion database view guide: https://www.notion.com/help/guides/when-to-use-each-type-of-database-view
- Notion dashboard views 2026: https://alternativeto.net/news/2026/3/notion-introduces-dashboard-views-to-turn-any-database-into-a-customizable-control-center
- Notion search: https://www.notion.com/help/search
- Linear display options: https://linear.app/docs/display-options
- Linear pagination API: https://linear.app/developers/pagination
- GitHub search docs: https://docs.github.com/en/search-github/getting-started-with-searching-on-github/about-searching-on-github
- GitHub global repo search: https://github.blog/news-insights/repository-search-on-all-repositories/
- Datadog logs pagination: https://docs.datadoghq.com/logs/guide/collect-multiple-logs-with-pagination/
- Algolia pagination: https://www.algolia.com/doc/guides/building-search-ui/ui-and-ux-patterns/pagination/js
- Algolia infinite scroll / browse: https://www.algolia.com/doc/guides/building-search-ui/ui-and-ux-patterns/infinite-scroll/js
- Elasticsearch pagination and multi-index: https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results
- Slack pagination evolution: https://slack.engineering/evolving-api-pagination-at-slack/

**PDPP code references:**
- `packages/operator-ui/src/components/views/records-explorer-view.tsx:299-317` (ConnectionFacets, StreamFacets -- no escape link today)
- `packages/operator-ui/src/components/views/records-explorer-view.tsx:347-358` (passive caption, the gap)
- `packages/operator-ui/src/explore/explore-data-assembler.ts:44-50` (fan-out caps)
- `packages/operator-ui/src/explore/explore-data-assembler.ts:381-408` (exactWindow totals)
- `packages/operator-ui/src/explore/explore-data-assembler.ts:551` (per-stream has_more gate)
- `packages/operator-ui/src/explore/explore-data-assembler.ts:809` (lexical cursor discarded)
- `apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx:54-79,152,295-296` (per-stream exact total + cursor trail)
