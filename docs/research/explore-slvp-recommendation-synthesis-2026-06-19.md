# Explore Surface: SLVP Recommendation Synthesis

**Date:** 2026-06-19
**Status:** Decisive recommendation -- do not relitigate without new facts
**Sources:** explore-merged-timeline-pagination-prior-art-2026-06-19.md, explore-record-explorer-product-pattern-prior-art-2026-06-19.md, explore-search-relevance-pagination-prior-art-2026-06-19.md

---

## Executive Recommendation (read this first)

**Build Shape C: discovery feed with active per-stream escape ramps, plus wire lexical "Load more". Do NOT build the unified cross-source paginated firehose as the primary surface.**

The k-way merge unified firehose is architecturally sound but solves the wrong problem for heterogeneous data. The missing piece is much smaller: an active link from each truncated stream in the Explore feed to that stream's fully-paginated record page. The per-stream page already IS the complete, SLVP-quality paginated list. PDPP needs to connect it, not rebuild Explore.

---

## Q1: What is the SLVP-ideal surface shape?

**Recommendation: Shape C (explicit hybrid) -- discovery feed plus per-entity full lists connected by active escape ramps.**

Eight reference products (Datadog, Stripe, Linear, GitHub, Airtable, Notion, PostHog, Plaid) converge on the same architecture without exception: a cross-cutting discovery/search surface for "what happened recently / find something across all my data" that links into per-entity fully-paginated lists for "see everything in this stream."

No SLVP-tier product exposes a raw paginated firehose across ALL heterogeneous entity types as the PRIMARY browse surface. The reasons are not purely technical:

1. Heterogeneous cards (a WhatsApp message card, an Amazon order card, a GitHub commit card) are readable in small quantities (the "recent" pulse works) but cognitively expensive to page through at scale in a mixed list. Plaid-style unified feeds work because all records are homogeneous (transactions: amount, merchant, date). PDPP's streams are not.

2. The user's actual question at scale is not "show me all 85,000 WhatsApp messages and 1,183 Amazon orders in one list sorted by time." It is "show me recently what happened across everything" (discovery pulse) or "show me all my Amazon orders" (per-entity browse). The first is a bounded sample with an escape; the second IS the per-stream records page.

3. The "no dead-end" requirement is met by an escape ramp, not by a unified firehose. Stripe's Activity Breakdown links every summary row to the filtered full list. Notion's dashboard widgets link to the full database. PDPP currently says "select a row to open that stream's full records" (records-explorer-view.tsx:349) -- passive text with no link. That is the gap to close.

**What Shape C looks like for PDPP:**
- Recent lens: keep the bounded sample. Fix: surface a "See all N in [Stream]" link per stream wherever `has_more = true` (assembler line 551 drives this). Use `exactWindow.total` (assembler lines 381-408) for the count when known.
- Time-range lens: same sample. Same fix: per-stream count + escape link, pre-filtered to the same date window.
- Search lens: keep the bounded first-page results. Fix: "Showing top 25 most relevant results" label; "Browse all records in [Stream]" CTA on matching stream chips and result rows.
- The per-stream records page (`/dashboard/records/[connector]/[stream]`) is already SLVP-quality: PAGE_SIZE=50, cursor trail (page.tsx:152,295-296), exact total count (page.tsx:54-79). It just needs to be connected more aggressively.

Source: explore-record-explorer-product-pattern-prior-art-2026-06-19.md (Sections 2, 3, 6)

---

## Q2: Is merged-timeline pagination architecturally sound on PDPP's keyset cursor architecture?

**Yes -- technically sound, standard engineering, not niche. It is just not the right first move.**

The k-way merge with per-partition keyset cursors is in production at Elasticsearch (composite aggregation `after_key` is the exact pattern), Datadog Logs (`meta.page.after` opaque Base64 spanning multiple indexes), and Mastodon home timeline. The algorithm: a max-heap of size K, one keyset cursor per partition, composite cursor serialized as a base64url blob (`{partition_id -> {k, r}}` map), stateless.

PDPP already implements the per-partition half. `reference-implementation/lib/db.ts:142` has `encodeCursor`/`decodeCursor` (`{k, r, v}` base64url JSON). `reference-implementation/operations/rs-records-list/index.ts:91-96` returns `has_more`+`next_cursor` per stream. The single-stream cursor trail in `apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx:152` already works. What does not exist is the server-side merge layer.

**Engineering cost if built:**
- One new endpoint (e.g., `GET /v1/explore/records`)
- Composite cursor blob encoding `{v, ceil, parts:{connection:stream -> {k,r}}}`, base64url-encoded, ~3KB at K=30 partitions (within URL limits)
- Server algorithm: parse cursor, fan-out K parallel keyset reads with `before=ceil` soft snapshot, k-way heap merge, build next composite cursor
- Per-page cost: K parallel O(log N) keyset reads + O(K log K) heap ops. At K=10-40 this is trivially cheap
- UI: replace `FEED_TOTAL_CAP=32` slice with paginated component; reuse existing prevHref/nextHref trail pattern

**Why not build it now:** The unified paginated firehose solves "page through all 85k messages and 1k orders in one mixed list." Prior art shows no SLVP product does this for heterogeneous data because users do not want it. The escape ramp approach (Shape C) delivers Tim's "no dead-ends" bar with far less code and without the heterogeneous UX cost.

**If Tim decides the unified firehose IS the right product direction** (e.g., he wants "everything sorted by time across all sources, pageable"), the architecture is fully sound and implementable. It is not off-limits; it is just not the recommendation.

Source: explore-merged-timeline-pagination-prior-art-2026-06-19.md (Sections 1-7)

---

## Q3: The honest answer for the search lens, especially hybrid/relevance/vector

**Hybrid search cannot be honestly deep-paginated with a keyset cursor. The current first-page-only design is correct. The gap is in the UX framing, not the architecture.**

Three independent reasons hybrid pagination is unsound:

1. **ANN/vector top-K is not a prefix.** HNSW (pgvector) is a greedy approximate graph traversal. "Results 26-50" requires re-running with K=50 and discarding the first 25; there is no stable "position 26." Re-querying with a larger K does not guarantee a stable superset of the smaller-K result. (`reference-implementation/operations/rs-search-hybrid/index.ts` already rejects cursor param as `invalid_request`.)

2. **RRF fused rank is not decomposable.** Reciprocal Rank Fusion scores are a function of position across BOTH sub-lists. You cannot compute rank N without knowing ranks 1 through N in both lexical and semantic sub-lists. If the sub-lists change between requests (new data ingested), the fused ranking shifts. Elasticsearch's own RRF pagination is bounded by `rank_window_size`; beyond that, zero results.

3. **Lexical with snapshot IS sound and cursor is already built.** PDPP's lexical search already builds a ranked snapshot and returns `next_cursor` in the envelope (`rs-search-lexical/index.ts:1136`). The Explore assembler discards it (`explore-data-assembler.ts:809`). This is a true UI gap.

**The SLVP-ideal UX per lens:**

| Lens | Deep pagination sound? | SLVP upgrade |
|---|---|---|
| Hybrid search | No (RRF + ANN) | "Showing top 25 most relevant results" label + "Browse all in [Stream]" CTA per matched stream |
| Lexical search | Yes (snapshot cursor) | Wire existing `next_cursor` into a "Load more" button in Explore |
| Recent feed | Yes (keyset stable) | Per-stream "See all N" escape link (per Shape C) |
| Time-range feed | Yes (keyset stable) | Per-stream "See all N" escape link with date filter preserved |

Algolia, Meilisearch, Airtable Deep Match, and Notion "Best Matches" all label hybrid/semantic results with explicit "Top N results" copy. The path to more is query refinement + stream browse, not deeper pagination. That is SLVP-tier honest.

Source: explore-search-relevance-pagination-prior-art-2026-06-19.md (Sections 2-5)

---

## Q4: Recommended end state and phased path

### End State: What "Full Visibility, No Dead-Ends" Looks Like

**Explore Recent lens:** Shows bounded sample across connections (current caps are fine). Each stream group in the feed that has `has_more=true` shows a header: "Amazon Orders -- 1,183 records" that is a link to `/dashboard/records/amazon/orders`. The italic passive caption at records-explorer-view.tsx:349 becomes a set of linked "See all N" CTAs per stream. No dead-end.

**Explore Time-range lens:** Same as recent, with per-stream "See all N in [date window]" links that pass `filter[cursor_field_gte]` and `filter[cursor_field_lt]` to the per-stream records page.

**Explore Search lens (hybrid):** "Showing top 25 most relevant results" visible label near the result count. Each matched stream chip in the `StreamFacets` component (records-explorer-view.tsx:309) shows a "Browse all [N]" link to the stream records page. "Narrow results" label on filter chips (not generic "Filter"). No cursor added to hybrid. No dead-end.

**Explore Search lens (lexical):** "Load more" button wires the existing `next_cursor` from the lexical envelope. Accumulate results (infinite scroll or prev/next). The snapshot infrastructure already exists.

**Per-stream records page:** Already SLVP-quality. No changes required except adding stream-level context (source name, connection badge) for navigational clarity on landing from Explore.

**Connection facets (records-explorer-view.tsx:299):** Add "Browse all records" link per connection, navigating to the per-connection records index.

### Phased Path

**Phase 1 (cheap, high-impact, ~1-2 days):**
Active escape ramps on the recent and time-range lenses. When `has_more=true` for a stream in the fan-out result (assembler:551), display "See all N in [Stream]" as a linked header above those rows. Wire `exactWindow.total` (assembler:381-408) for the count. Replace the passive caption at records-explorer-view.tsx:349. This alone closes Tim's "6 of 1,183 with no path forward" complaint without building anything new.

**Phase 2 (small, completes search honesty, ~1 day):**
Lexical "Load more": persist the `next_cursor` returned by `rs-search-lexical/index.ts:1136` in the assembler's loadSearchFeed (currently discarded at explore-data-assembler.ts:809). Add a "Load more results" button to the Explore search result view. Hybrid: upgrade the `search_page_limited` warning (assembler:849) to "Showing top 25 most relevant results" with linked stream CTAs.

**Phase 3 (optional, only if Tim decides the merged firehose is the right direction):**
Unified paginated firehose via k-way merge server endpoint. Full architecture is specified in explore-merged-timeline-pagination-prior-art-2026-06-19.md, Section 6. Cost: 1 new endpoint, composite cursor design, UI pagination component swap. Not recommended as the primary investment if Phase 1-2 close the product bar.

### Decision for Tim

If the bar is "no dead-ends from the Explore surface to the full record set for any stream" -- Phases 1 and 2 get there. Both are small changes against existing infrastructure.

If the bar is "one unified paginated list across ALL sources and streams, sorted by time, navigable to the last record" -- that is Phase 3. It is architecturally sound and worth building eventually, but it does not replace the per-stream records page (users still need stream-scoped views for filtering and relationship navigation). No prior art treats the unified firehose as the ONLY paginated surface.

The shape that no SLVP-tier product uses: a discovery feed that dead-ends with no exit ramp. PDPP currently has that shape. Phases 1 and 2 fix it at minimal cost.

---

## PDPP File References

- Fan-out caps: `packages/operator-ui/src/explore/explore-data-assembler.ts:44-50`
- Per-stream `has_more` gate: `packages/operator-ui/src/explore/explore-data-assembler.ts:551`
- Exact window totals: `packages/operator-ui/src/explore/explore-data-assembler.ts:381-408`
- Activity summary construction: `packages/operator-ui/src/explore/explore-data-assembler.ts:430-443`
- Search page limited warning: `packages/operator-ui/src/explore/explore-data-assembler.ts:849-853`
- Lexical cursor discarded: `packages/operator-ui/src/explore/explore-data-assembler.ts:809`
- Truncation caption (passive, to be replaced): `packages/operator-ui/src/components/views/records-explorer-view.tsx:347-358`
- Connection facets: `packages/operator-ui/src/components/views/records-explorer-view.tsx:299-306`
- Stream facets: `packages/operator-ui/src/components/views/records-explorer-view.tsx:309-317`
- Per-stream keyset cursor: `reference-implementation/lib/db.ts:142-174`
- Per-stream `next_cursor` + `has_more`: `reference-implementation/operations/rs-records-list/index.ts:91-96`
- Lexical `next_cursor` in envelope: `reference-implementation/operations/rs-search-lexical/index.ts:1136`
- Hybrid cursor rejection: `reference-implementation/operations/rs-search-hybrid/index.ts` (cursor param -> `invalid_request`)
- Single-stream cursor trail: `apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx:152,295-296`
- Per-stream exact total display: `apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx:54-79`
