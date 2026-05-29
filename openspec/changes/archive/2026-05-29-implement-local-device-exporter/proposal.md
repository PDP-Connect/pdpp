## Why

The reference implementation can run local-file connectors today only from the same machine that hosts the reference server. That blocks realistic serverless or remote-hosted deployments for sources like Codex CLI, where the records live on an owner's device and must be pushed safely to the remote reference instance.

## What Changes

- Add a reference-only local device exporter flow for the Codex connector first.
- Add owner-approved device enrollment that exchanges a one-time enrollment code for a device-scoped ingest credential.
- Add source-instance-aware device ingest so multiple devices can push the same connector without record-key collisions.
- Add idempotent batch ingest keyed by `device_id`, `batch_id`, and `body_hash`, with conflict rejection when the same batch id is reused for different content.
- Add a small durable local queue and retry loop for the device agent.
- Add owner/operator diagnostics for enrolled devices, source instances, heartbeat, ingest freshness, accepted/rejected counts, stale state, and last error.
- Keep the feature explicitly reference-experimental and reference-only; do not promote a PDPP Core or Collection Profile contract in this change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-implementation-architecture`: add the reference-only local device exporter, its credential boundary, ingest idempotency, source-instance isolation, and owner diagnostics.

## Impact

- Reference server storage and route surface for device enrollment, credential exchange, heartbeat, batch ingest, and owner diagnostics.
- SQLite and Postgres storage adapters for device exporters, source instances, ingest credentials, and ingest batch idempotency.
- Existing record ingest/index maintenance reused behind a source-instance-aware adapter.
- `packages/polyfill-connectors` Codex connector path and a local exporter CLI/agent wrapper.
- Owner dashboard pages and web data clients for device exporter status.
- Tests for enrollment, credential scope, idempotency, replay/conflict rejection, multi-device isolation, queue retry, and dashboard data.
