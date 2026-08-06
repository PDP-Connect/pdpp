// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Constants shared between the run-interaction streaming server action and
 * the streaming viewer client component. This module deliberately has no
 * imports — it must be safe to load from a `"use client"` component without
 * dragging server-only code into the client bundle.
 *
 * Server-action error boundaries strip prototype identity, so the action
 * re-throws unavailable errors with this stable message prefix and the
 * client matches on it without relying on `instanceof`.
 */
export const STREAMING_UNAVAILABLE_TAG = "STREAMING_COMPANION_UNAVAILABLE: ";

interface StreamEndpointPaths {
  clipboard_path: string;
  input_path: string;
  viewer_path: string;
  viewport_path: string;
}

export interface SameOriginStreamUrls {
  clipboard_url: string;
  input_url: string;
  viewer_url: string;
  viewport_url: string;
}

function sameOriginPath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

/**
 * Browser stream traffic returns through the console's `/_ref` proxy. Keep
 * those URLs relative so the browser uses the origin that served the page,
 * including a custom Docker host port.
 */
export function sameOriginStreamUrls(paths: StreamEndpointPaths): SameOriginStreamUrls {
  return {
    clipboard_url: sameOriginPath(paths.clipboard_path),
    input_url: sameOriginPath(paths.input_path),
    viewer_url: sameOriginPath(paths.viewer_path),
    viewport_url: sameOriginPath(paths.viewport_path),
  };
}
