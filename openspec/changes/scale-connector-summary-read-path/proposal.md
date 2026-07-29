## Why

`GET /_ref/connectors` is the owner-console summary feed, but it has no page
contract and computes every visible connection in one request. The current
connection store also has an internal 500-row list limit, so a large fleet can
be silently incomplete. Bounded worker concurrency limits simultaneous work; it
does not make total work bounded.

## What Changes

- Add an explicit cursor/limit contract to the unscoped owner connector-summary
  list while retaining the exact scoped `connection` read.
- Page durable connection identities before the summary observation barrier, and
  fetch all page evidence through connection-scoped semantic-store batches.
- Keep `connector_summary_evidence` a repairable derived projection, not a new
  truth or rendered-summary cache.
- Compose owner-wide fleet counts and health separately from the page feed.

## Capabilities

Modified:

- `reference-connector-instances`
- `reference-implementation-architecture`

## Impact

- Affects the reference-only `/_ref/connectors` contract, connection-instance
  and scheduler store interfaces, and SQLite/PostgreSQL query parity.
- Does not change a summary item's connection identity or its small-fleet
  fields. Scoped/detail/diagnostic reads remain deep and exact.
