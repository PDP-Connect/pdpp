## Why

The reference operation-boundary program has moved public records, streams, schema, search, dataset-summary, connector catalog, and approvals reads into canonical operation modules. Owner-only schedule reads on `/_ref/schedules` and `/_ref/connectors/:connectorId/schedule` are still route-local, even though `SchedulerStore` now isolates the underlying persistence and the controller already exposes a clean async read surface (`listSchedules`, `getSchedule`).

## What Changes

- Add canonical operation modules for `ref.schedules.list` and `ref.connector-schedule.get`.
- Mount the existing `GET /_ref/schedules` and `GET /_ref/connectors/:connectorId/schedule` routes through those operations.
- Add operation-boundary and behavior tests without changing response contracts or scheduler semantics.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Production code: two new reference operation modules and Fastify host adapters.
- Tests: operation-boundary and behavior tests; existing schedule/control-action and owner-gate route tests must remain green.
- Out of scope: scheduler mutation routes (`PUT/POST/DELETE /_ref/connectors/:connectorId/schedule[...]`), `runNow`, interaction responses, public RS protocol changes, scheduler persistence or refresh-policy semantics, dashboard schedule UX.
