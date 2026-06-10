# Tasks: add manual-connector freshness advisory

## 1. Classifier refresh-policy input

- [x] 1.1 Add `ConnectionRefreshEvidence { backgroundSafe: boolean | null; recommendedMode: "automatic" | "manual" | null }` and an optional `refresh` field on `ComputeConnectionHealthInput` in `reference-implementation/runtime/connection-health.ts`.
- [x] 1.2 Add `isManualRefreshOnly(refresh)` returning `true` when `backgroundSafe === false` OR `recommendedMode === "manual"`; absent/`null` evidence returns `false` (treated as schedulable).
- [x] 1.3 Add the `stale_manual_refresh` reason to `CONNECTION_CONDITION_REASONS`.

## 2. Manual-aware freshness + classification

- [x] 2.1 In `freshCondition`, when the connector is manual-refresh-only and freshness is `stale`, emit `Fresh=false` at `info` severity, reason `stale_manual_refresh`, with a manual-refresh remediation (`retry_by_runtime`, target `run`). Schedulable connectors keep the `warning`/`stale` condition.
- [x] 2.2 Add an ordered step `classifyManualStaleAdvisory` (after `classifyDegradedEvidence`/`classifyCurrentEvidenceWithoutVerdict`, before `classifyNeverRunIdle`) that returns `idle` with reason `stale_manual_refresh` only when the connector is manual-refresh-only, the stale `Fresh` carries the `stale_manual_refresh` marker, and both `CollectionSucceeded` and `SourceCoverageComplete` are `true`.
- [x] 2.3 Make `pickDominantConditionId` for `idle` prefer the manual-stale `Fresh` condition so the surface explains why the connection is idle (vs the paused-schedule `ScheduleEligible` condition).

## 3. Caller wiring (manifest refresh_policy → evidence)

- [x] 3.1 Add `buildRefreshEvidence(refreshPolicy)` to `reference-implementation/server/ref-control.ts`, reading `background_safe` / `recommended_mode` from the raw manifest policy; `null` when absent/malformed.
- [x] 3.2 Add an optional `refreshPolicy` input to `projectConnectorSummaryConnectionHealth` and pass `refresh: buildRefreshEvidence(input.refreshPolicy)` into `computeConnectionHealth`.
- [x] 3.3 Thread the already-in-scope `refreshPolicy` at both call sites: `listConnectorSummaries` and `getConnectorDetail`.

## 4. Spec + tests

- [x] 4.1 Add this change's `reference-connection-health` spec delta: extend "Scheduler Policy SHALL Be Separate From Data Health" to cover auto-schedulability, and add the manual-connector stale-freshness advisory requirement.
- [x] 4.2 Unit tests in `connection-health.test.js`: manual complete/succeeded/stale → idle advisory (not degraded); either flag alone is sufficient; local-device verdict also satisfies it; schedulable connector with same evidence still degrades; manual incomplete-coverage / terminal-gap / failed-run / stalled-outbox / open-attention still degrade or block; manual fresh still healthy; never-run manual stale stays never-run idle (not advisory).
- [x] 4.3 Caller-level tests in `connection-health-acceptance.test.js`: a Reddit-shaped raw `refreshPolicy` (manual + background_safe:false) drives the idle advisory end-to-end; schedulable policy degrades; no policy degrades; incomplete/failed still degrade.

## Acceptance checks

- `node --test --import tsx reference-implementation/test/connection-health.test.js reference-implementation/test/connection-health-acceptance.test.js reference-implementation/test/ref-connectors-local-coverage-green.test.js` — all pass.
- `npx tsc --noEmit` (reference-implementation) — no errors.
- `openspec validate add-manual-connector-freshness-advisory --strict` — passes.
- `git diff --check` — clean.
