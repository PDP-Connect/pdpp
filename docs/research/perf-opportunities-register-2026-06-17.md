# PDPP Performance Opportunities Register (lens-driven audit, 2026-06-17)

> 8 CONFIRMED / 10 FLAGGED / 3 REFUTED. Adversarially verified against the live tree.
> Lenses: docs/research/performance-evaluation-lenses.md. FINALIZATION GATE: 9:pdpp RI (Codex).
> OUT OF SCOPE / do not re-litigate: the runs-page 7s->0.4s win is already shipped.

## 1. CONFIRMED — ranked (impact x low-cost x low-correctness-risk; top = do first)
1. [LARGE] Serial per-binding query in fan-in reads (rs-api, runtime) -> bounded mapWithConcurrency 4-8, union-merge keeps cursor order. Lenses L9/L8/L3. Cost low (~50 LOC, reuses primitive). No result change. THE top item.
2. N+1 semantic index upserts loop-per-entry (db, runtime) -> pre-delete once + single multi-row INSERT..ON CONFLICT via unnest() (mirror postgresLexicalIndexInsertMany). L10/L6/L13. ~15 LOC. No result change.
3. Missing store-parity index on spine_events for aggregation (db, BOTH stores) -> composite BTREE (source_kind, source_id, ...). L5/L10/L6. DDL only. No result change.
4. N+1 spine correlation searches loop-per-row fetchRowsForSummary (db, runtime) -> WHERE col IN(..) + JS partition or LATERAL join; removes the 8-worker band-aid. L9/L10/L13. ~30-40 LOC.
5. No skeleton on records/[connector]/[stream], CLS on table (console, MINE) -> loading.tsx skeleton (~10 rows / PAGE_SIZE 50) + hoist parentMetadata into queryRecords Promise.all. L7/L8/L3/L6. Low cost. No API change.
6. [CHANGES RESULTS] Candidate-cap recall tradeoff in lexical search, UNDISCLOSED (rs-api, runtime) -> wire count=exact/estimated + meta.count (mirror /aggregate). L4/L14/L13. ~50 LOC shape change. HOLD for contract design + Codex sign-off.
7. N+1 semantic/lexical field counts loop-per-field COUNT (db, runtime) -> single GROUP BY; DRY into shared util. L10/L6/L13. ~10 LOC. No result change.
8. Codex pendingCalls fixed but pattern fragile (collectors) -> per-session concurrent-call ceiling (~1000) + backpressure/warn, or write-back stale open calls after offset-move timeout. L4/L6/L8/L12. Low cost.

## 2. FLAGGED (10) — real problem but band-aid/overstated/risks correctness; need redesign
- router.refresh() 3s poller full-tree re-render: INTENTIONAL & overstated (3s only while running; idle 30s; 2-call Promise.all; unchanged response = no DOM mutation). Don't "fix" without a measured client-cost problem.
- listConnectorManifests() blocks diagnostics (connector page): real waterfall; fix = split Promise.all (summary, then diagnostics+manifests parallel). Do NOT serialize manifests after (regressive).
- Manifest fetch every records load: real, but force-cache is WRONG (readFile not HTTP). Ideal = React.cache() + unstable_cache() + revalidation hook.
- Manifest->client/localStorage: conflates costs; real cost is server getStreamMetadata() (correctness-critical, must stay hot). Moving to client REGRESSES. Ideal = memoize getStreamMetadata() server-side.
- "Unbounded Promise.all" in /_ref/connectors: "unbounded" WRONG (mapWithConcurrency gates 8; conditional hydration already shipped). Remaining lever = flip list default false; 7/9 ops contract-required.
- HTTP cache headers on /v1/schema, /_ref/connectors: band-aid on EXISTING in-memory cache (TTL 5s + 15 invalidate calls). Second uncoordinated cache = stale post-mutation. DO NOT.
- Claude Code double full-file scan: cold-start only (mtime cursors skip re-reads). Leave unless measured.
- (+2 more flagged, incl a Claude Code tool-results item; truncated in capture.)

## 3. REFUTED (3) — not real / already fixed; do NOT action. (Specifics truncated; verifiers marked not-real.)

## Cross-cutting themes
- N+1 / loop-per-X recurs in db-layer (#2,4,7) -> a "batch, don't loop" pattern.
- Store-parity (L5): #3 index on BOTH stores; SQLite pragmas (other corpus doc) still open.
- Honesty (L14): #6 candidate-cap truncation must be DISCLOSED (meta.count), not silent.
- Verifiers killed 4+ "obvious" caching/parallelism ideas as band-aids on EXISTING primitives -> easy wins mostly done; remaining = real N+1s + indexes + disclosed-recall + perceived-perf skeletons.

## Recommended FIRST batch (confirmed, high-impact x low-risk)
- #1 serial fan-in -> mapWithConcurrency (large, runtime) = a Codex lane.
- #2 + #7 N+1 upserts + field counts (near-free, runtime) = one Codex lane.
- #3 spine_events composite index BOTH stores (DDL, parity) = runtime, quick.
- #5 records-table skeleton + fetch hoist (console, Claude, no API change).
- HOLD #6 (changes results -> contract design + Codex sign-off). #4 = second wave.
SLVP-restoration items (read-model, SQLite pragmas/parity, BM25, PPR-shell, collector bounded-memory) are SEPARATE from these NEW finds; sequence with Codex.
