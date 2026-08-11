## Context

The source webhook route is not a PDPP Core endpoint. It is an operator-configured reference ingress. HMAC verification authenticates the source, not an owner session or client token, so the configured source target is the only authority for record and run namespace.

## Decisions

### Connection Target

After HMAC verification, but before event claim, the route resolves the source to `{ ownerSubjectId, connectorId, connectorInstanceId }`. A target is writable only when the connection exists, belongs to that owner and connector, and is active.

### Compatibility

The legacy comma-separated `sourceId:secret[:connectorId]` form is preserved as connector shorthand. It resolves against the configured single owner and is accepted only when that owner has exactly one active connection for the connector. It does not materialize default-account connections.

Explicit multi-connection targets use JSON rather than adding another colon segment. Supported JSON forms are either an array of entries or an object keyed by source id. Each entry accepts `source_id`/`sourceId`, `secret`, `connector_id`/`connectorId`, `owner_subject_id`/`ownerSubjectId`, and `connector_instance_id`/`connectorInstanceId`.

## Out Of Scope

- Claim-before-downstream-failure state-machine changes.
- Body size limits.
- Moving webhook configuration into durable storage.

## Acceptance Checks

- Two sources for the same connector can target different connector instances.
- Missing, revoked, wrong-owner, wrong-connector, and ambiguous targets reject before idempotency claim or mutation.
- Record ingest uses `requireConnectionAdmission: true`.
- Run start receives owner and connector instance.
- Scheduler fallback writes last-run time by connector instance.
