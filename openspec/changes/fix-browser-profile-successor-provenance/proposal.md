## Why

An externally lost managed browser surface is recorded as terminal before a successor can prove its browser generation. The next container therefore cannot complete the causal record. Its failure can be hidden behind an older browser-session repair action even though it is a runtime problem.

## What Changes

- Keep an `external_or_host_loss` receipt pending until a scoped successor proves a browser generation or an actual successor allocation fails.
- Correlate a successor with the durable connection, surface subject, and profile key when its surface ID changes.
- Project a failed successor as system-actionable runtime continuity evidence with no new owner credential action.
- Persist the allocator's connection-scoped profile bind path into the reference surface projection.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`
- `reference-connection-health`

## Impact

`reference-implementation/runtime/browser-surface/`, browser-surface receipt tests, and the reference surface persistence projection.
