## Why

Retained-size dataset summary reads can report stale derived metadata even when the existing bounded reconcile path can repair the read model from durable reference state. The owner dashboard also must not turn internal maintenance details into hero copy.

## What Changes

- Attempt retained-size auto-reconcile from the `_ref/dataset/summary` read path only when retained-size metadata is stale or failed.
- Bound read-path retry behavior with an in-process cooldown after reconcile failure.
- Keep ordinary reads from running full retained-size rebuilds.
- Preserve stale or failed metadata when reconcile fails.
- Render owner dashboard stale/failure hero copy without raw internal reasons.

## Capabilities

Modified:
- `reference-implementation-architecture`

## Impact

- Touches the reference-only `_ref/dataset/summary` retained-size projection path and owner dashboard standing copy.
- Adds focused regression coverage for global-only dirty metadata, reconcile success, reconcile failure, retry throttling, and owner-safe UI copy.
- Does not change PDPP Core, grant-scoped APIs, connector runtime contracts, live deployment configuration, or live data.
