# Design: schedule source-pressure cooldown

## Context

`add-connector-adaptive-lanes` made a single ChatGPT run *account-safe within the run*: bare-429 fast-open, cold-state preflight, and degrade-to-`DETAIL_GAP` instead of grinding a hot account. Cleanup is green and the Postgres `DETAIL_GAP` round-trip is proven (`test(runtime): prove detail gap replay on postgres`).

The remaining schedule blocker is *cross-run cadence*. The reference scheduler already has a mature failure-class exponential back-off (`reference-implementation/runtime/scheduler-backoff.ts`) that surfaces `cooling_off` / `blocked` and suppresses dispatch. But it only counts `failed` runs:

```
record.status === "succeeded"  // resets the consecutive-failure streak to 0
```

A ChatGPT run that defers conversations under pressure terminates `succeeded` and records durable `pending` gaps (`reason: upstream_pressure | rate_limited`) in `connector_detail_gaps`. The failure streak stays 0, so the next scheduled tick fires on the base interval and re-hits the same per-account bucket that the 2026-06-02 probes showed recovers over minutes-to-hours, not instantly. Unattended, the schedule keeps re-pressuring the source.

## Live evidence basis

This reuses the throttle model already established for `add-connector-adaptive-lanes` (see that change's `design.md` → Live Evidence): the ChatGPT detail throttle is **per-account and time-varying**, with no `Retry-After` on bare 429s, recovering over minutes-to-hours (38% → 67% → 20% across cooldown probes; fully cold later the same day). The only honest cross-run signal available offline is the durable pending-gap set itself and how many recovery attempts those gaps have survived. No new live run is required to land this change; the governor is proven deterministically.

## Approach

A second governor, **orthogonal to failure back-off**, modeled on the existing back-off module and the existing `hasUnresolvedAttention` durable-probe pattern.

- **Pure module** `reference-implementation/runtime/scheduler-source-pressure-cooldown.ts`: `computeSourcePressureCooldown(pendingPressureGaps, baseIntervalMs, lastRunAtMs, options)` returns a `cooldownApplied` / `effectiveIntervalMs` / `nextRunAt` / `recommendedHealthState: "cooling_off"` / `identity` decision. No I/O, no timers — mirrors `scheduler-backoff.ts`.
- **Durable signal**: pending gaps come from the existing `connector_detail_gaps` store (the same store the runtime hydrates at run START to replay gaps). No new table/column/migration.
- **Dispatch wiring**: an injected async probe `getSourcePressureGaps(connectorId, connectorInstanceId)` (default `() => []`) mirrors `hasUnresolvedAttention`. In `evaluateBackoffDispatch` the cooldown and failure back-off are combined conservatively: the run is eligible only when *both* intervals have elapsed (whichever defers further wins), and one cooling-off skip is emitted per pressure identity (deduped, re-armed when the picture changes, cleared when pressure recovers). Manual `runNow` bypasses the whole evaluator, so `Sync now` is unaffected.
- **Projection wiring**: `controller.ts` reads the same pending gaps into `ScheduleHistoryFacts.pendingPressureGaps` and `buildSchedulerBackoffApi` blends the cooldown into the existing `SchedulerBackoffApi` (`recommended_health_state`, `next_run_at`, `reason_class: "source_pressure"`). The dashboard's existing `cooling_off` pill renders honestly without a new UI field.

### Decay / cap policy

- Multiplier = `2^min(maxAttemptCount, MAX_COOLDOWN_EXP)`, floored at `MIN_MULTIPLIER` (1× base), capped at `MAX_COOLDOWN_MS` (6h).
- `attemptCount` is the gaps' durable recovery-attempt count (incremented when the runtime re-attempts a gap). Fresh pressure (attempt 0) waits ≥ 1 base interval; each unrecovered run doubles the wait.
- 6h cap is above the observed per-account recovery curve but below the failure-back-off 24h cap, so even persistent pressure is retried a few times a day to pick up recovery without owner action.
- A connector/runtime-authored `next_attempt_after` on a gap is honored as a floor when it pushes the next run out further (e.g. a future `Retry-After`-derived wait).

### Reset / relax

The cooldown is derived live from the *current* pending pressure set, not a sticky counter. When a run recovers the gaps (marks them `recovered`), the next probe returns no pressure gaps → `cooldownApplied: false` → the connection becomes eligible and the projection drops `cooling_off`. There is no separate clear step to get wrong.

## Connector-agnostic by construction, ChatGPT-scoped in effect

The governor is intentionally **connector-agnostic**: any connector that records `upstream_pressure` / `rate_limited` detail gaps gets the same protection. It is gated purely on gap *reason*, not connector id. Today ChatGPT is the only connector that emits those reasons, so in practice only ChatGPT is affected — but no ChatGPT-specific branch exists in the scheduler, which keeps the policy honest and reusable. Connectors with no source-pressure gaps (the common case) compute an empty pressure set and are never throttled. This is the connector-agnostic-with-justification answer to acceptance check 4.

## Fail-open

Both the dispatch probe and the projection read treat a store error as "no pressure" (empty list), the same stance as `hasUnresolvedAttention`. An unreadable gap store must never silently pause a schedule or erase honest history facts — a visible freshness gap is strictly preferable to an invisible pause.

## Alternatives considered

### Count `succeeded`-with-pending-gaps as a failure for back-off

Rejected. It would conflate two distinct states (a clean-but-deferred run vs. an actually-failed run), corrupt the failure-streak semantics other connectors rely on, and reuse the failure 24h cap and `blocked` promotion that are wrong for recoverable source pressure.

### Put the cooldown inside the connector / adaptive lane

Rejected. The lane is intra-run; it cannot defer the *next scheduled dispatch*. Cross-run cadence is a scheduler concern by definition.

### A new durable progress ledger / cooldown table

Rejected (and explicitly out of scope). The pending-gap set in `connector_detail_gaps` is already the durable cross-run record; the cooldown is a pure function of it. No new persistence is warranted.

## Acceptance checks

- A scheduled connection with pending `upstream_pressure` / `rate_limited` gaps is not immediately due; it cools off. (scheduler-gate + pure tests)
- The next attempt time grows as pressure persists. (pure + projection tests)
- A recovered/clean run clears the cooldown — never stuck. (scheduler-gate + projection tests)
- Non-pressure connectors / gap reasons are not throttled. (scheduler-gate + projection + pure tests)
- The projection surfaces `cooling_off` + deferred `next_run_at` (not bare green). (projection tests)
- `openspec validate add-schedule-source-pressure-cooldown --strict` passes.

## Deferred / out of scope

- Raising ChatGPT concurrency above serial (owned by `add-connector-adaptive-lanes`).
- Distributed/multi-worker cooldown coordination (single-process reference target, same deferral as adaptive lanes).
- A first-class `_ref` timeline event type for cooldown decisions; the one-shot skip record + `cooling_off` projection is sufficient for now.
