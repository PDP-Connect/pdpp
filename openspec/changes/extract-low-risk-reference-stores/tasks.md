## 1. Consent and owner-device stores

- [ ] 1.1 Inventory current pending-consent and owner-device storage functions and route call sites.
- [ ] 1.2 Define production `ConsentStore` and `OwnerDeviceAuthStore` interfaces with semantic method names.
- [ ] 1.3 Implement SQLite-backed stores without exposing raw DB handles to callers.
- [ ] 1.4 Migrate current auth/device routes to use the stores without behavior changes.
- [ ] 1.5 Add production-store-backed conformance tests for the existing consent/device-auth harness.
- [ ] 1.6 Run relevant auth/device route tests, conformance tests, typecheck, and check.

## 2. Connector state and scheduler stores

- [ ] 2.1 Inventory current connector-state, schedule, and active-run storage functions and controller call sites.
- [ ] 2.2 Define production `ConnectorStateStore` and `SchedulerStore` interfaces with semantic method names.
- [ ] 2.3 Implement SQLite-backed stores without exposing raw DB handles to callers.
- [ ] 2.4 Migrate current controller/runtime paths to use the stores without behavior changes.
- [ ] 2.5 Add production-store-backed conformance tests for the existing connector-state/scheduler harness.
- [ ] 2.6 Run relevant controller/scheduler route tests, conformance tests, typecheck, and check.

## 3. Consolidated owner review

- [ ] 3.1 Rebase both lanes onto current `main` and resolve conflicts.
- [ ] 3.2 Review all diffs against `design.md` stop conditions.
- [ ] 3.3 Run combined conformance suites for consent/device-auth and connector-state/scheduler.
- [ ] 3.4 Run nearby route/controller tests and reference typecheck/check.
- [ ] 3.5 Run `openspec validate extract-low-risk-reference-stores --strict`.
- [ ] 3.6 Run `openspec validate --all --strict`.
- [ ] 3.7 Run `pnpm workstreams:status` and reconcile any risks before merge/push.
