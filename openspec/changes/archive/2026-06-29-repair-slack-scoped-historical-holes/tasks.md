## 1. Spec

- [x] 1.1 Add an OpenSpec change for Slack scoped historical-hole repair.
- [x] 1.2 Validate the change with strict OpenSpec checks.

## 2. Implementation

- [x] 2.1 Preserve per-channel cursor filtering for normal unscoped Slack runs.
- [x] 2.2 Ignore saved message cursors for `messages.resources` scoped Slack repair runs.

## 3. Regression Tests

- [x] 3.1 Cover normal per-channel cursor behavior.
- [x] 3.2 Cover scoped archive rows older than `channel_last_ts`.

## 4. Acceptance Checks

- [x] 4.1 Run focused Slack runtime tests.
- [x] 4.2 Run `openspec validate repair-slack-scoped-historical-holes --strict`.
- [x] 4.3 Live-verify scoped archive keys are retained after deploy and repair rerun. (`docs/research/slack-coverage-live-verification-2026-06-29.md` records `archive_missing_retained=0`.)
