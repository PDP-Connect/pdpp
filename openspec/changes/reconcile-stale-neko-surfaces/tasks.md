## 1. Lease Manager

- [x] 1.1 Add `BrowserSurfaceLeaseManager.invalidateSurface(surfaceId, options)` that evicts a surface from the in-memory map and optionally fails an active lease with `wait_reason: surface_unhealthy`.
- [x] 1.2 Add `BrowserSurfaceLeaseManager.reconcileSurfacesWithAllocator(allocator)` that evicts in-memory surfaces the allocator no longer reports and downgrades in-memory health when the allocator reports non-ready state. Static mode is a no-op.
- [x] 1.3 Cover both methods with focused unit tests including the static-mode no-op, allocator-null eviction, allocator-unhealthy eviction, and allocator-starting downgrade paths.

## 2. Controller

- [x] 2.1 Invoke `reconcileSurfacesWithAllocator` from `reconcileBrowserSurfaceLeasesAfterBoot` before the existing lease-level `reconcileAfterRestart`. Persist evicted and downgraded surfaces.
- [x] 2.2 In `runBrowserSurfaceReadinessGate`, after the probe-failed event and before `releaseBrowserSurfaceLease`, call `invalidateSurface(surfaceId, { releaseLease: false })` and persist the eviction.
- [x] 2.3 In the same path, when a dynamic allocator is configured, call `allocator.stopSurface({ reason: "surface_failed" })` so the underlying container is removed.
- [x] 2.4 Cover the readiness-failure-evicts-surface path and the allocator-stop-on-probe-failure path with controller tests.

## 3. Allocator Server

- [x] 3.1 Treat a non-running owned container in `ensureSurface` as a replaceable carcass: remove it, then fall through to the create path.
- [x] 3.2 Treat `stopSurface({ reason: "surface_failed" })` as a remove-the-container signal in addition to stopping it. Other reasons preserve the container.
- [x] 3.3 Cover the new ensure/stop semantics in `neko-surface-allocator-server.test.js`, including: stale exited container is removed and recreated; `surface_failed` deletes the container; `idle_ttl` does not.

## 4. Verification

- [x] 4.1 `pnpm --filter @opendatalabs/remote-surface test`
- [x] 4.2 `node --test reference-implementation/test/controller-browser-surface-readiness.test.js`
- [x] 4.3 `node --test reference-implementation/test/controller-browser-surface-leases.test.js`
- [x] 4.4 `node --test reference-implementation/test/browser-surface-leases.test.js`
- [x] 4.5 `node --test reference-implementation/test/neko-surface-allocator-server.test.js`
- [x] 4.6 `pnpm --dir reference-implementation typecheck`
- [x] 4.7 `openspec validate reconcile-stale-neko-surfaces --strict`
- [ ] 4.8 Live verification on operator-driven USAA run after deploy. Owner step, recorded as residual risk in the change.
