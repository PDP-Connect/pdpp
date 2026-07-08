export interface StreamViewport {
    height: number;
    width: number;
}
export interface ViewportPayload extends StreamViewport {
    deviceScaleFactor: number;
    hasTouch: boolean;
    mobile: boolean;
    screenHeight?: number;
    screenWidth?: number;
    userAgent: string;
}
export interface CssBox {
    height: number;
    left: number;
    top: number;
    width: number;
}
export interface ClientPoint {
    clientX: number;
    clientY: number;
}
export interface StreamViewportRect {
    height: number;
    width: number;
    x: number;
    y: number;
}
type MobileViewportSample = Pick<ViewportPayload, "height" | "mobile" | "width">;
export interface LocalViewportSample {
    height: number;
    visualHeight: number | null;
    visualWidth: number | null;
    width: number;
}
export interface MobileKeyboardResizeState {
    baseline: MobileViewportSample | null;
    lastSuppressed: MobileViewportSample | null;
    mode: "keyboard" | "stable";
}
export declare function createMobileKeyboardResizeState(): MobileKeyboardResizeState;
export declare function buildViewportPayload({ deviceScaleFactor, hasTouch, height, mobile, screenHeight, screenWidth, userAgent, width, }: {
    width: number;
    height: number;
    deviceScaleFactor: number;
    hasTouch: boolean;
    mobile: boolean;
    screenHeight?: number;
    screenWidth?: number;
    userAgent: string;
}): ViewportPayload;
export declare function viewportsAreEquivalent(a: StreamViewport | null | undefined, b: StreamViewport | null | undefined, tolerancePx?: number): boolean;
export declare function viewportPayloadsAreEquivalent(a: ViewportPayload | null | undefined, b: ViewportPayload | null | undefined, tolerancePx?: number): boolean;
export declare function isMobileKeyboardViewportResize({ hasLocalTextInputFocus, next, nextLocal, previous, previousLocal, }: {
    hasLocalTextInputFocus?: boolean;
    next: MobileViewportSample;
    nextLocal?: LocalViewportSample | null;
    previous: MobileViewportSample | null | undefined;
    previousLocal?: LocalViewportSample | null;
}): boolean;
export declare function assessMobileKeyboardViewportResize({ hasLocalTextInputFocus, next, nextLocal, previous, previousLocal, state, }: {
    hasLocalTextInputFocus?: boolean;
    next: MobileViewportSample;
    nextLocal?: LocalViewportSample | null;
    previous: MobileViewportSample | null | undefined;
    previousLocal?: LocalViewportSample | null;
    state: MobileKeyboardResizeState;
}): {
    state: MobileKeyboardResizeState;
    suppress: boolean;
};
export declare function containedStreamRect(imageBox: CssBox, viewport: StreamViewport): CssBox;
export declare function streamViewportRectToClientBox(fieldRect: StreamViewportRect, { imageBox, viewport, }: {
    imageBox: CssBox;
    viewport: StreamViewport;
}): CssBox | null;
export declare function pointToStreamViewport(point: ClientPoint, { containerBox, imageBox, viewport, }: {
    containerBox: CssBox;
    imageBox?: CssBox | null;
    viewport?: StreamViewport | null;
}): {
    x: number;
    y: number;
} | null;
export {};
//# sourceMappingURL=geometry.d.ts.map