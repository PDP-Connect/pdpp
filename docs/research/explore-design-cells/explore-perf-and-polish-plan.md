# Explore perf + polish — batched plan (SLVP-ideal, for Codex gate before build)

Six issues Tim raised, batched into ONE coordinated effort. Target: SLVP-ideal, >95% confidence,
prior-art-grounded. Plan to be gated by Codex BEFORE building. Prior art:
`over-time-chart-perf-prior-art.md` (Datadog/Grafana/ES/Timescale/d3-time, cited) + the LAND'd
`over-time-chart/design.md`. All file:line from deploy tree commit 2eebcd7f.

## The six issues (root causes, code-confirmed)
1. **Explore slow (REGRESSION I shipped).** The over-time chart's `loadBucketSeries` fires ~38 (cap 48)
   `aggregateRecordsByTime` HTTP calls — one per (connection,stream) — AND awaits them on the critical
   first-paint path (`explore-data-assembler.ts:2722,2835`). Turns a ~3-round-trip page into ~40.
2. **Chart inherently slow even at 1 call.** `listRowsForAggregation` (`storage-backend.js:44`) is a FULL
   table scan with NO limit/time-predicate — `SELECT record_key, record_json WHERE stream=X` — pulling
   every row's JSON into Node, bucketed in JS (`records.js:2576,727`). For claude_code/messages (1.04M
   rows) one call materializes ~1M JSON blobs. Fan-out isn't the only cost; the full-scan is.
3. **Chart looks SPARSE.** Default view: `spanMs` computed from URL filter only → 0 when unfiltered →
   `deriveGranularity(0)` returns "day" (`over-time-chart.ts:108`). So a 20-year corpus buckets at DAY,
   anchored at one 2005 record, mostly-empty ticks. The adaptive ladder exists but is never fed the real
   extent. (The cell's own comment promises extent-adaptive granularity the code doesn't implement.)
4. **Works on SQLite? YES** — confirmed: bucketing is in-JS (not date_trunc), dialect-abstracted; both
   substrate impls exist. (Informs the fix: the indexed-aggregate must keep dual-dialect.)
5. **White PWA splash in dark app.** apps/console ships NO web manifest + NO `viewport.themeColor`
   (`layout.tsx:46`). Only manifest is the marketing site's cream `#f8f6f0` (`apps/site/manifest.ts:13`).
6. **Error after backgrounding PWA during load.** Explore has NO scoped `error.tsx` → errors bubble to
   the dashboard-wide boundary (`dashboard/error.tsx:23`). Trigger: `useTransition`+`router.push` on a
   `force-dynamic` RSC fetch with NO abort handling (`explore-canvas.tsx:2951,3199`); backgrounding
   aborts the in-flight fetch → rejection escapes → boundary.

## SLVP-ideal target (prior-art-grounded, per the perf research)
- **ONE index-backed server aggregate, not per-stream JS scans.** A single endpoint takes
  (scope-filter, since, until, granularity) and returns ~30–60 `{bucket,count}` rows via
  `date_trunc(unit, semantic_time) , COUNT(*) GROUP BY` over the merged-timeline substrate's EXISTING
  multi-stream WHERE clause. No `record_json` read (count needs no payload). The enabling index already
  exists: `idx_records_semantic_time(connector_instance_id, stream, COALESCE(...semantic_time...), record_key)`
  (`db.js:3405`). Mirrors Grafana's separate log-volume query + ES date_histogram. ONE call, ONE query.
- **Dual-dialect** (Postgres + SQLite) — the substrate already has both; the bucket-count query must too
  (Postgres `date_trunc`; SQLite `strftime`/equivalent). Honesty: counts are TRUE window=exact totals.
- **Resting domain = auto-fit to populated extent** (min(semantic_time)…now), NOT a fixed 20yr window,
  NOT a trailing-30d clamp. Kill the empty-desert by COARSENING granularity, not hiding history.
- **Granularity = span/target snapped to a calendar ladder, target ~30–60 bars** (≤2d→hour, ≤~10wk→day,
  ≤~2yr→week, larger→month). 20yr → ~240 dense month bars. Always caption the unit ("· by week"). This
  is the cell's existing ladder — the fix is FEEDING IT THE REAL EXTENT.
- **Empty buckets = zero-fill, never collapse** (server emits dense gap-filled series; gaps = real
  silence). Keep current behavior; it's correct once granularity adapts.
- **Load = deferred, off critical path** — list paints first; chart fetches as a SEPARATE request
  (skeleton→bars); brush re-derives granularity + re-queries; list never blocks on the chart.
- **Rollup/continuous-aggregate = build ONLY if proven needed** after the indexed aggregate + windowing
  (don't speculatively build a materialized rollup).

## Proposed batched scope (ONE coordinated effort, honest sub-PR split)
Per the established branch-strategy rule (frontend-only vs server splits):

**A. Server (own PR, OpenSpec + server tests) — the perf ceiling:**
- New substrate method `listExploreTimelineBucketCounts(scope, since, until, granularity)` (dual-dialect)
  = index-backed `date_trunc/strftime , COUNT(*) GROUP BY` over the substrate's multi-stream WHERE, +
  `generate_series`-style dense zero-fill. New route (or `group_by_time` on a scoped endpoint).
- Server returns the populated EXTENT (min/max semantic_time over scope) so the client can fit the domain
  + pick granularity in ONE round-trip (or the endpoint takes "auto" granularity and resolves it server-side).
- Honesty: window=exact totals; suppressed over relevance_bounded (unchanged); local-tz bucketing matching
  the feed's day-grouping (unchanged invariant).

**B. Frontend (own PR, frontend-only):**
- Chart OFF the critical path: Suspense-defer / client-fetch the bucket series so the feed paints first.
- Consume the new single endpoint; RETIRE the per-stream `aggregateRecordsByTime` fan-out + CHART_FAN_IN_TARGET_CAP.
- Extent-aware granularity: feed `deriveGranularity` the real span (from the endpoint's extent) on the
  default view → multi-year snaps to month. Auto-fit resting domain to populated extent.
- PWA: add `apps/console/app/manifest.ts` (dark `background_color`/`theme_color`, ideally light/dark media
  pair) + `viewport.themeColor`.
- `apps/console/app/dashboard/explore/error.tsx` (SegmentError, scopes blast radius) + treat
  AbortError/backgrounded-tab RSC abort as no-op + refetch on `visibilitychange`.

## Gates (each sub-PR)
Build → adversarial verify (honesty: counts==reachability, window=exact, no engine-vocab; perf: chart
off critical path proven; sparse: granularity adapts, asserted) → tsc + full suite + manifest/role gates
→ CI green → Codex gate → coordinated deploy window + LIVE verify (feed paints fast; chart bars dense not
sparse; PWA dark splash; background-during-load no longer ejects to dashboard error).

## Open questions for Codex (the gate)
1. Is the single index-backed bucket-count endpoint the right SLVP-ideal ceiling, or do you want the
   continuous-aggregate/rollup now (the research says build-only-if-proven-needed)?
2. Endpoint shape: new `/v1/explore/timeline/aggregate`-style route reusing the substrate, vs extending
   an existing scoped endpoint with `group_by_time`? Your call on the contract + OpenSpec home.
3. Does the server resolve "auto" granularity + return the extent in one call (cleanest), or does the
   client do a 2-pass (extent query → bucket query)?
4. Split confirmation: server perf PR (A) + frontend PR (B), B depends on A's endpoint. Same staged-deploy
   pattern as foundation+chart. Agree?
5. Anything in your live-stack/branch model that constrains the deploy of a NEW server route + a migration-
   free index reuse?

## ✅ CODEX GATE: LAND (2026-06-24) — build A first, constraints locked
Decisions:
1. Single index-backed bucket-count endpoint = the SLVP ceiling NOW. NO rollups/continuous aggregates
   this tranche (defer until the indexed query is measured insufficient).
2. Contract = NEW Explore-specific reference route (NOT a generic-stream-aggregate extension):
   `/_ref/explore/records/buckets` (or `/timeline/buckets`), under the reference/owner Explore surface.
   OpenSpec: `reference-implementation-architecture` (route/contract) + `reference-owner-agent-control-surface` (UI).
3. ONE call: server resolves auto granularity + returns extent. Request = current Explore filters +
   time_zone + target_buckets + granularity=auto/override. Response = populated extent, chosen
   granularity, dense zero-filled buckets, source/partial warnings. NO 2-pass unless proven impossible.
4. Split: A = server perf/contract PR (endpoint + substrate SQL + tests + OpenSpec). B = frontend
   (consume A, retire fan-out, off-critical-path, auto-fit, PWA, scoped error boundary/background abort).
   B DEPENDS ON A.
5. Branch: build on FRESH origin/main, not old deploy lineage. NO DB migration (reuse idx_records_semantic_time);
   if a migration is discovered necessary → STOP and re-gate. Coordinate mutex before live deploy.
NON-NEGOTIABLE BAR: no first-paint fan-out; no JS full-scan / record_json read for chart counts; dual
dialect (SQLite+Postgres query builders+tests); exact/honest counts or explicit partial/unavailable reason
(never fabricated bars); dense zero-fill, local-tz bucketing, extent-aware granularity, honest captions.
TESTS PIN: call count; query shape (no record_json); multi-year granularity; empty-bucket honesty;
background-abort; PWA dark manifest/theme.
"Do not let frontend async masking substitute for server-side indexed aggregation — that would be sub-SLVP."

## ⛔ STOP-AND-RE-GATE (2026-06-24) — PR A blocked: server foundation + MIGRATION not on main
Per Codex's constraint "if a migration is discovered necessary, STOP and re-gate" — it IS necessary.
On fresh origin/main the bucket-aggregate's dependencies DO NOT EXIST:
- `semantic_time` COLUMN on the records table — ABSENT on main (main has only `emitted_at`). The index-
  backed bucket query buckets on COALESCE(semantic_time, emitted_at) → needs the column = a MIGRATION.
- `idx_records_semantic_time` INDEX — ABSENT on main (main has idx_records_lookup + idx_records_version
  only). The whole perf ceiling depends on this index = a MIGRATION.
- `explore-timeline-substrate.ts` (871 lines, dual-dialect merged-timeline queries) — ABSENT on main
  (deploy-branch-only). + `rs-explore-timeline/index.ts` operation. The bucket endpoint reuses the
  substrate's multi-stream WHERE/scope plumbing.
- Net: ~21 server files / ~1,813 insertions diverge deploy-vs-main in the explore/timeline server area.
PRESENT on main (so the dual-dialect plumbing itself is fine): storage-backend.js abstraction +
isPostgresStorageBackend(), records table, emitted_at column, idx_records_lookup.
ROOT: the SERVER explore-timeline foundation (substrate + semantic_time column/index + route) was never
merged to main — it lives only on the deploy branch (the same foundation gap as sort/record-components).
The live site's fast feed + chart run on DEPLOY-BRANCH server code. PR A cannot build "on fresh main reusing
the substrate" because the substrate AND its migration aren't there.
RE-GATE QUESTION FOR CODEX (architecture, its call): how does the server explore-timeline foundation
(substrate + the semantic_time column/index MIGRATION + route) land on main? Options:
  (1) Port the server explore-timeline foundation to main FIRST (server analog of the frontend foundation
      port; includes the semantic_time migration) — its own PR — then PR A (bucket endpoint) builds on it.
  (2) Bundle substrate-port + migration + bucket endpoint into ONE server PR (mixes foundation w/ feature;
      against the semantic-boundary rule, but fewer round-trips).
  (3) A self-contained bucket endpoint that buckets on emitted_at (ON MAIN today) with idx_records_lookup,
      avoiding semantic_time/substrate entirely — BUT emitted_at = ingest time, not authored/semantic time,
      so bars would mis-attribute records to ingest dates (an HONESTY problem: chart wouldn't match the
      feed's semantic-time day-grouping). Likely sub-SLVP. Flag, don't assume.
Codex: this is the stop-and-re-gate you asked for. The migration changes the calculus — your call on the
foundation-to-main sequencing before I build PR A.

## CODEX RE-GATE VERDICT: option 1 — server foundation-to-main FIRST (2026-06-24)
HOLD bucket work. Build the SERVER explore-timeline foundation-to-main PR first (substrate +
semantic_time column/migration/index + rs-explore-timeline route + proving tests), OpenSpec-first,
mechanical+reviewable. NOT bucket-chart work. Migration ADDITIVE/backward-safe ONLY (semantic_time
nullable/default-compatible, explicit lazy backfill via COALESCE fallback to emitted_at + on-write
populate, idx created IF NOT EXISTS not assuming empty DB, dual SQLite/Postgres). Tests prove existing
timeline behavior + semantic_time ordering/grouping on main, not just compile. NO bucket endpoint.
After foundation lands → PR A (bucket endpoint) builds on it. STOP again if migration/backfill has
owner-data operational risk beyond additive/index.

MIGRATION SAFETY VERIFIED (deploy branch, the source of truth):
- semantic_time: `ALTER TABLE records ADD COLUMN [IF NOT EXISTS] semantic_time TEXT NOT NULL DEFAULT ''`
  (db.js:2014 sqlite via hasTableColumn guard; postgres-storage.js:2208 idempotent). Additive + safe default.
- index: `CREATE INDEX IF NOT EXISTS idx_records_semantic_time / idx_pg_records_semantic_time ON records(
  connector_instance_id, stream, (COALESCE(NULLIF(semantic_time,''), emitted_at)) DESC, record_key DESC)`
  (db.js:3405 / postgres-storage.js:2219). Idempotent; COALESCE → existing rows order by emitted_at (no
  misattribution before backfill).
- backfill is LAZY: NO bulk UPDATE of records; semantic_time set on write (ON CONFLICT semantic_time=
  EXCLUDED, postgres-records.js:1012). Only backfill* calls are for OTHER tables (semantic_search_*).
→ Within Codex's additive/index envelope. No op risk beyond additive/index. SAFE TO PORT.

BUILDING: foundation port via workflow (wf8k52lao): OpenSpec-first → port substrate+route+migration+
write-path+3 proving tests onto main (closure-pulled within explore-timeline scope) → gate (proving tests
+ migration idempotency on real sqlite + full suite) → adversarial verify (migration-safety, behavior-
proven, scope-no-bucket). Worktree /home/tnunamak/.tmp/pdpp-server-foundation off origin/main 02b751b5.
SEQUENCE: foundation PR → CI → Codex gate → merge → THEN PR A (bucket endpoint) → THEN PR B (frontend).
