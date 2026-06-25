# Tasks

## 1. Spec

- [x] 1.1 Add polyfill-runtime requirements for source-partition coverage honesty and partition-aware cursors.
- [x] 1.2 Validate the OpenSpec change strictly.

## 2. Slack Connector

- [x] 2.1 Add current archive channel inventory extraction.
- [x] 2.2 Compare prior observed channels with current archive channels.
- [x] 2.3 Emit bounded `SKIP_RESULT` diagnostics for missing previously observed channels.
- [x] 2.4 Persist `messages.channel_last_ts` and `messages.observed_channel_ids`.
- [x] 2.5 Use per-channel message high-water thresholds when iterating `MESSAGE` rows.
- [x] 2.6 Add a dry-run-by-default repair script to seed Slack message partition state from retained records.
- [x] 2.7 Add isolated scoped Slack archives for targeted channel backfills.
- [x] 2.8 Add collector-runner `--resources` support so backfills can use the normal ingest path.
- [x] 2.9 Add owner/ref run-route `resources` support so targeted backfills can be triggered through the normal audited run path.

## 3. Tests

- [x] 3.1 Cover missing prior Slack channel diagnostics.
- [x] 3.2 Cover clean inventory with no diagnostic.
- [x] 3.3 Cover per-channel cursor emission and legacy fallback.
- [x] 3.4 Cover repair-script merge semantics and backup-table naming.
- [x] 3.5 Cover scoped Slack archive backfill behavior.
- [x] 3.6 Cover collector-runner START resources.
- [x] 3.7 Cover controller and run-route propagation of scoped resources.

## 4. Validation

- [x] 4.1 Run focused Slack connector tests.
- [x] 4.2 Run repair-script tests.
- [x] 4.3 Run package typecheck or equivalent focused TypeScript validation.
- [x] 4.4 Summarize live-data implication and repair/deploy follow-up.
