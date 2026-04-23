# RS memory-pressure fix — design

## Framing

The reference server crashes in V8 under load. The failure mode (SIGSEGV in parallel scavenger during native-addon string allocation) is at the C++ level, uncatchable in JS. The immediate question is "how do we stop crashing," but the durable question is "how is the reference read-path supposed to behave under load, and what invariants should hold regardless of what V8 does?"

The answer we're committing to: **no RS handler materializes unbounded result arrays**. Access-control filters, time-range filters, and pagination all happen in SQL. Handler code sees a bounded stream of already-visible rows, not a dump of the substrate.

This is the "right shape" independent of the crash. The crash is a symptom that made it urgent.

## Principle

**The substrate is arbitrarily large. The response is bounded. Filtering happens at the smallest layer that can do it.**

- Access control on `time_range`, `resources`: in SQL, via `WHERE`.
- Pagination: in SQL, via `LIMIT` + cursor.
- Field projection: in SQL when possible (`json_extract`), in JS as a final pass.
- Sort: in SQL via `ORDER BY` derived from the stream's manifest-declared `cursor_field` + primary key.

The JS layer's role is to **translate grant + request into SQL**, **stream bounded results**, and **assemble the response envelope**. It is not a filter engine over raw materialized arrays.

## Why this crashes now

A few compounding factors:

1. The dashboard fans one page load into many parallel RS calls.
2. Each RS call for a mid-size stream (Slack messages, ChatGPT conversations, Gmail threads) materializes ~100 MB of JSON into a single array.
3. Next.js SSR holds all of those response strings alive while assembling the page.
4. Under concurrent navigation, several such pages are in flight, so 500 MB+ of JSON arrays live in V8 old space at the same moment.
5. V8's parallel scavenger runs concurrently with handler JSON-parsing loops over these arrays. The resulting allocation pressure can push V8 into a state where its internal heap iteration finds a corrupt map pointer. That's our SIGSEGV.

The crash is V8 failing to stay safe under our pathological load, not V8 misbehaving under normal load. Our fix is to never put V8 in this state.

## Expansion (child-stream `expand=...` parameter)

`hydrateExpandedRelations` currently reads every non-deleted row of the child stream for every parent page, groups by foreign key in JS, and slices per parent. For a `has_many` relation against any of our large streams (`slack/messages`, `gmail/messages`) this is as bad as the parent query. Fix shape:

```sql
-- Window-function version; requires SQLite 3.25+.
-- Build at statement-prepare time per (parent_stream, child_stream, expansion_name, parent_count).
WITH ranked AS (
  SELECT
    record_key,
    record_json,
    emitted_at,
    json_extract(record_json, '$.<child_foreign_key>') AS fk,
    ROW_NUMBER() OVER (
      PARTITION BY json_extract(record_json, '$.<child_foreign_key>')
      ORDER BY /* child order — same cursor_field/primary_key basis as the parent path */
    ) AS rn
  FROM records
  WHERE connector_id = ?
    AND stream = ?
    AND deleted = 0
    AND json_extract(record_json, '$.<child_foreign_key>') IN (?, ?, ?, …)  -- parent record_keys
    ${child_time_range_clause}
    ${child_resources_clause}
)
SELECT * FROM ranked WHERE rn <= ?  -- expansion.limit + 1 for has_more signal
```

Cardinality handling:
- `has_many`: `ROW_NUMBER()` partitioned by foreign key, `rn <= limit + 1`.
- `has_one`: `ROW_NUMBER()` partitioned by foreign key, `rn = 1`. Or a simpler `SELECT ... GROUP BY fk HAVING rowid = MIN(rowid)`.

The SQL is built per (parent_stream, child_stream, parent_count) because the `IN` arity is dynamic. Cache by parent_count so we only re-prepare on arity change. In practice the parent page size is fixed per handler, so we pay this once per page.

Grant enforcement: the child's `time_range` and `resources` (from `expansion.childGrant`) ride in on the same WHERE. A parent page of N rows with expansion produces at most `N × (expansion.limit + 1)` child rows read, bounded by the page size, not by the child stream's total size.

## Alternatives considered

- **Workaround with `--no-parallel-scavenge`.** Tested. Makes the crash much harder to trigger in short runs but does not eliminate it at steady state. Rejected: masks the real problem and slows GC globally. Not acceptable for production per steering constraint "I won't accept a workaround."
- **Increase `--max-old-space-size` to 4+ GB.** Gives us headroom but doesn't prevent concurrency from using it all. Not a fix.
- **Lazy JSON parse (only parse fields the response needs).** Helps but doesn't change the fundamental pattern of loading all rows. Partial fix at best.
- **Add response-body streaming (NDJSON).** Valid optimization orthogonal to this change. Adds a protocol surface decision; out of scope for the crash fix.

## SQL-level filter push-down details

### `time_range`

Today: rows come out of SQLite, `rawData = JSON.parse(row.record_json)`, then JS checks `rawData[consent_time_field]` against `since` / `until`.

Target: `WHERE json_extract(record_json, '$.<consent_time_field>') BETWEEN ? AND ?`. The `consent_time_field` is manifest-authored and per-stream; we validate it against `/^[A-Za-z_][A-Za-z0-9_]*$/` and build the SQL at statement-prepare time, per (stream, consent_time_field) pair, so the path is still parameterized (values are bound).

### `resources`

Today: JS `effective.resources.includes(row.record_key)` per row.

Target: when `resources` is non-empty and small (≤ 100 typical), emit a `WHERE record_key IN (?, ?, ?, ...)` clause. Dynamic arity SQL, built per call; better-sqlite3 caches these by text so as long as the set size is stable (pagination preserves it), we pay prepare cost once.

### `fields` projection

Today: full row materialized, then `projectFields` prunes to the grant's allowed list.

Target: keep JSON parse in JS (projecting inside SQL via repeated `json_extract` is possible but noisy). The win from filter push-down is that **we parse far fewer rows** — the ones we actually return. Field projection is still the last step on that small set.

### Pagination

Today: `.all()` all rows; paginate in JS with `slice(0, limit)`.

Target: SQL `ORDER BY` + `LIMIT` + cursor. Cursor encodes the last-seen `(cursor_value, primary_key)` tuple. Each page reads exactly `limit + 1` rows to detect `has_more`.

### Order-by derivation

The stream's manifest declares `cursor_field` and `primary_key`. The ORDER BY becomes `ORDER BY json_extract(record_json, '$.<cursor_field>') ASC/DESC, json_extract(record_json, '$.<primary_key[0]>') ASC, …`. Indexed? Not on the JSON fields directly. But for the page-sized queries we do (25–100 rows), scan-then-sort is fine. For very hot paths we can add generated-column indexes per stream later.

### What about `changes_since`?

Already mostly correct — it queries `record_changes` which is indexed on `(connector_id, stream, version)` and streams by version window. The query does `getSnapshotAtVersion` per change, which is O(change_count × log n); we keep that structure but ensure the outer loop breaks as soon as `visibleChanges.length > limit`.

## Spine-events query restructure

Today: `listSpineCorrelations` reads **every** spine event row (`SELECT * FROM spine_events ORDER BY rowid`), groups in JS by trace_id / grant_id / run_id, sorts in JS, paginates in JS. For a 92k-row table that's 21 MB of JSON parsed per call, and `/_ref/runs`, `/_ref/grants`, `/_ref/traces` each hit this.

Target: per-key aggregation in SQL.

```sql
SELECT
  trace_id AS id,
  MIN(occurred_at) AS first_at,
  MAX(occurred_at) AS last_at,
  COUNT(*) AS event_count,
  -- status is derived from the chronologically last event's status;
  -- SQLite's lack of "first_value OVER ORDER BY" makes this awkward but
  -- doable via a subquery:
  (SELECT status FROM spine_events WHERE trace_id = outer.trace_id
    ORDER BY rowid DESC LIMIT 1) AS status
FROM spine_events outer
WHERE trace_id IS NOT NULL
  AND (? IS NULL OR status = ?)
  AND (? IS NULL OR last_at >= ?)
  …
GROUP BY trace_id
ORDER BY last_at DESC
LIMIT ? OFFSET ?
```

The `kinds` field (distinct event types per trace, top 16) and `connector_id` derivation currently happen via `connectorIdFromEvent`, which reads `event.data`. Those require JSON access. Options:
- Add them to the GROUP BY via `group_concat(DISTINCT event_type)` and `json_extract(data_json, '$.connector_id')`.
- Add them in a second SQL pass for the page-sized result set only (25 rows), which is cheap.

We'll pick whichever is cleaner in implementation. Both are bounded.

## `listRecordsTimeline` (ref-control.js)

This one serves `/_ref/records/timeline`, consumed by `/planning/changes` and some dashboard surfaces. Today it issues `SELECT … FROM records WHERE deleted = 0` with optional connector_id/stream filters (no LIMIT at the SQL level), parses every row, filters by `since`/`until` against the manifest's `consent_time_field` in JS, then slices to the handler's `limit`.

Target: push the time window into SQL at the smallest layer that knows the `consent_time_field`. Because that field is manifest-authored per (connector, stream), the query has to be built per pair:

1. Look up the manifest for each candidate (connector_id, stream) and extract its `consent_time_field`.
2. For each pair, `SELECT … WHERE connector_id = ? AND stream = ? AND deleted = 0 AND json_extract(record_json, '$.<field>') BETWEEN ? AND ? ORDER BY <emitted_at or cursor_field> DESC LIMIT ?`.
3. The caller already iterates over manifests-with-data; we emit one prepared-and-cached statement per (connector, stream, timestamp-mode) tuple.
4. Stream via `.iterate()` and stop after `limit` rows.

When `connector_id` / `stream` params are supplied by the caller, only one pair runs. When they aren't, the handler unions across all matching pairs and applies the top-level `limit` globally (either via SQL `UNION ALL` + final `ORDER BY` + `LIMIT`, or by draining from a merge-sort heap of per-pair iterators).

## Concurrency cap

Fastify doesn't ship a built-in per-route concurrency cap. Two reasonable implementations:

1. **Tiny semaphore per route class**: an in-memory counter incremented at `onRequest` and decremented at `onResponse`. Reject with 503 when ≥ N. Simple, 30 lines.
2. **`@fastify/rate-limit` plugin**: comprehensive but heavier.

Start with option 1. The cap is per-(method, route-pattern) and the limit is configurable via env. Default: `PDPP_MAX_INFLIGHT_PER_ROUTE=4`.

### Cap + dashboard client: the non-optional coupling

A per-route cap with 503-on-exceed is only safe if the callers handle 503s explicitly. Our current client (`apps/web/src/app/dashboard/lib/rs-client.ts:80`) throws on any non-OK response, and `searchRecords` / `loadTimeline` catch that exception into `return []`. A 503 would land as "this stream had zero records" — silent under-reporting, the opposite of what users see. That would be worse than the crash it's trying to prevent.

So the cap ships with a **coordinated client-side change**:

1. **Bounded parallelism**: a small `pMapLimit(array, fn, {concurrency})` helper. Search + timeline switch from `Promise.all` to `pMapLimit(targets, fn, {concurrency: 3})`. Three is chosen so the client voluntarily stays below the server's cap of four; leaves headroom for other dashboard requests that hit the same route class.
2. **503 is retried, not swallowed**: `rs-client.ts` distinguishes 503 from other non-OK statuses. On 503 it retries up to 2× with 100 ms and 400 ms delays. A 503 that persists past those retries is surfaced as an error, not silently converted to empty results.
3. **Partial-failure visibility**: where per-target failures happen, the returned object is `{records, failures: [{target, reason}]}` instead of `[]`. The page renders zero records *and* a visible "N streams couldn't be queried: retry?" banner — not silent truncation.

Implementation scope for #1–#3: `apps/web/src/app/dashboard/lib/rs-client.ts` (add `pMapLimit` helper and 503-aware fetch), `apps/web/src/app/dashboard/search/page.tsx` (use helper, render partial-failure banner), `apps/web/src/app/dashboard/lib/timeline.ts` (same), and a small helper `apps/web/src/lib/p-limit.ts` (or just inline).

## Response-size budget

Hook: `preSerialization`. If the outbound object's JSON size (estimated via `JSON.stringify(body).length`) exceeds `PDPP_MAX_RESPONSE_BYTES` (default 20 MB), the handler returns a 500 with `{error: {code: 'response_too_large', ...}}` and a structured log record.

Caveats:
- Estimating size by stringifying twice is wasteful. Cheaper: track cumulative size as we assemble. For the streaming handler (`listRecords`), this is natural.
- For blob responses (binary), the limit doesn't apply — that's already streamed.

## Supervisor

Two paths:
- **Dev**: leave `pnpm dev` as-is. It uses pnpm's `--parallel --stream` runner, which doesn't auto-restart children. Add a small wrapper (shell loop) only if crashes remain after the code fix.
- **Prod / reference deployment**: a one-line `ExecStart` systemd unit with `Restart=on-failure` and `RestartSec=1s`. Or PM2 for non-systemd hosts. The important property is: SIGSEGV → auto-restart with structured log of the last crash reason, not manual intervention.

The systemd unit is out of `reference-implementation/`'s repo scope (deployment-local), but the OpenSpec should mandate "the reference implementation, when deployed as a long-running service, MUST be wrapped by a supervisor that restarts on non-zero exit."

## Acceptance, precisely

- `repro-crash.sh --runs=5` returns exit 0 (all five runs survived 10 rounds) on the frozen branch + DB snapshot. A 5-run PASS is our proxy for "functional fix." Five is chosen because our background-observed crash rate is ~50% per 10 rounds — P(any crash in 5 runs) at baseline ≈ 97%, so surviving 5/5 post-fix is strong evidence.
- Response times for the three dashboard URLs, measured on the frozen repro, are at least as fast as current baseline. Expected substantial improvement (today: ~10 s records, ~17 s search; target: < 3 s each).
- Memory footprint measured via `/proc/<pid>/status RssAnon` during the 5-run test stays below 1 GB peak. Today it climbs to ~2 GB at crash time.
- No regressions in the existing 596-test suite; pre-existing `composed-origin.test.js` flake excluded.
- A minimal-reproducer script (`repro-native-only.mjs`) is attempted after the fix: if we can isolate the crash to a ~200-line script that hits only better-sqlite3 + concurrency (no Fastify, no Next), we file it upstream. If we can't isolate it, that's informative too — it means the pathology required the full handler stack, which is consistent with "allocation pressure" being the trigger rather than a driver bug.

## What this is not

- Not a protocol change. The wire contract of `/v1/streams/*/records` is unchanged; pagination, cursor semantics, response envelopes all stay identical.
- Not a query-profiling exercise. We aren't adding indices yet. Pagination plus streaming is enough; if specific queries stay slow after, index work is a separate change.
- Not an ORM introduction. Raw `better-sqlite3` + `.prepare(...).iterate(...)` is the idiom.
- Not a dashboard UX change. Dashboard keeps working the same; it just stops crashing and gets faster.
