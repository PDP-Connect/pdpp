// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  BrowserSurface,
  BrowserSurfaceLease,
  BrowserSurfaceLeaseManager,
} from "@opendatalabs/remote-surface/leases";
import type {
  BrowserSurfaceReadinessProbe,
  BrowserSurfaceReadinessProbeFailure,
  BrowserSurfaceReadinessProbeResult,
} from "../browser-surface-readiness.ts";

const WINDOW_SETTLE_UNAVAILABLE = "browser_surface_window_settle_unavailable";

interface ReconciliationLogger {
  warn?: (message: string) => void;
}

interface WindowSettleReconciliationDeps {
  readonly invalidateDeferredLease: (lease: BrowserSurfaceLease, probeCode: string) => Promise<void>;
  readonly invalidateIdleSurface: (surface: BrowserSurface, probeCode: string) => Promise<void>;
  readonly leaseManager: BrowserSurfaceLeaseManager | null;
  readonly log: ReconciliationLogger;
  readonly readinessProbe: BrowserSurfaceReadinessProbe | null;
  readonly shouldReconcile: () => boolean;
}

export interface WindowSettleReconciliation {
  reconcileAtBoot(activeRunIds: ReadonlySet<string>): Promise<void>;
  retireDeferredLease(lease: BrowserSurfaceLease): Promise<void>;
}

function isWindowSettleUnavailable(
  result: BrowserSurfaceReadinessProbeResult | null
): result is BrowserSurfaceReadinessProbeFailure {
  return result?.ok === false && result.code === WINDOW_SETTLE_UNAVAILABLE;
}

function findLeasedSurfaceLease(
  leaseManager: BrowserSurfaceLeaseManager,
  surfaceId: string
): BrowserSurfaceLease | undefined {
  return leaseManager
    .listLeases()
    .find((candidate) => candidate.surface_id === surfaceId && candidate.status === "leased");
}

export function createWindowSettleReconciliation(deps: WindowSettleReconciliationDeps): WindowSettleReconciliation {
  const deferredSurfaceIds = new Set<string>();

  function invokeProbe(
    probe: BrowserSurfaceReadinessProbe,
    surface: BrowserSurface
  ): Promise<BrowserSurfaceReadinessProbeResult> {
    try {
      return probe.probe(surface);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  function reportProbeError(surface: BrowserSurface, err: unknown): null {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn?.(`[controller] boot capability probe threw for ${surface.surface_id}: ${message}`);
    return null;
  }

  function probeSurface(surface: BrowserSurface): Promise<BrowserSurfaceReadinessProbeResult | null> {
    const probe = deps.readinessProbe;
    if (!probe) {
      return Promise.resolve(null);
    }
    return invokeProbe(probe, surface).catch((err) => reportProbeError(surface, err));
  }

  async function retireUnavailableSurface(
    leaseManager: BrowserSurfaceLeaseManager,
    surface: BrowserSurface,
    activeRunIds: ReadonlySet<string>
  ): Promise<void> {
    const lease = findLeasedSurfaceLease(leaseManager, surface.surface_id);
    if (lease && activeRunIds.has(lease.run_id)) {
      deferredSurfaceIds.add(surface.surface_id);
      deps.log.warn?.(
        `[controller] deferring retirement of active surface ${surface.surface_id} until run ${lease.run_id} completes`
      );
      return;
    }
    await deps.invalidateIdleSurface(surface, WINDOW_SETTLE_UNAVAILABLE);
  }

  async function reconcileSurface(
    leaseManager: BrowserSurfaceLeaseManager,
    surface: BrowserSurface,
    activeRunIds: ReadonlySet<string>
  ): Promise<void> {
    if (surface.health !== "ready") {
      return;
    }
    const result = await probeSurface(surface);
    if (!isWindowSettleUnavailable(result)) {
      return;
    }
    await retireUnavailableSurface(leaseManager, surface, activeRunIds);
  }

  return {
    async reconcileAtBoot(activeRunIds) {
      const { leaseManager } = deps;
      if (!(leaseManager && deps.readinessProbe && deps.shouldReconcile())) {
        return;
      }
      for (const surface of leaseManager.listSurfaces()) {
        await reconcileSurface(leaseManager, surface, activeRunIds);
      }
    },
    async retireDeferredLease(lease) {
      if (!(lease.surface_id && deferredSurfaceIds.delete(lease.surface_id))) {
        return;
      }
      await deps.invalidateDeferredLease(lease, WINDOW_SETTLE_UNAVAILABLE);
    },
  };
}
