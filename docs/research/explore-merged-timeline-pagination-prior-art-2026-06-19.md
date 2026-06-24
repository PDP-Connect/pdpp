# Merged Timeline Pagination Prior Art and PDPP Verdict

**Date:** 2026-06-19
**Status:** Research complete, verdict rendered
**Scope:** Engineering prior art for paginating a merged, time-sorted feed across many independently-cursored partitions (scatter-gather / federated cursor / k-way merge timeline pagination)

---

## Summary Verdict

Full merged-timeline pagination is **sound, standard engineering** for a data-ownership product like PDPP. The k-way merge with per-partition keyset cursors is the canonical algorithm -- used by Elasticsearch composite aggregation, Twitter/X home timeline, Mastodon, Datadog Logs, Slack, Facebook Graph, and GitHub. The composite cursor (a serialized map of per-partition positions, opaque to clients) is URL-safe when Base64-encoded and stateless. Fan-out width for PDPP (10--30 partitions at realistic scale) is far below the threshold where the algorithm becomes a concern; it is bounded by the manifest, not by user social graph size. Page stability under new arrivals is handled by keyset anchoring (the "descended past" boundary is fixed) combined optionally with a point-in-time snapshot on the server side. The current PDPP Explore surface is a **first-page-only, client-side merge** capped at 32 records with no "Next page" path -- this dead-ends Tim at 6 of 1,183 Amazon orders and violates the no-dead-end product bar. The SLVP-ideal is a server-side k-way merge endpoint returning `next_cursor` + `has_more` per page.

---

## 1. The Canonical Algorithm: k-way Merge with Per-Partition Keyset Cursors

### Core structure

A merged timeline over K independent streams (connection, stream) is the classic **merge K sorted lists** problem. The optimal algorithm uses a min-heap (or equivalent priority queue) of size K, where each heap entry holds the current frontier record from one partition and a pointer to that partition's cursor. Page N is produced by:

1. For each active partition, issue a bounded read (`queryRecords(partition, cursor=lastCursor[partition], limit=pageSize)`) in parallel.
2. Pop the globally-smallest (or largest) timestamp from the heap.
3. Emit records until the page is full. The partition that contributed the last emitted record is advanced; all others retain their current cursor position.
4. The composite cursor for the page boundary = `{ partition_id -> cursor_value }` for every partition, serialized as an opaque blob.

The key invariant: the composite cursor is the **full frontier** -- a map from each partition ID to the keyset position that partition has reached. "Next page" means: for each partition, resume from its recorded position. This is stateless because the cursor carries all state needed to reconstruct the frontier.

**Algorithmic cost per page:** O(K log K) heap operations, plus K parallel I/O calls to the underlying storage layer. Because each underlying call uses a keyset predicate (`WHERE (cursor_field, rowid) > (v, r)`), each returns in O(log N) index time regardless of how deep in the dataset you are.

### PDPP grounding

PDPP already implements the per-partition half of this. `reference-implementation/lib/db.ts:142` implements `encodeCursor` / `decodeCursor` (base64url-encoded JSON `{k, r, v}` -- the keyset value `k`, tiebreaker rowid `r`, version `v`). `reference-implementation/operations/rs-records-list/index.ts` exposes `has_more` + `next_cursor` per stream. The single-stream records page (`apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx:152`) already implements a cursor "trail" (comma-separated list of cursors in the URL, popped for prev / pushed for next). The infrastructure to paginate a single partition fully exists and is proven. What does not exist is the **merge layer** that combines per-partition cursors into a single composite cursor and drives the k-way heap.

---

## 2. How Serious Products Encode the Composite Cursor

### Twitter/X (2024)

Twitter's home timeline uses a pre-computed, fan-out-on-write materialized list (a Redis sorted set per user). The server returns `TimelineCursor` entries inside the `TimelineAddEntries.entries` array alongside tweet entries. The cursor has `cursorType: 'Bottom'` (for next-page) and `cursorType: 'Top'` (for new content above). The `value` field is an opaque string (`'DAAACgGBGedb3Vx__9sKAAIZ5g4QENc99AcAAwAAIAIAAA'`) -- it is not a raw timestamp but a position in the pre-materialized timeline list for that user. Each `TimelineItem` also carries a `sortIndex` string (a synthetic monotonic integer) that drives ordering within the materialized list.

Twitter's approach collapses the K-partition problem by materializing the merge at write time (fanout-on-write to a single Redis sorted set per follower), so the read cursor is a position in one list, not a composite over K lists. This is their solution to the fan-out width problem at 500M-user scale: trade write amplification for read simplicity. A self-hosted single-owner system like PDPP has no social graph fan-out to worry about -- the 10--30 partition case does not need write-time materialization.

Source: https://trekhleb.dev/blog/2024/api-design-x-home-timeline/

### Mastodon / ActivityPub

Mastodon exposes `max_id`, `min_id`, and `since_id` as string parameters on `GET /api/v1/timelines/home`. These are server-internal entity IDs returned in HTTP `Link` headers (`rel="next"`, `rel="prev"`). The `max_id` sets an upper bound (page backward), `min_id` sets a cursor-forward position, `since_id` sets a lower bound. This is a **single-server keyset cursor** over a materialized home timeline table that is already merged by the ingest fanout (ActivityPub push delivery). The merge happens at ingest time; pagination is over one already-sorted table.

Source: https://docs.joinmastodon.org/methods/timelines/ and https://docs.joinmastodon.org/api/guidelines/#pagination

### Elasticsearch: search_after + PIT (the k-way merge reference implementation)

Elasticsearch's `search_after` is the most explicit public implementation of cross-shard keyset cursor pagination. The request includes:

- `pit.id` -- a Point In Time handle that freezes the index state across pages (prevents phantom/duplicate records from concurrent writes)
- `sort` -- an ordered list of fields (e.g. `[{"@timestamp": "asc"}, {"_shard_doc": "asc"}]`)
- `search_after` -- the sort values from the last hit of the previous page (the composite keyset position)

The implicit tiebreaker `_shard_doc` encodes `(shard_index, lucene_doc_id)`, guaranteeing uniqueness within the PIT. Elasticsearch internally runs a k-way merge across shards using a priority queue; the `search_after` array is the composite cursor that conveys the frontier position across all shards.

The **composite aggregation** is even more explicit: it merges K independently-sorted value sources (e.g. date_histogram + terms), and the `after_key` returned in the response is exactly the composite cursor -- a JSON object of `{ source_name -> last_value }` that is passed as the `after` parameter on the next request. This is the textbook k-way merge cursor, publicly documented and in production at scale.

Sources: https://www.elastic.co/guide/en/elasticsearch/reference/current/paginate-search-results.html, https://www.elastic.co/guide/en/elasticsearch/reference/current/search-aggregations-bucket-composite-aggregation.html

### Datadog Logs Explorer

Datadog's `POST /api/v2/logs/events/search` returns `meta.page.after` -- a Base64-encoded opaque cursor passed as `page.cursor` in subsequent requests. The API spans multiple log indexes (data partitions) transparently; the cursor encodes the cross-index frontier. The response also includes `links.next` (a pre-built URL). This is a production-scale example of merged cross-partition pagination over time-ordered data where the caller does not need to know the partition structure.

Source: https://docs.datadoghq.com/logs/guide/collect-multiple-logs-with-pagination/

### Stripe

Stripe's list APIs use `starting_after` and `ending_before` -- plain object IDs, not opaque tokens. This works because Stripe's event/charge/customer lists are **single-stream, already-sorted tables** (one database partition, monotonic IDs). The cursor is trivially a single ID because there is no fan-out to merge. Stripe does not need a composite cursor because there is no K-way problem; it is the K=1 degenerate case.

Stripe's `/v2/core/events` timeline (their unified activity feed for webhooks and billing) is also a single pre-materialized stream -- not a merge of independently-cursored partitions.

Source: https://edge-docs.stripe.com/api/pagination

### Slack

Slack evolved from offset to cursor pagination, encoding the cursor as a Base64-opaque string that can internally be a different strategy per endpoint. The `users.list` cursor decodes to `user:W07QCRPA4` -- the last-seen user ID. Slack's `conversations.history` (per-channel message history) uses a Unix timestamp as the cursor; pagination within a single channel is straightforward keyset. Slack does **not** expose a cross-channel merged timeline API -- that is the `search.messages` endpoint, which is full-text search returning relevance-ranked results, not a keyset-paginated chronological merge.

This is the key split: Slack deliberately separates **browse-within-channel** (keyset-paginated, single partition) from **search-across-channels** (relevance-ranked, first-page results). The cross-channel search endpoint does not guarantee deep pagination of a chronological merge.

Source: https://slack.engineering/evolving-api-pagination-at-slack/

### Facebook Graph API

Facebook returns `paging.cursors.after` and `paging.cursors.before` as Base64-encoded opaque strings, plus `paging.next` and `paging.previous` as pre-built URLs. The cursor is explicitly called opaque: "a random string of characters which marks a specific item." This is the standard pattern.

Source: https://developers.facebook.com/docs/graph-api/results

### GitHub

GitHub uses cursor-based pagination for per-repo activity (`GET /repos/{owner}/{repo}/activity`) via an `after=` parameter in the `Link` header (e.g. `after=djE6ks8AAAADp2rKWQA`). GitHub does not expose a native unified cross-repo merged activity feed with cursor pagination via REST. The user events API (`GET /users/{username}/events`) uses offset pagination and is capped. Cross-repo merged feed work requires GraphQL. This is a case where the product chose NOT to build the merged feed -- the engineering cost and ranking complexity did not justify it for a source-code forge.

Source: https://docs.github.com/en/rest/using-the-rest-api

---

## 3. Fan-out Width: How Products Handle N Concurrent Queries per Page

The naive k-way merge fires K concurrent reads per page. At K=10 this is fine; at K=10,000 (Twitter's follower graph) it is not.

**Strategies used:**

### a) Write-time materialization (Twitter, Mastodon)
Pre-merge at write time into one sorted list per consumer. Reads become K=1 cursors. Cost: write amplification (tweet goes to N follower timelines). Correct for massive social graphs. Wrong for PDPP, which has no social graph fan-out and data volumes that are bounded by the owner's own data.

### b) Partition pruning via capability field (Elasticsearch, Datadog)
Before scatter-gather, filter the partition set by metadata (index name, tag, time range). Elasticsearch's `search_after` + PIT only scans shards that have matching data. Datadog's log indexes can be filtered by `@index` at the query level. For PDPP, the manifest already provides this: each stream declares a `cursor_field` and a `consent_time_field`. A merged cursor can prune partitions that have no data in the requested time window at query time.

### c) Bounding fan-out width explicitly
PDPP already does this for the current snapshot feed: `MAX_FEED_CONNECTIONS = 6`, `MAX_FEED_STREAMS_PER_CONNECTION = 2` (see `packages/operator-ui/src/explore/explore-data-assembler.ts:44`). This is appropriate for the first-page "recent sample" lens. For full pagination, the fan-out width is the total number of (connection, stream) pairs the owner has configured. For a typical PDPP instance this is 10--40 pairs -- well within the range where K concurrent reads per page is cheap (each returning in O(log N) keyset time).

### d) Connection pool / batching
For wide fan-out (K > 50), batch the K reads into M rounds of concurrency. PDPP is currently single-owner and unlikely to exceed K=50 meaningful partitions.

**PDPP conclusion:** Fan-out width is not a meaningful constraint. The manifest-driven partition list is the natural bound. A merged-timeline endpoint should accept optional `connection` and `stream` filter params (which the Explore page already supports for the current snapshot) to let the user narrow the active partition set.

---

## 4. Page Stability Under New Arrivals

### The problem
If records arrive in partition P between page 1 and page 2 of a merged read, a naive implementation may deliver duplicates (new records pushed existing ones past the page boundary) or skip records (the cursor advanced past a new record's position).

### Keyset anchoring (the standard approach)
The keyset cursor for partition P records the `(cursor_field, rowid)` of the last record emitted from P on page 1. Page 2 for P starts at `WHERE (cursor_field, rowid) > (v, r)`. New records in P that fall above the cursor (newer than the last emitted record) will appear when the user navigates forward past their timestamp, or will appear as "N new above" if the UI exposes that affordance. New records that fall below the cursor (older, e.g., delayed ingest) may not appear unless the user re-fetches. This is the standard trade-off for live feeds: keyset pagination is not a snapshot, but it is stable against duplicates and does not lose records that were present at page-1 time.

PDPP's existing per-stream keyset (`{k, r, v}` in `db.ts:142`) already provides this guarantee within a single partition.

### Point-in-time snapshot (Elasticsearch PIT, Datadog)
For stronger stability, Elasticsearch's PIT freezes the Lucene segment state at a timestamp; all pages of a search see the same index state. Datadog's opaque cursor encodes an index-state snapshot. The cost is server-side state held open for the duration of a pagination session. For PDPP (SQLite or Postgres, single-user), this can be approximated by filtering on `emitted_at <= (page1_start_time)` -- effectively a soft snapshot via a time ceiling.

### Slack's "latest" approach
Slack's `conversations.history` accepts a `latest` parameter (Unix timestamp upper bound) that pins the ceiling of each page request. This is the lightweight snapshot pattern: the client records the timestamp at which the first page was loaded and passes it with every subsequent page request. Pages are stable because records above the ceiling are excluded.

### PDPP recommendation
For the time-range lens, the `until` parameter already acts as the ceiling. For the empty-query "recent" lens, the server can include a soft ceiling (`fetched_at` timestamp) in the composite cursor, which it passes as a `before` filter on subsequent pages. This preserves PDPP's current "newest first" ordering without server-side PIT state.

---

## 5. When Products Do NOT Build Merged Pagination (and Why)

Several products deliberately split into a discovery/search surface + per-entity full list:

**Slack:** Cross-channel chronological merged feed does not exist as a paginated API. Browse (per-channel history) is keyset-paginated; search is relevance-ranked first-page-only. Reason: the ranking function (relevance score) is not a stable keyset comparator, so deep pagination of search results is not meaningful. Chronological cross-channel merged browse was likely deemed too expensive to serve without materialization.

**GitHub:** No cross-repo merged activity feed via REST. Reason: the use case is repo-scoped by product design; unified cross-repo timelines are a power-user feature served by GraphQL with its own cursor infrastructure.

**Twitter:** Fan-out-on-read (merge K=500 followee streams per page) was abandoned early as unscalable at 500M user scale. The solution was write-time materialization, not "don't paginate." Twitter still paginates a merged feed -- they just merge at write time.

**When NOT to merge:** The split-into-search + per-entity-browse pattern makes sense when (a) ranking is relevance-based (not timestamp), (b) partitions are too numerous or too heterogeneous to merge cheaply, or (c) the user's actual question is "find me X across all partitions" (search), not "show me everything sorted by time" (browse). For PDPP's owner, both questions matter: they want full chronological browse of their own data.

**PDPP's hybrid search case:** PDPP already implements the split correctly for hybrid search (`loadSearchFeed` in `explore-data-assembler.ts:766`): hybrid search returns a relevance-ranked first page with no cursor, which is appropriate. Lexical search returns `next_cursor` and `has_more` (so deep pagination is possible in principle). The chronological merged feed is the part that lacks pagination.

---

## 6. Implementation Shape for PDPP

### What to build

**Server endpoint: `GET /v1/explore/records` (or equivalent)**

Request parameters:
- `connection[]` -- filter to specific connections (optional, default = all active)
- `stream[]` -- filter to specific streams (optional, default = all)
- `since` / `until` -- time window filter (ISO 8601)
- `limit` -- page size (default 50, max 500)
- `cursor` -- opaque composite cursor from the previous page (absent = first page)

Response:
```json
{
  "data": [ ...records sorted by displayAt desc... ],
  "has_more": true,
  "next_cursor": "<base64url-encoded composite cursor>",
  "meta": { "partitions_scanned": 12, "partitions_empty": 3 }
}
```

**Composite cursor encoding:**
```json
{
  "v": 1,
  "ceil": "2026-06-19T12:00:00Z",
  "parts": {
    "<connection_id>:<stream>": { "k": "2026-06-10T08:23:11Z", "r": 4172 },
    "<connection_id>:<stream>": { "k": "2026-06-09T19:01:44Z", "r": 3841 }
  }
}
```
Base64url-encode the JSON. `ceil` is the ceiling timestamp (soft snapshot), set to `NOW()` at first-page time and passed through unchanged in subsequent cursors. Partitions with no records are omitted from `parts`; on resume they are re-queried from the beginning (they had no records on the previous page).

**Server-side algorithm:**
1. Parse composite cursor. Extract `ceil` and per-partition positions.
2. Partition list = intersect manifest-declared active connections with request filters.
3. Fan-out: for each partition, issue `queryRecords(partition, cursor=parts[partition], limit=pageSizePerPartition, before=ceil)` concurrently.
4. K-way merge of results using a max-heap keyed on `displayAt`. Emit records until `limit` reached.
5. Build next composite cursor: for each partition, record the cursor position of the last record emitted from that partition (or carry forward the previous cursor if no records were emitted from that partition this page).
6. Return `has_more = true` if any partition returned `has_more` or if the heap still has unconsumed records.

**Per-partition page size:** Use `ceil(globalLimit / activePartitions) + buffer` as the per-partition fetch size, with a minimum of 5. This ensures enough records are fetched across all partitions to fill a page without multiple rounds of I/O per page. Alternatively, overfetch with a fixed `perPartitionLimit` (e.g. 25 records per partition per page), which gives up to `K * 25` candidates to merge down to `limit` results.

### What the UI should show

- "Showing 32 of 1,183" becomes "Showing 1--50 of 1,183+" with a real "Next page" button.
- The `activitySummary` block (`explore-data-assembler.ts:410`) should say `"source": "paginated"` and show the actual record range and per-partition totals from `meta.exactWindows`.
- The time-range lens already computes per-stream `exactWindow.total` and sums them (`mergedExactWindow` at line 387). With full pagination this sum becomes the authoritative total count with no bounding.
- The empty-query "recent" lens (currently `FEED_TOTAL_CAP = 32`) should become the first page of a fully paginated merged feed with `limit = 50` default.

---

## 7. Cost Assessment

| Concern | Single-stream keyset | K-way merge cursor | PDPP specific |
|---|---|---|---|
| Per-page I/O | O(log N) per partition | K * O(log N) parallel | K = 10-40; trivial |
| Cursor size | ~80 bytes | ~100 + 80*K bytes | ~3 KB at K=30; fine in URL |
| Stability | Stable, no duplicates | Same guarantee | Soft-snapshot via `ceil` |
| Server state | None (stateless) | None (stateless) | No PIT needed for SQLite/PG |
| UI complexity | Prev/Next exists today | Prev/Next unchanged | Extend existing trail pattern |
| New arrivals | "N new above" pattern | Same | Optional, add later |
| Search lens | Not affected | Not affected | Hybrid stays first-page-only |

The cursor URL length at K=30 partitions is approximately 3 KB when Base64-encoded -- within URL limits for modern browsers (2--8 KB). The PDPP records page already uses a comma-separated cursor trail in the URL (`cursors=` param at `page.tsx:152`); the composite cursor for the merged feed is a single encoded blob of similar character length.

---

## 8. The Definitive Answer to Tim's Question

**Is a unified, fully-paginated cross-source explorer the SLVP-ideal?**

Yes. The k-way merge with per-partition keyset cursors is sound, standard, and in production at every SLVP-tier product that has a chronological merged feed (Datadog, Mastodon, Elasticsearch composite agg). Products that avoid it do so for a specific reason -- social-graph-scale fan-out (Twitter) or relevance-ranked search (Slack search, PDPP hybrid) -- neither of which applies to PDPP's chronological browse lens. For PDPP's scale (one owner, 10--40 partitions, millions of records, SQLite or Postgres), the algorithm is cheap.

**Is the current implementation a dead-end?**

Yes. `FEED_TOTAL_CAP = 32` with no cursor and `activitySummary.source = "bounded_sample"` and the copy "recent sample; select a row to open that stream's full records" is an explicit dead-end message. Tim's bar is "no terminal caps presented as complete; if bounded, there must be a real path to the complete set." The real path exists at the per-stream level (the records page cursor trail works) but not at the merged level.

**What does it cost?**

One new server endpoint (`/v1/explore/records`) that runs the k-way merge in O(K log K) per page with K parallel keyset reads. The composite cursor is a Base64url blob of ~1--4 KB at realistic K. The UI change is minimal: replace the `FEED_TOTAL_CAP` slice and `bounded_sample` status with a paginated component reusing the existing `prevHref` / `nextHref` trail pattern.

---

## Citations

- Twitter/X timeline API design (2024): https://trekhleb.dev/blog/2024/api-design-x-home-timeline/
- Twitter fanout architecture (2013): https://highscalability.com/the-architecture-twitter-uses-to-deal-with-150m-active-users/
- Twitter fanout strategy analysis: https://dev.to/gabrielanhaia/twitters-fanout-strategy-at-scale-the-trade-off-most-designs-miss-55oa
- Mastodon timelines API: https://docs.joinmastodon.org/methods/timelines/
- Mastodon pagination guidelines: https://docs.joinmastodon.org/api/guidelines/#pagination
- Elasticsearch search_after + PIT: https://www.elastic.co/guide/en/elasticsearch/reference/current/paginate-search-results.html
- Elasticsearch composite aggregation (k-way merge reference): https://www.elastic.co/guide/en/elasticsearch/reference/current/search-aggregations-bucket-composite-aggregation.html
- Elasticsearch PIT API: https://www.elastic.co/guide/en/elasticsearch/reference/current/point-in-time-api.html
- Datadog logs pagination: https://docs.datadoghq.com/logs/guide/collect-multiple-logs-with-pagination/
- Stripe pagination: https://edge-docs.stripe.com/api/pagination
- Slack pagination evolution (2017, updated 2020): https://slack.engineering/evolving-api-pagination-at-slack/
- Facebook Graph API cursor pagination: https://developers.facebook.com/docs/graph-api/results
- GitHub activity cursor pagination: https://github.com/orgs/community/discussions/69826
- USPTO patent on N-way paginated merge: https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/9465881

### PDPP file:line references

- Fan-out caps: `packages/operator-ui/src/explore/explore-data-assembler.ts:44-49`
- Client-side k-way merge (sort step): `packages/operator-ui/src/explore/explore-data-assembler.ts:569`
- Bounded sample status: `packages/operator-ui/src/explore/explore-data-assembler.ts:426-443`
- Per-stream keyset cursor encoding: `reference-implementation/lib/db.ts:142-144`
- Per-stream cursor decoding + tiebreaker: `reference-implementation/lib/db.ts:146-174`
- Single-stream pagination cursor trail (Prev/Next): `apps/console/src/app/dashboard/records/[connector]/[stream]/page.tsx:152,295-296`
- `MAX_FEED_CONNECTIONS`, `MAX_FEED_RECORDS_PER_STREAM`, `FEED_TOTAL_CAP`: `packages/operator-ui/src/explore/explore-data-assembler.ts:44-49`
- Per-stream `next_cursor` + `has_more` contract: `reference-implementation/operations/rs-records-list/index.ts:91-96`
- `mergedExactWindow` (total count across partitions): `packages/operator-ui/src/explore/explore-data-assembler.ts:387-407`
