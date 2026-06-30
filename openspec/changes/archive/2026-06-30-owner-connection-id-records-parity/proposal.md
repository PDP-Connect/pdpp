## Why

Owner-agent REST callers can discover `connection_id` values from `/v1/streams`, but the polyfill owner read path still requires `connector_id` on stream record reads. This makes the public REST contract weaker than MCP and weaker than the advertised `connection_id` query shape.

The report that `/v1/streams/:stream` returns metadata is not a bug; that route is metadata-only by design. The bug is narrower: `/v1/streams/:stream/records?connection_id=...` should work for owner bearer callers without also requiring `connector_id`.

## What Changes

- Resolve owner-bearer polyfill reads from canonical `connection_id` when present.
- Preserve existing `connector_id` and deprecated `connector_instance_id` behavior.
- Reject conflicting `connection_id` / `connector_instance_id` values through the existing alias validator.
- Add focused owner REST coverage for the discovered `connection_id` records path.

## Capabilities

Modified:

- `reference-implementation-architecture`

## Impact

- No protocol-core change.
- No MCP behavior change.
- Owner-agent REST callers can use the same connection identity they discover from stream listings.
