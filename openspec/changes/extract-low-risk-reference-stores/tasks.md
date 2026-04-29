## 1. Consent and owner-device stores

- [x] 1.1 Inventory current pending-consent and owner-device storage functions and route call sites.
- [x] 1.2 Define production `ConsentStore` and `OwnerDeviceAuthStore` interfaces with semantic method names.
- [x] 1.3 Implement SQLite-backed stores without exposing raw DB handles to callers.
- [x] 1.4 Migrate current auth/device routes to use the stores without behavior changes.
- [x] 1.5 Add production-store-backed conformance tests for the existing consent/device-auth harness.
- [x] 1.6 Run relevant auth/device route tests, conformance tests, typecheck, and check.

## 2. Connector state and scheduler stores

- [x] 2.1 Inventory current connector-state, schedule, and active-run storage functions and controller call sites.
- [x] 2.2 Define production `ConnectorStateStore` and `SchedulerStore` interfaces with semantic method names.
- [x] 2.3 Implement SQLite-backed stores without exposing raw DB handles to callers.
- [x] 2.4 Migrate current controller/runtime paths to use the stores without behavior changes.
- [x] 2.5 Add production-store-backed conformance tests for the existing connector-state/scheduler harness.
- [x] 2.6 Run relevant controller/scheduler route tests, conformance tests, typecheck, and check.

## 3. Consolidated owner review

- [x] 3.1 Rebase both lanes onto current `main` and resolve conflicts.
- [x] 3.2 Review all diffs against `design.md` stop conditions.
- [x] 3.3 Run combined conformance suites for consent/device-auth and connector-state/scheduler.
- [x] 3.4 Run nearby route/controller tests and reference typecheck/check.
- [x] 3.5 Run `openspec validate extract-low-risk-reference-stores --strict`.
- [x] 3.6 Run `openspec validate --all --strict`.
- [x] 3.7 Run `pnpm workstreams:status` and reconcile any risks before merge/push.
