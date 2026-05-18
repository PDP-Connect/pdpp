import type { ViewportPayload } from "./geometry.ts";
import { type NekoMediaSettleSample, type NekoMediaSettleState } from "../backends/neko/media-settle.ts";
import { type ViewportObservation } from "./viewport-classifier.ts";
export type StreamViewerControlEvent = {
    observation: ViewportObservation;
    source: string;
    type: "viewport.observed";
    viewport: ViewportPayload;
} | {
    sample: NekoMediaSettleSample;
    type: "media.sampled";
};
export type StreamViewerCommand = {
    reason: string;
    source: string;
    type: "viewport.hold";
} | {
    reason: string;
    source: string;
    type: "viewport.post";
    viewport: ViewportPayload;
} | {
    reasons: string[];
    type: "media.degraded";
} | {
    type: "media.settled";
};
export interface StreamViewerControlState {
    media: NekoMediaSettleState;
    viewport: {
        orientationSettle: OrientationSettleState | null;
        previousObservation: ViewportObservation | null;
    };
}
export interface StreamViewerControlStep {
    commands: StreamViewerCommand[];
    state: StreamViewerControlState;
}
export interface StreamViewerControlPolicy {
    orientationSettleMs: number;
    orientationStableSamples: number;
    orientationStableTolerancePx: number;
}
interface OrientationSettleState {
    lastSize: {
        height: number;
        width: number;
    };
    stableSamples: number;
    startedAtMs: number;
}
export declare function presentationViewportsMatch(a: {
    height: number;
    width: number;
} | null, b: {
    height: number;
    width: number;
} | null, tolerancePx?: number): boolean;
export interface PresentationViewportLike {
    height: number;
    screenHeight?: number;
    screenWidth?: number;
    width: number;
}
export declare function localSurfaceCanDisplayPresentation(local: PresentationViewportLike | null, presentation: PresentationViewportLike | null): boolean;
export declare function stablePresentationContainerRect(actual: {
    height: number;
    width: number;
} | null, presentation: PresentationViewportLike | null): {
    height: number;
    width: number;
} | null;
export declare function nextPresentationOrientationHoldUntilMs({ currentHoldUntilMs, holdMs, nowMs, source, }: {
    currentHoldUntilMs: number;
    holdMs: number;
    nowMs: number;
    source: string;
}): number;
export declare function shouldDebouncePresentationViewportUpdate({ nowMs, orientationHoldUntilMs, source, }: {
    nowMs: number;
    orientationHoldUntilMs: number;
    source: string;
}): boolean;
export declare function nextPresentationKeyboardHoldUntilMs({ currentHoldUntilMs, isKeyboardActive, holdMs, nowMs, }: {
    currentHoldUntilMs: number;
    holdMs: number;
    isKeyboardActive: boolean;
    nowMs: number;
}): number;
export declare function shouldHoldPresentationViewportForKeyboard({ isMobileViewport, keyboardActive, keyboardHoldUntilMs, nowMs, source, }: {
    isMobileViewport: boolean;
    keyboardActive: boolean;
    keyboardHoldUntilMs: number;
    nowMs: number;
    source: string;
}): boolean;
export declare function createStreamViewerControlState(): StreamViewerControlState;
export declare function reduceStreamViewerControl(state: StreamViewerControlState, event: StreamViewerControlEvent, policy?: StreamViewerControlPolicy): StreamViewerControlStep;
export declare function replayStreamViewerControl(events: StreamViewerControlEvent[], initialState?: StreamViewerControlState, policy?: StreamViewerControlPolicy): StreamViewerControlStep;
export {};
//# sourceMappingURL=stream-viewer-control.d.ts.map