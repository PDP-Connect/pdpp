## Why

Source webhook intake moved from abstract design-note discussion to a narrow SLVP implementation need. The reference needs a safe first tranche that can accept concrete source callbacks without claiming generic PDPP event-driven collection support.

## What Changes

- Add a reference-only source webhook endpoint for signed source callbacks.
- Require source-specific HMAC authentication, timestamp freshness, and durable event-id idempotency before any record mutation or scheduler signal.
- Map accepted record-push events through the existing `rs.records.ingest` operation.
- Map accepted run-trigger events to scheduler input only; the webhook does not execute connector runs directly.
- Mark the source-webhooks design note as promoted for this tranche.

## Capabilities

Modified:

- `reference-implementation-architecture`

Added:

- None

Removed:

- None

## Impact

- Affected code: `reference-implementation/server`, `reference-implementation/operations`, tests.
- Affected behavior: deployments may opt into source webhook credentials and receive source-specific callbacks safely.
- Protocol impact: none; this is a reference-runtime adapter surface, not a core PDPP webhook profile.
