## Why

The owner connector-summary feed must have bounded work and an explicit client
contract. A complete fleet is traversed as pages, never disguised as one
constant-cost response.

## What Changes

- Require a bounded `limit` for unscoped `GET /_ref/connectors` pages (maximum
  100), with opaque owner/filter-bound cursors.
- Keep exact `connection` reads unpaged and mutually exclusive with page
  controls; support bounded `connector_id` filtering.
- Gather page evidence by exact connection ids and compose fleet rollups
  independently.
- Integrate the console, CLI, and operator callers with bounded traversal.

## Impact

This modifies `reference-connector-instances` and
`reference-implementation-architecture`.
