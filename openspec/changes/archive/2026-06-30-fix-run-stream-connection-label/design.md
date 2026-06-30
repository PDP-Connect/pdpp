## Context

The browser-session stream page renders resolved, continuing, and unavailable states from a run timeline. The page already fetches the run status, which includes `connector_instance_id`, but subject resolution only used `connector_id` and selected the first matching summary.

That is ambiguous for connectors with multiple active connections.

## Decision

Prefer connection-scoped identity when available:

- `runStatus.connector_instance_id`
- timeline `connector_instance_id`
- timeline `connection_id` / `source.connection_id`
- connector-type fallback only if the instance id is unavailable or the summary read fails

## Alternatives

### Keep connector-type labels

Rejected. It is misleading when multiple connections share a connector type.

### Query a new run-detail endpoint

Rejected for this fix. The stream page already has enough data: run status plus connector summaries.

## Acceptance Checks

- The stream page lookup prefers `connector_instance_id` / `connection_id`.
- The fallback still renders connector type when summaries cannot be read.
- Existing no-assistance stream-state behavior remains unchanged.
