# Audit: RS memory pressure leading to SIGSEGV under concurrent dashboard load

Scope: reference-implementation/* (server, lib, runtime) plus apps/web/src (the caller fan-out). Goal: understand every contributing factor to the crash, ranked by blast radius. Complementary to `proposal.md`'s framing.

Bounds of the audit: what we have measured on the frozen branch (`repro/scavenger-crash-2026-04-23`) against the frozen DB snapshot (sha256 `001afdcc…`, 3.3 GB, 772,287 records). Anything we infer but have not measured is marked as such.

## 1. Reproduction rate (baseline)

Measured by `./repro-crash.sh` on the frozen state, 10-round concurrent curl against `/dashboard/records`, `/dashboard/search`, `/planning/changes`:

- Run 1 (~2 minutes): **survived** 10 rounds.
- Run 2 (~2 minutes): **crashed** on round 9.

Baseline crash rate: **~50% per 10-round run**. Non-deterministic. Needs `--runs=5` to give 97%+ confidence that a fix flipped the dial.

## 2. Query surface: 88 prepared statements, 4 catastrophic

88 `db.prepare()` sites across `server/{records.js,auth.js,ref-control.js,index.js}`, `lib/spine.js`, `runtime/controller.js`. Classification:

| Category | Count | Risk |
|---|---|---|
| Point lookup by indexed key (`WHERE id = ?`, `WHERE grant_id = ?`, etc.) | 62 | Safe |
| Single-row INSERT/UPDATE/DELETE | 18 | Safe |
| Bounded scan (LIMIT or small result set) | 4 | Safe |
| **Unbounded scan of JSON-column table** | **4** | **Catastrophic** |

### The four catastrophic sites

| # | Location | Query | Worst-case data | Called by |
|---|---|---|---|---|
| A | `server/records.js:543` `fetchVisibleRecordRows` | `SELECT record_json FROM records WHERE connector_id=? AND stream=? AND deleted=0` | 370 MB (`gmail/message_bodies`) | `/v1/streams/*/records`, `/v1/streams/*/records/:id`, `listStreams` |
| B | `server/records.js:1122` `listStreams` | Same shape, once per granted stream | 152 MB (`slack/messages`) × N streams | `/v1/streams` |
| C | `lib/spine.js:246` `listSpineCorrelations` | `SELECT * FROM spine_events ORDER BY rowid` | 21 MB (full spine scan; grows unbounded) | `/_ref/runs`, `/_ref/grants`, `/_ref/traces` |
| D | `lib/spine.js:304` `searchSpine` | Same full spine scan | 21 MB | `/_ref/search` |

Measured JSON size per stream on the frozen DB (top 10 by total bytes):

```
gmail/message_bodies         17,826 rows × 20,784 B avg =  370 MB
slack/messages              196,518 rows ×    775 B avg =  152 MB
claude-code/messages        235,273 rows ×    435 B avg =  102 MB
codex/function_calls         47,120 rows ×  1,697 B avg =   80 MB
slack/message_attachments    56,920 rows ×    724 B avg =   41 MB
codex/messages               27,400 rows ×    641 B avg =   18 MB
chatgpt/messages              9,252 rows ×  1,731 B avg =   16 MB
gmail/messages               17,826 rows ×    831 B avg =   15 MB
github/issues                 7,068 rows ×  1,796 B avg =   13 MB
slack/reactions              73,463 rows ×    172 B avg =   13 MB
```

Site A alone, called once for `gmail/message_bodies`, materializes a 370 MB JSON string array **before any filtering**. Under the dashboard fan-out, several of these are in flight concurrently.

## 3. Handler allocation: what a single `/v1/streams/*/records` call does

Traced through `server/index.js:2060` (`app.get('/v1/streams/:stream/records')`) → `records.js::queryRecords` → `records.js::fetchVisibleRecordRows`:

1. `.all()` of every non-deleted row for the stream → array of up to 196 K objects, each with a ~775 B JSON string (for `slack/messages`). **No filter applied yet.**
2. `for (const row of rows) { const rawData = JSON.parse(row.record_json); … }` — `JSON.parse` per row produces a nested JS object tree ~3-5× the JSON string size due to V8's object representation. Rows that fail visibility/filter checks are parsed, allocated, and then thrown away.
3. `visibleRows.push({ record_key, rawData, emitted_at, sortPosition })` — wrapper object per visible row.
4. `visibleRows.sort(...)` — in-memory sort of potentially all visible rows.
5. `pagedRows.slice(0, limit + 1)` + `.map(row => ({ ...row, responseRecord: buildResponseRecord(...) }))` — new page wrapper.
6. Outer handler: `res.json({ ...result, data: result.data.map(decorateRecordBlobRefs), url: req.path })` — another map allocates the final response array.

Per a `limit=500` request to `gmail/message_bodies` **with no `time_range` filter**:
- SQLite returns 17,826 rows (370 MB of JSON strings).
- JSON.parse produces ~1.4 GB of transient parsed-object graphs during the filter loop.
- If `time_range` or `resources` would have narrowed to 500 final rows, those allocations were still paid up front.

## 4. Concurrency: dashboard fan-out

Next.js SSR routes invoke RS helpers via `apps/web/src/app/dashboard/**/*`. Observed fan-out patterns:

- **`/dashboard/search`** (`apps/web/src/app/dashboard/search/page.tsx`): `Promise.all` over 12 connectors to list streams, then `Promise.all` over all (connector, stream) pairs to query records at `PER_STREAM_LIMIT = 500`. Worst case: **60 concurrent RS calls**, each `limit=500`. No concurrency cap.
- **`/dashboard/records/timeline`** (via `apps/web/src/app/dashboard/lib/timeline.ts`): `Promise.all` over all (connector, time-anchored stream) pairs at `perStreamLimit` (default 500). Same pattern as search.
- **`/dashboard/records`** (the hero + list): calls `listConnectors` + per-connector `listStreams`, which each hit `fetchVisibleRecordRows`. Fan-out is per-connector (~12) × per-stream (~5 avg) = ~60 queries.
- **`/_ref/*` list endpoints**: each calls `listSpineCorrelations`, which reads the entire spine table. Hit independently by the dashboard's runs/grants/traces sidebars. Small per-call (21 MB) but adds multiplicative load.

Together: a single dashboard tab load can fire **dozens of concurrent large-allocation RS calls with no per-route cap**.

## 5. Memory budget

- **V8 old-space default on Node 25.8.2**: ~4 GB. Checked via `/proc/$PID/limits` and V8's internal defaults.
- **Observed pre-crash state** (from `--trace-gc --trace-gc-verbose`):
  - Old space: 503 MB used / 509 MB committed — **5 MB available**.
  - Pool buffering: **2.0 GB** of committed chunks.
  - Allocation rate: **~1 GB/s** (scavenge every ~30-45 ms, each moving tens of MB).
  - New space thrashing: `Scavenge 315 (478) -> 315 (478) MB` — young gen full, nothing surviving-to-promote because old space already full.
- **Worst realistic response body size**: ~15 MB (500 chatgpt/messages at 1.7 KB/record × JSON wrap overhead). The ~370 MB numbers above are transient *processing* footprint, not response size.
- **Recommended `--max-old-space-size`**: 1536 MB. Enough for legitimate worst-case (60 × 15 MB = 900 MB), tight enough that the pathological case hits graceful OOM-throw rather than V8-internal-SIGSEGV. Combined with the response-size budget (proposal §3.2), any single leaky handler triggers an error envelope rather than the whole process falling over.

## 6. Safety/resilience

Current state:
- No `requestTimeout` configured in Fastify (`server/transport.js`).
- No keep-alive timeout tuned; Fastify default applies.
- `bodyLimit: 200 * 1024 * 1024` (200 MB) — too permissive for our non-blob routes.
- No concurrency cap per route or per process.
- No response-size limit enforced.
- No process supervisor (`pnpm dev` doesn't auto-restart on crash).
- Pino logger + fatal handler for `uncaughtException` / `unhandledRejection` / SIGTERM / SIGINT — **good**, but SIGSEGV bypasses JS handlers by definition, so these don't help with our current crash.

Gaps this change addresses:
- Per-route concurrency cap (proposal §3.1).
- Response-size budget (proposal §3.2).
- Supervisor expectation documented as a new Requirement (proposal §3.3).

Gaps this change does **not** address (noted as follow-ups):
- Per-request timeout: noted but deferred. The right value depends on what a "reasonable" query takes, which we can answer only after the fix lands.
- `bodyLimit` lowering: 200 MB is for connector ingest where big batch posts happen. Splitting the cap for `/v1/ingest` vs `/v1/*` read routes is a small follow-up.

## 7. Connector ingest: not the problem

Scanned `reference-implementation/runtime/*.js` and `packages/polyfill-connectors/src/*.ts` for `.all()` pathologies. The only `.all()` calls on the substrate DB happen in the RS read path (audited above). Ingest paths write to the substrate one record at a time (`runtime/index.js::ingestRecord`), with no bulk read-back.

Connectors (`packages/polyfill-connectors/connectors/*/index.ts`) do use `.all()` against their *own* local SQLite files (slackdump exports, iMessage `chat.db`, codex rollouts, etc.). Risk exists there but is bounded by the external export's size, not our substrate. Out of scope for this change.

## 8. What the upstream ecosystem has to say

Checked Node.js, WiseLibs/better-sqlite3, and TryGhost/node-sqlite3 issue trackers on 2026-04-23 for V8-scavenger crashes in SQLite drivers under load.

Nearest match: [nodejs/node#62515](https://github.com/nodejs/node/issues/62515) — "Sporadic SIGSEGV: native addon .got.plt reset to unrelocated file offsets" on Node v25.8.2 with better-sqlite3. Same Node version, same ecosystem, **open, unresolved**. Different crashing frame from ours (GOT corruption vs. Scavenger SizeFromMap), but same symptom class: sporadic SIGSEGV in a native addon under sustained use. Tells us the Node/V8/addon surface is known-fragile at 25.8.2 — our change removes our contribution to the instability, regardless of whether #62515 gets fixed.

Historical match (closed, old): [nodejs/node#38401](https://github.com/nodejs/node/issues/38401) — same `v8::internal::HeapObject::SizeFromMap` frame in a different GC phase (Sweeper, not Scavenger). Closed because unreproducible on modern Node; acknowledged as the kind of crash V8 shouldn't have.

Community consensus from the `better-sqlite3` README, Drizzle's docs, and [WiseLibs issue #1234](https://github.com/WiseLibs/better-sqlite3/issues/1234): **"prepare once, reuse"** and **"use `.iterate()` for large result sets"**. Our cached-prepare layer handles the first; this change handles the second.

## 9. Severity-ranked findings

| ID | Severity | Finding | Action | In this tranche? |
|---|---|---|---|---|
| F-1 | P0 | `fetchVisibleRecordRows` materializes 370 MB of JSON per call on the worst stream, pre-filter. | Stream via `.iterate()`; push `time_range`/`resources` into `WHERE`. | Yes (task 2.1) |
| F-2 | P0 | `/dashboard/search` fans out to 60 concurrent RS calls at `limit=500`. | Server: per-route concurrency cap with 503. Client: `pMapLimit` + 503-aware retry + partial-failure banner. | Yes (tasks 3.1, 3.2) |
| F-3 | P0 | `listSpineCorrelations` and `searchSpine` read the entire `spine_events` table on every `/_ref/runs`, `/_ref/grants`, `/_ref/traces`, `/_ref/search`. | Aggregate + paginate in SQL. | Yes (tasks 2.5, 2.6) |
| F-4 | P0 | `hydrateExpandedRelations` calls `fetchVisibleRecordRows` over the entire child stream for every parent page of an `expand=…` request. Unbounded by the same mechanism as F-1. | Push child foreign-key narrowing and per-parent limits into SQL via window functions. | Yes (task 2.3) |
| F-5 | P0 | `listRecordsTimeline` (`server/ref-control.js:219`) does `SELECT … FROM records` with no LIMIT, parses every row, filters `since`/`until` in JS. Called by `/planning/changes` and timeline surfaces. | Push `since`/`until` into SQL per (connector, stream) consent_time_field. Apply SQL `LIMIT`. Stream via `.iterate()`. | Yes (task 2.4) |
| F-6 | P1 | `listStreams` does `.all()` per granted stream, once per `/v1/streams` call. | Replace with one aggregate SQL per stream. | Yes (task 2.2) |
| F-7 | P1 | No process supervisor. A SIGSEGV takes the reference down permanently. | Document supervisor expectation; provide systemd + PM2 reference files. | Yes (task 3.4) |
| F-8 | P2 | No per-route concurrency cap. | Add Fastify hook with semaphore. | Yes (task 3.1, coupled to 3.2) |
| F-9 | P2 | No response-size budget. | Add `preSerialization` hook enforcing `PDPP_MAX_RESPONSE_BYTES`. | Yes (task 3.3) |
| F-10 | P2 | `--max-old-space-size` not pinned. V8 grows to ~4 GB before hitting ceiling. | Pin to 1536 MB so pathological cases hit graceful OOM-throw. | Yes (in package.json) |
| F-11 | P3 | No request-level timeout in Fastify. | Follow-up after fix lands. | No (follow-up) |
| F-12 | P3 | `bodyLimit: 200 MB` for all routes; too permissive for non-ingest. | Split caps per route group. | No (follow-up) |

## 10. What fixes each site to (target shape)

Hand-offs for implementation. Details in `design.md` §"SQL-level filter push-down details".

### F-1: `fetchVisibleRecordRows`

```js
// Before
const rows = db.prepare(`SELECT record_json, … WHERE connector_id=? AND stream=? AND deleted=0`).all(cid, stream);
for (const row of rows) { const rawData = JSON.parse(row.record_json); if (!passesFilters(rawData)) continue; … }

// After (sketch)
const stmt = db.prepare(`
  SELECT record_key, record_json, emitted_at
  FROM records
  WHERE connector_id = ? AND stream = ? AND deleted = 0
    ${timeRangeClause /* WHERE json_extract(record_json, $.<field>) BETWEEN ? AND ? */}
    ${resourcesClause /* AND record_key IN (?, ?, …) */}
  ORDER BY ${orderByClause}
  LIMIT ?
`);
const visibleRows = [];
for (const row of stmt.iterate(...binds, limit + 1)) {
  visibleRows.push({ record_key: row.record_key, rawData: JSON.parse(row.record_json), … });
  if (visibleRows.length > limit) break;
}
```

### F-3: `listSpineCorrelations`

```sql
-- Aggregate in SQL
SELECT
  trace_id AS id,
  MIN(occurred_at) AS first_at,
  MAX(occurred_at) AS last_at,
  COUNT(*) AS event_count,
  (SELECT status FROM spine_events WHERE trace_id = outer.trace_id ORDER BY rowid DESC LIMIT 1) AS status
FROM spine_events outer
WHERE trace_id IS NOT NULL
GROUP BY trace_id
ORDER BY last_at DESC
LIMIT ? OFFSET ?
```

Second pass on the page-sized set fetches `kinds` and `connector_id` (both require JSON parse but only on page-size rows).

## 11. Falsifiability

Each fix is independently testable against the frozen repro:

- After F-1: re-run `./repro-crash.sh --runs=5`. Target: 5/5 pass.
- After F-3: as above.
- After F-2 (concurrency cap): expect to see 503s from the dashboard. Dashboard client may need a guard; if so, scope that into this change.

Baseline memory footprint (pre-fix): 2 GB peak RSS. Target post-fix: < 1 GB peak RSS under the same workload.

## 12. What we are not claiming

- We are **not claiming** the underlying V8 bug (if one exists beyond our allocation pressure) is fixed. Our theory is that the allocation pressure is the trigger, but we've seen related open Node.js issues that suggest the V8/native-addon interaction is generally fragile. The proposal's supervisor requirement is the belt to this suspenders.
- We are **not claiming** a minimal standalone reproducer exists yet. Proposal §5 attempts one post-fix; if it works, we file upstream. If not, that itself is evidence the pathology requires the full handler stack.
- We are **not claiming** 100% confidence. Our confidence is ~75% that F-1 + F-3 eliminate this specific crash; combined with F-5 (supervisor), our confidence that the reference stays up in production is ~95%. The missing 5% is "some other V8/native-addon bug fires." Supervisor + graceful OOM is how we handle that case.
