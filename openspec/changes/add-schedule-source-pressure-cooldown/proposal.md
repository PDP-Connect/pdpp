# Proposal: add-schedule-source-pressure-cooldown

## Why

A connector run can defer work under upstream/source pressure and still terminate `succeeded`. ChatGPT does exactly this: when a private detail endpoint returns bare 429s, the run degrades the remaining conversations to resumable `DETAIL_GAP` records (reason `upstream_pressure` / `rate_limited`) and exits cleanly rather than grinding a hot account. That is correct connector behavior.

The scheduler's existing failure-class back-off (`add-connector-adaptive-lanes` is intra-run; the scheduler back-off is cross-run) only counts `failed` runs. A `succeeded`-with-pending-pressure run resets the failure streak to zero, so the next scheduled tick fires on the normal interval and re-hits the same still-cooling account bucket. Unattended cadence then keeps re-pressuring the source. This is the remaining blocker to scheduling ChatGPT confidently.

## What Changes

- Add a cross-run **source-pressure cooldown** governor to the reference scheduler: when a connection still has pending retryable source-pressure detail gaps, the scheduler SHALL defer the next *automatic* dispatch with a decaying/exponential, capped inter-run cooldown.
- Decay/relax: the cooldown grows with the gaps' recovery-attempt persistence and clears the moment the pending pressure set empties (a recovered/clean run), so a connection is never stuck cooling.
- Honesty: the schedule projection SHALL surface the cooldown through the existing `cooling_off` health state and a deferred next-run timestamp, so the dashboard does not present a connection as bare green while pressure gaps remain.
- Manual `Sync now` / owner-triggered runs SHALL bypass the cooldown.
- The policy is reason-gated (`upstream_pressure`, `rate_limited`), so connectors without source-pressure gaps are not throttled.

## Capabilities

Modified:
- `reference-implementation-architecture`

## Impact

- Affects the reference scheduler dispatch gate (`reference-implementation/runtime/scheduler.ts`) and the schedule/health projection (`reference-implementation/runtime/controller.ts`).
- Reads pending gaps from the existing durable `connector_detail_gaps` store; no new table, column, or migration.
- Does not change Collection Profile JSONL messages, connector manifests, run terminal statuses, intra-run adaptive-lane behavior, or public PDPP protocol semantics.
