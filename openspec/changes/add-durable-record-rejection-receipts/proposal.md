## Why

The hosted connector runtime currently treats a `2xx` ingest response with permanently rejected records as a successful flush, then may commit the connector's cursor even though the rejected records are neither stored nor recoverable. A real SQLite system test reproduced a successful run with `records_accepted: 0`, `records_rejected: 1`, no stored record, and a cursor advanced past that record.

## What Changes

- Persist every permanently rejected hosted-ingest record as an owner-bound, bounded quarantine entry before returning it as terminally accounted.
- Return stable rejection receipt identities from hosted record ingest, with idempotent exact-request replay.
- Allow the hosted runtime to stage and commit progress past rejected records only after it validates a complete durable receipt set for the batch.
- Report attempted, accepted, permanently rejected, and unresolved retryable counts without describing submitted or rejected records as flushed or accepted.
- **BREAKING** Correct retained `records_flushed`-named runtime fields to count confirmed accepted records rather than submitted records; new attempted and rejected fields preserve the previously braided facts explicitly.
- Expose an owner-session, read-only reference surface for inspecting quarantined records without putting rejected payloads in list results, run timelines, audit events, or logs.
- Defer retry, discard, payload editing, and device-exporter parity to follow-up changes after the hosted receipt invariant is proven.
- Keep the local device-exporter path's current all-or-retry, checkpoint-blocking behavior unchanged. Device parity is a separate change after the hosted invariant is proven.

## Capabilities

### New Capabilities

- `durable-record-rejections`: Durable quarantine identity, persistence, replay, bounded owner inspection, retention, and connection-deletion semantics for permanently rejected hosted-ingest records.

### Modified Capabilities

- `reference-implementation-runtime`: A hosted runtime batch is progress-complete only when each submitted record is durably accepted or represented by a validated durable rejection receipt; terminal accounting distinguishes all outcomes.
- `reference-implementation-architecture`: The destination-confirmed checkpoint contract explicitly covers permanently rejected records and their recoverable quarantine evidence.

## Impact

- Hosted `POST /v1/ingest/{stream}` response contract and runtime ingest client.
- SQLite and PostgreSQL quarantine transactions, schema migrations, and owner-bound read-only reference routes.
- Runtime batch accounting, checkpoint staging, terminal events, run history, and focused real-backend tests.
- No Collection Profile wire-protocol change and no change to device-exporter checkpoint semantics in this tranche.
