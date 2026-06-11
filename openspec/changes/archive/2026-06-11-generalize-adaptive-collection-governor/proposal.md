# Proposal: generalize-adaptive-collection-governor

## Why

`ship-adaptive-collection-rate-controller` proved the SLVP-ideal adaptive rate
controller LIVE on ChatGPT (19 → 32.7 conv/min): slow-start discovery, AIMD
accelerate-under-success, a single owner-authored rate ceiling it never probes
across, warm-start that compounds the learned rate across runs, and an operator-
legible `collection_rate` readout.

But that adaptive behavior was wired in the ChatGPT detail path
(`connectors/chatgpt/index.ts`). The six API connectors that already adopted the
shared send governor — github, notion, oura, spotify, strava, ynab — call
`createConnectorHttpGovernor({ name, maxAttempts: 1 })` and got the governor
*plumbed* but run NON-adaptive: the factory defaulted `pacingInitialIntervalMs: 0`
(no pacing wait at all). The proven loop was a connector-specific feature, not a
shared capability.

The owner's goal: *a useful general abstraction that is easy to use in new
connectors.* Phase A of the collection-governor generalization makes the adaptive
behavior a shared, nearly-free default for every API connector — discovery,
back-off, warm-start, and observability inherited from the SAME bare factory call,
with ~zero added adoption surface.

Scope: API connectors only. Browser-bound connectors (amazon/chase/usaa) and
reddit are **Phase B** (a separate research verdict, pending) and are NOT touched
here.

## What Changes

- **Adaptive collection is the DEFAULT in `createConnectorHttpGovernor`.** The
  factory's `pacingInitialIntervalMs` now defaults to a conservative slow-start
  discovery seed (`DEFAULT_PACING_INITIAL_INTERVAL_MS = 1000`) and
  `pacingMinIntervalMs` to the shared rate ceiling
  (`DEFAULT_PACING_MIN_INTERVAL_MS = 250`) — ChatGPT's live-calibrated values
  hoisted as the shared defaults. The AIMD machinery (`recordSuccess` additive
  increase, `recordThrottle` multiplicative decrease) was already wired into the
  factory's request path; flipping the default from 0 turns it on. The same bare
  `createConnectorHttpGovernor({ name })` call now yields slow-start discovery →
  accelerate-under-success → ceiling-bounded back-off. Pass
  `pacingInitialIntervalMs: 0` to opt OUT (the pre-convergence byte-identical
  no-pacing path).

- **Warm-start persistence as a runtime concern via a clean seam.** The governor
  exposes `snapshot()` (the live rate state) and three shared, framework-owned
  helpers a connector threads its durable state through instead of hand-rolling:
  `readPersistedPacingInterval(stateSlice)` (restore, with the staleness guard),
  `buildPacingStateFields(governor)` (persist), and `buildCollectionRateProgress
  (governor)` (observability). A connector restores last run's learned interval
  into the factory's new `restoredIntervalMs` option, and persists this run's
  interval onto an existing declared stream cursor. The GCRA mechanics stay in the
  governor; the connector only says WHERE its state lives. github is wired as the
  reference adoption.

- **The six API connectors inherit adaptive behavior with no per-connector rate
  code.** Their existing `createConnectorHttpGovernor({ name, maxAttempts: 1 })`
  call now yields the adaptive loop by default. Warm-start + observability remain
  opt-in seams (~3 lines) demonstrated on github.

- **`collection_rate` observability flows from the shared governor for ALL
  governor-using connectors.** `buildCollectionRateProgress` emits the same
  `collection_rate` run-trace progress shape ChatGPT wired runtime→spine→UI, so
  any connector's rate is visible through the existing path with no new UI work.

## Impact

- Affected specs: `polyfill-runtime` (ADDED requirements for default-on adaptive
  collection, the warm-start runtime seam, and shared collection_rate
  observability across governor-using connectors).
- Affected code:
  - `packages/polyfill-connectors/src/connector-http-governor.ts` — default-on
    pacing, `restoredIntervalMs` option, `snapshot()`, and the shared
    `readPersistedPacingInterval` / `buildPacingStateFields` /
    `buildCollectionRateProgress` helpers.
  - `packages/polyfill-connectors/connectors/github/index.ts` — reference warm-
    start (restore + persist onto the `user` cursor) and collection_rate emit.
  - Tests: `connector-http-governor.test.ts` (adaptive-default, warm-start,
    observability parity tests), `connectors/github/index.test.ts` (carrier +
    round-trip; instant-timer so default-on pacing keeps the suite fast).
- NOT touched (other workstreams / Phase B): `auth.js`, `apps/console` UI,
  browser-bound connectors (amazon/chase/usaa), reddit.
- No live calibration in this change: ChatGPT's proven values become the shared
  defaults; a supervised live run per new connector is owner-run.
