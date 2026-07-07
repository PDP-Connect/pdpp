## Why

Local-device collectors can recover after a machine restart by draining their device outbox, but the owner source summary can still classify them as stale because old scheduler history wins over fresh local progress. That makes a self-healing collector look like it needs manual repair.

## What Changes

- Treat trusted local-device heartbeat progress as the freshness anchor for local-device-backed connections.
- Keep stalled outboxes, dead letters, incomplete coverage, failed current runs, and owner attention as degrading evidence.
- Add a regression test for a local-device connection that has fresh heartbeat evidence plus stale historical scheduler history.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reference-connection-health`: Local-device freshness uses trusted local progress rather than stale historical scheduler history.

## Impact

- Affects reference owner/control-plane connection summaries and source health projection.
- No protocol API, storage, manifest, credential, or connector-runtime contract changes.
