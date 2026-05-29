## Context

`add-neko-browser-surface-leases` and `add-dynamic-neko-surface-allocation` established the controller-owned lease boundary. The readiness probe added by the dynamic-surface tranche prevents the worst failure mode (handing a connector a dead CDP URL and then asking the human for an OTP). Real-world evidence from `run_1779900509276` (USAA, 2026-05-27) shows the probe firing correctly but the surface state still being wrong by construction:

- Allocator container `pdpp-neko-https-registry.pdpp.org-connectors-usaa-fb8946fb017fcfc3` was `Exited (255)` hours before the run started.
- Reference rebooted between the prior run and this one.
- Reference rehydrated lease/surface rows from Postgres and constructed `BrowserSurfaceLeaseManager` with `initialSurfaces` including this dead container's row, still tagged `health: "ready"`.
- `acquire` matched the run to that ready idle surface in-memory and emitted `leased` immediately.
- The probe correctly classified the surface as unreachable and the lease was released. The surface row was left in-memory with `health: "ready"`.

The construction defect is not "should we probe?" — the probe works. The defect is that the in-memory surface model is allowed to disagree with the allocator without ever being reconciled, and that disagreement persists across lease releases.

## Goals

- Prove an in-memory n.eko surface still corresponds to a live allocator container before any acquire can lease it.
- Make readiness-probe failure invalidate the surface, not just the lease.
- Make the allocator replace exited carcasses rather than restart them silently.
- Keep the static n.eko path unchanged; this work refines dynamic mode.

## Non-Goals

- No new owner UX for stale surfaces; the existing browser-surface state surface remains the way operators see queue/lease/surface state.
- No change to streaming, profile storage, or connector-launch env.
- No preemption or multi-allocator support.

## Design

### Lease Manager: invalidateSurface

A new method on `BrowserSurfaceLeaseManager`:

```ts
invalidateSurface(surfaceId, options?: { reason?: BrowserSurfaceWaitReason; releaseLease?: boolean }):
  { surface?: BrowserSurface; lease?: BrowserSurfaceLease };
```

- Removes the surface row from the in-memory map.
- If `releaseLease !== false` and the surface still references an active lease, that lease transitions to `surface_failed` with the given wait reason (default: `surface_unhealthy`).
- Returns the evicted surface and (if applicable) the failed lease so callers can persist them.

The controller's readiness-gate failure path now calls `invalidateSurface(surfaceId, { releaseLease: false })` before releasing the lease through the existing release flow. `releaseLease: false` keeps the existing `run.browser_surface_released` event semantics intact for the lease side; the surface side is what changes.

### Lease Manager: reconcileSurfacesWithAllocator

A new async method on `BrowserSurfaceLeaseManager`:

```ts
reconcileSurfacesWithAllocator(allocator): Promise<{ evicted: BrowserSurface[]; downgraded: BrowserSurface[] }>;
```

- Iterates the in-memory `neko` surfaces.
- Calls `allocator.getSurfaceStatus(surfaceId)` for each. Allocator errors are treated as "cannot prove this surface is live" and fall through to eviction.
- `null` (allocator does not know about it) → evict; any active lease transitions to `surface_failed` with reason `surface_unhealthy`.
- Allocator health `"unhealthy"` → evict.
- Allocator health `"starting"` or `"stopping"` → downgrade the in-memory row's health to match. `#findReadyIdleSurface` only returns `ready` rows, so a downgrade alone is sufficient to keep the surface from being leased until the allocator confirms readiness again.
- Allocator health `"ready"` while in-memory is non-ready → resync metadata (keeps `connector_id`, `profile_key`, subject keys).
- Static-mode no-op: this method is only meaningful when a dynamic allocator exists.

The controller invokes this from `reconcileBrowserSurfaceLeasesAfterBoot`, before the existing lease-level `reconcileAfterRestart` call. Persistence is updated for both evicted and downgraded surfaces so the next boot does not re-hydrate the same stale rows.

### Allocator: stale container replacement

`ensureSurface` previously called `/start` on any owned container that was not currently running. That is wrong when the container exited because of a Chromium crash, OOM, network removal, or any other state that a fresh start cannot recover. The new behavior:

- A non-running owned container is treated as a replaceable carcass. The allocator removes it (`DELETE /containers/<id>?force=true&v=false`) and falls through to the create path. Profile storage is on a host bind mount and survives container removal, so this is non-destructive for owner-visible state.
- The new `#removeContainer` helper tolerates 404/409.

`stopSurface({ reason: "surface_failed" })` now also removes the container after stopping it. Other stop reasons (`idle_ttl`, `operator`, `capacity_pressure`, `reconcile`) preserve the container so it can be restarted cheaply. This split matches the controller's signal: `surface_failed` is direct CDP-level evidence of unrecoverability, not a routine idle event.

### Failure mode mapping

| Symptom in the field | Construction layer | Mechanism |
| --- | --- | --- |
| Stale healthy surface row survives across boot | Lease manager | `reconcileSurfacesWithAllocator` evicts |
| Probe fails on a leased surface | Controller | `invalidateSurface` evicts; `allocator.stopSurface(surface_failed)` removes container |
| Allocator finds an exited owned container | Allocator | `ensureSurface` removes and recreates |
| Controller crashes after probe failure | Lease manager + boot reconcile | Next boot's `reconcileSurfacesWithAllocator` evicts before any acquire |

## Alternatives

### Add an allocator-aware idle TTL sweep

Rejected as the primary mechanism. Idle TTL is a periodic background sweep. The bug here is a single tight loop where every fresh acquire can lease a dead surface before the next sweep. The reconcile must be synchronous with boot and synchronous with probe failure.

### Mark surface "unhealthy" instead of evicting

Considered. The simpler edit would keep the surface row in memory with `health: "unhealthy"` so it would not be picked by `#findReadyIdleSurface`. Rejected for two reasons:

- The dynamic allocator owns surface lifecycle; the lease manager's in-memory map should not retain rows for surfaces the allocator has destroyed.
- Eviction lets the next acquire pass cleanly through `#promoteWaitingLeaseToStarting`, which creates a fresh surface via the allocator. That path already exists, is tested, and is the right code to run when the previous surface was unrecoverable.

### Make readiness-probe failure also fence-bump the lease

Rejected as out of scope. The probe failure path already terminates the lease cleanly; the gap is not fencing.

## Acceptance Checks

- A boot with a persisted `health: "ready"` surface whose allocator returns null evicts that surface before any acquire can lease it.
- A boot with a persisted surface whose allocator reports `starting` downgrades the in-memory row and the next acquire does not lease it as ready idle.
- A leased surface whose readiness probe returns a typed failure code is removed from the in-memory map and the allocator is asked to stop it with `reason: "surface_failed"`.
- The allocator removes a non-running owned container in `ensureSurface` and creates a fresh one rather than restarting in place.
- The allocator removes the container during `stopSurface(surface_failed)`; other stop reasons leave the container in place.
- Static n.eko mode behavior is unchanged: no allocator is consulted, no eviction occurs, the existing static surface is preserved across restart.

## Residual Risks

**Live operator-driven USAA run after deploy (owner-only):** All construction paths are covered by automated tests (1.3, 2.4, 3.3, 4.1–4.7) including allocator-aware reconciliation, probe-failure eviction, and stale container replacement. The one remaining gap is end-to-end confirmation that these mechanisms compose correctly under a real deployed Docker environment where an n.eko container has gone exited and a fresh USAA connector run is attempted. This requires operator access and credentials and cannot be reproduced in CI. The change was designed against real field evidence (`run_1779900509276`) and all individual mechanisms are unit-tested; the live step is a final confidence check, not a prerequisite for the change's correctness claims. Owner should run a USAA connector attempt after deploy and confirm the stale surface is not reused.
