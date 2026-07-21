/**
 * Console-side geometry glue. Every value below is computed by calling the
 * remote-surface library's own geometry authority (`@opendatalabs/remote-surface/client`)
 * — this module MUST NOT re-derive container-fit, scale, letterbox, or
 * coordinate-projection math locally. See docs/architecture/planes.md §6
 * (VIEWPORT/GEOMETRY) in the remote-surface repo: "hosts MUST consume it,
 * never re-derive it."
 *
 * Extracted out of stream-viewer.tsx (a "use client" React component file)
 * into a plain module so `stream-parity-geometry.test.ts` can import these
 * exact functions under plain `node --test` without a JSX/React runtime, and
 * assert they are bit-identical to calling the library directly — the parity
 * check the spec's acceptance instrument requires ("a geometry test that only
 * exercises the library in isolation does not catch [re-derivation drift]").
 */
import {
  buildViewportPayload,
  pointToStreamViewport,
  type StreamViewportInfo,
  viewportCaptureSize,
} from "@opendatalabs/remote-surface/client";
import { computeStreamCaptureTargetForContext } from "@opendatalabs/remote-surface/diagnostics";

export const MOBILE_USER_AGENT_RE = /Android|iPhone|iPad|iPod|Mobile/i;

export interface ReadViewerViewportOptions {
  deviceScaleFactor?: number;
  highDprCapture?: boolean;
}

export const NEKO_NATIVE_VIEWPORT_OPTIONS: ReadViewerViewportOptions = {
  deviceScaleFactor: 1,
  highDprCapture: false,
};

/**
 * Compute the operator's current viewport for the mint request / resize
 * reconciliation. Server-only pre-render returns `undefined` (the viewer is
 * a client component, but the helper guards against accidental SSR call
 * sites).
 */
export function readViewerViewport(width: number, height: number, options: ReadViewerViewportOptions = {}) {
  if (typeof window === "undefined") {
    return;
  }
  const hasTouch = window.navigator.maxTouchPoints > 0 || "ontouchstart" in window;
  let coarsePointer = false;
  try {
    coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  } catch {
    coarsePointer = false;
  }
  const deviceScaleFactor = options.deviceScaleFactor ?? window.devicePixelRatio ?? 1;
  const mobile = coarsePointer || MOBILE_USER_AGENT_RE.test(window.navigator.userAgent);
  const captureTarget = computeStreamCaptureTargetForContext({
    devicePixelRatio: deviceScaleFactor,
    highDprCapture: options.highDprCapture ?? mobile,
    viewport: { width, height },
  });
  return buildViewportPayload({
    width,
    height,
    deviceScaleFactor,
    hasTouch,
    mobile,
    screenHeight: captureTarget.height,
    screenWidth: captureTarget.width,
    userAgent: window.navigator.userAgent,
  });
}

/** n.eko viewport-layout POST shape: library-computed capture size + the raw viewport. */
export function viewportLayoutFromInfo(viewport: StreamViewportInfo) {
  const capture = viewportCaptureSize(viewport);
  return {
    screenHeight: capture.height,
    screenWidth: capture.width,
    viewportHeight: viewport.height,
    viewportWidth: viewport.width,
  };
}

/**
 * Thin, intentionally-transparent wrapper: forwards straight to the
 * library's own `pointToStreamViewport` projection. Kept as a named function
 * (rather than an inline call at each site) only for call-site readability
 * and the debug-payload callers below — it adds no math of its own.
 */
export function mapPointerToStreamViewport({
  containerBox,
  event,
  imageBox,
  viewport,
}: {
  containerBox: DOMRect;
  event: { clientX: number; clientY: number };
  imageBox: DOMRect | undefined;
  viewport: StreamViewportInfo | { height: number; width: number } | null;
}) {
  return pointToStreamViewport(event, {
    containerBox,
    imageBox,
    viewport,
  });
}
