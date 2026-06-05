# Design: bound-connector-run-by-owner-cap

## Context

The ChatGPT detail lane (`packages/polyfill-connectors/connectors/chatgpt/index.ts`)
runs a list+detail pass: it lists conversations, then hydrates per-conversation
message detail serially. Two existing circuits can stop the detail pass early and
defer the remainder as resumable `DETAIL_GAP` records:

1. **Per-record retry exhaustion.** A single conversation that exhausts its retry
   budget defers as a resumable gap.
2. **Cumulative 429-density stop** (`ChatGptRateLimitDensityTracker`, commit
   `69bc2e11`). Once a *pressured* account has served enough 429s, the lane opens
   the upstream-pressure circuit and defers this and every later conversation as
   `upstream_pressure` gaps — which **do** arm the cross-run source-pressure
   cooldown governor (`SOURCE_PRESSURE_GAP_REASONS = {rate_limited,
   upstream_pressure}`).

Neither bounds a **cold** account. With 0% 429s, nothing trips, and the serial
lane walks the entire history. That is the gap a prior readiness report flagged as
the most valuable next build: a cold large-history account makes an unattended
owner-gesture schedule indefensible, because a single nudge runs to completion.

The deferral, cursor-commit, and recovery machinery already exist and are correct.
The recovery pass re-hydrates gaps filtered by `gap.stream === "messages"` — *not*
by reason — so a resumable gap of any reason recovers on the next run. The only
missing piece is an owner-configured way to *choose* to stop early on a cold
account, with the deferral honestly marked as self-imposed rather than as source
pressure.

## Goals

- Bound a single run by **size** (max detail fetches) and/or **time** (max
  wall-clock of the detail phase), opt-in and **default off**, so an unattended
  owner-gesture schedule does bounded work per nudge.
- Reuse the existing resumable-`DETAIL_GAP` deferral and cursor-commit so the
  remainder recovers first on the next run and a large history fills in over
  several bounded runs.
- Keep the cap **strictly safer** than today: it can only ever make a run stop
  *earlier*, never fetch more, raise concurrency, or change pacing.
- Keep a cap deferral **decomplected from source pressure**: it must not arm the
  cooldown governor or appear in the source-pressure backlog rollup, and it must
  read distinctly in owner copy.

## Non-goals

- Not a concurrency, pacing, or retry-budget change. The connector is not made
  faster; the cap is purely a stop-early bound.
- Not a change to the scheduler dispatch policy, the `background_safe` /
  `recommended_mode` manifest gates, or the `needs_human_auth` posture. The cap
  bounds the *gesture*; it does not flip a manual connector to background-safe.
- Not a new wire reason, manifest field, terminal status, or Collection Profile
  message. The deferral reuses `retry_exhausted`, already in the `DETAIL_GAP`
  reason union.
- Not a mid-fetch interrupt. A serial fetch in flight is never aborted by the cap.

## Decisions

### D1. Two opt-in knobs, both default off

- `PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN` — max hydrated conversation details
  per run. Unset, non-integer, or `< 1` → `Infinity` (no cap).
- `PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS` — max wall-clock (ms) the detail phase may
  spend. Unset, non-finite, or `<= 0` → `Infinity` (no cap).

The disable sentinel is `Infinity`, so an unset/invalid knob is simply never the
reason a run stops. With **neither** set the budget never trips and the run is
byte-for-byte identical to today — the safety property of the change is that it is
inert until an owner opts in. The knobs are connector-prefixed because the cap
ships in the ChatGPT lane first; a future connector adopting the contract adds its
own prefixed knobs.

### D2. One run-scoped budget shared across recovery + forward passes

A single `ChatGptRunBudget` is created once in `collect()` and threaded through
`StreamDeps.runBudget` into **both** the gap-recovery pass and the forward-walk
pass. A large recovery backlog plus newly listed conversations are therefore
bounded *together*, not per-invocation — otherwise a backlog larger than the cap
could consume the whole budget on recovery and the forward pass would start a
*second* full budget, defeating the bound. The budget is pure, with an injectable
clock, so the cap decision is unit-testable without a multi-hour run.

The wall-clock anchors **lazily** on first consultation (the first `reason()` /
`shouldStop()` call), so it measures the detail phase, not connector setup. An
idle run that never reaches the detail lane never burns its clock.

### D3. Cap trip defers the remainder as resumable `DETAIL_GAP`

Before launching each detail fetch, the lane consults the budget. Once a cap is
reached, it stops launching fetches and defers this conversation and every later
one as a resumable `DETAIL_GAP` (no fetch), pushing the keys into
`DETAIL_COVERAGE.gap_keys`. The conversations cursor still commits the hydrated
prefix — exactly as the density stop does — because the deferred records are
durable gaps the next run recovers first. The fetch count is incremented only
**after** a successful hydration, so deferred/failed conversations never consume
the size budget.

### D4. Cap deferral is NOT source pressure (the load-bearing honesty decision)

The account did not throttle us; the run *chose* to stop. The deferred gaps
therefore carry:

- wire `reason: "retry_exhausted"` — resumable and retried next run, but **not** in
  `SOURCE_PRESSURE_GAP_REASONS`, so it does **not** arm the cross-run
  source-pressure cooldown governor and is **not** counted in the source-pressure
  detail-gap backlog rollup (`deriveSourcePressureBacklog` filters to
  `SOURCE_PRESSURE_GAP_REASONS`). Falsely using `upstream_pressure` would tell the
  scheduler the source is hot when it is not, and would inflate the
  source-pressure backlog with a self-imposed bound.
- a distinct `error.class: "run_cap_deferred"` so an owner surface can render a
  configured cap separately from a busy-service defer.

This is the separation the `surface-source-pressure-detail-gap-backlog` change
depends on: its rollup is reason-scoped to source pressure, so a cap deferral is
excluded by construction. This change makes that exclusion normative rather than
incidental.

### D5. Wall-clock checked between fetches, not mid-fetch

The budget is consulted between conversations, never mid-fetch. A serial fetch
cannot be safely interrupted, so the honest, clean behavior is to let the
in-flight fetch finish and stop before the next one. A wall-clock cap can
therefore be exceeded by at most **one** in-flight conversation's processing time,
itself bounded by the connector's per-fetch timeout
(`chatgpt_backend_fetch_timeout`, 45 s). The overrun is small, bounded, and
documented rather than hidden.

### D6. Display copy: generic reason vs. specific cap class

`reference-implementation/runtime/display-messages.ts` is the single source of
truth for end-user copy. The cap surfaces two codes:

- `retry_exhausted` — the **generic** resumable wire reason: a retry budget was
  used up (a configured run cap, or transient failures consuming a retry budget).
  Its copy must stay generic and must not imply a configured cap or a busy
  service.
- `run_cap_deferred` — the **specific** error class for a configured per-run
  size/time cap. Its copy names the self-imposed bound ("this run's budget").

Before this change both strings were byte-identical and both phrased as run-cap
copy, which made `retry_exhausted` overclaim a configured cap for any
retry-exhaustion path. Differentiating them keeps each honest. Neither string may
imply source pressure ("the service is busy"); that copy belongs to
`upstream_pressure` / `upstream_pressure_deferred`.

## Risks and tradeoffs

- **Cursor advances on a capped run.** A capped run commits the hydrated prefix's
  conversations cursor while leaving message-detail gaps behind. This is the
  established connector contract (exercised by the density-stop tests), correct
  *because* the deferred conversations are durable gaps recovered first next run.
  Not new risk; made explicit here.
- **Default-off means an unconfigured scheduled run is still unbounded.** The cap
  does nothing until an owner sets a knob. The operational guidance (set a cap
  before scheduling unattended) is part of the safety property, not optional.
- **Wall-clock overrun by one in-flight fetch** (D5) — bounded by the per-fetch
  timeout, intentional.
- **Connector-specific knobs.** The first implementation is ChatGPT-prefixed. The
  requirement is connector-agnostic, but a second connector must add its own
  knobs and budget; there is no shared global cap. Acceptable: per-connector
  pacing differs enough that one global number would be wrong.

## Acceptance checks

- With **neither** knob set, a run is byte-for-byte unchanged: the budget never
  trips, no cap branch is reached, and a large backlog runs to completion exactly
  as before. (Default-off.)
- An unset / non-integer / non-positive knob resolves to no cap; a positive value
  caps the run. (Knob resolver contract.)
- A single run budget bounds the gap-recovery pass **and** the forward-walk pass
  together: a recovery backlog larger than the cap defers the forward pass without
  starting a second budget. (Shared budget.)
- A max-detail-fetches cap defers the tail as resumable `DETAIL_GAP` records with
  `reason: retry_exhausted` and `error.class: run_cap_deferred`, never
  `upstream_pressure` / `rate_limited`; the hydrated records validate against the
  production record shape; the trip is announced once without leaking ids/paths.
  (Finite cap deferral.)
- A wall-clock cap defers the tail via an injected clock and is exceeded by at
  most one in-flight fetch. (Wall-clock overrun bound.)
- A cap deferral does **not** arm the source-pressure cooldown governor and is
  **not** counted in the source-pressure detail-gap backlog rollup
  (`retry_exhausted` is outside `SOURCE_PRESSURE_GAP_REASONS`). (Source-pressure
  decomplection.)
- The next run recovers the cap-deferred gaps first (recovery filters by
  `stream`, not reason) and walks forward, so a large history fills in over
  several bounded runs. (Resumability.)
- `retry_exhausted` and `run_cap_deferred` display strings are distinct; neither
  implies the service was busy. (Display copy honesty.)

## Safe-scheduling guidance (informative)

The cap makes an owner-gesture (manual run-now) schedule safe to automate
externally while the connector itself stays `needs_human_auth` / not
background-safe:

1. Keep the connector manual-only; schedule the *gesture*, not background
   automation. Do not flip `background_safe` / `recommended_mode`.
2. Set a per-run cap before scheduling unattended — for example
   `PDPP_CHATGPT_MAX_RUN_WALL_CLOCK_MS=1800000` (30 min) **or**
   `PDPP_CHATGPT_MAX_DETAIL_FETCHES_PER_RUN≈300–600`. Either bounds a single
   nudge; the remainder defers and the next nudge resumes.
3. Cadence no tighter than the connector's `minimum_interval_seconds`. Each run
   recovers prior gaps first, then walks forward.
4. Keep the density stop at its default and concurrency serial on a recently-hot
   account; run owner-present for the first few large catch-up runs until the
   backlog visibly drains and the chosen cap value is confirmed reasonable.
