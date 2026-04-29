## 1. Inventory

- [x] 1.1 Inventory current connector-state helper functions, SQL queries, and tests.
- [x] 1.2 Inventory current schedule and active-run controller functions, SQL queries, and tests.
- [x] 1.3 Identify which persistence obligations already have route/controller coverage and which need conformance scenarios.
- [x] 1.4 Decide and document any scenario deferrals where behavior is only safe to test through controller routes today. (Deferrals captured in `helpers/connector-state-scheduler-conformance.js` foot comment: manifest-stream membership, grant-scope rejection, schedule input validation, `minimum_interval_warning` policy, active-run interaction projection — all remain covered by existing route/controller tests.)

## 2. Harness

- [x] 2.1 Add a test-only conformance harness under `reference-implementation/test/helpers/**`.
- [x] 2.2 Keep the harness API semantic and narrow; do not expose raw SQL, table names, or a generic repository.
- [x] 2.3 Add connector-state scenarios for owner-scoped upsert/list, overwrite behavior, grant isolation, and allowed-stream enforcement where feasible. (Allowed-stream enforcement covered as the *read-side narrowing* the helper actually performs; pre-write rejection deferred to route tests.)
- [x] 2.4 Add schedule scenarios for create/update/list/pause/resume/delete behavior where feasible.
- [x] 2.5 Add active-run scenarios for one-active-run-per-connector, unique run id (across connectors), lookup/delete, and restart cleanup where feasible. (Active-run insert reaches the persistence seam through the registered `controllerUpsertActiveRun` query because the controller has no public insert seam without spawning a real run; that coupling is bounded inside the SQLite driver and the harness scenarios stay lifecycle-shaped. The `run_id UNIQUE` constraint on `controller_active_runs` is pinned by the cross-connector duplicate-run_id scenario, which the SQLite driver satisfies by throwing on the second insert.)

## 3. Drivers And Falsifiability

- [x] 3.1 Add a SQLite-backed driver that exercises current reference implementation behavior without production code changes where possible.
- [x] 3.2 Add a deliberately broken driver or negative proof proving the harness fails on at least one real state/schedule/active-run invariant. (Broken driver violates one invariant per area: state ignores `grantId`, schedule appends instead of upserting, active-run permits duplicates per connector, restart is a no-op. Falsifiability test asserts at least one failure in each area.)
- [x] 3.3 Keep all existing controller/scheduler/state tests; do not delete route-level evidence.

## 4. Validation

- [x] 4.1 Run the connector-state/scheduler conformance tests. (16/16 SQLite scenarios pass; falsifiability test asserts state, schedule, and active-run failures in the broken driver.)
- [x] 4.2 Run nearby existing tests such as `control-actions.test.js`, relevant `pdpp.test.js` state slices, `scheduler.test.js`, or `run-interaction-control.test.js` as appropriate. (`control-actions.test.js`, `scheduler.test.js`, `run-interaction-control.test.js` all green: 51/51.)
- [x] 4.3 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [x] 4.4 Run `pnpm --filter pdpp-reference-implementation check`.
- [x] 4.5 Run `openspec validate add-connector-state-scheduler-conformance-harness --strict`.
- [x] 4.6 Run `openspec validate --all --strict`.
- [ ] 4.7 Run `pnpm workstreams:status -- --no-fail` before owner review/merge.
