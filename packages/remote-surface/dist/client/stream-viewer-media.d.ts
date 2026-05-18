import type { ViewportPayload } from "./geometry.ts";
export type StreamViewportInfo = Pick<ViewportPayload, "height" | "width"> & {
    deviceScaleFactor?: number | undefined;
    screenHeight?: number | undefined;
    screenWidth?: number | undefined;
};
export interface NekoMediaSettleTarget {
    statusPath: string;
    viewport: StreamViewportInfo;
}
export declare function viewportInfoFromPayload(viewport: ViewportPayload): StreamViewportInfo;
export declare function toNekoNativeViewportInfo(viewport: StreamViewportInfo | null): StreamViewportInfo | null;
export declare function viewportCaptureSize(viewport: StreamViewportInfo): {
    height: number;
    width: number;
};
export declare function nekoMediaSettleTarget(clientConfig: {
    statusPath?: string | null;
}, viewport: StreamViewportInfo): NekoMediaSettleTarget;
export declare function nekoMediaSettleTargetsMatch(a: NekoMediaSettleTarget | null | undefined, b: NekoMediaSettleTarget | null | undefined): boolean;
export declare function streamViewportInfosMatch(a: StreamViewportInfo | null | undefined, b: StreamViewportInfo | null | undefined): boolean;
//# sourceMappingURL=stream-viewer-media.d.ts.map