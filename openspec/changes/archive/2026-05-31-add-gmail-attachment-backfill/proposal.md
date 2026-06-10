# add-gmail-attachment-backfill

## Why

Gmail attachment hydration currently happens while syncing newly processed messages. If connector state has already advanced past historical UIDs before attachment hydration is enabled or repaired, existing mail can keep metadata-only attachment records indefinitely. The reference Docker path therefore cannot yet prove the user-facing goal: attachments are fetchable for all Gmail mail that the connector can still access.

## What Changes

- Define Gmail attachment hydration/backfill as a bounded reference-runtime operation, not an implicit side effect of normal incremental message sync.
- Add SLVP done criteria for Docker preflight, historical rehydration, idempotent blob persistence, partial-failure reporting, and operator-visible gap summaries.
- Require a per-stream attachment backfill cursor that can walk historical All Mail UIDs without rewinding the normal messages cursor.
- Require tests and a Docker acceptance path that prove old metadata-only attachment records are rehydrated or reported with truthful terminal status.

## Capabilities

Modified:

- `reference-implementation-architecture`

Added:

- None

Removed:

- None

## Impact

- Affects the Gmail connector, connector state handling, reference Docker preflight, run timeline/gap reporting, and Gmail connector tests.
- Does not change the public PDPP blob API or add stream-specific attachment download routes.
- Implementation is intentionally deferred because it crosses connector runtime, state, reporting, and Docker validation surfaces.
