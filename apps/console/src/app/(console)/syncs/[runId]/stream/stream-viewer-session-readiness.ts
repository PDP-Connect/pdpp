// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type {
  NekoRemoteSurfaceSession,
  NekoSurfaceAdapter,
  RemoteSurfaceViewerHandle,
} from "@opendatalabs/remote-surface/client";

/**
 * The remote-surface viewer publishes its session before the injected adapter
 * finishes mounting. Console mechanism calls are safe only after both sides
 * report mounted.
 */
export function getMountedNekoViewerSession(
  viewer: RemoteSurfaceViewerHandle | null,
  adapter: Pick<NekoSurfaceAdapter, "getLifecycleState"> | null
): NekoRemoteSurfaceSession | null {
  if (viewer?.getLifecycleState() !== "mounted" || adapter?.getLifecycleState() !== "mounted") {
    return null;
  }
  const session = viewer.getSession();
  return session && "getViewportState" in session ? session : null;
}
