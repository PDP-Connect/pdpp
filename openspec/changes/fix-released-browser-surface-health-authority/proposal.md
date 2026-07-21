## Why

A released browser surface can remain in the durable `browser_surfaces`
table after its lease is cleared. The current connection-health projection
still falls back to the newest surface row even when no current lease or
current readiness evidence exists, so a retired surface that later becomes
`unhealthy` can wrongly become the live authority for the connection.

## What Changes

- Treat browser-surface health authority as lifecycle-scoped rather than
  purely row-recency-scoped.
- Keep fail-closed degradation for current lease-backed failures and other
  current allocator evidence.
- Do not let released or retired unleased surface history degrade a
  connection when current evidence is absent.

## Capabilities

Modified:
- reference-connection-health
- reference-implementation-architecture

## Impact

- Connection health stops using retired browser-surface history as the
  current source of truth.
- Current leased failures still degrade the connection.
- Operator surfaces see `unknown` only when there is no current evidence to
  classify, not when a historical surface row happens to be unhealthy.
