## Why

`add-dynamic-neko-surface-allocation` introduced the controller-owned lease boundary and the readiness probe, but a real USAA run (`run_1779900509276`) still failed the way the design tried to prevent: the lease manager held an in-memory n.eko surface row marked `health: "ready"` whose underlying Docker container was `Exited (255)` and no longer attached to the Compose network. `acquire` returned `leased` immediately, the readiness probe correctly reported `browser_surface_cdp_unreachable`, the lease was released, and the surface row was left in memory still marked ready. The next acquire would have hit the same dead surface.

Two construction gaps fed this:

- `BrowserSurfaceLeaseManager.reconcileAfterRestart` only inspects rehydrated in-memory state. It never asks the allocator whether the surfaces it inherited from the previous boot still exist or are still healthy.
- The controller's readiness-gate failure path releases the lease but does not invalidate the surface or tell the allocator that the underlying container is unrecoverable.

## What Changes

- Make the lease manager `invalidateSurface(surfaceId, options)` an explicit, testable operation that evicts a surface row from the in-memory map and (optionally) terminates the active lease.
- Add `BrowserSurfaceLeaseManager.reconcileSurfacesWithAllocator(allocator)` so boot reconciliation can prove against the allocator that an in-memory surface still exists and is still healthy. Surfaces the allocator no longer knows about are evicted; surfaces it reports as `starting`/`unhealthy` are downgraded.
- Run `reconcileSurfacesWithAllocator` from the controller's boot reconciliation, before any acquire can pick a stale ready surface.
- On readiness-probe failure, invalidate the in-memory surface AND call `allocator.stopSurface({ reason: "surface_failed" })` so the underlying container is removed instead of left in an exited carcass state.
- Treat `stopSurface({ reason: "surface_failed" })` as a remove-the-container signal in the n.eko allocator service, and treat an existing non-running owned container in `ensureSurface` as a replaceable carcass (remove and recreate) rather than restart in place.
- Keep static n.eko surface behavior unchanged: there is exactly one configured surface; no dynamic allocator to consult; the reconcile method is a no-op in static mode.

## Capabilities

### Modified Capabilities

- `reference-implementation-architecture`: extend the dynamic n.eko reconcile-after-restart and lease-failure semantics to be allocator-aware and to evict in-memory surface rows when their underlying container is missing or unrecoverable.

## Impact

- `packages/remote-surface/src/reference/browser-surface-leases.ts` lease-manager invalidation and allocator-aware reconciliation methods.
- `reference-implementation/runtime/controller.ts` boot reconcile and readiness-gate failure path.
- `reference-implementation/server/neko-surface-allocator-server.ts` ensure/stop semantics for stale containers.
- Tests covering invalidation, allocator-aware reconciliation, the controller's probe-failure invalidate-and-stop path, and allocator carcass replacement.
- No change to connector code, manifest semantics, or the static n.eko path.
