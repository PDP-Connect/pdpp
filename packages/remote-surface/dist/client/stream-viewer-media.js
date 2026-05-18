import { presentationViewportsMatch } from "./stream-viewer-control.js";
export function viewportInfoFromPayload(viewport) {
    return {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: viewport.deviceScaleFactor,
        screenWidth: viewport.screenWidth,
        screenHeight: viewport.screenHeight,
    };
}
export function toNekoNativeViewportInfo(viewport) {
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
export function viewportCaptureSize(viewport) {
    return {
        width: viewport.screenWidth ?? viewport.width,
        height: viewport.screenHeight ?? viewport.height,
    };
}
export function nekoMediaSettleTarget(clientConfig, viewport) {
    return {
        statusPath: clientConfig.statusPath ?? "",
        viewport,
    };
}
export function nekoMediaSettleTargetsMatch(a, b) {
    if (!(a && b)) {
        return false;
    }
    return (a.statusPath === b.statusPath &&
        streamViewportInfosMatch(a.viewport, b.viewport) &&
        Math.abs((a.viewport.deviceScaleFactor ?? 1) - (b.viewport.deviceScaleFactor ?? 1)) <= 0.01);
}
export function streamViewportInfosMatch(a, b) {
    return (presentationViewportsMatch(a ?? null, b ?? null) &&
        presentationViewportsMatch(a ? viewportCaptureSize(a) : null, b ? viewportCaptureSize(b) : null));
}
//# sourceMappingURL=stream-viewer-media.js.map