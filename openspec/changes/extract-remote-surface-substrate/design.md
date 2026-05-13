## Context

The static lease tranche settled the browser-surface lease model, queue policy, fencing tokens, and restart reconciliation behavior. The dynamic allocation tranche needs the same policy plus allocator contracts, but should not force allocator/Docker/server concerns into a package intended to be reusable.

## Decision

Create or extend the private internal `@pdpp/remote-surface` package as the owner of pure substrate:

- Backend-agnostic remote-surface and browser-surface lease types.
- `BrowserSurfaceLeaseManager` and its capacity, fencing, duplicate, priority/FIFO queue, timeout, release, and restart reconcile policy.
- Backend allocator interfaces for ensure/status/stop/list operations.

The reference implementation remains the owner of:

- Persistence adapters and storage transactions.
- Spine/run events and operator projections beyond pure projection helpers.
- Connector launch integration and child-process env construction.
- Docker Compose wiring and operator configuration.
- The dynamic allocator sidecar process and Docker Engine access.

The old `reference-implementation/runtime/browser-surface-leases.ts` may remain as a compatibility shim for reference-specific env parsing and launch-env helpers, but the real state-machine implementation must live in the package.

## Alternatives

- Keep the code in the reference runtime: rejected because dynamic allocation would deepen the reference coupling.
- Publish a polished npm package now: rejected because this tranche only needs a clean internal boundary and testable separation.

## Acceptance Checks

- The package does not import from `reference-implementation`, `server`, Docker code, `apps/web`, or connectors.
- Reference tests continue to pass through the package-backed implementation.
- Package tests cover pure lease behavior at the substrate boundary.
- OpenSpec validates for this change and for the dynamic allocation change.
