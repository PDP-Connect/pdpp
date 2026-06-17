# Performance evaluation lenses — the standing gate for any perf change (2026-06-17)

Purpose: a perf change must NOT pass on "it's faster" alone. Each lens is a question to run a
change through. Earned from this session's real mistakes (noted) + 2026 elite-practice research
(blazing-fast-stack-best-practices + perceived-and-architectural-perf docs). Use as a pre-ship
checklist; most changes genuinely implicate only 2-3 lenses — the skill is knowing which.

## The two meta-lenses (highest weight — these caused the most wasted work this session)
- **L13 Band-aid vs ideal (construction-boundary):** is this a point-fix or does it restore/
  establish the right primitive? (5s hand-cache vs tag-revalidation; shallow rows vs read-model;
  candidate-cap vs BM25). Ask "SLVP-ideal construction or patch?" BEFORE shipping.
- **L14 Honesty / does-it-hide:** did we make it look fast by HIDING or DROPPING data the
  user/reviewer should see? (shallow rows dropped run evidence; a fast "0 results" that's really
  a truncation). PDPP's whole value is honesty — a fast fix that hides data violates the core
  principle even if the number improves.

## Correctness & data lenses
- **L4 Correctness-vs-speed (MOST DANGEROUS):** does the fast path change the RESULT or only the
  latency? Cache→staleness; candidate-cap→dropped match; shallow projection→hidden data. The
  speedup is visible; the regression is invisible. (candidate-cap, shallow rows, 5s staleness)
- **L5 Store-parity / backend-agnostic:** optimizes Postgres but neglects SQLite? Is the
  diagnosis store-specific (µs SQLite vs ms×N Postgres)? Both stores must reach parity.
  (the cache that excluded SQLite "for test isolation")
- **L6 Scale / data-volume:** does cost grow with N (connectors/records/file size)? What about
  the p99 user, not the median? (collector O(file) OOM; N+1 invisible at small N)

## Measurement & runtime lenses
- **L3 Measurement fidelity:** measuring what the user FEELS (real browser, hydration, repeat
  RSC fetches, cold cache) or a proxy (curl/TTFB)? The 2s-vs-7s gap — absence of this lens caused
  the most wasted work. ALWAYS measure the real thing before AND after.
- **L8 Tail latency / variance (incl. cold-vs-warm):** optimizing p50 while p95/p99/cold suffer?
  The runs RSC fetch swung 0.9s→3s under load. Elite products optimize the TAIL. Cold vs warm is
  part of this (the owner's 7s ≈ cold; my measurements ≈ warm).
- **L9 Concurrency / contention:** holds a lock, saturates the pool, blocks the event loop →
  slows EVERYONE? (fanout=8, SQLite single-writer, Node event-loop). Perf-of-one vs perf-under-load.

## Cost-of-the-speedup lenses (the other side of the ledger)
- **L10 Write/ingest cost:** what does this read-optimization cost on writes? Every cache/index/
  read-model trades write or memory cost for read speed. (GIN index speeds reads, slows ingest +
  costs disk). Don't only look at the read.
- **L11 Payload / bandwidth:** how big is what we send? (371KB /_ref/connectors; 138-row syncs
  page). Bytes-over-wire is a perceived-perf factor independent of server time; dominates on slow
  networks.
- **L12 Memory / resource footprint:** steady-state AND peak RAM, server AND device. (collector
  OOM = server; "use client" bundle/hydration = device). RAM is first-class — we nearly lost the
  machine to a perf-adjacent bug.

## Architecture & experience lenses
- **L1 Deploy-target:** assumes a platform we don't have / will have (serverless/edge vs self-
  host)? Degrades gracefully across both? Use only PORTABLE primitives. (force-dynamic vs PPR;
  PDPP will support serverless → PPR is the deploy-agnostic, serverless-ready target).
- **L2 Separation-of-concerns / boundary placement:** where do security/data/cache boundaries
  sit? Does a perf change move data across a boundary it shouldn't? (cached-shell vs DAL auth —
  resolved: DAL-at-data-source is correct, so PPR-shell is safe).
- **L7 Perceived vs objective:** faster, feels-faster, or both? Optimizing a number the user
  doesn't feel, or ignoring a feel-issue with good numbers? (instant shell + skeletons vs raw ms;
  Doherty <400ms; skeleton>spinner ~30% perceived).

## High-signal ordering (by how much each bit us)
L3 measurement → L4 correctness → L13 band-aid-vs-ideal → L5 store-parity → L6/L8 scale/tail →
L10 write-cost → (L1/L2/L7/L9/L11/L12 as applicable).
An SLVP-ideal perf change: faster on a REAL-browser measure, changes NO results, RESTORES (not
patches) the construction, works on BOTH stores, holds at p99/scale, doesn't blow up writes/
memory, hides nothing, and is deploy-portable.
