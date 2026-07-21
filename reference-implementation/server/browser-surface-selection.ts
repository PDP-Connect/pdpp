// Pure ranking / selection over browser-surface leases and surfaces, used by the
// connection remote-surface projection in `ref-control.ts`. A leaf module: it
// reads only the lease/surface status and timestamp fields (types owned by the
// remote-surface package) and has no store or projection dependency.

import type { BrowserSurface, BrowserSurfaceLease } from "@opendatalabs/remote-surface/leases";

/** Lease statuses that mean the connection is actively waiting for a surface. */
export const ACTIVE_WAITING_LEASE_STATUSES = new Set<BrowserSurfaceLease["status"]>([
  "waiting_for_browser_surface",
  "starting_surface",
]);

function rankRemoteSurfaceLease(status: BrowserSurfaceLease["status"]): number {
  // Lower rank = more urgent. `leased` above `waiting` so an operator
  // viewing a connection sees "running" before "queued" when both
  // exist; the waiting variants share a rung.
  if (status === "leased") {
    return 0;
  }
  if (status === "starting_surface") {
    return 1;
  }
  if (status === "waiting_for_browser_surface") {
    return 2;
  }
  return 3;
}

/** The most-urgent lease by status rank, tie-broken by most-recent request. */
export function pickMostUrgentLease(leases: readonly BrowserSurfaceLease[]): BrowserSurfaceLease | null {
  if (leases.length === 0) {
    return null;
  }
  const [mostUrgent] = [...leases].sort((a, b) => {
    const r = rankRemoteSurfaceLease(a.status) - rankRemoteSurfaceLease(b.status);
    if (r !== 0) {
      return r;
    }
    // Stable secondary: most-recent requested_at first.
    const at = Date.parse(b.requested_at) - Date.parse(a.requested_at);
    return Number.isFinite(at) ? at : 0;
  });
  return mostUrgent ?? null;
}

function surfaceRecencyMs(surface: BrowserSurface): number {
  const lastUsed = Date.parse(surface.last_used_at);
  if (Number.isFinite(lastUsed)) {
    return lastUsed;
  }
  const created = Date.parse(surface.created_at);
  return Number.isFinite(created) ? created : 0;
}

/** The most-recently-used surface, tie-broken by descending surface_id. */
export function pickMostRecentSurface(surfaces: readonly BrowserSurface[]): BrowserSurface | null {
  if (surfaces.length === 0) {
    return null;
  }
  const [mostRecent] = [...surfaces].sort((a, b) => {
    const at = surfaceRecencyMs(b) - surfaceRecencyMs(a);
    if (at !== 0) {
      return at;
    }
    return b.surface_id.localeCompare(a.surface_id);
  });
  return mostRecent ?? null;
}

/**
 * The most recent current browser surface evidence.
 *
 * Only ready, unleased surfaces qualify here. A released or retired row may
 * still exist in storage for diagnostics, but it is historical and must not be
 * promoted into current health authority on its own.
 */
export function pickMostRecentCurrentSurface(surfaces: readonly BrowserSurface[]): BrowserSurface | null {
  return pickMostRecentSurface(surfaces.filter((surface) => surface.health === "ready" && !surface.active_lease_id));
}
