import type { ViewportPayload } from "./geometry.ts";
import { presentationViewportsMatch } from "./stream-viewer-control.ts";

export type StreamViewportInfo = Pick<ViewportPayload, "height" | "width"> & {
  deviceScaleFactor?: number | undefined;
  screenHeight?: number | undefined;
  screenWidth?: number | undefined;
};

export interface NekoMediaSettleTarget {
  statusPath: string;
  viewport: StreamViewportInfo;
}

export function viewportInfoFromPayload(viewport: ViewportPayload): StreamViewportInfo {
  return {
    width: viewport.width,
    height: viewport.height,
    deviceScaleFactor: viewport.deviceScaleFactor,
    screenWidth: viewport.screenWidth,
    screenHeight: viewport.screenHeight,
  };
}

export function toNekoNativeViewportInfo(viewport: StreamViewportInfo | null): StreamViewportInfo | null {
  if (!viewport) {
    return null;
  }
  return {
    ...viewport,
    deviceScaleFactor: 1,
    screenHeight: viewport.height,
    screenWidth: viewport.width,
  };
}

export function viewportCaptureSize(viewport: StreamViewportInfo): { height: number; width: number } {
  return {
    width: viewport.screenWidth ?? viewport.width,
    height: viewport.screenHeight ?? viewport.height,
  };
}

export function nekoMediaSettleTarget(
  clientConfig: { statusPath?: string | null },
  viewport: StreamViewportInfo
): NekoMediaSettleTarget {
  return {
    statusPath: clientConfig.statusPath ?? "",
    viewport,
  };
}

export function nekoMediaSettleTargetsMatch(
  a: NekoMediaSettleTarget | null | undefined,
  b: NekoMediaSettleTarget | null | undefined
): boolean {
  if (!(a && b)) {
    return false;
  }
  return (
    a.statusPath === b.statusPath &&
    streamViewportInfosMatch(a.viewport, b.viewport) &&
    Math.abs((a.viewport.deviceScaleFactor ?? 1) - (b.viewport.deviceScaleFactor ?? 1)) <= 0.01
  );
}

export function streamViewportInfosMatch(
  a: StreamViewportInfo | null | undefined,
  b: StreamViewportInfo | null | undefined
): boolean {
  return (
    presentationViewportsMatch(a ?? null, b ?? null) &&
    presentationViewportsMatch(a ? viewportCaptureSize(a) : null, b ? viewportCaptureSize(b) : null)
  );
}
