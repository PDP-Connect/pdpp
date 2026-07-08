// Host-neutral surface-lease APIs. Constants and host-neutral types/functions
// are re-exported from the reference-shaped substrate without aliasing reference
// internals into this subpath. Reference-shaped (`run_id`, snake_case) surfaces
// are re-exported separately below with `@deprecated` jsdoc.

export {
  BROWSER_SURFACE_BACKEND_NEKO,
  BROWSER_SURFACE_LEASE_STATUSES,
  BROWSER_SURFACE_PRIORITY_CLASSES,
  BROWSER_SURFACE_WAIT_REASONS,
  SurfaceLeaseManager,
  DEFAULT_NEKO_IDLE_TTL_MS,
  DEFAULT_NEKO_LEASE_WAIT_TIMEOUT_MS,
  DEFAULT_NEKO_PRIORITY_CLASS,
  DEFAULT_NEKO_PRIORITY_RANKS,
  TERMINAL_BROWSER_SURFACE_LEASE_STATUSES,
  createSurfaceLeaseManager,
  isTerminalBrowserSurfaceLeaseStatus,
  projectSurfaceLease,
} from "./surface-lease-manager.ts";
export type {
  AcquireBrowserSurfaceSessionLeaseRequest,
  AcquireSurfaceLeaseRequest,
  BrowserSurface,
  BrowserSurfaceAllocator,
  BrowserSurfaceBackend,
  BrowserSurfaceHealth,
  BrowserSurfaceLeaseStatus,
  BrowserSurfaceMode,
  BrowserSurfacePriorityClass,
  BrowserSurfaceWaitReason,
  EnsureStartingBrowserSurfaceRequest,
  EnsureBrowserSurfaceRequest,
  ReconcileSurfaceLeasesAfterRestartRequest,
  ReconcileSurfaceLeasesAfterRestartResult,
  ReleaseSurfaceLeaseRequest,
  ReleaseSurfaceLeaseResult,
  RenewSurfaceLeaseRequest,
  RenewSurfaceLeaseResult,
  StopBrowserSurfaceRequest,
  SurfaceLease,
  SurfaceLeaseManagerConfig,
  SurfaceLeaseManagerOptions,
  SurfaceLeaseProjection,
  SurfaceLeaseResult,
  TerminalSurfaceLeaseResult,
} from "./surface-lease-manager.ts";

/**
 * @deprecated Reference-shaped browser-surface lease APIs (with snake_case
 *   `run_id`, `pending_run_id`, and PDPP-coupled projections) moved to
 *   `@opendatalabs/remote-surface/reference`. These re-exports are
 *   preserved for the deprecation horizon recorded in the
 *   `republish-remote-surface-as-opendatalabs` OpenSpec change
 *   (planned removal: first post-publish minor). Import the host-neutral
 *   `SurfaceLease` / `SurfaceLeaseManager` surface above, or the reference
 *   subpath if you need PDPP-shaped lease projections.
 */
export {
  BrowserSurfaceLeaseManager,
  projectBrowserSurfaceLease,
} from "./surface-lease-manager.ts";
/**
 * @deprecated Reference-shaped lease types moved to
 *   `@opendatalabs/remote-surface/reference`. See the export block above
 *   for the deprecation horizon.
 */
export type {
  AcquireBrowserSurfaceLeaseRequest,
  BrowserSurfaceLease,
  BrowserSurfaceLeaseConfig,
  BrowserSurfaceLeaseManagerOptions,
  BrowserSurfaceLeaseResult,
  BrowserSurfaceProjection,
  CleanupIdleBrowserSurfacesResult,
  CompleteBrowserSurfaceCapacityReclaimResult,
  ReconcileBrowserSurfaceLeasesAfterRestartRequest,
  ReconcileBrowserSurfaceLeasesAfterRestartResult,
  ReleaseBrowserSurfaceLeaseRequest,
  ReleaseBrowserSurfaceLeaseResult,
  RenewBrowserSurfaceLeaseRequest,
  RenewBrowserSurfaceLeaseResult,
  TerminalBrowserSurfaceLeaseResult,
} from "./surface-lease-manager.ts";
