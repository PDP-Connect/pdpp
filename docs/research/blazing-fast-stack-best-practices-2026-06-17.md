# Blazing-fast: whole-stack performance best-practices corpus (2026-06-17)

Purpose: the officially-documented + community best-practices research backing the "every
journey + read surface blazing fast" mandate, with each documented anti-pattern mapped to
PDPP's actual code. Per the corpus HARD RULE (full-context-refresh.md), web research lands
on disk with sources + dates + conclusions carried forward. Companion live-measurement
evidence: tmp/workstreams/real-browser-perf-measurement.md.

## TL;DR — is the stack the problem?
No. Next.js/RSC + Postgres + SQLite + Node are the SLVP-tier fast path. Every PDPP slowness
maps to a DOCUMENTED, fixable anti-pattern, not a stack ceiling. The framework "lets you make
invisible mistakes" — and we made several textbook ones. Fixes are best-practices, not rewrites.

## The proven root cause of the live >7s (measured, not theorized)
`/dashboard/runs` reaches 7-12s in a real browser because GET /_ref/connectors
(listConnectorSummaries N+1 projection: ~8 DB reads × N connectors) costs ~0.9s/call + 371KB,
the page re-fetches its RSC payload 2-5× UNCACHED, those fetches run SEQUENTIALLY (stack), and
server load multiplies it 2-3×. curl measured ONE 0.9s call → "sub-2s", missing the multiply.
The fix that collapses all three multipliers: CACHE the projection (repeat fetches → ~free) +
BATCH the N+1 + trim payload. (See real-browser-perf-measurement.md for the raw timings.)

## Layer 1 — Next.js App Router / React Server Components
Reputation (2026): "high ceiling, high expertise floor"; perf problems come from complexity,
not instability; done right = 50-70% less client JS + better LCP.
Documented anti-patterns → PDPP mapping:
- **Block-on-slowest-read (no streaming)** — the canonical example: layout/page awaits all data
  before sending a byte, so even a static heading hangs on the slowest fetch. → PDPP standing
  page (loadStandingInputs awaits a Promise.all of 8 reads before render). FIX: Suspense
  streaming — send the shell immediately, stream slow sections.
- **No use of the 4 cache layers** (request memoization, data cache, full route cache, router
  cache) — repeat RSC fetches re-run expensive server work. → PDPP runs page re-fetches the
  uncached connector projection 2-5×. FIX: cache/revalidate the projection.
- **"use client" contagion** — a client-marked layout ships the whole subtree as JS. → NOT yet
  audited in PDPP; check shell.tsx / layout boundaries (the #1 cited killer).
- **Serial awaits that should parallelize** → PDPP explore (below).

## Layer 2 — Postgres (remote/managed; what pdpp.vivid.fish RUNS)
Reputation: excellent. 80% of issues = missing indexes, 15% poor query design, 5% conn mgmt.
- **N+1 / fan-out** (poor query design, the 15%) → PDPP listConnectorSummaries projects ~8
  reads × N connectors; getLatestRunSummary called 2×/connector → listSpineCorrelations each;
  detail-gap does 3 count queries/connector. FIX: EXPLAIN ANALYZE (cuts p95 50-80%), batch the
  per-connector reads into ~2 grouped queries.
- **Connection pooling** — new connections cost 2-10MB RAM each; PgBouncer (transaction mode)
  is standard. → VERIFY PDPP has pooling.
- Read replicas / partitioning = the scaling answer for dashboard reads if needed later.

## Layer 3 — SQLite (local store; PDPP supports BOTH stores)
Reputation: the FASTEST path — no network hop, microsecond reads, 100K+ reads/s — but distinct,
non-obvious tuning, and DIFFERENT diagnosis than Postgres.
- **WAL mode** — non-negotiable for concurrent read-heavy server use (readers don't block writers).
- **PRAGMA synchronous = NORMAL** — single most impactful pragma in WAL.
- **cache_size** — default ~2MB is tiny; raise it (e.g. 64MB).
- **mmap_size** — ~40% scan-latency cut in one report.
- **busy_timeout** (5000 user-facing), **BEGIN IMMEDIATE** for known writes, separate read/write
  conn pools (single writer, many readers), never copy bare .db in WAL (need -wal too).
- CRITICAL: the SAME N+1 may be INVISIBLE on SQLite (µs reads absorb it) but bite on Postgres
  (ms × N). → Diagnosis & fixes are STORE-SPECIFIC; measure against the store the instance runs.
  → VERIFY PDPP's SQLite pragmas are set (likely a quick, high-value local-instance win).

## Layer 4 — Node reference server / read-surface (RS) API
Reputation: event-loop; bottlenecks = blocking I/O, CPU on main thread, large payloads.
- **Promise.all for independent I/O** (~50% faster) → PDPP explore serial chain (below) + any
  server-side serial awaits.
- **Caching hot reads** (study: 30s→1.66s) → the connector projection is the prime candidate.
- Conn pooling + indexing; watch payload size (the 371KB /_ref/connectors body); middleware
  ordering/scoping (auth only where needed).

## CONFIRMED PDPP findings (adversarial workflow, 1 confirmed / 2 refuted)
- /dashboard/explore — CONFIRMED, low-risk, console-only: per-stream serial chain
  getStreamMetadata→queryRecords (≤48 serial pairs) in
  packages/operator-ui/src/explore/explore-data-assembler.ts:416-430 → should be Promise.all
  per stream; also top-level serial awaits (1150-1184). (NOTE: real-browser showed explore's
  browser cost is partly client/JS too — confirm where its 2s goes under cold+throttle.)
- /dashboard/runs — "slim projection" REFUTED: the page uses rendered_verdict + connection_health
  (syncs-model.ts:371-372), so naive slimming breaks it. The real fix is CACHE + BATCH, not slim.
- /dashboard (standing) — N+1 fan-out (runtime); + the block-on-slowest-read streaming anti-pattern.

## Recommended sequence (Codex owns sequencing; this is the documented-best-practice order)
1. Commit the RIGHT measurement harness (real browser, cold, Web Vitals + RSC-fetch-count +
   sequential timing + RS latency). Without it, every "faster" claim is unprovable (the prior
   loop-never-closed failure).
2. Cache/memoize the connector-summaries projection (kills the runs-page repeat-fetch multiplier
   — the proven biggest win) + batch the N+1.
3. Stream the standing page (Suspense) so it stops blocking on the slowest read.
4. Parallelize explore's per-stream serial chain (console, confirmed).
5. Verify SQLite pragmas (WAL/synchronous/cache/mmap) for local instances.
6. RS API: cache + Promise.all + payload trim.
Each step: before/after on the real harness, like-for-like load, Codex acceptance, deploy via
the live-stack mutex with smoke.

## Sources (web, June 2026)
- Next.js/RSC: usuallycorrect.com/blog/nextjs-performance-optimization-2026 ;
  blog.logrocket.com/react-server-components-performance-mistakes ;
  meisteritsystems.com/news/next-js-app-router-in-2026-is-it-ready-for-production/ ;
  developerway.com/posts/react-server-components-performance
- Postgres: instaclustr.com/education/postgresql/top-10-postgresql-best-practices-for-2025/ ;
  last9.io/blog/postgresql-performance/ ; tusharagrawal.in/blog/database-connection-pooling-performance-guide
- SQLite: kerkour.com/sqlite-for-servers ; cj.rs/blog/sqlite-pragma-cheatsheet-for-performance-and-consistency/ ;
  github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md
- Node/RS: ksolves.com/blog/node-js/performance-optimization-tips-for-scalable-apis ;
  sciencedirect.com/science/article/pii/S1877050925026158 (caching 30s→1.66s study)
