# Owner-only detail-gap observability

## Why

The owner connection diagnostics projection currently reports only bounded
aggregates for pending detail gaps. Those aggregates cannot distinguish a
policy skip from a retryable failure or identify the exact rows responsible for
a recovery-lane gap.

## What Changes

- Add an exact-connection, owner-bearer detail-gap page below the existing owner
  diagnostics route.
- Add a bounded, deterministic keyset listing method to the existing
  `connector_detail_gaps` store for all statuses.
- Project only gap identity, neutral state, timing, lease state, and terminal or
  policy disposition; never return locators, source metadata, payloads, or raw
  error text.
- Advertise the read through the existing owner control action catalog and
  reference contract.

## Impact

- `reference-implementation/server/routes/owner-connection-diagnostics.ts`
- `reference-implementation/server/owner-detail-gap-projection.ts`
- `reference-implementation/server/stores/connector-detail-gap-store.ts`
- `reference-implementation/server/metadata.ts`
- `packages/reference-contract/src/reference/index.ts`
- SQLite/Postgres store and owner-route conformance tests

No new store, materialized view, provider-specific route, mutation, or deploy
surface is introduced.
