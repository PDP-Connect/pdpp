import type { BrowserSurface, BrowserSurfaceAllocator } from "@opendatalabs/remote-surface/leases";

import type { AllocatorObservation } from "./ephemeral-health-projection.ts";

export interface BrowserSurfaceRuntimeInventorySnapshot {
  readonly allocator_observation: AllocatorObservation | null;
  readonly surfaces: readonly BrowserSurface[];
}

interface AllocatorObservationWindow {
  readonly expires_at: string;
  readonly observed_at: string;
}

function observationWindow(now: Date, ttlMs: number): AllocatorObservationWindow {
  return {
    observed_at: now.toISOString(),
    expires_at: new Date(now.getTime() + Math.max(0, ttlMs)).toISOString(),
  };
}

function allocatorFailureReason(
  error: unknown
): Exclude<NonNullable<AllocatorObservation["reason"]>, "expired" | "not_observed"> {
  const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
  if (code.includes("http")) {
    return "http";
  }
  if (code.includes("timeout")) {
    return "timeout";
  }
  if (code.includes("malformed") || code.includes("invalid")) {
    return "malformed";
  }
  return "fetch";
}

function unobservedInventory(window: AllocatorObservationWindow): BrowserSurfaceRuntimeInventorySnapshot {
  return {
    allocator_observation: { status: "unknown", reason: "not_observed", ...window },
    surfaces: [],
  };
}

function unavailableInventory(
  error: unknown,
  window: AllocatorObservationWindow
): BrowserSurfaceRuntimeInventorySnapshot {
  return {
    allocator_observation: { status: "unavailable", reason: allocatorFailureReason(error), ...window },
    surfaces: [],
  };
}

/**
 * Reads allocator inventory without allocating, stopping, restarting, or
 * leasing a surface. The observation includes its own validity window so a
 * summary cache cannot reuse capability evidence after it expires.
 */
export async function observeDynamicBrowserSurfaceRuntimeInventory(input: {
  readonly allocator: BrowserSurfaceAllocator | undefined;
  readonly now?: Date;
  readonly ttl_ms: number;
}): Promise<BrowserSurfaceRuntimeInventorySnapshot> {
  const window = observationWindow(input.now ?? new Date(), input.ttl_ms);
  if (!input.allocator) {
    return unobservedInventory(window);
  }
  try {
    return {
      allocator_observation: { status: "available", ...window },
      surfaces: await input.allocator.listSurfaces(),
    };
  } catch (error) {
    return unavailableInventory(error, window);
  }
}
