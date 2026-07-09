## 1. Server Verdicts

- [x] 1.1 Make historical recovered gaps unable to force passive deferred progress after a later failed/backed-off run.
- [x] 1.2 Emit owner retry action for failed/backed-off owner-runnable resumable sources.
- [x] 1.3 Preserve passive wait for active work, source-pressure cooldown, and system-managed recovery.
- [x] 1.4 Ensure active-run evidence participates in source health even when schedule metadata is stale or absent.
- [x] 1.5 Classify `assistance_timed_out` run gaps as owner/session-recoverable,
      not terminal maintainer code-fix gaps.
- [x] 1.6 Emit an owner retry action for idle sources with retryable coverage
      gaps unless active progress, source-pressure, scheduled retry, or
      cooldown evidence proves the system is already handling the work.
- [x] 1.7 Fix the `retryable_gap` coverage condition's remediation label
      ("Wait for detail-gap retry") that contradicted the owner-runnable
      Retry/Refresh now CTA rendered next to it; match the "Run the
      connector ..." phrasing already used by every other `retry_by_runtime`
      remediation in this file.

## 2. Console Actionability

- [x] 2.1 Prevent non-owner wait actions from hiding the owner-run primary action on detail pages when no active/system-managed work exists.
- [x] 2.2 Keep source list and detail page action derivation shared.

## 3. Verification

- [x] 3.1 Add regression tests for ChatGPT-like failed/backed-off deferred history.
- [x] 3.2 Add regression tests for Chase-like active-run visibility.
- [x] 3.3 Run targeted reference and console health/actionability tests.
- [x] 3.4 Add a classifier regression for assistance-timeout gaps.
- [x] 3.5 Add a rendered-verdict regression for idle retryable assisted gaps
      so they cannot fall through to passive "Collecting" copy.
- [ ] 3.6 Live audit the named source states after deploy.
- [x] 3.7 Stop rendering a green `Healthy` pill for idle-with-prior-success,
      stale, paused-schedule, or `owner_refresh_due` connections; render
      `amber`/`advisory` instead, distinguished from a genuinely never-run
      idle connection via `last_success_at`.
- [x] 3.8 Add regression tests for stale-manual/`owner_refresh_due`,
      paused-with-fresh-data, and never-run-idle tone cases in
      `rendered-verdict.test.js` and `owner-verdict-wire.test.js`.
- [x] 3.9 Split the amber label: add `VerdictLabel: "Needs refresh"` for
      idle-with-prior-success/stale/`owner_refresh_due` (not-actually-broken)
      cases, distinct from `Degraded` (real coverage/attention/outbox trouble
      or a broken state/disposition such as `resumable`/`awaiting_owner`).
- [x] 3.10 Add regression tests proving Chase-shaped (`resumable`/
      `retryable_gap`), USAA-shaped (`awaiting_owner`/attention-open),
      terminal, and `degraded`-state cases still render `Degraded`/`Can't
      collect`, not `Needs refresh`.
- [x] 3.11 Fix the console copy bridge (`source-actionability.ts`
      `sourceIssueStatus`/`sourceWorkItemFromConnector`) so a server pill
      label `Needs refresh` produces `"needs a refresh"` copy and routes to
      the `review` group ("Available actions"), not `"is degraded"` copy
      under `systemIssue` ("System or connector issue" / "no account action
      is needed from you") — that group's copy is false for a paused-schedule
      or stale-manual connection the owner can resume/refresh. Keyed off
      `pill.label`, not `tone`, so `Degraded` (real trouble) is unaffected.
- [x] 3.12 Add console regression tests (`source-actionability.test.ts`)
      proving `Needs refresh` routes to `review` with `"needs a refresh"`
      copy and excludes the needs-you headline count, while `Degraded`
      (same no-owner-action shape) still routes to `systemIssue` with
      `"is degraded"` copy.
