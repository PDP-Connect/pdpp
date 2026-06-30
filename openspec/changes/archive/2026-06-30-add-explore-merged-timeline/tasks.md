# Tasks: add-explore-merged-timeline

## 1. Server endpoint

- [x] 1.1 Implement `mountRefExploreRecords(app, ctx)` in
  `reference-implementation/server/routes/ref-admin.ts` — `GET /_ref/explore/records`,
  owner-session gated, parses optional `limit` and `cursor` query params, delegates
  to `executeExploreTimeline`, maps `InvalidCompositeCursorError` to HTTP 400
  `invalid_cursor`, returns JSON matching `ExploreTimelineOutput`.
- [x] 1.2 Wire `buildExploreTimelineDeps()` in the substrate module
  (`explore-timeline-substrate.ts`) to dispatch to the correct backend (SQLite or
  Postgres) based on `isPostgresStorageBackend()`.
- [x] 1.3 Ensure `mountRefExploreRecords` is called from
  `reference-implementation/server/index.js` (alongside other `mountRef*` calls).

## 2. Operation: k-way merge + composite cursor

- [x] 2.1 `executeExploreTimeline` in `rs-explore-timeline/index.ts` resolves or
  initializes the composite cursor (first page: captures `MAX(id)` snapshot anchor;
  subsequent pages: decodes base64url blob for snapshot anchor + per-partition
  positions).
- [x] 2.2 Partition enumeration calls `deps.listPartitions()` with NO LIMIT — all
  (connector_instance_id, stream) pairs are returned.
- [x] 2.3 k-way merge: always emits the globally-newest head across all partition
  buckets; refills a bucket when it is drained; terminates when all buckets are
  exhausted or `limit` records are emitted.
- [x] 2.4 `has_more` is true when any bucket has buffered rows or is not yet
  exhausted after the current page.
- [x] 2.5 `next_cursor` encodes all live per-partition positions + snapshot anchor
  as a v2 base64url blob; null when `has_more` is false or no records were emitted.
- [x] 2.6 `new_since_snapshot` is the count of records with `id > snapshotSeq`
  across all visible partitions (best-effort; may be deferred/approximate for large
  corpora without violating the cursor contract).

## 3. Substrate implementations

- [x] 3.1 SQLite substrate: `sqliteListPartitions` runs `SELECT DISTINCT
  connector_instance_id, connector_id, stream FROM records WHERE deleted = 0`
  with no LIMIT.
- [x] 3.2 SQLite substrate: `sqliteFetchSnapshotAnchor` uses `MAX(id)` (rowid
  alias = monotonic ingest sequence) not `MAX(emitted_at)`.
- [x] 3.3 SQLite substrate: `sqliteFetchPartitionPage` keyset on
  `(COALESCE(NULLIF(semantic_time, ''), emitted_at) DESC, record_key DESC)` with
  snapshot gate `id <= snapshotSeq` (Step A: order by semantic time, anchor by id).
- [x] 3.4 Postgres substrate: parallel implementations using `postgresQuery`;
  semantic-time keyset; snapshot anchor uses `MAX(id)` (BIGSERIAL); partition
  enumeration has no LIMIT.

## 4. Set-descriptor contract

- [x] 4.1 The console (operator-ui) assembler derives a `descriptor` field typed
  as a discriminated union FROM the endpoint response — the endpoint itself returns
  only the raw merged page. Under the recent lens the derived descriptor is
  `{ kind: "complete_chronological" }` (everything, newest first, exhaustively
  keyset-pageable); the same endpoint response is given a bounded descriptor under
  the time-range / search lenses, which is why the descriptor cannot be authored
  server-side. The UI renderer switches on `descriptor.kind` and is structurally
  constrained: it MUST NOT claim completeness or ordering the descriptor does not
  carry.
- [x] 4.2 Console Explore canvas wires the descriptor into its rendering path so
  the "newest first" and "complete" claims only appear when the descriptor is
  `complete_chronological`.

## 4b. Scoped (per-connection / per-stream) filtering

- [x] 4b.1 `GET /_ref/explore/records` accepts optional `connection`/`connection_id`
  and `stream` query params (comma-separated or repeated) and threads them as
  `connectionIds`/`streams` scope into `executeExploreTimeline`.
- [x] 4b.2 The scope is pushed into `listPartitions` (partition enumeration is
  filtered) AND into `countNewSinceSnapshot`, so pagination, `has_more`,
  `next_cursor`, and `new_since_snapshot` are all scoped to the SAME selected set.
  A selected source MUST NOT produce sparse/empty pages from a globally-paged feed
  trimmed client-side. The console client-side filter is retained ONLY as a
  defensive guard against an older/misconfigured endpoint, not as the primary
  mechanism.

## 5. Validation

- [x] 5.1 `openspec validate add-explore-merged-timeline --strict` passes.
- [x] 5.2 `openspec validate --all --strict` passes.
- [x] 5.3 `reference-implementation/operations/rs-explore-timeline` test suite
  green (k-way merge correctness, cursor encode/decode, snapshot stability,
  no-partition-cap invariant, scoped-traversal conformance).
- [x] 5.4 `pnpm --filter pdpp-console types:check` clean.
- [x] 5.5 Dual-backend conformance: test suite covers both SQLite and Postgres
  substrate paths (including scoped traversal).

## Acceptance Checks

- `GET /_ref/explore/records` returns HTTP 401 without a valid owner session.
- First-page response carries `snapshot_at`, `new_since_snapshot`, `has_more`,
  and (when records exist) a non-null `next_cursor`.
- Paging through the cursor yields strictly non-increasing SEMANTIC time
  (`COALESCE(NULLIF(semantic_time, ''), emitted_at)`), no duplicates, and spans
  records from multiple connector instances.
- Inserting a record after page 1 is loaded: it does NOT appear in subsequent
  pages of the same cursor (snapshot stability); `new_since_snapshot` increments
  on a fresh first-page call.
- A corpus covering more than one (connector_instance_id, stream) pair: all
  records are reachable by exhaustively paging the cursor (no silent cap).
- An invalid cursor string returns HTTP 400 `invalid_cursor`.
- The endpoint is NOT reachable via `/mcp` or a grant-scoped token.
