## Why

The reference operation-boundary program has moved public records, streams, schema, search, and dataset-summary reads into canonical operation modules. The operator connector catalog and pending-approval list are still route-local even though their read shapes are already isolated and now have store seams for consent/device state.

## What Changes

- Add canonical operation modules for `ref.connectors.list`, `ref.connectors.detail`, and `ref.approvals.list`.
- Mount the existing `/_ref/connectors`, `/_ref/connectors/:connectorId`, and `/_ref/approvals` routes through those operations.
- Add operation-boundary and behavior tests without changing response contracts.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- Production code: reference operation modules and Fastify host adapters.
- Tests: operation boundary tests plus existing connector/approval route coverage.
- Out of scope: auth protocol mutation routes, device/consent approve/deny, run-control mutations, scheduler mutation operations, and public RS protocol changes.
