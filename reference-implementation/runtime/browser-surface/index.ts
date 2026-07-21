// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Public facade for the browser-surface run-coordinator subsystem.
// Consumers import from this module; the internal structure is an
// implementation detail of the browser-surface/ directory.

export type { BrowserSurfaceReadinessProbe } from "../browser-surface-readiness.ts";
// biome-ignore lint/performance/noBarrelFile: intentional public facade — consumers import the run-coordinator subsystem from this module while the internal directory structure stays an implementation detail.
export {
  type BrowserSurfaceManager,
  type BrowserSurfaceManagerDeps,
  createBrowserSurfaceManager,
  type ManagedSurfaceContext,
} from "./run-coordinator.ts";
