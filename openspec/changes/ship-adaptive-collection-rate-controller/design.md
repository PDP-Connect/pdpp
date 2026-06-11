# Design: ship-adaptive-collection-rate-controller

## Context

This change implements the defended SLVP-ideal verdict
(`docs/research/slvp-adaptive-collection-ideal-2026-06-11.md`, 96% confidence) on
top of the already-converged single-send-governor architecture
(`converge-provider-rate-governance`). The binding-constraint mechanics are
diagnosed in `tmp/workstreams/adaptive-floor-diagnosis-2026-06-11.md` (the 1500 ms
jitter floor + ephemeral GCRA state) and `tmp/workstreams/recovery-early-exit-diagnosis-2026-06-11.md`
(the self-terminating recovery exit). The architecture is settled; this change is
parameterization + persistence + one policy fix + observability — not a redesign.

## The control loop, final shape

One control variable: the GCRA inter-request interval held by
`ProviderPacing._currentIntervalMs`. AIMD primitives already exist:
`recordSuccess()` shaves the interval down (additive increase of rate),
`recordThrottle()` multiplies it up (multiplicative decrease of rate). The lane
folds the interval in as `launchDelayHint`; the lane waits
`max(launchDelay≈εjitter, cooldown, pacingDelayHint())`. Concurrency is frozen at
1 — a hard ceiling, not a controller.

## The authored numbers, after this change

The design goal is to eliminate every constant that is a confession the
controller cannot find its own operating point. After this change the authored
numbers are:

1. **The rate ceiling** — `minIntervalMs` (default 250 ms = the one owner number;
   `PDPP_CHATGPT_PACING_MIN_INTERVAL_MS`). This is the fastest interval AIMD may
   reach: the operator's risk tolerance, set below the estimated behavioral
   threshold. *Justified: it is the single owner-authored safety number the ideal
   explicitly preserves; it cannot be discovered by probing without risking the
   account.*

2. **The ε-jitter bound** — `pauseMinMs=0 / pauseMaxMs=150`. *Justified: ±ε
   anti-phase-lock noise, bounded far below the slowest learned interval so it is
   never a rate floor. The ideal's "tens of ms" jitter.*

3. **The cold-start discovery interval** — `initialIntervalMs` (default 1000 ms;
   `PDPP_CHATGPT_PACING_INITIAL_INTERVAL_MS`). *Justified, narrowly: this is the
   discovery ramp's safe entry, used ONLY when no fresh learned state exists.
   Warm-start makes it a one-time seed, not an operating point — the ideal's "safe
   but not glacial start." It is lowered from 2500 to 1000 so cold starts are not
   glacial, and it is bounded by (never faster than) the ceiling.*

4. **The AIMD shape constants** — `additiveIncreaseMs=100`,
   `multiplicativeDecreaseFactor=0.5`. *Justified: the ideal classes the additive
   step as an owner-judgment shape ("slow enough recovery spans multiple runs"),
   kept. Persistence (warm-start) is what makes "spans multiple runs" true: the
   descent compounds instead of resetting.*

5. **The staleness guard multiple** — derived as `2 × burstToleranceMs` (reuses an
   existing horizon, not a new authored number).

Eliminated: the 1500/3000 jitter floor as a rate authority; the per-run reset of
the learned interval; the authored 2500 ms operating point (demoted to a one-time
cold seed). The concurrency-AIMD is annotated/neutralized as inert dead code.

## Warm-start persistence

`ProviderPacing` gains a `snapshot()` (`{ intervalMs }`) and accepts a
`restoredIntervalMs` option; on construction it seeds `_currentIntervalMs` from the
restored value, clamped to `[minIntervalMs, ∞)` (never faster than the ceiling).
`ProviderBudgetController` re-exposes `snapshotPacing()`.

In the connector, the learned interval is persisted as a STATE cursor on a
dedicated `messages` cursor field (`pacing_interval_ms` + `pacing_recorded_at`),
read at run start and passed to `resolveChatGptProviderBudget` as
`restoredIntervalMs` when within the staleness guard. The connector already emits
per-stream STATE cursors; this rides the same durable substrate (no new storage
primitive). Stamping at run end uses the controller's final interval after the
detail pass.

## Drain-within-budget recovery

`recoverPendingMessageDetailGapsBeforeForwardRun` becomes `void`-returning; the
caller (`runConversationsAndMessagesStreams`) no longer `return`s on
`stoppedWithPending`. Instead, after recovery it checks
`deps.runBudget?.shouldStop()` (genuine budget exhaustion) and returns only then.
The intra-recovery `stoppedWithPending` paging guard is unchanged (it still
prevents backlog-gap expansion while per-key gaps remain owed). The durable-gap
invariant holds because un-hydrated recovery items are already written as
`DETAIL_GAP` before the function returns. With the jitter floor gone, the
`tailStop` abort's original reason-for-being (avoid paying 1500 ms per no-op tail
item) is dissolved; the abort remains as a cheap micro-optimization (queued tasks
reject immediately at sub-ms ε cost), so no behavior regresses.

## Observability

A `collection_rate` structured progress event is emitted from the detail pass
carrying `{ current_interval_ms, effective_rate_per_min, ceiling_interval_ms,
ceiling_rate_per_min, last_backoff: { reason, at_interval_ms } | null }` — no
content. It is emitted on speed-up and back-off transitions (throttled to
transitions, not every request, to avoid event spam). The console diagnostics
region renders a "Collection rate" readout from the latest such state if the
reference surfaces it, degrading to an explicit unknown otherwise (honest-by-
default, matching the existing diagnostics convention). The run-trace event is the
load-bearing, fully-testable legibility surface; the console readout is the
operator-facing summary.

## What is NOT done here

Live calibration. The supervised live run that watches the controller accelerate
is owner-run; this change is code + tests only and leaves the stack untouched.
