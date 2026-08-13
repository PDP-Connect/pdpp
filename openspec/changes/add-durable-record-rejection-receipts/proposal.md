## Why

Hosted connector ingestion can accept a batch with permanent per-record failures, advance runtime progress, and later commit cursor state without durable evidence for the rejected input. A retry after response loss or process restart must be able to distinguish already-accepted siblings from permanently rejected lines and must not claim success until the rejected payload is recoverable by its owner.

## What Changes

- Persist owner-bound durable record-rejection receipts before a hosted ingest response can report permanent line rejection success.
- Preserve per-line durable-prefix semantics: accepted siblings and committed rejection receipts may survive a later systemic sibling failure, while replay remains exact and idempotent.
- Re-check connection writability and run/connection fences inside the rejection transaction.
- Add owner-only, connection-scoped list/detail inspection with paging, metadata-only lists, payload privacy, fresh-process retrieval, and connection-delete cleanup.
- Prove SQLite and PostgreSQL parity for the hosted receipt store, replay, fencing, and inspection behavior.

## Impact

The change is additive to the reference hosted ingestion path and owner inspection surface. It does not add mutation/disposition routes for pending rejections and does not change device-exporter ingestion semantics.
