import type { CssBox, StreamViewport } from "./geometry.ts";
export interface StreamViewerSurfaceViewportInput extends StreamViewport {
    deviceScaleFactor?: number;
    hasTouch?: boolean;
    mobile?: boolean;
    screenHeight?: number;
    screenWidth?: number;
    userAgent?: string;
}
export interface StreamViewerSurfaceGeometry {
    containerBox: CssBox;
    displayRect: CssBox;
    isOneToOne: boolean;
    letterboxBars: {
        bottom: number;
        left: number;
        right: number;
        top: number;
    };
    scale: number;
    viewport: StreamViewport;
}
export interface StreamViewerSurface {
    dispose(): void;
    getGeometry(): StreamViewerSurfaceGeometry | null;
    mapClientPointToStream(clientX: number, clientY: number): {
        x: number;
        y: number;
    } | null;
    projectStreamViewportRectToClientBox(fieldRect: {
        height: number;
        width: number;
        x: number;
        y: number;
    }): CssBox | null;
    setViewport(viewport: StreamViewerSurfaceViewportInput): void;
    subscribe(listener: StreamViewerSurfaceGeometryListener): () => void;
}
export type StreamViewerSurfaceGeometryListener = (geometry: StreamViewerSurfaceGeometry) => void;
export interface StreamViewerSurfaceOptions {
    onGeometryChange?: StreamViewerSurfaceGeometryListener;
    resizeObserverFactory?: StreamViewerResizeObserverFactory;
}
export interface StreamViewerResizeObserver {
    disconnect(): void;
    observe(target: Element): void;
    unobserve(target: Element): void;
}
export type StreamViewerResizeObserverFactory = (callback: () => void) => StreamViewerResizeObserver;
export declare function createContainerFitStreamViewerSurface(container: HTMLElement, viewport: StreamViewerSurfaceViewportInput, options?: StreamViewerSurfaceOptions): StreamViewerSurface;
//# sourceMappingURL=stream-viewer-surface.d.ts.map