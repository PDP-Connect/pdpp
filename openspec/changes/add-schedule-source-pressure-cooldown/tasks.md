# Tasks — add-schedule-source-pressure-cooldown

## 1. Pure cooldown module

- [x] Add `reference-implementation/runtime/scheduler-source-pressure-cooldown.ts` with `computeSourcePressureCooldown(pendingPressureGaps, baseIntervalMs, lastRunAtMs, options)` returning `{ cooldownApplied, effectiveIntervalMs, nextRunAt, identity, maxAttemptCount, pendingPressureGapCount, recommendedHealthState }`.
- [x] Gate on source-pressure reasons only (`SOURCE_PRESSURE_GAP_REASONS` = `upstream_pressure`, `rate_limited`); ignore all other gap reasons.
- [x] Decaying/exponential multiplier `2^min(attempt, MAX_COOLDOWN_EXP)`, floored at `MIN_MULTIPLIER`, capped at `MAX_COOLDOWN_MS` (6h); honor a later `next_attempt_after` floor.
- [x] Manual bypass; robust to malformed timing/attempt inputs.

## 2. Scheduler dispatch wiring

- [x] Add an injected async `getSourcePressureGaps` probe to `SchedulerOptions` (default `() => []`), failure-safe (a throw is treated as no pressure).
- [x] In `evaluateBackoffDispatch`, combine the cooldown with failure back-off: eligible only when both intervals have elapsed; whichever defers further wins.
- [x] Emit one cooling-off skip per pressure identity (deduped via `notifiedCooldownIdentity`, re-armed on change, cleared on recovery); suppress the cooldown skip when a back-off skip already fired this tick.
- [x] Keep manual `runNow` bypassing the cooldown (it bypasses the evaluator entirely).

## 3. Projection honesty

- [x] Read pending source-pressure gaps into `ScheduleHistoryFacts.pendingPressureGaps` in `loadScheduleHistoryIndex` via the durable detail-gap store (bounded, fail-open).
- [x] Blend the cooldown into `buildSchedulerBackoffApi` so the schedule projection surfaces `cooling_off` + deferred `next_run_at` (`reason_class: "source_pressure"`) instead of bare green, without inventing a new UI field.
- [x] Never downgrade a `blocked` failure state; surface `cooling_off` when either governor is cooling.

## 4. Production probe

- [x] Wire the real `getSourcePressureGaps` probe in `reference-implementation/server/index.js` `createScheduler(...)`, reading `connector_detail_gaps` (reason-filtered, per-connection, bounded, fail-open).

## 5. Tests

- [x] Pure-function tests: engage/decay/cap, recovery clears, non-pressure ignored, `next_attempt_after` floor, manual bypass, robustness, pinned constants.
- [x] Scheduler-gate suppression tests: cooling-off one-skip-per-identity + no spawn, re-arm on change, recovery → eligible again, no cross-connection bleed, probe-failure fail-open.
- [x] Projection tests: pending pressure → `cooling_off` + deferred `next_run_at`; no pressure → not throttled; non-pressure reasons → not throttled; growth with persistence.

## 6. Validation

- [x] `pnpm --dir reference-implementation typecheck` (`tsc --noEmit`).
- [x] Targeted tests: scheduler, scheduler-backoff, attention-suppression, cooldown (pure + gate), cooldown projection, connection-health, owner-connection-schedule.
- [x] Biome check clean on changed reference-implementation files.
- [x] `openspec validate add-schedule-source-pressure-cooldown --strict`.

## 7. Follow-up gate (owner-only)

- [ ] One owner-attended, cold-start ChatGPT scheduled-cadence observation: enable a schedule, let one run record pressure gaps, confirm the next automatic tick defers (cooling-off skip + deferred `next_run_at`) and that a later clean/recovered run resumes the normal cadence. Owner-only live action; the governor behavior is proven deterministically by the tests above.
