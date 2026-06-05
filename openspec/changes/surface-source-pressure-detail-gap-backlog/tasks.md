# Tasks — surface-source-pressure-detail-gap-backlog

This is a design/spec lane. No implementation code is changed here. The tasks
below sequence the bounded implementation lanes the owner can dispatch after the
spec delta is accepted. None are marked complete because no code has landed.

## 1. Spec delta (this lane)

- [x] Add the `reference-connection-health` requirements for the additive,
  nullable source-pressure detail-gap backlog rollup, its decomplection /
  non-secret / owner-only constraints, and the console catch-up cue.
- [x] Confirm no overlap with `add-schedule-source-pressure-cooldown` (governs
  *dispatch* + `cooling_off`) or `define-connector-progress-evidence-contract`
  (governs *per-run* per-stream facts); this rollup is the *cross-run* retained
  backlog on the connection-health snapshot.
- [x] `openspec validate surface-source-pressure-detail-gap-backlog --strict`.
- [x] `openspec validate --all --strict`.
- [x] `git diff --check`.

## 2. Projection (implementation lane — not in this spec lane)

- [ ] Add a nullable `detail_gap_backlog` rollup field to
  `ConnectionHealthSnapshot`
  (`reference-implementation/runtime/connection-health.ts`):
  `{ pending: number; recovered: number | null; max_attempt_count: number;
  next_attempt_at: string | null } | null`.
- [ ] Project it from the existing `getSourcePressureGaps` probe
  (`reference-implementation/server/index.js`) /
  `computeSourcePressureCooldown` figures (`pendingPressureGapCount`,
  `maxAttemptCount`, `nextRunAt`) wired through the connection-health input
  evidence, for all connectors — not only scheduled ones.
- [ ] `null` when the durable gap evidence is unreadable (fail-open, mirroring the
  cooldown probe); real `0` when drained; never inferred from record counts.
- [ ] (Optional, same lane or follow-up) add a bounded reason-scoped
  count-by-status aggregate to the detail-gap store for the recovered count;
  leave `recovered` `null` until then.
- [ ] Make the pending count honest about the read bound (exact total or a
  bound-aware floor; resolve the bounded-probe decision recorded in `design.md`).

## 3. Contract tests (implementation lane)

- [ ] The rollup is additive and nullable; `null` (unreadable) is distinct from a
  drained `0`.
- [ ] Pending is reason-scoped to source pressure and never inferred from
  collected record counts.
- [ ] `recovered` is `null` when not computed.
- [ ] The rollup does not change the headline state, coverage axis, freshness
  axis, forward disposition, or `next_action`.
- [ ] The rollup is exposed for a manual-refresh connector that never reaches
  `cooling_off`.
- [ ] The rollup carries no body/locator/payload/source name/secret and is not
  exposed to grant-scoped clients.

## 4. Console consumption (implementation lane — depends on §2)

- [ ] Render a compact catch-up cue ("Catching up: N pending" + "K recovered"
  when present) only on a source-pressure / retryable-gap connection with a
  positive pending count, keyed on the `source_pressure` reason class.
- [ ] No cue on `null` (unmeasured), `0` (drained), healthy, idle, or
  non-source-pressure connections.
- [ ] No raw `source_pressure` token in owner-facing copy; no connector name.
- [ ] Console snapshot/voice tests for the cue and for the quiet cases.

## 5. Owner closeout

- [ ] Owner-only live verification that the rollup matches the live
  `connector_detail_gaps` aggregate for a connection with a real backlog (e.g.
  the ChatGPT `messages` backlog), recorded as a residual risk if it is the only
  remaining step.
- [ ] File the deferred design note (per-gap ledger / bulk-import / automatic
  background catch-up) captured in `design.md`.
- [ ] Archive this change once the projection + tests + console land and the spec
  delta is folded into `reference-connection-health`.
