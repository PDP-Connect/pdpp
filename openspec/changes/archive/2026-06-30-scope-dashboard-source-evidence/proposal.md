## Why

The owner console can show multiple configured connections for the same connector type. The current dashboard still has routes and cards that fall back from a concrete connection to connector-wide run evidence. That makes real sources look broken, duplicated, or actionable based on sibling/orphan connector runs.

Live evidence: the Amazon connector has many active connections with fallback names, and a Chase browser-surface run is connector-keyed while the visible Chase source is a different configured connection. A source page or recovery CTA must not silently present that evidence as if it belongs to one source.

## What Changes

- Treat configured connections as the source identity for dashboard source/detail/recovery journeys.
- Stop generating connector-type links where the user is acting on one configured source.
- Suppress or label connector-wide run evidence when exact connection attribution is not available.
- Keep connector-wide views available only when they are explicitly described as connector-wide.

## Capabilities

Modified:

- `reference-implementation-architecture`
- `reference-surface-topology`

## Impact

- Console and `_ref` route behavior become stricter for multi-account connector types.
- No PDPP protocol-core change.
- Existing single-connection connector routes may continue to resolve as a convenience, but ambiguous connector-type fallback must not silently select one configured source.
