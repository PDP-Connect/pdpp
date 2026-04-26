## 1. Audit Current Runtime

- [ ] Inventory current schedule routes, controller persistence, dashboard controls, scheduler loop, retry policy, and run interaction behavior.
- [ ] Confirm which schedule behavior is already shipped versus only specified by `add-reference-runtime-spec`.
- [ ] Identify baseline tests that cover schedule lifecycle and scheduler retry behavior.

## 2. Manifest Refresh Policy

- [ ] Add validation for `capabilities.refresh_policy`.
- [ ] Seed first-party polyfill manifests with conservative refresh policies and owner-readable rationale.
- [ ] Include policy hints for high-friction browser/bank connectors, API-token connectors, local-file connectors, and low-risk communication connectors.
- [ ] Add manifest regression tests for valid/invalid refresh policies.

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

- [ ] Document `refresh_policy` as reference/polyfill metadata only.
- [ ] If any part needs portable cross-implementation semantics, record it as a candidate for Collection Profile or companion-spec review.
- [ ] Do not present schedule policy hints as finalized PDPP core protocol.

## 7. Validation

- [ ] Run schedule lifecycle tests.
- [ ] Run scheduler retry/backoff/overlap tests.
- [ ] Run manifest validation tests.
- [ ] Run apps/web typecheck, check, and build.
- [ ] Run `openspec validate add-connector-refresh-policy-controls --strict`.
- [ ] Run `openspec validate --all --strict`.
