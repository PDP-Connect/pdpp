// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Optional-dependency guard for @opendatalabs/remote-surface.
//
// The remote-surface package was extracted to its own repo
// (github.com/vana-com/remote-surface) and is declared as an OPTIONAL
// dependency here. When it is installed, this module is a transparent
// pass-through to the real lease-manager surface. When it is NOT installed
// (e.g. a deployment that does not use browser-session streaming), the dynamic
// import fails and we degrade cleanly: the browser-surface / streaming path is
// reported unavailable instead of crashing the whole server at module load.
//
// Only the RUNTIME (value) coupling is guarded here — one class plus a
// constant. All other remote-surface usage in the reference implementation is
// type-only and erases at compile time, so it needs no guard.

export type RemoteSurfaceModule = typeof import("@opendatalabs/remote-surface/leases");

export type RemoteSurfaceAvailability =
  | { available: true; module: RemoteSurfaceModule }
  | { available: false; reason: string };

let cached: RemoteSurfaceAvailability | null = null;

/**
 * Lazily resolve @opendatalabs/remote-surface/leases. Result is cached.
 * Never throws — a missing package yields `{ available: false, reason }`.
 */
export async function loadRemoteSurface(): Promise<RemoteSurfaceAvailability> {
  if (cached) return cached;
  try {
    const module = (await import(
      "@opendatalabs/remote-surface/leases"
    )) as RemoteSurfaceModule;
    cached = { available: true, module };
  } catch (error) {
    cached = {
      available: false,
      reason:
        "browser surface unavailable: @opendatalabs/remote-surface is not installed " +
        `(${error instanceof Error ? error.message : String(error)})`,
    };
  }
  return cached;
}

/**
 * Build a BrowserSurfaceLeaseManager if the package is present, else null.
 * A null manager signals the streaming/browser-surface path is disabled;
 * callers must treat null as "browser surface unavailable" and not crash.
 */
export async function createOptionalBrowserSurfaceLeaseManager(
  args: ConstructorParameters<RemoteSurfaceModule["BrowserSurfaceLeaseManager"]>[0]
): Promise<InstanceType<RemoteSurfaceModule["BrowserSurfaceLeaseManager"]> | null> {
  const surface = await loadRemoteSurface();
  if (!surface.available) return null;
  return new surface.module.BrowserSurfaceLeaseManager(args);
}
