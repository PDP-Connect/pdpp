## Context

The owner connection-summary projection first reads run summaries from the event spine. Some older or connector-wide run events do not carry `connector_instance_id`; for multi-account connectors, the projection correctly refuses to assign those ambiguous events to a sibling connection.

The scheduler already persists terminal run history by `connector_instance_id`. When the spine lacks an exact match, that scheduler history is the right bounded fallback: it is connection-scoped, durable, indexed, and already used for scheduler freshness/last-run bookkeeping.

## Decision

Add `SchedulerStore.getLatestRunHistoryForConnection(connectorInstanceId, status?)` and use it in connection-summary projection after exact spine/browser-profile matching and before connector-wide fallback.

The ordering is deliberate:

1. Exact spine/browser-surface profile match remains strongest because it carries event-derived metadata.
2. Exact scheduler history is next because it is scoped to one connection.
3. Connector-wide fallback remains only for the existing singleton-active legacy case.

## Alternatives

- Reinterpret connector-wide spine runs for multi-account connectors. Rejected: it would reintroduce sibling-run smearing.
- Query scheduler tables directly from `ref-control.ts`. Rejected: it leaks table shape into the projection layer and bypasses the semantic scheduler-store seam.
- UI-only copy change. Rejected: the UI was missing evidence, not wording.

## Acceptance Checks

- Multi-account connection summaries hydrate `last_run` and `last_successful_run` from exact scheduler history.
- Browser-surface profile matching still wins when present.
- Ambiguous connector-wide spine fallback remains limited to the existing singleton-active case.
- SQLite and Postgres scheduler stores expose the same semantic method.
