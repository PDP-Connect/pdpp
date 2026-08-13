## Why

Source webhooks currently persist an event ID before the requested ingest or run dispatch succeeds. A transient downstream failure is then returned as a permanent duplicate on retry, losing the source notification. The accepted HMAC event binding protects identity but does not provide an execution lifecycle.

## What Changes

- Validate the complete deterministic source-webhook payload before acquiring event execution state.
- Replace permanent claim-only idempotency with an atomic, durable processing/completed/failed lifecycle that supports expired-lease and failed-attempt recovery.
- Reject a reused `(source_id, event_id)` whose authenticated body hash differs instead of treating it as a duplicate.
- Keep completed same-body retries as non-mutating duplicates.
- Require a durable source-event identity at controller run dispatch before schedule-run retries may be released.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: Source-webhook replay handling gains a durable execution lifecycle and conflict/retry semantics.

## Impact

- `reference-implementation/operations/ref-source-webhook-ingest/`
- `reference-implementation/server/routes/source-webhooks.ts`
- `reference-implementation/server/stores/source-webhook-event-store.ts`
- SQLite/Postgres schema bootstrap and storage-migration inventory
- Source-webhook operation/store/backend parity tests
- Controller run-dispatch contract, which is a prerequisite for safe `schedule_run` replay recovery
