## 1. Contract And Tests

- [x] 1.1 Add dashboard summary fixtures for degraded, cooling-off, stalled-outbox, healthy, running, stale, and no-data connections.
- [x] 1.2 Add tests proving degraded/stalled cards affect an attention-visible summary bucket.
- [x] 1.3 Add tests proving unknown freshness is not counted as stale without a freshness policy.
- [x] 1.4 Add tests proving the connection count label matches its population.

## 2. Dashboard Implementation

- [x] 2.1 Update `records-list-view.tsx` summary counters to expose degraded/cooling-off/stalled work.
- [x] 2.2 Clarify the primary connection count copy or add a registered-total breakdown.
- [x] 2.3 Keep `Running` tied to actual active run/outbox activity and preserve the no-data partition.
- [x] 2.4 Review dashboard copy for operator voice and no hosted-service drift.

## 3. Validation

- [x] 3.1 Run targeted `apps/console` dashboard tests.
- [x] 3.2 Run `pnpm --dir apps/console run types:check`.
- [x] 3.3 Run `openspec validate align-dashboard-health-summary --strict`.
- [x] 3.4 Run `openspec validate --all --strict`.
- [x] 3.5 Run `git diff --check`.
