## Why

The dashboard can show `Needs attention 0` while the connection list contains `Degraded` cards and `Outbox · stalled` states. That is arithmetically consistent with the current narrow counter, but it is not an operator-grade summary because it hides meaningful degraded work from the top-level rollup.

## What Changes

- Define the dashboard health summary contract for connection list rollups.
- Make degraded and cooling-off connection projections visible in the summary instead of silently excluded.
- Clarify the "Connections" count so registered/no-data connections are not confused with connections that have durable progress.
- Preserve the existing health projection taxonomy; this change only aligns the operator summary and copy with that projection.

## Capabilities

### New Capabilities

### Modified Capabilities

- `reference-connection-health`: Add owner-dashboard summary semantics for attention/degraded/running/stale/no-data rollups.

## Impact

- Affected UI: `apps/console/src/app/dashboard/components/views/records-list-view.tsx` and companion tests.
- Affected specs: `reference-connection-health`.
- No change to connector health projection storage or public read APIs.
