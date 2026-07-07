## Context

The run controller has `connectorInstanceId` before it launches a connector and the runtime already uses that id for ingest and state writes. The spine event payload, however, only carries `source: { kind: "connector", id: connectorId }`. `listSpineCorrelations("run")` then returns summaries that are connector-wide unless a browser-surface profile key happens to imply a connection id.

This is correct for public source identity but insufficient for the reference owner console, where rows are connection-instance scoped.

## Decision

Keep source identity and storage identity separate:

- `data.source` remains the public source object: connector realization plus connector id.
- `data.connection_id` and `data.connector_instance_id` carry the concrete runtime storage binding for owner/read-model correlation.
- Run-summary projection exposes those fields when they are present on any run event.

The projection MAY continue to use the existing singleton fallback for legacy runs without connection identity, but it SHALL NOT borrow connector-wide runs when more than one active visible connection exists.

## Alternatives

- Change `source.id` to `connection_id`: rejected because it would collapse public source identity into reference storage identity and break source-binding semantics.
- Patch only the dashboard summary: rejected because timelines, source detail, and owner-agent run control would still lack durable correlation evidence.
- Infer from records written during the run: rejected because zero-record successful runs and failed runs still need to be attributable.

## Acceptance Checks

- A runtime run with `connectorInstanceId` emits `run.started` and terminal event data containing both `connection_id` and `connector_instance_id`.
- SQLite and Postgres run summaries project the connection id from runtime data.
- A same-connector, two-connection summary test proves a new manual run updates only the addressed connection and does not rely on connector-wide fallback.
- Existing legacy singleton fallback behavior remains covered.
