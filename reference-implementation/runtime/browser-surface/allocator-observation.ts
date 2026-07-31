// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// biome-ignore lint/correctness/noUnresolvedImports: remote-surface 1.5.1 exports ./leases; Biome 2.5.5 fails to resolve this package export.
import type { BrowserSurface, BrowserSurfaceAllocator } from "@opendatalabs/remote-surface/leases";

import type { AllocatorObservation } from "./ephemeral-health-projection.ts";

export interface BrowserSurfaceRuntimeInventorySnapshot {
  readonly allocator_observation: AllocatorObservation | null;
  readonly surfaces: readonly BrowserSurface[];
}

/** Maximum known surfaces accepted by one bounded runtime observation. */
export const MAX_BROWSER_SURFACE_RUNTIME_OBSERVATION_SURFACES = 25;

/**
 * Scoped status read for known durable surface ids. Missing and unreadable ids
 * stay explicit instead of becoming indistinguishable from an empty inventory.
 */
export interface BrowserSurfaceRuntimeSurfaceObservation {
  readonly allocator_observation: AllocatorObservation | null;
  readonly missing_surface_ids: readonly string[];
  readonly surfaces: readonly BrowserSurface[];
  readonly unknown_surface_ids: readonly string[];
}

interface AllocatorObservationWindow {
  readonly expires_at: string;
  readonly observed_at: string;
}

function observationWindow(now: Date, ttlMs: number): AllocatorObservationWindow {
  return {
    expires_at: new Date(now.getTime() + Math.max(0, ttlMs)).toISOString(),
    observed_at: now.toISOString(),
  };
}

function allocatorFailureReason(
  error: unknown
): Exclude<NonNullable<AllocatorObservation["reason"]>, "expired" | "not_observed"> {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: TypeScript boundary permits nullish input; this guard preserves runtime behavior.
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
    allocator_observation: { reason: "not_observed", status: "unknown", ...window },
    surfaces: [],
  };
}

function unavailableInventory(
  error: unknown,
  window: AllocatorObservationWindow
): BrowserSurfaceRuntimeInventorySnapshot {
  return {
    allocator_observation: { reason: allocatorFailureReason(error), status: "unavailable", ...window },
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

function boundedSurfaceIds(surfaceIds: readonly string[]): readonly string[] {
  const unique = [...new Set(surfaceIds)];
  if (unique.length > MAX_BROWSER_SURFACE_RUNTIME_OBSERVATION_SURFACES) {
    throw new RangeError(
      `browser surface observation accepts at most ${MAX_BROWSER_SURFACE_RUNTIME_OBSERVATION_SURFACES} surface ids`
    );
  }
  return unique;
}

/**
 * Reads only caller-known allocator surface ids. Unlike the global inventory
 * diagnostic, this never calls `listSurfaces()`.
 */
export async function observeDynamicBrowserSurfaceRuntimeSurfaces(input: {
  readonly allocator: BrowserSurfaceAllocator | undefined;
  readonly now?: Date;
  readonly surface_ids: readonly string[];
  readonly ttl_ms: number;
}): Promise<BrowserSurfaceRuntimeSurfaceObservation> {
  const surfaceIds = boundedSurfaceIds(input.surface_ids);
  if (surfaceIds.length === 0) {
    return { allocator_observation: null, missing_surface_ids: [], surfaces: [], unknown_surface_ids: [] };
  }
  const window = observationWindow(input.now ?? new Date(), input.ttl_ms);
  if (!input.allocator) {
    return {
      allocator_observation: { reason: "not_observed", status: "unknown", ...window },
      missing_surface_ids: [],
      surfaces: [],
      unknown_surface_ids: surfaceIds,
    };
  }
  const results = await Promise.all(
    surfaceIds.map(async (surfaceId) => {
      try {
        return { surface: await input.allocator?.getSurfaceStatus(surfaceId), surfaceId };
      } catch {
        return { surface: undefined, surfaceId };
      }
    })
  );
  const surfaces: BrowserSurface[] = [];
  const missingSurfaceIds: string[] = [];
  const unknownSurfaceIds: string[] = [];
  for (const result of results) {
    if (result.surface === undefined) {
      unknownSurfaceIds.push(result.surfaceId);
    } else if (result.surface === null) {
      missingSurfaceIds.push(result.surfaceId);
    } else {
      surfaces.push(result.surface);
    }
  }
  return {
    allocator_observation:
      unknownSurfaceIds.length === 0
        ? { status: "available", ...window }
        : { reason: "fetch", status: "unavailable", ...window },
    missing_surface_ids: missingSurfaceIds,
    surfaces,
    unknown_surface_ids: unknownSurfaceIds,
  };
}
