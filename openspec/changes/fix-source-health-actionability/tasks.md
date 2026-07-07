## 1. Server Verdicts

- [x] 1.1 Make historical recovered gaps unable to force passive deferred progress after a later failed/backed-off run.
- [x] 1.2 Emit owner retry action for failed/backed-off owner-runnable resumable sources.
- [x] 1.3 Preserve passive wait for active work, source-pressure cooldown, and system-managed recovery.
- [x] 1.4 Ensure active-run evidence participates in source health even when schedule metadata is stale or absent.
- [x] 1.5 Classify `assistance_timed_out` run gaps as owner/session-recoverable,
      not terminal maintainer code-fix gaps.

## 2. Console Actionability

- [x] 2.1 Prevent non-owner wait actions from hiding the owner-run primary action on detail pages when no active/system-managed work exists.
- [x] 2.2 Keep source list and detail page action derivation shared.

## 3. Verification

- [x] 3.1 Add regression tests for ChatGPT-like failed/backed-off deferred history.
- [x] 3.2 Add regression tests for Chase-like active-run visibility.
- [x] 3.3 Run targeted reference and console health/actionability tests.
- [x] 3.4 Add a classifier regression for assistance-timeout gaps.
- [ ] 3.5 Live audit the named source states after deploy.
