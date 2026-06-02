# Tasks: classify stalled outbox cause

## 1. Runtime projection

- [x] 1.1 Add `OutboxStalledCause` type and the cause-specific condition reasons (`LOCAL_EXPORTER_STATE_READ_FAILED`, `LOCAL_EXPORTER_DEAD_LETTER_BACKLOG`, `LOCAL_EXPORTER_STALE_PENDING`, and the `OUTBOX_*` peers).
- [x] 1.2 Add optional `cause` to `ConnectionOutboxEvidence` and optional `deadLetterCount` to `HeartbeatOutboxEvidence`.
- [x] 1.3 Return `cause` from `deriveOutboxAxisFromHeartbeat` (state_read_failed vs dead_letter_backlog by dead-letter count; stale_pending for stale pending work; null otherwise).
- [x] 1.4 Render cause-specific message/reason/remediation in `localExporterAvailableCondition` and `backlogClearCondition`, with a generic fallback and a non-stalled guard.

## 2. Server rollup threading

- [x] 2.1 Escalate the dominant stalled cause across trusted heartbeat rows in `projectConnectorOutboxAxisFromHeartbeats`, passing each row's `dead_letter` count.
- [x] 2.2 Return `cause` from `getConnectorOutboxAxis` and thread it into the outbox evidence at both connection-summary call sites (list + detail).

## 3. Spec + tests

- [x] 3.1 Modify the `reference-connection-health` requirement so a stalled local-device outbox names its cause class.
- [x] 3.2 Add/extend `connection-health.test.js` for each cause class, the generic fallback, and the non-stalled guard.

## Acceptance checks

- `node --test --experimental-strip-types reference-implementation/test/connection-health.test.js` — all pass.
- `openspec validate classify-stalled-outbox-cause --strict` — passes.

## Owner-gated residual

- [ ] 3.3 Integration coverage of the server rollup-with-cause path (`connection-health-acceptance.test.js`, `ref-connectors-list-operation.test.js`) requires `pnpm install` for the native `better-sqlite3` dependency, which is absent in the worker worktree. Run on the owner integration pass.
