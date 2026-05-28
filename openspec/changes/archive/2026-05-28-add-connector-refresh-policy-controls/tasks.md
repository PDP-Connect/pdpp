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

- [x] Extend schedule projections with recommended policy, effective mode, last success, last attempt, active run, and human-attention state. (`effective_mode` reflects what the reference will actually do — `automatic` for enabled schedules, `paused` when disabled or needs-human; `recommended_policy` carries the policy hint separately. `next_due_at` deferred.)
- [x] Preserve owner-only mutation posture for schedule changes. (`/_ref/*` schedule mutations require the owner session middleware.)
- [x] Add policy-aware validation warnings when an owner schedules below the recommended minimum interval. (`upsertSchedule` returns `policy_warning`; HTTP response includes it; dashboard surfaces as toast. Never rejects.)
- [x] Add scheduler behavior for interaction-required background runs: automatic run triggers `markNeedsHuman`; subsequent automatic ticks suppress to one skip record then go silent until owner clears flag via manual run.
- [x] Add explicit skip/delay history for policy decisions. (One `needs_human_attention` skip record emitted per human-attention cycle; `single_use grant already consumed` skip record for exhausted grants.)

## 4. Dashboard UX

- [x] Build a connector schedule list view with connector, recommended mode, current schedule, last success, active run, and action controls. (`/dashboard/schedules` page with scheduled/unscheduled sections, needs-human banner.)
- [x] Add edit controls for paused and interval schedules. (Pause/Resume/Delete + inline interval/jitter editor.)
- [x] Show connector rationale and friction warnings before saving aggressive schedules. (Pre-save friction callout for `otp_likely`, `manual_action_likely`, `credentials` postures; `policy_warning` toast on save.)
- [x] Link active/running/needs-input rows to run detail. (Active-run link to `/dashboard/runs/:runId`; needs-human badge.)
- [x] Make the view auto-refresh or poll while runs are active. (`SchedulesPoller` polls `router.refresh()` every 3s when `hasActiveRun`.)
- [x] Add `/sandbox/schedules` read-only page so mock-owner nav link is not a 404.

## 5. Connector Defaults

- [x] Classify first-party connectors by refresh posture: frequent automatic, moderate automatic, daily automatic, manual-by-default, paused/unsupported. (See `design-notes/2026-04-26-first-party-refresh-defaults.md`. Locked in CI by `reference-implementation/test/polyfill-refresh-defaults.test.js`.)
- [x] Add todo entries for connectors whose live behavior contradicts their recommended policy. (Captured in the "Live-behavior contradictions" section of `design-notes/2026-04-26-first-party-refresh-defaults.md`. No first-party manifest needs a posture flip today: Chase / ChatGPT / USAA evidence is messaging/transport/capability, not policy.)
- [x] Include progress-reporting improvements for connectors where the dashboard cannot explain run progress well enough. (Captured in the "Progress-reporting gaps" section of `design-notes/2026-04-26-first-party-refresh-defaults.md` — concrete targets: Slack, YNAB, Chase, Gmail, ChatGPT/Anthropic browser-scrape group, Claude Code/Codex.)

## 6. Protocol Candidate Handling

- [x] Document `refresh_policy` as reference/polyfill metadata only. (`specs/polyfill-runtime/spec.md` plus inline comment in the validator.)
- [x] If any part needs portable cross-implementation semantics, record it as a candidate for Collection Profile or companion-spec review. (Captured in `specs/polyfill-runtime/spec.md` final scenario and the audit note.)
- [x] Do not present schedule policy hints as finalized PDPP core protocol.

## 7. Validation

- [x] Run schedule lifecycle tests. (`test/control-actions.test.js` — schedule lifecycle, policy_warning, 19 tests pass.)
- [x] Run scheduler retry/backoff/overlap tests. (`test/scheduler.test.js` — 23 tests pass, including needs-human skip/suppression and interaction-triggered mark.)
- [x] Run manifest validation tests. (`test/manifest-refresh-policy.test.js` — 13 tests pass; `test/query-contract.test.js` 40 tests pass against seeded manifests.)
- [x] Run apps/web typecheck, check, and build. (All pass; build generates 247 static pages.)
- [x] Run `openspec validate add-connector-refresh-policy-controls --strict`.
- [x] Run `openspec validate --all --strict`.

> Section 5 is now closed: first-party refresh-posture classification is documented in `design-notes/2026-04-26-first-party-refresh-defaults.md` and locked by `reference-implementation/test/polyfill-refresh-defaults.test.js` (4 tests). Live-behavior contradictions and connector progress-reporting gaps are captured as durable todos in that design note. Follow-up implementation work (Slack/YNAB/Chase/Gmail progress emission; Chase `stream_skipped` messaging; ChatGPT host browser bridge; USAA transport debugging) belongs to later tranches and is not part of this change.
