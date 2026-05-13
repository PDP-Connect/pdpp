## Why

The browser-surface lease/state-machine substrate is settled enough to extract from the reference runtime. Keeping pure scheduling policy inside `reference-implementation/` makes OSS-spinnable boundaries harder to audit.

## What Changes

- Add a private internal `@pdpp/remote-surface` package boundary for backend-agnostic remote-surface types, lease state machine, capacity/fencing/queue/reconcile policy, and backend allocator interfaces.
- Move the pure browser-surface lease manager into that package while preserving existing public names where practical.
- Keep reference-owned concerns in the reference implementation: persistence adapters, spine/run events, connector launch integration, Docker Compose wiring, and the allocator sidecar process.
- Add package-level lease tests and update direct reference consumers to resolve through the package or compatibility shim.

## Capabilities

Modified:

- `reference-implementation-architecture`

Added:

- None

Removed:

- None

## Impact

- No intended behavior change for static n.eko leases.
- Dynamic n.eko allocation can build on the extracted substrate instead of adding more policy to the reference runtime module.
