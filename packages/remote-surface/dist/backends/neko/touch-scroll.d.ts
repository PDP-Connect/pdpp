export interface NekoTouchScrollBridgeEnvironment {
    coarsePointer: boolean;
    landscape: boolean;
    nativeTouchSupported: boolean | null;
}
export interface NekoTouchScrollIntentInput {
    currentX: number;
    currentY: number;
    startX: number;
    startY: number;
    thresholdPx?: number;
    verticalBias?: number;
}
export interface NekoTouchPointRect {
    bottom: number;
    left: number;
    right: number;
    top: number;
}
export declare const NEKO_TOUCH_SCROLL_POLICY: {
    readonly clickMaxDurationMs: 700;
    readonly scrollIntentThresholdPx: 10;
    readonly scrollStepPx: 50;
    readonly verticalBias: 1.1;
};
export declare function shouldUseNekoTouchScrollBridge({ coarsePointer, landscape, nativeTouchSupported, }: NekoTouchScrollBridgeEnvironment): boolean;
export declare function isNekoTouchScrollIntent({ currentX, currentY, startX, startY, thresholdPx, verticalBias, }: NekoTouchScrollIntentInput): boolean;
export declare function isNekoTouchPointInsideRect({ clientX, clientY, rect, }: {
    clientX: number;
    clientY: number;
    rect: NekoTouchPointRect;
}): boolean;
export declare function takeNekoTouchScrollSteps(accumulatedPx: number, stepPx?: 50): {
    remainderPx: number;
    steps: number;
};
export declare function nekoTouchScrollStepsToControlDelta(steps: number): number;
//# sourceMappingURL=touch-scroll.d.ts.map