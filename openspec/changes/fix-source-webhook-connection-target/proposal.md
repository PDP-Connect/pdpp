## Why

Signed source webhooks authenticate `sourceId`, but accepted actions were applied with only `connectorId`. Record ingest could fall through to the compiled default owner namespace, and scheduler fallback was connector-scoped.

## What Changes

- Resolve each authenticated source webhook to an explicit owner, connector, and connector instance before idempotency claim.
- Keep legacy `PDPP_SOURCE_WEBHOOK_SECRETS` entries only when they resolve to exactly one active writable connection for the configured owner.
- Add JSON `PDPP_SOURCE_WEBHOOK_SECRETS` entries for explicit multi-connection targets.
- Thread the resolved connection through record ingest, manual run start, and scheduler fallback.

## Capabilities

Modified:
- `reference-implementation-architecture`

## Impact

- Affects only reference-only `POST /_ref/source-webhooks/:sourceId`.
- Ambiguous, missing, revoked, wrong-owner, or wrong-connector webhook targets now reject before claim or mutation.
