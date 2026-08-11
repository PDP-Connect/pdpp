## Context

See proposal.md. The accepted source-webhook implementation stores only `(source_id, event_id, body_hash, received_at)`. It atomically inserts that row before calling record ingest or controller `runNow`; a thrown action has no completion or failure transition.

The state distinction is essential rather than bookkeeping: a stored event may mean one of three different things—an action is in flight, an action completed, or an action failed before completion. The existing boolean claim conflates all three.

## Goals / Non-Goals

**Goals:**

- Make authenticated payload validation precede durable event acquisition.
- Make duplicate, same-event-payload conflict, processing ownership, terminal completion, and retryable recovery explicit and atomic on SQLite and Postgres.
- Preserve at-least-once retry for record ingest, whose existing record path is idempotent by manifest primary key.
- Give schedule-run retry a durable source-event dispatch identity before releasing its failed or expired processing lease.

**Non-Goals:**

- Claim exactly-once execution across the webhook database and controller/connector runtime.
- Treat a bare row delete in a generic catch as a lifecycle protocol.
- Change record ingest's accepted-prefix semantics or its existing record-level idempotency.

## Decisions

### Store lifecycle state, body hash, lease, and attempt metadata

The event row will have `status` (`processing`, `completed`, `failed`), a unique processor/lease token and expiry while processing, timestamps, and attempt count. An atomic acquire result distinguishes: acquired new/recovered work; completed duplicate; in-flight work; and same-ID different-body conflict. A compare-and-set terminal transition binds the lease token, so an expired worker cannot complete or fail a newer owner.

This retains diagnostic and concurrency state. A `DELETE` on failure loses both and lets a late original worker overwrite the meaning of a retry.

### Validate action shape before acquisition

The webhook operation will parse and validate `action`, `ingest_records.stream`, and `ingest_records.records` before it asks the event store to acquire work. Authentication remains before parsing. This prevents a deterministic 400 from consuming a sender's event ID.

Manifest stream existence is part of the downstream record-ingest operation, not payload shape. It is allowed to fail after acquisition and must enter the retryable lifecycle according to the action contract.

### Do not release schedule-run work without durable controller event identity

Record ingest has an existing idempotency boundary: a retry of an accepted prefix is safe through manifest primary-key/upsert semantics. Controller run dispatch does not have that boundary.

Audit at `5d17952a` found no usable controller seam:

- `RunNowOptions.runId` is caller supplied, but only identifies a transient active run.
- `controller_active_runs` is deleted on every terminal cleanup.
- `runNow` does not query a durable mapping from `(source_id, event_id)` to a run or dispatch receipt.
- `run_history` has a run-ID uniqueness index but is not a run-admission/dedupe lookup.

The prerequisite controller contract uses `source_webhook_run_receipts`, keyed by `(source_id, event_id)`. It binds the authenticated body hash and resolved owner, connector, connector instance, and action to the first run handle. SQLite creates that receipt and `controller_active_runs` row in one `BEGIN IMMEDIATE` transaction; Postgres does the same in one transaction. The receipt stays after terminal active-run cleanup, while a fresh receipt is rolled back if the active-run admission conflicts. A replay returns the stored handle and cannot create a second durable admission row. This is an admission/deduplication receipt, not a claim of exactly-once connector execution across process failure after admission.

### Backend parity and migration inventory

SQLite and Postgres must implement the same compare-and-set lifecycle outcomes. The new receipt table and the later lifecycle changes must be reflected in the storage schema parser/target inventory, migration guide, and backup/restore inventory. Additive, nullable/defaulted bootstrap columns preserve existing rows; legacy claimed rows need an explicit migration disposition, not an implicit completed assumption.

## Risks / Trade-offs

- [Lease expires while an original worker is still alive] → Lease-token compare-and-set prevents its late terminal transition; downstream action retry needs an action-specific idempotency key.
- [Ingest partially commits before a retryable failure] → retain the existing manifest-primary-key retry contract and test accepted-prefix replay.
- [Controller call outcome is ambiguous] → do not release/retry `schedule_run` until the durable controller receipt exists.
- [Legacy permanent claims have unknown execution outcome] → require an explicit migration policy; do not silently mark them completed.

## Migration Plan

1. Add the controller/outbox source-event receipt capability and its SQLite/Postgres oracle first.
2. Add the event lifecycle columns and an explicit migration for legacy claim-only rows.
3. Deploy only after both storage backends pass lifecycle, concurrent-acquire, and controller-replay oracles.
4. Roll back application code only with a compatible schema reader; do not remove lifecycle columns or erase failed rows.
