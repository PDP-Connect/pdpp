// Public facade for the browser-surface run-coordinator subsystem.
// Consumers import from this module; the internal structure is an
// implementation detail of the browser-surface/ directory.

export {
  createBrowserSurfaceManager,
  type BrowserSurfaceManager,
  type BrowserSurfaceManagerDeps,
  type ManagedSurfaceContext,
} from "./run-coordinator.ts";

export type { BrowserSurfaceReadinessProbe } from "../browser-surface-readiness.ts";
