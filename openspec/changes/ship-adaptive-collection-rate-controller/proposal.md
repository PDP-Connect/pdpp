# Proposal: ship-adaptive-collection-rate-controller

## Why

The ChatGPT connector's adaptive collection rate controller is dressed in AIMD
machinery that a hand-tuned floor disables. `converge-provider-rate-governance`
correctly collapsed the two pre-flight waits into one (the AdaptiveLane is the
sole send governor; GCRA pacing rides as a `launchDelayHint`), but three
incidental constants and one cap-era policy still defeat the loop:

1. **The launch-jitter floor is the binding rate authority, not the controller.**
   The lane waits `max(launchDelay, cooldown, pacingDelayHint())`. With
   `CONVO_DETAIL_PAUSE_MIN_MS = 1500` as the lane's `minDelayMs`, the jitter
   floor overrides the GCRA rate-AIMD from below: the controller can never probe
   an interval shorter than 1500 ms even when the provider would accept it,
   capping throughput at ~19–40 conv/min regardless of what `ProviderPacing`
   learns. Jitter is an anti-phase-lock technique for competing flows; a single
   serial collector has no competing flows, so a fixed jitter *floor* has no
   convergence role — it is a manual throttle masquerading as control.

2. **The learned rate is discarded every run.** `ProviderPacing` is
   re-instantiated fresh at every run start, so the AIMD descent toward the floor
   (23 successes to reach 250 ms) is thrown away at each run boundary. A
   hand-authored `initialIntervalMs = 2500` is the permanent operating point for
   short-to-medium runs — the controller never gets to keep what it found.

3. **The self-terminating recovery exit abandons live budget.** When gap recovery
   stops on transient source pressure (`stoppedWithPending`), the run `return`s
   before the forward walk — even with substantial wall-clock budget remaining.
   The list cursor does not advance and newly-created conversations are not
   discovered. This was a cap-era policy that is overly conservative under
   fastest-safe; a transient upstream-pressure circuit must back off, not
   terminate the run.

The SLVP ideal (`docs/research/slvp-adaptive-collection-ideal-2026-06-11.md`,
96% confidence): *adapt rate down fast and up slow, inside a fixed envelope you
never probe, and turn what you couldn't fetch into a durable re-entry point.* One
control variable (the GCRA interval); concurrency frozen at 1 as a hard ceiling;
ONE owner-authored number (the rate ceiling); the controller's state legible to
an operator.

## What Changes

- **Delete the launch-jitter floor as a rate floor.** Lower the detail-lane
  `pauseMin/pauseMax` defaults from `1500/3000` to a sub-second ε anti-phase-lock
  window (`0/150`). The GCRA pacing interval becomes the sole rate authority;
  jitter survives only as ±ε noise, never as a floor that can exceed the learned
  interval.

- **Slow-start discovery + warm-start.** Persist the controller's learned
  interval to connector state at run end and restore it at run start behind a
  staleness guard, so AIMD descent compounds across runs instead of resetting.
  The cold-start interval is a discovery seed used only when no fresh learned
  state exists, not a hand-authored operating point.

- **The one owner number: the rate ceiling.** A single owner-configurable safety
  ceiling — the minimum inter-request interval (= maximum sustained rate) the
  probe never crosses — wired as one env value (`PDPP_CHATGPT_PACING_MIN_INTERVAL_MS`)
  with a safe default, documented as the only number and the operator's risk
  tolerance. Concurrency stays frozen at 1; the concurrency-AIMD is neutralized
  as inert under `maxConcurrency === 1`.

- **Drain-within-budget recovery.** Remove the `return` on `stoppedWithPending`;
  continue to the forward walk while run budget remains, deferring only at true
  budget exhaustion. The durable-gap invariant is preserved: remaining recovery
  items stay recorded as `DETAIL_GAP`.

- **Observability.** Emit the controller's live state — current interval /
  effective rate, the ceiling rate, last back-off event + reason — as structured
  run-trace progress events, and surface a small honest "Collection rate" readout
  in the connection-detail diagnostics region.

## Impact

- Affected specs: `polyfill-runtime` (ADDED requirements for the rate ceiling,
  warm-start persistence, ε-jitter, drain-within-budget, controller legibility).
- Affected code:
  - `packages/polyfill-connectors/src/provider-pacing.ts` — ceiling-aware throttle
    ceiling, warm-start snapshot/restore, controller-state snapshot for legibility.
  - `packages/polyfill-connectors/src/provider-budget.ts` — expose the pacing
    snapshot / warm-start seam on the controller.
  - `packages/polyfill-connectors/connectors/chatgpt/index.ts` — ε-jitter defaults,
    warm-start state read/write, drain-within-budget recovery exit, controller-state
    progress events, neutralize concurrency-AIMD.
  - `apps/console/src/app/dashboard/records/[connector]/` — Collection rate readout.
- No live calibration in this change: the supervised live run is owner-run.
