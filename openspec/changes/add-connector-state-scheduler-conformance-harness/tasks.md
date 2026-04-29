## 1. Inventory

- [ ] 1.1 Inventory current connector-state helper functions, SQL queries, and tests.
- [ ] 1.2 Inventory current schedule and active-run controller functions, SQL queries, and tests.
- [ ] 1.3 Identify which persistence obligations already have route/controller coverage and which need conformance scenarios.
- [ ] 1.4 Decide and document any scenario deferrals where behavior is only safe to test through controller routes today.

## 2. Harness

- [ ] 2.1 Add a test-only conformance harness under `reference-implementation/test/helpers/**`.
- [ ] 2.2 Keep the harness API semantic and narrow; do not expose raw SQL, table names, or a generic repository.
- [ ] 2.3 Add connector-state scenarios for owner-scoped upsert/list, overwrite behavior, grant isolation, and allowed-stream enforcement where feasible.
- [ ] 2.4 Add schedule scenarios for create/update/list/pause/resume/delete behavior where feasible.
- [ ] 2.5 Add active-run scenarios for one-active-run-per-connector, unique run id, lookup/delete, and restart cleanup where feasible.

## 3. Drivers And Falsifiability

- [ ] 3.1 Add a SQLite-backed driver that exercises current reference implementation behavior without production code changes where possible.
- [ ] 3.2 Add a deliberately broken driver or negative proof proving the harness fails on at least one real state/schedule/active-run invariant.
- [ ] 3.3 Keep all existing controller/scheduler/state tests; do not delete route-level evidence.

## 4. Validation

- [ ] 4.1 Run the connector-state/scheduler conformance tests.
- [ ] 4.2 Run nearby existing tests such as `control-actions.test.js`, relevant `pdpp.test.js` state slices, `scheduler.test.js`, or `run-interaction-control.test.js` as appropriate.
- [ ] 4.3 Run `pnpm --filter pdpp-reference-implementation typecheck`.
- [ ] 4.4 Run `pnpm --filter pdpp-reference-implementation check`.
- [ ] 4.5 Run `openspec validate add-connector-state-scheduler-conformance-harness --strict`.
- [ ] 4.6 Run `openspec validate --all --strict`.
- [ ] 4.7 Run `pnpm workstreams:status -- --no-fail` before owner review/merge.
