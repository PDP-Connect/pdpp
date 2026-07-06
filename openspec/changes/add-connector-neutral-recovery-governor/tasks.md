## 1. Runtime Recovery Governor

- [ ] 1.1 Add pure recovery-decision helpers that classify queued detail gaps by reason, attempt metadata, next eligible time, and provider work domain.
- [ ] 1.2 Add tests proving run-cap and retry-budget deferrals remain non-source-pressure recovery work.
- [ ] 1.3 Add tests proving provider-pressure gaps block ordinary manual retry until the next eligible time.
- [ ] 1.4 Add tests proving unrelated provider work domains do not block each other.
- [ ] 1.5 Add the standing starvation invariant test: an active source-pressure cooldown must not make non-pressure queued recovery ineligible, and stale pressure rows without fresh evidence must not re-arm cooldown (regression shape: the live 51-holds-942 ChatGPT residue).
- [ ] 1.6 Add per-item quarantine helpers and tests: poison item reaches its per-item threshold, is quarantined with evidence and a terminal class, remains visible in accounting, and siblings keep draining.

## 2. Recovery Execution Integration

- [ ] 2.1 Thread the recovery admission decision into the runtime path that serves `DETAIL_GAPS_PAGE_REQUEST` pages.
- [ ] 2.2 Ensure recovery pages preserve attempt metadata and provider-budget state across pages within one run.
- [ ] 2.3 Wire ordinary owner-started retry/refresh through the same recovery admission gate, excluding only explicit force/debug paths.
- [ ] 2.4 Add regression coverage that repeated owner clicks cannot bypass a provider-pressure cooldown.
- [ ] 2.5 Add idempotency and crash-accounting coverage: re-attempt after an interrupted attempt does not duplicate records; interrupted attempts count and repeated interruption escalates to connector/system issue.
- [ ] 2.6 Record admission decisions (outcome, reason class, next eligible time, forced flag) and expose them to owner-only diagnostics; test that a denial can answer "why didn't it run".
- [ ] 2.7 Wire the stall watchdog: eligible work with no attempt beyond the cadence window becomes an observable system condition; test that it observes without force-admitting.

## 3. Amazon Proof Connector

- [ ] 3.1 Move Amazon order-item detail recovery onto the connector-neutral recovery admission path.
- [ ] 3.2 Preserve Amazon's per-run detail-attempt cap as a run blast-radius limit, not as the cross-run recovery scheduler.
- [ ] 3.3 Classify Amazon detail failures into planned cap, transient DOM/no-progress, provider pressure, owner-required repair, or connector defect.
- [ ] 3.4 Add fixture-backed tests for repeated Amazon detail-page no-progress escalating to connector/system issue rather than owner retry busywork.

## 4. Connection Health And Actionability

- [ ] 4.1 Add typed recovery state to the rendered verdict or the connection-health projection consumed by owner surfaces.
- [ ] 4.2 Replace indefinite "Checking" projection paths with active-check, queued-recovery, cooldown, unknown-unmeasured, read-failure, or system-issue states.
- [ ] 4.3 Update shared source-actionability grouping so queued/cooling recovery is passive progress, eligible recovery is owner-runnable, and connector defects are system issues.
- [ ] 4.4 Add dashboard, Sources, Syncs, and source-detail tests proving group counts equal rendered rows and no inactive queued recovery row says "Checking".
- [ ] 4.5 Add stalled-recovery projection coverage: queued/catching-up carries recency evidence, and eligible work with no attempt beyond the cadence window renders as a system issue rather than indefinite passive progress.
- [ ] 4.6 Implement the source-row UI contract: one concrete primary sentence, one evidence line, and at most one primary action.
- [ ] 4.7 Add source-detail recovery panel view-model support for current step, progress counts, next eligible attempt, blocker, and recent non-secret evidence.
- [ ] 4.8 Add owner-surface tests proving active recovery names the work, such as "Syncing order details", instead of generic "Checking".
- [ ] 4.9 Add owner-surface tests proving unsafe retries show wait or blocker copy and no normal retry CTA.

## 5. Validation And Live Proof

- [ ] 5.1 Run `openspec validate add-connector-neutral-recovery-governor --strict`.
- [ ] 5.2 Run targeted runtime detail-gap, scheduler/manual-provider-safety, rendered-verdict, and console source-actionability tests.
- [ ] 5.3 Deploy from clean `main` after tests pass and no active run would be interrupted.
- [ ] 5.4 Run one supervised Amazon recovery batch and verify it recovers eligible work, respects any cooldown, and leaves the owner UI with typed recovery state rather than repeated retry instructions.
- [ ] 5.5 Verify the live ChatGPT residue (942 non-pressure gaps held by stale pressure rows) begins draining under the new eligibility rule without manual data cleanup, and keep that dataset as the regression proof.
