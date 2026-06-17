# Perceived + architectural performance — elite 2026 practices (research corpus)

Companion to blazing-fast-stack-best-practices-2026-06-17.md. the owner asked to widen beyond
"fix slow queries" to: (a) performant algorithms/runtime patterns, (b) the 2026 Next.js
recommended architecture, (c) elite-studio PERCEIVED-performance UX (loading, motion).
Grounded to recent/2026 sources. Per the corpus HARD RULE, research lands on disk.

## CATEGORY A — 2026 Next.js recommended architecture (we are NOT using the current default)
- **PPR (Partial Prerendering) is now the DEFAULT recommended strategy** — graduated from
  experimental to STABLE in Next.js 16 (Cache Components). "For most Next.js apps, PPR should
  be the default rendering strategy." Serves a STATIC shell instantly (nav/layout/above-fold)
  + STREAMS dynamic holes in the same response → CDN-speed TTFB + personalized data. PDPP is
  full-SSR App Router with no PPR — this is the single biggest architectural lever after the
  query fixes.
- **Server Components by default; Client Components only for interactivity** — RSC has zero
  client-JS cost. (We're on RSC already; audit "use client" contagion on shell/layout.)
- **Fine-grained Suspense boundaries** — ONE per independently-dynamic concern (not one giant
  boundary = that's just SSR-with-a-spinner). Independent boundaries stream in PARALLEL; a
  slow query doesn't block the rest. → PDPP standing/runs should wrap each slow section
  (connector list, run feed) in its OWN Suspense boundary so the shell + fast sections paint
  immediately.
- **The searchParams trap**: destructuring searchParams in a page opts the WHOLE route into
  dynamic rendering, killing PPR. Move searchParams into a Suspense-wrapped child. (PDPP uses
  searchParams on several pages — explore, peek params — AUDIT this.)
- **Parallel data fetching (Promise.all)** = "the single most impactful performance lever" and
  "the most common RSC performance anti-pattern" when violated. (Our confirmed explore
  serial-await is exactly this; standing already parallel.)
- **Caching layers (4)** — request memoization / data cache / full route cache / router cache;
  opt out selectively. PITFALL: a cache hit can hoist a component into the static shell and
  silently serve STALE personalized data — relevant to the 5s connector-summary cache.
- **Server Actions for mutations** (not API routes) — type-safe, co-located.
- CAVEAT: PPR's dynamic stream is only as fast as the upstream origin. "Static shell 40ms but
  dynamic stream 800ms because the downstream API isn't fast." → PPR AND the query fixes are
  complementary, not either/or. Our /_ref/connectors must be fast for PPR streaming to shine
  (it now is, ~45ms warm).

## CATEGORY B — Performant algorithms / runtime patterns (objective, beyond queries)
- **Promise.all for independent I/O** — covered; the explore fix is the open one.
- **Avoid O(file)/O(n) in-memory accumulation when streaming is possible** — DIRECTLY relevant:
  the codex collector OOM (see below) is an O(file) accumulation that should be streamed.
- **Optimistic UI decouples feedback from the network** — architectural speed, not a trick:
  reflect the result immediately, reconcile on response, revert on error. For PDPP: revoke,
  rename, sync-now, refresh actions could be optimistic.
- **Local-first / client cache (the Linear model)** — Linear feels instant because it stores
  the active dataset in the browser and syncs in the background; "making a CSR app feel
  instant, obsessive attention to first load." Aspirational, heavier lift; note as the ceiling.

## CATEGORY C — Perceived performance UX (elite studios; what we're NOT doing)
The reframe: "a page that loads in 800ms but shows a blank screen feels slower than one that
takes 1.2s but shows skeletons from the first frame." Felt speed, not just real speed.
- **Skeleton screens > spinners** — users perceive skeleton pages as ~30% faster at IDENTICAL
  real load time. A BLANK screen is the worst (triggers "something broke"). PDPP has some
  loading.tsx skeletons — audit coverage + fidelity (recognizable shapes, low fidelity, one
  placeholder per group). PAIRS with PPR/Suspense fallbacks.
- **Doherty Threshold (400ms)** — respond to input within ~400ms to preserve flow; return
  lightweight feedback (press state / skeleton / optimistic) within ~100-200ms even if final
  data lands later. Stage complexity: show the first decision now, lazy-load secondary panels.
- **Motion specs (systematized, not ad hoc)** — desktop transitions 150-200ms; micro-
  interactions 150-250ms eased; NEVER exceed ~400ms/transition; scale duration to distance.
  Every interactive element needs all 6 microstates (default/hover/focus/active/disabled/
  loading). Motion signals causality, not decoration.
- **Eliminate layout shift (CLS=0)** — skeletons must reserve EXACT final dimensions or content
  "jumps" when it streams in (the #1 PPR risk: a blank-div fallback spikes CLS). This connects
  to the owner's earlier complaint about degraded rows changing width/corners — instability reads as
  broken.
- **Progress for long determinate waits** — asymptotic bar that never stalls / never quite hits
  100% until done; for very long waits keep the user busy / let them do other things.
- **Every state is DESIGNED** (Linear/Stripe/Vercel common thread — not a shared aesthetic, a
  shared level of CRAFT): empty/loading/error states designed not stubbed; microstates complete;
  motion a defined curve+duration system. THIS is the SLVP bar the owner keeps invoking.

## What PDPP has NOT done (objectively-better, grounded), to bring to Codex
1. PPR / Cache Components — not adopted (the current Next.js default architecture).
2. Fine-grained Suspense boundaries per dynamic section (standing/runs) — not done (Codex
   fixed runs by payload-bounding instead of streaming).
3. searchParams audit (opts routes out of static/PPR).
4. explore serial-await Promise.all — confirmed, not done.
5. Skeleton coverage + fidelity + CLS-safe dimensions audit.
6. Motion system (durations/easing/microstates) — likely ad hoc.
7. Optimistic UI for low-risk actions (revoke/rename/refresh/sync-now).
8. SQLite pragmas (from the other corpus doc) — local-store free win, skipped.
9. The codex-collector O(file) OOM fix (runtime correctness + the machine getting killed).

## Sources (web, June 2026)
- Next.js/PPR: nextjs.org/docs/app/guides/ppr-platform-guide ;
  samcheek.com/blog/nextjs-partial-prerendering-production-2026 ;
  dev.to/pockit_tools/nextjs-partial-prerendering-ppr-deep-dive ;
  nextjs.org/docs/app/guides/production-checklist ; digitalapplied.com/blog/react-server-components-production-patterns-guide
- Perceived UX: blog.logrocket.com/ux-design/skeleton-loading-screen-design/ ;
  blog.logrocket.com/ux-design/designing-instant-feedback-doherty-threshold/ ;
  smart-interface-design-patterns.com/articles/designing-better-loading-progress-ux/ ;
  simonhearne.com/2021/optimistic-ui-patterns/ ; m1.material.io/motion/duration-easing.html
- Elite craft / Linear: mantlr.com/blog/stripe-linear-vercel-premium-ui ;
  performance.dev/how-is-linear-so-fast-a-technical-breakdown
