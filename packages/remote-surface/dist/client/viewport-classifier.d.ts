export interface ViewportSize {
    height: number;
    width: number;
}
export interface VisualViewportSample extends ViewportSize {
    offsetLeft: number;
    offsetTop: number;
    pageLeft: number;
    pageTop: number;
    scale: number;
}
export interface VirtualKeyboardSample {
    height: number;
    width: number;
    x: number;
    y: number;
}
export interface ViewportObservation {
    editableFocused: boolean;
    layout: ViewportSize;
    mobile?: boolean;
    orientation?: {
        angle: number;
        type: string;
    } | null;
    safeArea?: {
        bottom: number;
        left: number;
        right: number;
        top: number;
    } | null;
    timestampMs?: number;
    virtualKeyboard?: VirtualKeyboardSample | null;
    visual?: VisualViewportSample | null;
}
export type ViewportTransitionKind = "browser-chrome" | "keyboard-occlusion" | "layout-resize" | "orientation-change" | "stable" | "zoom";
export interface ViewportTransition {
    keyboardInsetBottom: number;
    kind: ViewportTransitionKind;
    reason: string;
    remoteResize: "hold" | "post";
}
export declare function classifyViewportTransition(previous: ViewportObservation | null | undefined, next: ViewportObservation): ViewportTransition;
//# sourceMappingURL=viewport-classifier.d.ts.map