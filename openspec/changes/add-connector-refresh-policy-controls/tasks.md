## 1. Audit Current Runtime

- [x] Inventory current schedule routes, controller persistence, dashboard controls, scheduler loop, retry policy, and run interaction behavior. (See `design-notes/2026-04-25-current-state-audit.md`.)
- [x] Confirm which schedule behavior is already shipped versus only specified by `add-reference-runtime-spec`.
- [x] Identify baseline tests that cover schedule lifecycle and scheduler retry behavior. (`test/scheduler.test.js`, `test/control-actions.test.js`, `test/control-plane.test.js`, `test/run-interaction-control.test.js`.)

## 2. Manifest Refresh Policy

- [x] Add validation for `capabilities.refresh_policy`. (`reference-implementation/server/auth.js#validateRefreshPolicyCapability`, called from `validateConnectorManifest`.)
- [x] Seed first-party polyfill manifests with conservative refresh policies and owner-readable rationale. (31 manifests under `packages/polyfill-connectors/manifests/`.)
- [x] Include policy hints for high-friction browser/bank connectors, API-token connectors, local-file connectors, and low-risk communication connectors.
- [x] Add manifest regression tests for valid/invalid refresh policies. (`reference-implementation/test/manifest-refresh-policy.test.js`, 13 tests.)

## 3. Schedule Control Plane

- [ ] Extend schedule projections with recommended policy, effective mode, next due, last success, last attempt, active run, and human-attention state.
- [ ] Preserve owner-only mutation posture for schedule changes.
- [ ] Add policy-aware validation warnings when an owner schedules below the recommended minimum interval.
- [ ] Add scheduler behavior for interaction-required background runs: pause, mark needs-human, or skip next automatic attempt according to the chosen policy.
- [ ] Add explicit skip/delay history for policy decisions.

## 4. Dashboard UX

- [ ] Build a connector schedule list view with connector, freshness, recommended mode, current schedule, last success, active run, next due, and action controls.
- [ ] Add edit controls for manual, paused, and interval schedules.
- [ ] Show connector rationale and friction warnings before saving aggressive schedules.
- [ ] Link active/running/needs-input rows to run detail.
- [ ] Make the view auto-refresh or poll while runs are active.

## 5. Connector Defaults

- [ ] Classify first-party connectors by refresh posture: frequent automatic, moderate automatic, daily automatic, manual-by-default, paused/unsupported.
- [ ] Add todo entries for connectors whose live behavior contradicts their recommended policy.
- [ ] Include progress-reporting improvements for connectors where the dashboard cannot explain run progress well enough.

## 6. Protocol Candidate Handling

- [x] Document `refresh_policy` as reference/polyfill metadata only. (`specs/polyfill-runtime/spec.md` plus inline comment in the validator.)
- [x] If any part needs portable cross-implementation semantics, record it as a candidate for Collection Profile or companion-spec review. (Captured in `specs/polyfill-runtime/spec.md` final scenario and the audit note.)
- [x] Do not present schedule policy hints as finalized PDPP core protocol.

## 7. Validation

- [ ] Run schedule lifecycle tests.
- [x] Run scheduler retry/backoff/overlap tests. (`test/scheduler.test.js` — 21 tests pass on this branch.)
- [x] Run manifest validation tests. (`test/manifest-refresh-policy.test.js` — 13 tests pass; `test/query-contract.test.js` 40 tests pass against seeded manifests.)
- [ ] Run apps/web typecheck, check, and build.
- [x] Run `openspec validate add-connector-refresh-policy-controls --strict`.
- [x] Run `openspec validate --all --strict`.

> Sections 3 (schedule control plane), 4 (dashboard UX), 5 (connector defaults beyond policy seeding), and the schedule-lifecycle validation in section 7 are explicitly deferred to a later tranche per the task packet for `connector-refresh-policy-controls`. Apps/web checks are deferred because no apps/web code changed in this tranche.
