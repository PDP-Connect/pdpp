# add-explore-record-buckets

## Why

Explore's over-time chart currently fans out from the console to many per-stream `aggregateRecordsByTime` calls. That makes first load slow and keeps the chart sparse when the selected corpus spans years because granularity is derived from a fixed client window instead of the populated record extent.

## What Changes

- Add an owner-session `GET /_ref/explore/records/buckets` reference route.
- Reuse the merged timeline substrate's scoped record set and semantic-time expression.
- Return one dense, zero-filled bucket series in a single call, with server-derived populated extent and auto granularity snapped to a calendar ladder targeting roughly 30-60 bars.
- Keep chart honesty: counts are exact reachable-record counts for the requested scope, and empty buckets are explicit zeros.

## Capabilities

Modified:
- `reference-implementation-architecture`

## Impact

- Reference implementation server route, operation, contract metadata, and tests.
- No PDPP Core protocol route.
- No grant-scoped `/v1` or `/mcp` behavior change.
- No deployment in this change.
