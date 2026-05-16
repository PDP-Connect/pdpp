## 1. Manifest Availability

- [x] 1.1 Add manifest schema support for stream availability metadata.
- [x] 1.2 Mark Slack `stars`, `user_groups`, `reminders`, and `dm_read_states` as unsupported in `slackdump_archive` mode.
- [x] 1.3 Add manifest reconciliation tests that keep Slack unavailable-stream declarations and connector safety-net skips in sync.

## 2. Gap Severity

- [x] 2.1 Add known-gap severity or reason-class normalization in runtime SKIP_RESULT handling.
- [x] 2.2 Map existing gap reasons to informational, transient, actionable, or recoverable classes.
- [x] 2.3 Treat unclassified historical gaps conservatively as actionable.

## 3. Health And Dashboard

- [x] 3.1 Update connector-health classification to use severity-aware gaps instead of `known_gaps.length > 0`.
- [x] 3.2 Update dashboard partial-coverage hints to ignore informational limitations for warning/yellow state.
- [x] 3.3 Preserve detail-view visibility for informational connector limitations.

## 4. Validation

- [x] 4.1 Add tests proving default Slack slackdump-mode status is healthy when only unsupported-in-mode streams are missing.
- [x] 4.2 Add tests proving an explicitly selected unavailable stream can still surface actionable coverage loss.
- [x] 4.3 Add tests proving transient/actionable gaps still degrade connector health.
- [x] 4.4 Run `openspec validate clarify-connector-capability-gap-severity --strict`.
