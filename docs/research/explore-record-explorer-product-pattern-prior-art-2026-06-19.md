# Explore / Record Browser: Prior Art and Shape Recommendation
**Date:** 2026-06-19
**Scope:** PDPP `apps/console/src/app/dashboard/explore` and the underlying assembler at `packages/operator-ui/src/explore/explore-data-assembler.ts`
**Question:** Should the Explore surface be (A) one unified fully-paginated cross-source feed, (B) a cross-source discovery/search surface whose per-stream full-record-set lives on per-entity paginated pages, or (C) a hybrid?

---

## 1. The PDPP Architecture Facts (grounding before any opinion)

**Current Explore implementation:**

- `explore-data-assembler.ts` lines 44-50 declare the caps: `MAX_FEED_CONNECTIONS = 6`, `MAX_FEED_STREAMS_PER_CONNECTION = 2`, `MAX_FEED_RECORDS_PER_STREAM = 6`, `FEED_TOTAL_CAP = 32` for the empty-query "recent" lens. Time-range lens caps at `TIME_RANGE_RECORDS_PER_STREAM = 50` / `TIME_RANGE_TOTAL_CAP = 500`. Search caps at `SEARCH_PAGE_LIMIT = 25`.
- The assembler performs a **client-side fan-out**: it issues parallel `queryRecords` calls per (connection, stream), collects results, sorts by `displayAt`, and slices to the cap. No server-side merge; the merge happens in this module.
- The per-stream API (`queryRecords`) uses **keyset cursors**: `has_more` + `next_cursor` (rs-client.ts lines 43, 49, 111, 112). A per-stream cursor trail is already implemented on the records list page (`apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx`, `PAGE_SIZE = 50`, lines 152 and 295-296).
- The per-stream records page (`/dashboard/records/[connector]/[stream]/page.tsx`) is a fully-paginated keyset list. It already shows `page N * 50 shown of X total` when the server returns an exact count (lines 54-79).
- **Hybrid search** has no cursor today: it is first-page-only by design (assembler line 795-799). Lexical and semantic do have `next_cursor`.
- Honest disclosure is already partially wired: `truncated` flag drives "recent sample; select a row to open that stream's full records" caption (`records-explorer-view.tsx` lines 347-358), and `activitySummary.source = "bounded_sample"` vs `"exact_window"` distinguishes the two honesty modes.

**The gap Tim named:** The current "recent" feed says "showing 6 of 1,183 Amazon orders" (or equivalent) and offers no path to navigate the remaining 1,177. The truncation message exists but the exit ramp does not.

---

## 2. Prior Art: How Leading Products Structure "All My Data" Browsing

### 2.1 Datadog Log Explorer

**The pattern:** Datadog draws a hard architectural line between the **Log Explorer** (unified cross-source feed for investigation) and **Dashboards** (per-widget, per-query scoped views for monitoring). The Log Explorer is the canonical "all my logs" surface. It is a single unified feed across all log sources, with faceted filtering on source/service/tag/index and cursor-based pagination (`nextLogId`) at the API layer.

**The honest-cap problem:** The UI displays at most 1,000 log entries in a single view. This is documented at https://docs.datadoghq.com/logs/guide/collect-multiple-logs-with-pagination/ and is a known UX friction point: there is no seamless "Load more" past the wall without dropping to the API. Export (up to 100,000 logs as CSV) is the escape valve but it is not surfaced inline. The Patterns view derives counts from a 10,000-log sample, making them estimates (docs.datadoghq.com/logs/explorer/analytics/patterns/).

**What Datadog gets right:** The Explorer is the one true home for cross-source search/browse. Filters narrow it; once sufficiently narrowed (e.g., `service:api host:web-1`) the bounded result IS the complete result. The key insight is that the honesty problem is solved by **making the filtered set small enough to be exact**, not by paginating a merged firehose.

**What Datadog gets wrong (the dead-end):** When the user has not narrowed enough and hits the 1,000 cap, the UI does not offer a path to "see all" beyond the filter. This is the canonical example of what Tim's product bar forbids.

### 2.2 Stripe Dashboard: Activity Feed vs. Per-Object Lists

**The pattern:** Stripe's primary discovery surface is NOT a unified transaction firehose. It is a set of **per-entity paginated lists**: the Payments list at `dashboard.stripe.com/payments`, the Customers list, the Subscriptions list, and so on. Each list is fully paginated with cursor-based navigation. The "Activity" view on a connected account detail page is a **scoped summary**, not the browsable-everything surface.

**The key design move:** Stripe's "Activity Breakdown" (docs.stripe.com/reports/activity-breakdown) drills from a summary total to an underlying filtered full list. You click a dollar amount, and you land on a filtered `Payments` list showing every transaction contributing to that total. This is the SLVP pattern for "no dead-ends": summary shows a bounded preview; every row or aggregate is a link into a FULL paginated list of the matching set.

**The Events API** (docs.stripe.com/api/events) provides a unified cross-resource event feed for programmatic consumption but it is not the primary BROWSE surface for humans. It is the firehose for webhooks and reconciliation, not the day-to-day browsing experience.

**Takeaway:** Leading products separate "cross-cutting summary/discovery" from "per-entity full list." The unified feed is the entry point; the per-entity paginated list is the "I need to see everything" destination.

### 2.3 Linear: My Issues vs. Project Lists

**The pattern:** Linear's "My Issues" view (linear.app/docs/display-options) aggregates work assigned to you across ALL teams and projects into a single cross-cutting view. It is explicitly a personal **discovery** surface: you see the issues that matter to you, regardless of which project they live in.

**The per-entity full set lives elsewhere:** If you want to see ALL issues in a project (not just yours), you navigate to the project list. If you want every issue ever created across all projects, you use global search. "My Issues" is explicitly bounded by your assignment/subscription -- it does not pretend to be a complete set. The label "My Issues" makes the scope honest.

**The global search** is the cross-cutting find-anything surface, NOT the browse-everything surface. It does not paginate through all 50,000 issues in your workspace; it returns ranked results for a query.

**Takeaway:** A cross-cutting aggregated view is correct for a bounded, well-labeled scope. When the scope is "all records ever," the aggregated view must either be a true paginated firehose (correct) or be honest about being a sample with a real exit to the full set (also correct).

### 2.4 GitHub: Global Search vs. Per-Repository Lists

**The pattern:** GitHub's global search (docs.github.com/en/search-github) is a **discovery** surface, not a browse-all surface. When you search issues globally, you get ranked results capped to the most-relevant page. There is no "show me all 2 million issues ever created" view.

**The per-repo list IS the full list:** Within a repository, the Issues list is fully paginated. You can see all 847 issues by scrolling through pages. The mental model is: global search finds it, per-entity list browses it.

**The "All repositories" toggle** (github.blog/news-insights/repository-search-on-all-repositories/) is the escape from repo-scoped to global, but even the global result is ranked/scoped, not an infinite firehose.

**Takeaway:** No leading SLVP-tier product exposes a raw, fully-paginated firehose across ALL entities of ALL types as the primary user-facing browse surface. They all differentiate search (cross-cutting, relevance-ranked, bounded) from browse (per-entity, fully-paginated, keyset-stable).

### 2.5 Airtable: Grid View vs. Cross-Base Search

**The pattern:** Each Airtable table has its own paginated Grid View. Cross-table or cross-base search is a secondary feature (support.airtable.com/docs/list-view-overview). The primary browse model is per-table, per-entity.

**Pagination:** The Airtable API uses offset-based pagination (community.airtable.com/development-apis-11/airtable-pagination-4463), which is less stable than keyset but the UX design principle is the same: the table view is the "see everything" surface; cross-base is for find/discovery.

### 2.6 Notion: Search vs. Database Views

**The pattern:** Notion explicitly distinguishes workspace search (cross-cutting, all page content, open-ended) from database views (per-database, filtered, browsable). The help article "When to use each type of database view" (notion.com/help/guides/when-to-use-each-type-of-database-view) makes this explicit: use workspace search when "you don't know where something lives"; use a database view when "you want to browse a structured dataset."

**Linked Views / Dashboards:** Notion's dashboard views (launched 2026 per alternativeto.net/news/2026/3/notion-introduces-dashboard-views) embed multiple filtered database views on one page. A widget shows a bounded sample; the user clicks into the linked database for the full list. This is the "summary + escape ramp" pattern executed cleanly.

**Takeaway:** Notion's clearest UX principle is that search and database-browse are different intents, served by different surfaces that link to each other.

### 2.7 PostHog: Activity Feed vs. Persons List

**The pattern:** PostHog maintains TWO separate browse surfaces (posthog.com/docs/data/events, posthog.com/docs/data/persons):
1. The **Activity / Events tab**: a global live feed of all events across all users, updating every 30 seconds. This is the raw-firehose surface.
2. The **Persons list**: a per-entity paginated list of user profiles, with filtering by person properties and cohort membership.

**They serve different intents:** The Events feed is for debugging and observability (what is happening right now). The Persons list is for segmentation and user-level browsing (who has these properties). Neither pretends to be the other.

**Takeaway:** PostHog's separation of "event-level feed" from "entity-level list" maps directly to PDPP's distinction between "cross-stream Explore" and "per-stream records page."

### 2.8 Plaid / PFM Apps: Unified Transaction Feed vs. Per-Institution View

**The pattern:** Plaid's API (plaid.com/docs/transactions/) returns a unified cross-institution transaction feed, and best-in-class PFM apps built on it (Mint, YNAB) expose BOTH:
- A unified "All Transactions" feed (sorted by date, fully paginated) for budgeting and search.
- A per-institution or per-account list for reconciliation and account-specific history.

**The key fact:** The unified feed works here because transactions are **homogeneous** -- they all have the same shape (amount, merchant, date, category) regardless of source institution. This makes a merged sorted feed semantically coherent.

**Heterogeneous data changes the equation:** When records from different streams have DIFFERENT schemas (a WhatsApp message vs. an Amazon order vs. a GitHub commit), a merged feed still works for BROWSING by time but is harder to read and harder to filter precisely. PDPP's data is explicitly heterogeneous across streams.

### 2.9 Algolia InstantSearch: Browse vs. Search

**The pattern:** Algolia explicitly separates "search" (query-driven, relevance-ranked) from "browse" (catalog exploration, no query, infinite scroll or paginated). The `browse` API endpoint is specifically for retrieving all records without relevance ranking (www.algolia.com/doc/guides/building-search-ui/ui-and-ux-patterns/infinite-scroll/js). A "show me everything" browse uses different semantics than a search.

**Infinite scroll for browse:** Algolia recommends infinite scroll for catalog browse (non-query) and paginated results for search (query). The "see more" button at bottom of a page is the recommended escape from a bounded first-page view to the full set.

**Takeaway:** Even a search-specialist company separates "search" from "browse all" and recommends different UX patterns for each.

---

## 3. The Core Pattern: What ALL Leading Products Do

After examining eight reference products, the pattern is universal and consistent:

**All leading products separate "cross-cutting find/skim" from "per-entity see-everything."**

The cross-cutting surface is for:
- Cross-source search (query-driven, relevance-ranked or time-ranked)
- Quick overview / recency pulse ("what happened recently across all my stuff")
- Scoping / discovery ("which source/stream do I want to dig into?")

The per-entity surface is for:
- Fully-paginated browsing of a SINGLE entity's complete record set
- Filters within a known entity context
- Stable keyset navigation through tens of thousands of records

**None** of the reference products expose a raw, fully-paginated firehose across ALL entities of ALL types as the ONLY browse surface. But the SLVP products ALL ensure the cross-cutting surface provides an honest exit ramp into the full per-entity paginated list.

**The critical distinction from the Datadog failure case:** Datadog's Log Explorer is capped at 1,000 and the exit to "more" requires dropping to the API. Stripe, Linear, Notion, and GitHub avoid this by making the per-entity list the explicit destination for "see everything," and wiring every summary row to link there.

---

## 4. The k-Way Merge Question: Is Unified Pagination Technically Sound?

Tim explicitly asked whether a merged, time-sorted, fully-paginated cross-source feed is "fundamentally unsound." It is NOT unsound, but it has a specific correctness requirement.

**k-way merge with per-stream keyset cursors is technically correct:**
- Given k streams each with a stable keyset sort (e.g., `(emitted_at, record_key)`), a k-way merge using a min-heap can produce a globally sorted merged feed one page at a time.
- Each page fetch reads the "next N" from each stream, merges, and the cursor state is a vector of k per-stream cursors.
- This approach is `O(P log k)` where P is page size and k is stream count. See: algocademy.com/blog/k-way-merge-a-comprehensive-guide/, stacksync.com/blog/keyset-cursors-postgres-pagination-fast-accurate-scalable.

**The implementation requirement:** A paginated merged feed requires server-side merge or a cursor-vector per page. Today's assembler does a CLIENT-SIDE fan-out that fetches a fixed per-stream sample and merges in-memory. This is a bounded sample, NOT a cursor-paginated merged feed. It could be extended to cursor-paginated with a vector of per-stream cursors, but that is new functionality.

**The heterogeneity cost:** A single merged feed across WhatsApp messages, Amazon orders, GitHub commits, and USAA transactions is time-sorted but not type-homogeneous. Each card renders differently (`kind: "message" | "money" | "event" | "titled" | "generic"` in `record-kind.ts`). The feed is browsable but the user cannot, for example, "show me only money records" without a stream filter -- and as soon as a stream filter is applied, the feed narrows to one or two streams, at which point the per-entity page is just as good.

---

## 5. What Makes an Explorer "Complete and Trustworthy"

Synthesizing the prior art, three properties distinguish Stripe/Datadog/Linear-quality explorers from frustrating ones:

**Property 1: Every bounded view is labeled as such.** When you see a bounded sample, the label says "most recent N records" not "all records." PDPP's `activitySummary.source = "bounded_sample"` text is already correct; Datadog's 1,000-log cap is labeled but its escape is broken.

**Property 2: Every bounded view has a real escape ramp.** Stripe's Activity Breakdown links to the full Payments list. Notion's dashboard widget links to the full database. PDPP currently says "select a row to open that stream's full records" (records-explorer-view.tsx line 349) -- this caption names the per-stream page as the escape but does NOT provide a direct link to it. The caption text is honest but passive.

**Property 3: Filters that narrow to a single stream produce a COMPLETE view.** When the user applies `connection=gmail&stream=messages`, the scoped feed should show ALL records in that stream, not a sample, because the scope is now equivalent to a per-entity list. This is the "filter becomes a full list" pattern. Datadog achieves this by narrowing until the result set is below the cap. PDPP's scoped feed hits the same per-stream cap regardless of how narrow the filter is.

---

## 6. Recommendation: Shape C (Explicit Hybrid)

**The SLVP-ideal shape for PDPP Explore is C: a cross-source discovery/search surface as the primary lens, with filter-scoping that transitions into a full-paginated per-stream list, connected by explicit escape ramps.**

This is not a compromise; it is what all the reference products do. Concretely:

### 6.1 The Cross-Cutting Discovery Feed (keep + fix honesty)

Keep the current merged-timeline Explore feed as the DISCOVERY surface. It is the right tool for:
- "What happened recently across all my data?" (recent lens, bounded sample)
- "Find records matching this query across all sources" (search lens)
- "What happened in October across all sources?" (time-range lens)

Fix the honesty gap: the "recent sample" caption (line 349) already exists but must become an ACTIVE exit ramp, not passive text. See Section 6.3.

### 6.2 The Per-Stream Full List (per-entity page, already exists)

The per-stream records page at `/dashboard/records/[connector]/[stream]` is already the correct "see everything" surface. It has:
- Keyset pagination with a cursor trail (page.tsx lines 152, 295-296)
- `PAGE_SIZE = 50` per page
- Exact total count when server returns it (lines 54-79, "page 1 * 50 shown of 1,183 total")
- Column selection, exact-field filters, relationship navigation

This page already IS the SLVP-ideal per-entity browser. The job is to connect it more aggressively from Explore.

### 6.3 The Escape Ramp (the missing piece)

The current state: Explore shows "most recent 32 records across all connections. Submit a query or pick a date window to narrow further." It does NOT say "or open [Amazon Orders] to see all 1,183."

The SLVP fix: When a row appears in the bounded feed and that stream has `has_more = true` (assembler line 551), the feed must surface a direct link to the per-stream page for that source. The pattern from Stripe/Notion:

- **Per-stream "See all N records" link** beside the stream's section header or connection facet chip. When the feed shows 6 Amazon orders and `has_more = true`, the header above those 6 rows should say "Amazon Orders (1,183 total)" and be a link to `/dashboard/records/amazon/orders`.
- **Connection facet chips** already exist in the UI (`ConnectionFacets` component in records-explorer-view.tsx lines 299-306). Extending them to show a record count and a "See all" link to the per-stream page is the minimal correct fix.
- **Search mode:** When a query returns `search_page_limited` (assembler line 849), the warning already says "open a matching stream to browse complete records." This needs to become a clickable link, not just text.

### 6.4 The "Filter Becomes a Full List" Transition

When the user applies `stream=orders` and `connection=amazon` on Explore, the result is logically equivalent to the per-stream page. At this point Explore should detect "single stream, single connection selected" and either:
- Auto-redirect to the per-stream page (cleanest, but loses the Explore search bar)
- Or: fully paginate the single-stream view within Explore by following the stream's keyset cursor chain (more complex, keeps UX consistent)

The cleaner approach used by all reference products is the redirect: the filter transition IS the navigation. Stripe does not try to show you all 10,000 payments inside the Activity widget; it links you to the Payments list. PDPP should do the same.

### 6.5 What NOT to Build: The Cross-Source Paginated Firehose

Option A (single unified fully-paginated cross-source feed) is technically sound via k-way merge but has no prior art as the PRIMARY browse surface for heterogeneous data in any SLVP-tier product. The reasons:

1. **Heterogeneous cards make a 50-per-page merged list cognitively harder** than a 50-per-page list of a single stream type. A money card, a message card, and an event card in the same scrollable list are readable in small quantities (the "recent" lens works) but frustrating to page through at scale.
2. **The cursor-vector state is complex to serialize** in a URL for a merged feed across 6 connections x 2 streams = 12 keyset cursors. The per-stream page already uses a cursor trail; generalizing this to 12 simultaneous cursors requires non-trivial URL design.
3. **The problem being solved is "no dead-end," not "unified scroll."** The Stripe insight is that users do not actually need to scroll through 1,183 orders mixed with 84,000 WhatsApp messages in one infinite list. They need to be able to GET to all 1,183 orders or all 84,000 messages when they want them, from a surface that surfaces the possibility.

Building a k-way merged paginated firehose would be correct and non-frustrating, but it would be over-engineering a problem that the "escape ramp" approach solves with much less complexity.

---

## 7. Concrete Spec for "Honest, Non-Dead-Ending, Full-Visibility"

Given PDPP's single-owner, self-hosted context and Tim's explicit bar:

**7.1 Recent lens (empty query):**
- Continue showing the bounded sample (up to 32 records across up to 6 connections x 2 streams x 6 records).
- For each stream that appears in the feed and where `has_more = true`, surface a "See all N in [Stream Name]" link to the per-stream page. Use the `exactWindow.total` when available (assembler lines 381-408 already compute this); fall back to "See all" without a count if the total is unknown.
- Move the truncation caption from passive to active: replace the italic text at line 349 with a set of "See all" links per stream.

**7.2 Time-range lens:**
- The time-range fan-out already computes `exactWindow` per stream (assembler lines 381-408) and reports `exactWindowComplete`. Use these totals to label stream sections and provide per-stream escape links filtered to the same date window.
- When a single stream is selected AND a date window is set, the per-stream page accepts `filter[emitted_at_gte]=<since>&filter[emitted_at_lt]=<until>` (or equivalent) to preserve the window.

**7.3 Search lens:**
- Search results are already labeled `"search_page_limited"` when truncated (assembler lines 849-853). The warning message already says the right thing ("open a matching stream to browse complete records"). Make the stream name in that message a link.
- Do not attempt to paginate hybrid search results (no cursor today; first-page-only is the design).

**7.4 Stream facet chips:**
- The `StreamFacets` component (records-explorer-view.tsx line 309) currently filters the merged feed when clicked. Extend it: if clicking a stream facet + connection results in "single stream selected," link directly to the per-stream page instead of narrowing the merged feed.

**7.5 Connection facets:**
- The `ConnectionFacets` component (records-explorer-view.tsx line 299) already exists. Add a "Browse all" or "See records" link per connection that navigates to the per-connection records index page (`/dashboard/records/[connectionId]`).

---

## 8. Summary Table

| Question | Answer | Evidence |
|---|---|---|
| Option A: unified paginated firehose? | No (as primary surface) | No SLVP product does this for heterogeneous data; cursor-vector complexity; not the user need |
| Option B: search-only surface, no inline records? | No | Users need a "recent" pulse, not just a query box |
| Option C: discovery feed + per-entity escape? | Yes (SLVP-ideal) | Stripe, Notion, Linear, Datadog, PostHog, GitHub all use this pattern |
| Is k-way merge sound? | Yes, technically | algocademy.com/blog/k-way-merge, stacksync.com/blog/keyset-cursors-postgres-pagination |
| What makes an explorer trustworthy? | Label bounded samples; real escape ramp; single-stream filter = full list | Stripe Activity Breakdown, Notion linked views, Datadog scoped filter |
| Biggest current PDPP gap? | Truncation caption is passive; no link to per-stream "see all" | `records-explorer-view.tsx` line 349; no `routes.stream(...)` link wired |
| Quickest win? | Wire `has_more = true` stream headers to per-stream page links | Minimal assembler + view change; reuses existing per-stream page |

---

## Sources

- Datadog Log Explorer documentation: https://docs.datadoghq.com/logs/explorer/
- Datadog Log Pagination guide: https://docs.datadoghq.com/logs/guide/collect-multiple-logs-with-pagination/
- Datadog Log Patterns (10K sample): https://docs.datadoghq.com/logs/explorer/analytics/patterns/
- Datadog Log Visualizations: https://docs.datadoghq.com/logs/explorer/visualize/
- Stripe Events API: https://docs.stripe.com/api/events
- Stripe List Events: https://docs.stripe.com/api/events/list
- Stripe Activity Breakdown: https://docs.stripe.com/reports/activity-breakdown
- Stripe Dashboard Basics: https://docs.stripe.com/dashboard/basics
- Linear Display Options: https://linear.app/docs/display-options
- Notion Database Views Guide: https://www.notion.com/help/guides/using-database-views
- Notion When to Use Each View: https://www.notion.com/help/guides/when-to-use-each-type-of-database-view
- Notion Dashboard Views (2026): https://alternativeto.net/news/2026/3/notion-introduces-dashboard-views-to-turn-any-database-into-a-customizable-control-center
- GitHub Search Docs: https://docs.github.com/en/search-github/getting-started-with-searching-on-github/about-searching-on-github
- GitHub Repository Search All: https://github.blog/news-insights/repository-search-on-all-repositories/
- Algolia Infinite Scroll Guide: https://www.algolia.com/doc/guides/building-search-ui/ui-and-ux-patterns/infinite-scroll/js
- PostHog Events Docs: https://posthog.com/docs/data/events
- PostHog Persons Docs: https://posthog.com/docs/data/persons
- Plaid Transactions Docs: https://plaid.com/docs/transactions/
- k-way Merge Guide: https://algocademy.com/blog/k-way-merge-a-comprehensive-guide-to-merging-sorted-arrays/
- Keyset Cursor Pagination: https://www.stacksync.com/blog/keyset-cursors-postgres-pagination-fast-accurate-scalable
- Airtable Pagination Community: https://community.airtable.com/development-apis-11/airtable-pagination-4463
- Stripe Why API is Gold Standard: https://dev.to/yukioikeda/why-stripes-api-is-the-gold-standard-design-patterns-that-every-api-builder-should-steal-3ikk

## PDPP File References

- `packages/operator-ui/src/explore/explore-data-assembler.ts` lines 44-50: fan-out caps
- `packages/operator-ui/src/explore/explore-data-assembler.ts` lines 381-408: exact window merge
- `packages/operator-ui/src/explore/explore-data-assembler.ts` lines 430-443: activitySummary construction
- `packages/operator-ui/src/explore/explore-data-assembler.ts` lines 849-853: search_page_limited warning
- `packages/operator-ui/src/components/views/records-explorer-view.tsx` lines 299-317: ConnectionFacets + StreamFacets
- `packages/operator-ui/src/components/views/records-explorer-view.tsx` lines 347-358: truncation caption text
- `apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx` lines 48, 152, 295-296: PAGE_SIZE=50, cursor trail, next/prev hrefs
- `apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx` lines 54-79: exact count display
