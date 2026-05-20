## 1. Outbox Substrate

- [x] 1.1 Add a package-local durable outbox module for local collectors with SQLite/WAL initialization, schema migrations, and a small typed adapter boundary.
- [x] 1.2 Model outbox rows for record batches, checkpoint/state commits, gap/backlog reports, and artifact/blob uploads.
- [x] 1.3 Implement enqueue, claim, acknowledge, fail/retry, dead-letter, lease-renew, expired-lease recovery, and status-summary operations.
- [x] 1.4 Add deterministic work ids and lease fencing so stale holders cannot acknowledge work after a newer claim.
- [x] 1.5 Add a temporary old JSON queue inspection/import/quarantine path so the owner's current pending local development work is not silently discarded.
- [x] 1.6 Remove the temporary old JSON queue inspection/import/quarantine path after the owner's current local queues have been imported or intentionally discarded.

## 2. Runner Integration

- [x] 2.1 Change the local collector runner to recover expired leases and drain ready durable work before scanning a source for new work.
- [x] 2.2 Map connector child output into bounded work units and durable outbox rows without changing the Collection Profile envelope seen by the child.
- [x] 2.3 Stage connector-emitted `STATE` as attempted progress and commit checkpoints only after server acknowledgement for the related records and gap metadata.
- [x] 2.4 Persist known incomplete work as backlog/gap units with stream/boundary identity, reason, retryability, first-seen run, last-attempt run, and next-attempt policy.
- [ ] 2.5 Enforce policy limits for first backfill and steady-state drains without losing queued work.

## 3. Server And Acknowledgement Semantics

- [x] 3.1 Define and implement the minimum server acknowledgement shape needed by local outbox items for records, gaps, state commits, and blobs. (Blobs remain partial: only record_batch, checkpoint/state, and gap have routes; blob upload acknowledgement is open until a local-blob path lands.)
- [x] 3.2 Ensure device-exporter ingest and state routes remain idempotent for at-least-once local delivery.
- [ ] 3.3 Add or extend reference-only diagnostics for connection-scoped backlog, last acknowledgement, last committed checkpoint, and dead-letter work.
- [x] 3.4 Keep new server surfaces under reference-only/device-exporter authority and document that they are not PDPP Core APIs.

## 4. Operator And Service UX

- [x] 4.1 Add local `doctor` and `status` output for durable outbox health, stale leases, oldest pending work, package/protocol version, configured device, and source-home identity.
- [x] 4.2 Add service-run guidance that preserves host-native systemd/launchd scheduling rather than adding a custom scheduler daemon.
- [ ] 4.3 Update dashboard/device-exporter health surfaces to distinguish pending, retrying, stale, dead-letter, backlog, and fully-drained local collector states.
- [x] 4.4 Ensure remote diagnostics avoid raw secrets, auth files, browser cookies, and unredacted absolute local paths.

## 5. Connector Adoption

- [ ] 5.1 Enable the durable outbox path for one low-risk local connector mode behind a compatibility flag or migration guard.
- [ ] 5.2 Enable the durable outbox path for Claude Code local collection after crash/restart tests pass.
- [ ] 5.3 Enable the durable outbox path for Codex local collection after crash/restart tests pass.
- [ ] 5.4 Preserve deterministic record ids and source-instance namespacing so multi-device local collection remains collision-safe.

## 6. Validation

- [x] 6.1 Add crash/restart tests for crash after enqueue before upload acknowledgement, crash after upload before local acknowledgement, and crash after state staging before commit.
- [x] 6.2 Add stale-lease tests proving expired work recovers and stale holders cannot acknowledge newer claims.
- [x] 6.3 Add backlog/gap tests proving partial progress is reported honestly and retryable work remains targetable.
- [x] 6.4 Add migration/quarantine tests for existing JSON queue files.
- [x] 6.8 Add a closeout check proving no long-term JSON queue migration path remains after the one-time migration is complete.
- [x] 6.5 Add CLI/status tests for local outbox health output.
- [ ] 6.6 Run relevant local collector, polyfill connector, reference server, and dashboard tests.
- [ ] 6.7 Run `openspec validate add-local-collector-durable-work-substrate --strict`.
