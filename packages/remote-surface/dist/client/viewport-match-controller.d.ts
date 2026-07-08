import { type CssBox, type StreamViewport, type ViewportPayload } from "./geometry.ts";
import type { StreamViewerSurface, StreamViewerSurfaceGeometry } from "./stream-viewer-surface.ts";
import { type ViewportObservation, type ViewportTransition } from "./viewport-classifier.ts";
export type ViewportMatchApplyViewport = (viewport: ViewportPayload) => Promise<void> | void;
export interface ViewportMatchClock {
    clearTimeout(handle: unknown): void;
    now(): number;
    setTimeout(callback: () => void, delayMs: number): unknown;
}
export interface ViewportMatchViewportDefaults {
    deviceScaleFactor?: number;
    hasTouch?: boolean;
    mobile?: boolean;
    screenHeight?: number;
    screenWidth?: number;
    userAgent?: string;
}
export interface ViewportMatchSnapContext {
    geometry: StreamViewerSurfaceGeometry;
    observation: ViewportObservation;
    transition: ViewportTransition;
}
export type ViewportMatchSnapPolicy = (viewport: ViewportPayload, context: ViewportMatchSnapContext) => ViewportPayload;
export type ViewportMatchObservationFactory = (geometry: StreamViewerSurfaceGeometry) => ViewportObservation;
export type ViewportMatchDefaultsProvider = ViewportMatchViewportDefaults | ((geometry: StreamViewerSurfaceGeometry) => ViewportMatchViewportDefaults);
export interface ViewportMatchOptions {
    clock?: ViewportMatchClock;
    debounceMs?: number;
    matchedThresholdPx?: number;
    observationFromGeometry?: ViewportMatchObservationFactory;
    snapViewport?: ViewportMatchSnapPolicy;
    viewportDefaults?: ViewportMatchDefaultsProvider;
}
export interface ViewportMatchControllerConfig {
    applyViewport: ViewportMatchApplyViewport;
    options?: ViewportMatchOptions;
    surface: StreamViewerSurface;
}
export interface ViewportMatchLetterboxBars {
    bottom: number;
    left: number;
    right: number;
    top: number;
}
export interface ViewportMatchTelemetry {
    actualViewport: StreamViewport | null;
    containerBox: CssBox | null;
    displayRect: CssBox | null;
    lastAppliedViewport: ViewportPayload | null;
    lastError: string | null;
    letterboxBars: ViewportMatchLetterboxBars;
    matched: boolean;
    maxLetterboxPx: number;
    pendingViewport: ViewportPayload | null;
    targetViewport: ViewportPayload | null;
    transition: ViewportTransition | null;
}
export type ViewportMatchTelemetryListener = (telemetry: ViewportMatchTelemetry) => void;
export interface ViewportMatchController {
    dispose(): void;
    getTelemetry(): ViewportMatchTelemetry;
    requestMatch(): void;
    subscribe(listener: ViewportMatchTelemetryListener): () => void;
}
export declare function createViewportMatchController({ applyViewport, options, surface, }: ViewportMatchControllerConfig): ViewportMatchController;
//# sourceMappingURL=viewport-match-controller.d.ts.map