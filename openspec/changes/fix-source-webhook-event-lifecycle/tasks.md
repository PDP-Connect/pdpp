## 1. Boundary evidence

- [x] 1.1 Reproduce the SQLite claim-before-failure loss for ingest and run dispatch.
- [x] 1.2 Audit controller run admission and establish that `runId`/active-run persistence is not a durable `(source_id, event_id)` dedupe receipt.

## 2. Prerequisite controller contract

- [x] 2.1 Add a durable controller/outbox source-event dispatch receipt keyed by `(source_id, event_id)` that returns the same run handle on replay.
- [x] 2.2 Add SQLite and Postgres controller-dispatch replay oracles, including a dispatch outcome interrupted after durable admission.

## 3. Source-webhook lifecycle — pending separate implementation

- [ ] 3.1 Validate deterministic action shape before event acquisition; implement atomic SQLite/Postgres processing/completed/failed/expired transitions and body-hash conflict rejection.
- [ ] 3.2 Thread the durable source-event receipt through `schedule_run`; release/reacquire only actions that have an idempotency boundary.
- [ ] 3.3 Add real-store lifecycle, lease-race, failed-ingest accepted-prefix, completed-duplicate, body-hash-conflict, and Postgres parity tests.
- [ ] 3.4 Update schema migration inventory, storage migration guide, and backup/restore policy for lifecycle data and legacy claims.

## 4. Verification — lifecycle follow-up pending

- [ ] 4.1 Run focused tests, both storage profiles, typecheck, OpenSpec validation, Biome, and reviewed diff.
