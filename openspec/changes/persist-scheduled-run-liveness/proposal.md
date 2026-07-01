## Why

Direct scheduled runs can emit `run.started` without a `controller_active_runs`
liveness row. During long quiet connector phases, the run summary fallback sees
`run.started` with no terminal event and no active row, so it projects
`orphaned_started_run` even though the connector is still running and may later
emit `run.completed`.

That makes source health look like a connector failure when the runtime is only
missing a durable liveness marker.

## What Changes

- Persist a scheduler active-run row for direct `runConnector` scheduled
  attempts as soon as `run.started` reports the real run id and trace id.
- Remove that row when the attempt reaches a terminal result or fails.
- Keep managed browser-surface runs on their existing controller-managed path.
- Preserve existing terminal-event projection behavior; it should now receive
  accurate liveness evidence for direct scheduled runs.

## Capabilities

Modified:

- `reference-implementation-runtime`

## Impact

- Affects reference scheduler runtime bookkeeping and the source-health/read
  projection that checks `controller_active_runs`.
- No public API shape change.
- Reduces false degraded source-health rows for long-running direct scheduled
  connectors.
