## Why

An owner can delete or revoke a configured connection while a record write is
waiting. A connector-instance coordinator alone serializes work but does not
refuse a write that starts after the lifecycle mutation has committed.

## What Changes

- Add opt-in, transaction-native connector-instance admission to record ingest.
- Make owner-routed record ingest opt in after it resolves a connection.
- Refuse missing and revoked instances through the record-ingest batch route's
  existing per-line rejection envelope.

## Capabilities

- Modified: `reference-connector-instances`

## Impact

- `reference-implementation/server/records.ts`
- `reference-implementation/server/postgres-records.ts`
- Owner record-ingest route
